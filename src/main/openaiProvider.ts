import type { Attachment, GeminiModel, ModelProvider, ProviderError } from "../shared/types.js";
import { classifyHttpStatus, classifyNetworkError } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import type { AIProvider, GeminiChunk, GeminiGenerateInput } from "./geminiProvider.js";

/** OpenAI-compatible endpoints. */
const ENDPOINTS: Record<ModelProvider, { base: string; label: string }> = {
  gemini: { base: "", label: "Gemini" },
  openrouter: { base: "https://openrouter.ai/api/v1", label: "OpenRouter" },
  minimax: { base: "https://api.minimax.io/v1", label: "MiniMax" },
  groq: { base: "https://api.groq.com/openai/v1", label: "Groq" },
  puter: { base: "", label: "Puter" }
};

const DEFAULT_MAX_TOKENS = 8192;

/** Gemini schema types are uppercase; OpenAI expects JSON Schema lowercase. */
function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === "type" && typeof val === "string") {
      out[key] = val.toLowerCase();
      continue;
    }
    out[key] = normalizeSchema(val);
  }
  return out;
}

/**
 * Convert Latex's tool declarations to OpenAI function tools.
 *
 * The agent passes Gemini-format declarations:
 *   [{ functionDeclarations: [{ name, description, parameters }, ...] }]
 * This flattening is what makes native function calling actually work for
 * OpenRouter / MiniMax / Groq. (OpenAI-shaped { function: {...} } entries are
 * also accepted defensively.)
 */
export function toolsToOpenAi(tools: unknown[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools) return undefined;
  const flat: Array<{ name?: string; description?: string; parameters?: unknown }> = [];
  for (const wrapper of tools) {
    const w = wrapper as {
      functionDeclarations?: Array<{ name?: string; description?: string; parameters?: unknown }>;
      function?: { name?: string; description?: string; parameters?: unknown };
      name?: string;
    };
    if (Array.isArray(w.functionDeclarations)) flat.push(...w.functionDeclarations);
    else if (w.function) flat.push(w.function);
    else if (typeof w.name === "string") flat.push(w);
  }
  return flat.map((t) => ({
    type: "function",
    function: {
      name: t.name ?? "",
      description: t.description ?? "",
      parameters: (normalizeSchema(t.parameters) as Record<string, unknown>) ?? { type: "object", properties: {} }
    }
  }));
}

/** Normalize a model id for the provider API: strip Latex prefixes. */
function normalizeModelId(id: string): string {
  return id
    .trim()
    .replace(/^models\//, "")
    .replace(/^gemini\//, "")
    .replace(/^openrouter\//, "")
    .replace(/^minimax\//, "")
    .replace(/^groq\//, "");
}

/** Keyword-based capability detection — used when the provider exposes no metadata. */
export function inferCapabilities(model: GeminiModel): { supportsTools?: boolean; supportsVision?: boolean; supportsReasoning?: boolean; isFree?: boolean } {
  const name = model.name.toLowerCase();
  const desc = `${model.description ?? ""} ${model.displayName ?? ""}`.toLowerCase();
  const combined = `${name} ${desc}`;

  // Vision: model or description mentions vision/multimodal/image
  const supportsVision = /vision|multimodal|image/.test(combined);

  // Reasoning: chain-of-thought / reasoning models
  const supportsReasoning = /reason|think|thinking|deepseek.r1|deepseek.reasoner/.test(combined);

  // Tool calling: explicitly excluded non-chat models first, then check for
  // instruction-tuned / chat / general-purpose model indicators.
  const excluded = /embedding|rerank|moderation|whisper|tts|audio|speech|dall.e|flux|stable|transcri|translate|summarize|embed|compress/.test(combined);
  if (excluded) return { supportsTools: false, supportsVision, supportsReasoning, isFree: false };

  // Models that are clearly chat/instruction-tuned support tools
  const chatIndicator = /instruct|chat|code|coder|assistant|helper|agent/.test(combined);
  // Versioned models (v2, v3, 3.5, 2.5-flash, etc.) are typically chat models
  const versioned = /\bv?\d+\.?\d*|\d+[a-z]*\b/.test(name);
  // Provider-specific known tool-capable families
  const knownToolCapable = /qwen|llama|mistral|codestral|nemotron|gemma|phi|deepseek|glm|claude|anthropic|gpt|o1|o3|o4/.test(name);

  const supportsTools = chatIndicator || versioned || knownToolCapable;

  // Free: only from explicit pricing metadata (caller sets this)
  return { supportsTools, supportsVision, supportsReasoning, isFree: false };
}

export class OpenAiCompatibleProvider implements AIProvider {
  constructor(
    private readonly provider: ModelProvider,
    private readonly apiKey: string,
    private readonly baseUrl?: string
  ) {}

  private endpoint(): string {
    return this.baseUrl ?? ENDPOINTS[this.provider].base;
  }

  private displayName(id: string): string {
    const parts = id.replace(/^models\//, "").split("/");
    const last = parts[parts.length - 1];
    return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async testConnection(): Promise<void> {
    const models = await this.listModels(true);
    if (models.length === 0) throw new Error(`No ${ENDPOINTS[this.provider].label} models were returned for this API key.`);
  }

  async listModels(forceRefresh = false): Promise<GeminiModel[]> {
    const models = await fetchModelsFromProvider(this.provider, this.apiKey, this.baseUrl, forceRefresh);
    return models;
  }

  async *generate(input: GeminiGenerateInput): AsyncGenerator<GeminiChunk> {
    const url = `${this.endpoint()}/chat/completions`;
    const messages = input.messages.map((message) => ({
      role: message.role === "model" ? "assistant" : "user",
      content: message.parts.map((part) => part.text).join("")
    }));
    const attachments = input.attachments?.filter((a) => a.kind === "text" || a.kind === "image");
    if (attachments?.length) {
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        const blocks: string[] = [];
        for (const att of attachments) {
          if (att.kind === "image" && att.base64 && att.mimeType) {
            blocks.push(`\n\n[Image attachment: ${att.name}]\n`);
          } else if (att.content) {
            blocks.push(`\n\n[Attachment: ${att.name}]\n${att.content}`);
          }
        }
        last.content += blocks.join("");
      }
    }

    const body: Record<string, unknown> = {
      model: normalizeModelId(input.model),
      messages: [{ role: "system", content: input.system }, ...messages],
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens || DEFAULT_MAX_TOKENS,
      stream: true
    };
    const openAiTools = toolsToOpenAi(input.tools);
    if (openAiTools && openAiTools.length > 0) body.tools = openAiTools;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.provider === "openrouter" ? { "HTTP-Referer": "https://latex.local", "X-Title": "Latex" } : {})
    };
    const modelId = normalizeModelId(input.model);
    const doFetch = (): Promise<Response> => fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: input.signal });

    let res: Response;
    try {
      res = await doFetch();
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
        throw classifyHttpStatus(this.provider, modelId, 0, "Request aborted.");
      }
      // Safely extract message from any thrown value (prevents [object Object])
      const netMsg = err instanceof Error ? err.message : typeof err === "string" ? err : safeExtractMessage(err) || "Network error";
      throw classifyNetworkError(this.provider, modelId, new Error(netMsg));
    }
    if (!res.ok) {
      const message = await providerError(res, this.provider);
      // Some models reject the tools parameter outright. Retry once without tools.
      if (openAiTools && openAiTools.length > 0 && /unsupported|not supported|does not (support|allow|accept)|unexpected|400|invalid|unknown (parameter|field|argument)/i.test(message)) {
        delete body.tools;
        const retryRes = await doFetch().catch((err) => {
          throw classifyNetworkError(this.provider, modelId, err instanceof Error ? err : new Error(typeof err === "string" ? err : "Network error"));
        });
        if (retryRes.ok) {
          res = retryRes;
        } else {
          const retryMsg = await providerError(retryRes, this.provider);
          throw classifyHttpStatus(this.provider, modelId, retryRes.status, retryMsg);
        }
      } else {
        throw classifyHttpStatus(this.provider, modelId, res.status, message);
      }
    }

    if (!res.body) {
      throw classifyHttpStatus(this.provider, modelId, res.status || 500, "No response body from provider.");
    }

    // ── SSE streaming ─────────────────────────────────────────────────────
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Accumulate tool call arguments across streaming chunks
    const toolCallAccum = new Map<number, { id: string; name: string; argsJson: string }>();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on double-newline (SSE event separator)
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const lines = event.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(line.charAt(5) === " " ? 6 : 5).trim();
            if (payload === "[DONE]") return;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // skip malformed JSON
            }
            // Detect in-stream error payloads from OpenAI-compatible providers
            if (parsed.error) {
              const errObj = parsed.error as Record<string, unknown>;
              const errMsg = safeExtractMessage(errObj);
              const errStatus = errObj.status ?? errObj.code;
              throw classifyHttpStatus(this.provider, modelId, typeof errStatus === "number" ? errStatus : 500, errMsg || "Provider stream error");
            }
            const choice = (parsed.choices as any[])?.[0];
            if (!choice) continue;
            // Detect finish reasons that indicate an error
            if (choice.finish_reason === "content_filter" || choice.finish_reason === "error") {
              const reason = choice.finish_reason;
              const filterMsg = choice.content_filter_results ? safeExtractMessage(choice.content_filter_results) : reason;
              throw classifyHttpStatus(this.provider, modelId, 400, `Response blocked by provider: ${filterMsg}`);
            }
            const delta = choice.delta ?? choice.message;
            if (!delta) continue;
            // ── Text content ──
            const content = delta.content;
            if (typeof content === "string" && content) {
              yield { type: "text", text: content };
            } else if (Array.isArray(content)) {
              for (const part of content) {
                const t = typeof part === "string" ? part : part?.text;
                if (t) yield { type: "text", text: t };
              }
            }
            // ── Tool calls (streamed incrementally) ──
            const toolCalls = delta.tool_calls as Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }> | undefined;
            if (toolCalls) {
              for (const tc of toolCalls) {
                const idx = tc.index ?? 0;
                const existing = toolCallAccum.get(idx);
                if (existing) {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
                } else {
                  toolCallAccum.set(idx, {
                    id: tc.id ?? `call_${idx}`,
                    name: tc.function?.name ?? "",
                    argsJson: tc.function?.arguments ?? ""
                  });
                }
              }
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    // ── Yield accumulated tool calls (if any) ──
    if (toolCallAccum.size > 0) {
      for (const [, tc] of toolCallAccum) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.argsJson ? JSON.parse(tc.argsJson) : {};
        } catch {
          args = { raw: tc.argsJson };
        }
        yield { type: "functionCall", name: tc.name, args };
      }
    }
  }
}

/** Model list cache per provider. */
const modelListCache = new Map<string, { list: GeminiModel[]; at: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchModelsFromProvider(provider: ModelProvider, apiKey: string, baseUrl: string | undefined, forceRefresh: boolean): Promise<GeminiModel[]> {
  const cacheKey = `${provider}:${apiKey.slice(-6)}`;
  const cached = modelListCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.list;

  const url = `${baseUrl ?? ENDPOINTS[provider].base}/models`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(await providerError(res, provider));
  const data = (await res.json()) as { data?: unknown[] };

  const models: GeminiModel[] = [];
  for (const raw of data.data ?? []) {
    const entry = raw as Record<string, unknown>;
    const id = String(entry.id ?? entry.name ?? "");
    if (!id) continue;
    const model: GeminiModel = {
      name: id,
      provider,
      displayName: String(entry.display_name ?? entry.displayName ?? "") || undefined,
      description: String(entry.description ?? "") || undefined
    };
    if (typeof entry.context_length === "number") {
      model.contextLength = entry.context_length;
      model.inputTokenLimit = entry.context_length;
    }
    if (typeof entry.max_tokens === "number") model.outputTokenLimit = entry.max_tokens;
    // OpenRouter pricing: both zero ⇒ free.
    const pricing = entry.pricing as Record<string, unknown> | undefined;
    if (pricing) {
      const prompt = Number(pricing.prompt ?? 0);
      const completion = Number(pricing.completion ?? 0);
      if (prompt === 0 && completion === 0) model.isFree = true;
    }
    const inferred = inferCapabilities(model);
    model.supportsTools = inferred.supportsTools;
    model.supportsVision = inferred.supportsVision;
    model.supportsReasoning = inferred.supportsReasoning;
    model.supportsStreaming = true;
    if (model.isFree === undefined) model.isFree = inferred.isFree;
    const caps: string[] = [];
    if (model.supportsTools) caps.push("tool-calling");
    if (model.supportsVision) caps.push("vision");
    if (model.supportsReasoning) caps.push("reasoning");
    if ((model.contextLength ?? 0) >= 200_000) caps.push("long-context");
    if (model.isFree) caps.push("free");
    model.capabilities = caps;
    if (!model.displayName) model.displayName = thisDisplayName(provider, id);
    models.push(model);
  }

  modelListCache.set(cacheKey, { list: models, at: Date.now() });
  return models;
}

function thisDisplayName(provider: ModelProvider, id: string): string {
  // OpenRouter ids look like org/model — show just the model part.
  const raw = id.replace(/^models\//, "");
  const base = raw.split("/").pop() ?? raw;
  return base
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function providerError(res: Response, provider: ModelProvider): Promise<string> {
  let detail = "";
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    // CRITICAL: use safeExtractMessage to handle ANY error shape from the API.
    // Providers return wildly different structures: {error: {message: "..."}},
    // {error: "string"}, {message: "string"}, nested objects, etc.
    // NEVER use String() on an object — it produces [object Object].
    detail = safeExtractMessage(data.error ?? data);
  } catch {
    // fall through to status text
  }
  const label = ENDPOINTS[provider].label;
  const base = `${label} request failed (HTTP ${res.status}).`;
  if (/429|quota|rate limit|insufficient_quota/.test(`${detail} ${res.status}`)) {
    return `${base} Rate limit or quota exceeded${detail ? ` — ${detail}` : ""}.`;
  }
  if (/402|insufficient.*(credit|balance)|payment|billing/.test(`${detail} ${res.status}`)) {
    return `${base} Insufficient credits or payment required${detail ? ` — ${detail}` : ""}.`;
  }
  if (/invalid.*api key|unauthorized|401/.test(`${detail} ${res.status}`)) {
    return `${base} The API key is invalid or lacks access.`;
  }
  if (/403|forbidden|permission|guardrail/.test(`${detail} ${res.status}`)) {
    return `${base} Permission denied or model restricted${detail ? ` — ${detail}` : ""}.`;
  }
  if (/404|not found|model.*(not|unavailable)/.test(`${detail} ${res.status}`)) {
    return `${base} Model not found or unavailable${detail ? ` — ${detail}` : ""}.`;
  }
  return detail ? `${base} ${detail}` : base;
}
