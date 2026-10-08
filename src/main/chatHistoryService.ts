/**
 * Latex Chat History Service
 *
 * Provides cross-chat context retrieval for Chat mode.
 * Searches previous user and assistant messages across all conversations.
 * Uses keyword/phrase matching with relevance scoring — no external APIs.
 *
 * Chat-only: Main Agent NEVER uses this system.
 */

import type { ChatMessage, Conversation } from "../shared/types.js";

// ── Indexed message entry ──────────────────────────────────────────────────

export interface IndexedMessage {
  /** Conversation this message belongs to. */
  conversationId: string;
  /** Conversation title for title-based search. */
  conversationTitle: string;
  /** Message ID. */
  messageId: string;
  /** "user" or "assistant" — used for role-aware ranking. */
  role: "user" | "assistant";
  /** Full message content. */
  content: string;
  /** Lowercase words for fast keyword lookup. */
  words: string[];
  /** When the message was created. */
  createdAt: number;
  /** Model that generated this message (assistant only). */
  model?: string;
  /** Provider that served this message (assistant only). */
  provider?: string;
}

// ── Search result ──────────────────────────────────────────────────────────

export interface RetrievedContext {
  /** Retrieved messages grouped by conversation. */
  conversations: RetrievedConversation[];
  /** Long-term memories that were also matched. */
  memories: RetrievedMemory[];
  /** Summary shown as subtle indicator in the UI. */
  summary: string;
  /** How many conversations contributed context. */
  conversationCount: number;
}

export interface RetrievedConversation {
  conversationId: string;
  title: string;
  messages: RetrievedMessage[];
  relevanceScore: number;
}

export interface RetrievedMessage {
  role: "user" | "assistant";
  content: string;
  score: number;
}

export interface RetrievedMemory {
  text: string;
  category: string;
  score: number;
}

// ── Configuration ──────────────────────────────────────────────────────────

const MAX_RETRIEVED_CONVERSATIONS = 8;
const MAX_RETRIEVED_MESSAGES_PER_CONVERSATION = 6;
const MAX_RETRIEVED_CHARACTERS = 8000;
const MIN_RELEVANCE_SCORE = 0.02; // Low threshold to allow "last chat" recency-only retrieval
const ASSISTANT_BOOST = 1.4; // boost for assistant messages when query asks "what did you say"
const RECENCY_WEIGHT = 0.15;
const KEYWORD_WEIGHT = 0.50;
const PHRASE_WEIGHT = 0.35;

// Patterns that suggest the user is asking about previous conversations
const PREVIOUS_CHAT_PATTERNS = [
  /what (?:did|do) (?:you|we|it|the) .*(?:before|earlier|last|previous|remember|say|tell|mention|discuss)/i,
  /remember (?:that|when|what|how|from|about)/i,
  /(?:previously|before|earlier|last time|in the past) .*(?:say|tell|mention|discuss|decide|suggest)/i,
  /what was your (?:recommendation|suggestion|answer|solution|response|advice)/i,
  /continue (?:that|from|where|with)/i,
  /(?:my|our) (?:project|app|application|code|work|thing|system)/i,
  /what did we (?:discuss|decide|agree|talk about)/i,
  /you (?:told|said|mentioned|suggested|recommended|advised)/i,
];

// Patterns that specifically ask about the LAST/PREVIOUS chat — prioritize recency
const LAST_CHAT_PATTERNS = [
  /last (?:chat|conversation|session|time|talk)/i,
  /previous (?:chat|conversation|session|talk)/i,
  /(?:tell|say|give) me .*(?:from |about )?(?:the |your )?(?:last|previous|earlier)/i,
  /what(?:'s| is| was) (?:in |from )?(?:the |our |your )?(?:last|previous)/i,
  /anything from (?:the |our |your )?(?:last|previous)/i,
  /what did (?:we|you) (?:talk|discuss|chat) about (?:last|yesterday|before)/i,
  /recap|summarize (?:our |the )?(?:last|previous|earlier)/i,
];

// ── ChatHistoryService ─────────────────────────────────────────────────────

export class ChatHistoryService {
  private index: IndexedMessage[] = [];
  private indexedConversationIds = new Set<string>();
  private settings: { enabled: boolean; useHistory: boolean; useLongTermMemory: boolean } = {
    enabled: true,
    useHistory: true,
    useLongTermMemory: true
  };

  /**
   * Rebuild the full search index from persisted conversations.
   * Call on startup and after bulk changes.
   */
  rebuildIndex(conversations: Conversation[]): void {
    this.index = [];
    this.indexedConversationIds.clear();

    for (const conv of conversations) {
      if (conv.mode !== "chat") continue; // Only index Chat conversations
      this.indexConversation(conv);
    }

    console.log(`[ChatHistory] Index rebuilt: ${this.index.length} messages from ${this.indexedConversationIds.size} conversations`);
  }

  /**
   * Index a single conversation's messages.
   */
  indexConversation(conversation: Conversation): void {
    if (!conversation.messages || conversation.messages.length === 0) return;
    // Only index chat-mode conversations
    if (conversation.mode !== "chat") return;

    // Remove old entries for this conversation first
    this.index = this.index.filter(m => m.conversationId !== conversation.id);
    this.indexedConversationIds.delete(conversation.id);

    for (const msg of conversation.messages) {
      // Index both user and assistant messages
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      // Skip very short messages
      if (msg.content.length < 5) continue;
      // Skip messages that are just streaming markers
      if (msg.content.includes("_(Generation stopped by user)_") && msg.content.length < 50) continue;

      const words = this.tokenize(msg.content);
      if (words.length === 0) continue;

      this.index.push({
        conversationId: conversation.id,
        conversationTitle: conversation.title || "Untitled",
        messageId: msg.id,
        role: msg.role,
        content: msg.content,
        words,
        createdAt: msg.createdAt,
        model: msg.model,
        provider: msg.provider
      });
    }

    this.indexedConversationIds.add(conversation.id);
  }

  /**
   * Remove a conversation from the index.
   */
  removeConversation(conversationId: string): void {
    this.index = this.index.filter(m => m.conversationId !== conversationId);
    this.indexedConversationIds.delete(conversationId);
  }

  /**
   * Update settings.
   */
  updateSettings(settings: Partial<typeof this.settings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  getSettings(): typeof this.settings {
    return { ...this.settings };
  }

  /**
   * Main retrieval method. Given a new Chat message, find relevant context
   * from previous Chat conversations and long-term memories.
   */
  retrieveContext(
    messageText: string,
    memories: Array<{ text: string; category: string; importance?: number }>,
    currentConversationId?: string
  ): RetrievedContext {
    if (!this.settings.enabled || !this.settings.useHistory) {
      return { conversations: [], memories: [], summary: "", conversationCount: 0 };
    }

    const messageWords = this.tokenize(messageText);
    const isAskingPrevious = this.isAskingAboutPrevious(messageText);
    const isLastChat = this.isLastChatQuery(messageText);

    // Search chat history
    const historyResults = this.searchHistory(messageText, messageWords, isAskingPrevious, isLastChat, currentConversationId);

    // Search long-term memories
    const memoryResults = this.settings.useLongTermMemory
      ? this.searchMemories(messageText, messageWords, memories)
      : [];

    // Build summary
    const totalConversations = new Set([
      ...historyResults.map(r => r.conversationId)
    ]).size;

    let summary = "";
    if (totalConversations > 0) {
      const convWord = totalConversations === 1 ? "conversation" : "conversations";
      summary = `Using context from ${totalConversations} previous ${convWord}`;
    }

    return {
      conversations: historyResults,
      memories: memoryResults,
      summary,
      conversationCount: totalConversations
    };
  }

  /**
   * Search previous chat messages for relevant content.
   */
  private searchHistory(
    messageText: string,
    messageWords: string[],
    isAskingPrevious: boolean,
    isLastChat: boolean,
    currentConversationId?: string
  ): RetrievedConversation[] {
    if (this.index.length === 0) return [];

    // Score each indexed message
    const scored = this.index
      .filter(m => m.conversationId !== currentConversationId)
      .map(entry => {
        let score = 0;

        // Keyword overlap
        const overlap = messageWords.filter(w => entry.words.includes(w)).length;
        if (messageWords.length > 0) {
          score += (overlap / messageWords.length) * KEYWORD_WEIGHT;
        }

        // Phrase matching — check for exact multi-word phrases
        const lowerMessage = messageText.toLowerCase();
        const lowerContent = entry.content.toLowerCase();
        if (lowerContent.includes(lowerMessage) || lowerMessage.includes(lowerContent.slice(0, 60))) {
          score += PHRASE_WEIGHT;
        } else {
          // Check for 2-gram and 3-gram phrases
          for (let n = 2; n <= 3; n++) {
            for (let i = 0; i <= messageWords.length - n; i++) {
              const phrase = messageWords.slice(i, i + n).join(" ");
              if (lowerContent.includes(phrase)) {
                score += (PHRASE_WEIGHT * 0.5) * (n / 3);
              }
            }
          }
        }

        // Title matching
        const titleWords = this.tokenize(entry.conversationTitle);
        const titleOverlap = messageWords.filter(w => titleWords.includes(w)).length;
        if (titleWords.length > 0) {
          score += (titleOverlap / titleWords.length) * 0.25;
        }

        // Recency (normalized — newer messages get slight boost)
        const ageHours = (Date.now() - entry.createdAt) / (1000 * 60 * 60);
        const recencyScore = Math.max(0, 1 - ageHours / (24 * 30)); // 30-day decay
        score += recencyScore * RECENCY_WEIGHT;

        // "Last chat" boost: when user asks about the last/previous chat,
        // strongly boost the most recent conversations regardless of keyword overlap.
        if (isLastChat) {
          // Massive recency boost for "last chat" queries — the most recent
          // conversation should always be retrieved even with zero keyword overlap.
          const recentBoost = Math.max(0, 1 - ageHours / (24 * 7)); // 7-day tight window
          score += recentBoost * 0.6; // Much stronger than normal recency
        }

        // Role boost: if user is asking "what did you say/tell me", boost assistant messages
        if (isAskingPrevious && entry.role === "assistant") {
          score *= ASSISTANT_BOOST;
        }

        // Boost for longer, more substantive messages
        if (entry.content.length > 200) {
          score *= 1.1;
        }

        return { entry, score };
      })
      .filter(s => s.score > MIN_RELEVANCE_SCORE)
      .sort((a, b) => b.score - a.score);

    // Group by conversation and select top messages per conversation
    const convMap = new Map<string, { title: string; messages: Array<{ entry: IndexedMessage; score: number }> }>();

    let totalChars = 0;
    let conversationsIncluded = 0;

    for (const { entry, score } of scored) {
      if (conversationsIncluded >= MAX_RETRIEVED_CONVERSATIONS) break;

      if (!convMap.has(entry.conversationId)) {
        convMap.set(entry.conversationId, { title: entry.conversationTitle, messages: [] });
        conversationsIncluded++;
      }

      const conv = convMap.get(entry.conversationId)!;
      if (conv.messages.length >= MAX_RETRIEVED_MESSAGES_PER_CONVERSATION) continue;
      if (totalChars + entry.content.length > MAX_RETRIEVED_CHARACTERS) break;

      conv.messages.push({ entry, score });
      totalChars += entry.content.length;
    }

    // Sort messages within each conversation by timestamp
    const results: RetrievedConversation[] = [];
    for (const [conversationId, { title, messages }] of convMap) {
      const sorted = messages
        .sort((a, b) => a.entry.createdAt - b.entry.createdAt)
        .map(m => ({
          role: m.entry.role as "user" | "assistant",
          content: this.truncateMessage(m.entry.content),
          score: m.score
        }));

      const avgScore = sorted.reduce((sum, m) => sum + m.score, 0) / sorted.length;
      results.push({ conversationId, title, messages: sorted, relevanceScore: avgScore });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Search long-term memories for relevant entries.
   */
  private searchMemories(
    messageText: string,
    messageWords: string[],
    memories: Array<{ text: string; category: string; importance?: number }>
  ): RetrievedMemory[] {
    if (memories.length === 0) return [];

    const scored = memories.map(memory => {
      const memWords = this.tokenize(memory.text);
      const overlap = messageWords.filter(w => memWords.includes(w)).length;
      const keywordScore = messageWords.length > 0 ? overlap / messageWords.length : 0;
      const importance = memory.importance ?? 0.5;

      const score = keywordScore * 0.6 + importance * 0.4;
      return { memory, score };
    });

    return scored
      .filter(s => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => ({
        text: s.memory.text,
        category: s.memory.category,
        score: s.score
      }));
  }

  /**
   * Check if the user's message is asking about previous conversations.
   */
  private isAskingAboutPrevious(messageText: string): boolean {
    return PREVIOUS_CHAT_PATTERNS.some(p => p.test(messageText));
  }

  /**
   * Check if the user is specifically asking about the LAST/PREVIOUS chat.
   */
  private isLastChatQuery(messageText: string): boolean {
    return LAST_CHAT_PATTERNS.some(p => p.test(messageText));
  }

  /**
   * Tokenize text into searchable words.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  /**
   * Truncate a message for context injection.
   * Keeps the beginning (most important) and adds ellipsis if truncated.
   */
  private truncateMessage(content: string): string {
    const MAX_CHARS = 800;
    if (content.length <= MAX_CHARS) return content;
    return content.slice(0, MAX_CHARS) + "…";
  }

  /**
   * Format retrieved context as a text block for injection into the system prompt.
   */
  formatContextForPrompt(context: RetrievedContext): string {
    if (context.conversations.length === 0 && context.memories.length === 0) {
      return "";
    }

    const parts: string[] = [];

    parts.push("--- Relevant Previous Chat Context ---");
    parts.push("");
    parts.push("The following is context retrieved from the user's previous Chat conversations.");
    parts.push("Use this to inform your response. Reference it naturally as if you remember.");
    parts.push("Do NOT mention conversation IDs, retrieval scores, or technical implementation details.");
    parts.push("");

    if (context.conversations.length > 0) {
      for (const conv of context.conversations) {
        parts.push(`--- Previous Conversation: \"${conv.title}\" ---`);
        parts.push("");

        for (const msg of conv.messages) {
          const roleLabel = msg.role === "user" ? "User" : "Assistant";
          parts.push(`${roleLabel}: ${msg.content}`);
          parts.push("");
        }
      }
    }

    if (context.memories.length > 0) {
      parts.push("--- Known Information from Previous Chats ---");
      parts.push("");

      for (const mem of context.memories) {
        parts.push(`- [${mem.category}] ${mem.text}`);
      }
      parts.push("");
    }

    parts.push("--- End of Previous Chat Context ---");
    parts.push("");

    return parts.join("\n");
  }
}

// ── Stop words ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "but", "in",
  "with", "to", "for", "of", "not", "no", "can", "had", "has", "have",
  "was", "were", "are", "be", "been", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "this", "that", "these",
  "those", "it", "its", "he", "she", "they", "we", "you", "i", "me",
  "my", "your", "his", "her", "our", "their", "what", "how", "when",
  "where", "who", "why", "if", "then", "than", "so", "just", "also",
  "very", "too", "some", "any", "all", "each", "more", "most", "other",
  "into", "over", "such", "after", "before", "between", "through",
  "about", "from", "up", "out", "off", "down"
]);
