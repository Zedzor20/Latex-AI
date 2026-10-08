/**
 * Latex Chat Memory Service (Enhanced)
 *
 * Stores useful information extracted from Chat conversations.
 * Only used in Chat mode — Main Agent never receives Chat memories.
 *
 * Supports:
 * - User and assistant message analysis
 * - Memory evolution (update/deprecate/merge)
 * - Duplicate detection
 * - Secret exclusion
 * - Importance and confidence scoring
 */

import type { ChatMemory } from "../shared/types.js";

export type { ChatMemory };

// ── Keywords that suggest useful information to remember ───────────────────

const MEMORY_KEYWORDS: Record<string, ChatMemory["category"]> = {
  // Preferences
  "prefer": "preference", "like": "preference", "want": "preference",
  "favorite": "preference", "style": "preference", "dark": "preference",
  "light": "preference", "theme": "preference", "dislike": "preference",
  "hate": "preference", "use": "preference",

  // Project info
  "project": "project", "app": "project", "application": "project",
  "electron": "project", "react": "project", "database": "project",
  "api": "project", "server": "project", "frontend": "project",
  "backend": "project", "called": "project", "named": "project",
  "latex": "project", "desktop": "project",

  // Technical
  "typescript": "technical", "javascript": "technical", "python": "technical",
  "html": "technical", "css": "technical", "node": "technical",
  "npm": "technical", "git": "technical", "docker": "technical",
  "streaming": "technical", "ipc": "technical", "provider": "technical",
  "ollama": "technical", "omniroute": "technical",

  // Architecture decisions
  "architecture": "architecture", "design": "architecture",
  "pattern": "architecture", "structure": "architecture",
  "separation": "architecture", "isolation": "architecture",

  // Workflow
  "workflow": "workflow", "process": "workflow", "deploy": "workflow",
  "build": "workflow", "test": "workflow", "release": "workflow",
  "ci": "workflow", "cd": "workflow", "pipeline": "workflow",

  // Instructions
  "should": "instruction", "must": "instruction", "always": "instruction",
  "never": "instruction", "remember": "instruction", "note": "instruction",
  "important": "instruction", "requirement": "instruction",
};

// Patterns that suggest useful context from both user and assistant messages
const CONTEXT_PATTERNS = [
  /my (main |current )?(project|app|application|code|repo|repository)/i,
  /i (prefer|like|want|use|need|suggest|recommend)/i,
  /the (project|app|application) (is|uses|has|needs)/i,
  /we (use|need|should|must|have|decided)/i,
  /(dark|light|futuristic|minimalist|modern) (theme|style|interface)/i,
  /(electron|react|typescript|python|node|docker)/i,
  /(api|database|server|frontend|backend)/i,
  /(deploy|build|test|release|ci|cd)/i,
  /i (always|never|usually|sometimes)/i,
  /you (should|can|could|might|would) (use|try|consider|implement|switch)/i,
  /the (best|recommended|preferred|correct|proper) (way|appro|method)/i,
  /a (better|good|common|standard|typical) (way|approach|pattern)/i,
  /use (the|a|an) (.+) (for|to|because)/i,
  /this (uses|relies|depends|works with|is built with)/i,
];

// Patterns that indicate secrets/credentials (never store these)
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /bearer/i,
  /authorization/i,
  /ghp_[a-zA-Z0-9]/i,
  /sk-[a-zA-Z0-9]/i,
  /AIza[A-Za-z0-9]/,
  /eyJ[A-Za-z0-9]/,
];

// Simple paraphrases of short excluded patterns
const TRIVIAL_PATTERNS = new Set([
  "hello", "hi", "hey", "thanks", "thank you", "ok", "okay", "yes", "no",
  "please", "sure", "alright", "got it", "sounds good", "nice", "cool",
  "what", "how", "when", "where", "who", "why",
  "hello world", "test", "testing", "lol", "haha", "hmm",
  "great", "perfect", "awesome", "wow", "oh", "um",
]);

/**
 * Analyze a Chat message and determine if it contains useful memory-worthy information.
 * Works for both user and assistant messages.
 */
export function analyzeForMemory(
  messageText: string,
  conversationId: string,
  existingMemories: ChatMemory[]
): ChatMemory | null {
  const text = messageText.trim();

  // Skip very short messages
  if (text.length < 15) return null;

  // Skip messages that are just simple exchanges
  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/);
  if (words.length < 4) return null;

  // Check for excluded trivial patterns
  const cleanedText = lowerText.replace(/[^\w\s]/g, "").trim();
  if (TRIVIAL_PATTERNS.has(cleanedText)) return null;
  if (TRIVIAL_PATTERNS.has(cleanedText.split(/\s+/).slice(0, 3).join(" "))) return null;

  // Never store secrets
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return null;
  }

  // Check for context patterns
  let hasContextPattern = false;
  for (const pattern of CONTEXT_PATTERNS) {
    if (pattern.test(text)) {
      hasContextPattern = true;
      break;
    }
  }

  // Check for memory keywords
  let keywordCount = 0;
  let detectedCategory: ChatMemory["category"] = "context";
  for (const word of words) {
    if (MEMORY_KEYWORDS[word]) {
      keywordCount++;
      detectedCategory = MEMORY_KEYWORDS[word];
    }
  }

  // Need either a context pattern or multiple keywords
  if (!hasContextPattern && keywordCount < 2) return null;

  // Check for high similarity with existing memories (duplicate detection)
  for (const memory of existingMemories) {
    if (memory.text.toLowerCase() === lowerText) return null;
    const memoryWords = new Set(memory.text.toLowerCase().split(/\s+/));
    const overlap = words.filter(w => memoryWords.has(w)).length;
    if (overlap > words.length * 0.7) {
      // Check if this is an UPDATE to an existing memory
      const existingIndex = existingMemories.indexOf(memory);
      if (existingIndex >= 0 && memory.sourceConversationId !== conversationId) {
        // Different conversation providing similar info — likely evolution
        // Don't create a new memory, but the existing one should remain
        return null;
      }
      // Same conversation — skip duplicate
      return null;
    }
  }

  // Calculate importance (0-1)
  const importance = Math.min(1,
    (keywordCount * 0.15) +
    (hasContextPattern ? 0.3 : 0) +
    Math.min(0.4, text.length / 300) +
    (words.length > 10 ? 0.1 : 0)
  );

  // Calculate confidence (0-1)
  const confidence = Math.min(1,
    (keywordCount * 0.2) +
    (hasContextPattern ? 0.4 : 0) +
    (text.length > 50 ? 0.2 : 0.1)
  );

  // Create a concise summary (first meaningful sentence or first 200 chars)
  const summaryText = createMemorySummary(text);

  return {
    id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: summaryText,
    category: detectedCategory,
    sourceConversationId: conversationId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    importance: Math.round(importance * 10) / 10,
    confidence: Math.round(confidence * 10) / 10
  };
}

/**
 * Create a concise summary from a longer text for memory storage.
 */
function createMemorySummary(text: string): string {
  // Take the first sentence if it's reasonable
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 0 && sentences[0].trim().length <= 300) {
    return sentences[0].trim() + ".";
  }
  // Fall back to first 250 chars
  return text.slice(0, 250).trim() + (text.length > 250 ? "…" : "");
}

/**
 * Find memories relevant to a new Chat message.
 * Uses keyword matching and scores by relevance + importance.
 */
export function findRelevantMemories(
  messageText: string,
  memories: ChatMemory[],
  maxResults: number = 5
): ChatMemory[] {
  if (memories.length === 0) return [];

  const messageWords = messageText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (messageWords.length === 0) return [];

  const messageWordSet = new Set(messageWords);

  // Score each memory by word overlap + importance
  const scored = memories.map(memory => {
    const memoryWords = new Set(memory.text.toLowerCase().split(/\s+/));
    const overlap = messageWords.filter(w => memoryWords.has(w)).length;
    const keywordScore = messageWords.length > 0 ? overlap / messageWords.length : 0;

    // Check for category relevance
    const categoryBoost = memoryWords.has(messageText.toLowerCase().split(/\s+/)[0]) ? 0.1 : 0;

    const score = keywordScore * 0.6 + (memory.importance ?? 0.5) * 0.3 + categoryBoost;
    return { memory, score };
  });

  return scored
    .filter(s => s.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.memory);
}

/**
 * Check if an existing memory should be updated/merged with new information.
 * Returns the memory to update, or null if no update needed.
 */
export function findMemoryToUpdate(
  newMemory: ChatMemory,
  existingMemories: ChatMemory[]
): ChatMemory | null {
  for (const existing of existingMemories) {
    // Same category and high word overlap → potential update
    if (existing.category === newMemory.category) {
      const existingWords = new Set(existing.text.toLowerCase().split(/\s+/));
      const newWords = newMemory.text.toLowerCase().split(/\s+/);
      const overlap = newWords.filter(w => existingWords.has(w)).length;

      if (overlap > newWords.length * 0.5) {
        // Similar enough to consider updating
        return existing;
      }
    }
  }
  return null;
}

/**
 * Merge two memories — keep the newer one's text but update metadata.
 */
export function mergeMemory(
  existing: ChatMemory,
  newMemory: ChatMemory
): ChatMemory {
  return {
    ...existing,
    // Keep the newer text (more recent information)
    text: newMemory.text.length > existing.text.length ? newMemory.text : existing.text,
    updatedAt: Date.now(),
    importance: Math.max(existing.importance ?? 0.5, newMemory.importance ?? 0.5),
    confidence: Math.min(1, ((existing.confidence ?? 0.5) + (newMemory.confidence ?? 0.5)) / 2 + 0.1)
  };
}
