import type { Attachment, GeminiModel, ModelProvider, ProviderError } from "../shared/types.js";
import { imageGenerationCapability, thinkingCapabilityOfModel } from "../shared/modelCapabilities.js";
import { classifyHttpStatus, classifyNetworkError } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import { attachmentBlock, filesOf, imageBytes, imageDataUrl, imagesOf, logVision } from "../shared/vision.js";
import type { AIProvider, GeminiChunk, GeminiGenerateInput } from "./geminiProvider.js";

/** OpenAI-compatible endpoints. */
const ENDPOINTS: Record<ModelProvider, { base: string; label: string }> = {
  gemini: { base: "", label: "Gemini" },
  openrouter: { base: "https://openrouter.ai/api/v1", label: "OpenRouter" },
  minimax: { base: "https://api.minimax.io/v1", label: "MiniMax" },
  groq: { base: "https://api.groq.com/openai/v1", label: "Groq" },
  puter: { base: "", label: "Puter" },
  ollama: { base: "http://localhost:11434/v1", label: "Ollama" },
  omniroute: { base: "http://localhost:20128/v1", label: "OmniRoute" }
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

/** Parse a `data:<mime>;base64,<payload>` URL into provider image data. */
function dataUrlToImage(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(url);
  if (!match) return null;
  const mimeType = (match[1] || "image/png").trim().toLowerCase();
  const base64 = (match[3] || "").replace(/\s+/g, "");
  if (!base64) return null;
  return { mimeType, data: base64 };
}

/**
 * Fetch a provider-hosted generated image and return it as base64. Bounded in
 * size, and it only ever accepts an `image/*` content type — a model response
 * can never point Latex at arbitrary non-image content.
 */
async function fetchImageAsBase64(url: string, signal?: AbortSignal): Promise<{ mimeType: string; data: string } | null> {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  try {
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") || "image/png").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return { mimeType, data: buf.toString("base64") };
  } catch {
    return null;
  }
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

  // Reasoning: shared, provider-aware capability (one source of truth). A name
  // containing "reason"/"think" is NOT enough — the capability module checks
  // that this provider/endpoint really exposes reasoning text to the adapter.
  const supportsReasoning = thinkingCapabilityOfModel(model).supportsThinking;

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
    // ── Vision pipeline ─────────────────────────────────────────────────
    // 1) Replay images persisted per message (follow-ups keep image context).
    // 2) Fresh attachments go on the last user message — never duplicated.
    let visionImages = 0;
    let visionBytes = 0;
    input.messages.forEach((source, index) => {
      const imgs = imagesOf(source.attachments);
      const fileParts = filesOf(source.attachments);
      if (imgs.length === 0 && fileParts.length === 0) return;
      const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      const existing = source.parts.map((part) => part.text).join("");
      if (existing.trim()) contentParts.push({ type: "text", text: existing });
      // Replay persisted FILE content — visible messages stay compact (file
      // text lives only in meta), so the request layer re-injects it here.
      if (fileParts.length > 0) contentParts.push({ type: "text", text: fileParts.map(attachmentBlock).join("") });
      for (const att of imgs) {
        const url = imageDataUrl(att);
        if (!url) {
          throw classifyHttpStatus(this.provider, input.model, 400, `Image "${att.name ?? "attachment"}" could not be prepared for the model (invalid image data). The image was NOT sent as text instead.`);
        }
        contentParts.push({ type: "image_url", image_url: { url } });
        visionImages += 1;
        visionBytes += imageBytes([att]);
      }
      (messages[index] as Record<string, unknown>).content = contentParts;
    });
    const attachments = input.attachments?.filter((a) => a.kind === "text" || a.kind === "image");
    const lastIndex = messages.length - 1;
    const lastSource = input.messages[lastIndex];
    const lastAlreadyHasImages = imagesOf(lastSource?.attachments).length > 0;
    // File attachments already replayed from the last message's meta — never send twice.
    const carriedFileNames = new Set(filesOf(lastSource?.attachments).map((a) => a.name));
    if (attachments?.length && !lastAlreadyHasImages) {
      const last = messages[lastIndex];
      if (last && last.role === "user") {
        // Check if any image attachments exist — if so, convert to content array format
        const hasImages = attachments.some((a) => a.kind === "image" && a.base64);
        if (hasImages) {
          // OpenAI vision format: content array with text and image_url parts
          const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
          // Keep existing text as first part
          if (typeof last.content === "string" && last.content.trim()) {
            contentParts.push({ type: "text", text: last.content });
          }
          for (const att of attachments) {
            if (att.kind === "image") {
              const url = imageDataUrl(att);
              if (!url) {
                throw classifyHttpStatus(this.provider, input.model, 400, `Image "${att.name ?? "attachment"}" could not be prepared for the model (invalid image data). The image was NOT sent as text instead.`);
              }
              contentParts.push({ type: "image_url", image_url: { url } });
              visionImages += 1;
              visionBytes += imageBytes([att]);
            } else if (att.content && !carriedFileNames.has(att.name)) {
              contentParts.push({ type: "text", text: `\n[Attachment: ${att.name}]\n${att.content}` });
            }
          }
          (last as Record<string, unknown>).content = contentParts;
        } else {
          // Text-only attachments — append as string
          for (const att of attachments) {
            if (att.content && !carriedFileNames.has(att.name)) {
              last.content += `\n\n[Attachment: ${att.name}]\n${att.content}`;
            }
          }
        }
      }
    }
    logVision(this.provider, visionImages, visionBytes, messages.length);

    const body: Record<string, unknown> = {
      model: normalizeModelId(input.model),
      messages: [{ role: "system", content: input.system }, ...messages],
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens || DEFAULT_MAX_TOKENS,
      stream: true
    };
    // Image output is REQUESTED only for a model whose capability says the
    // provider returns generated image data — a normal text turn never carries
    // `modalities`, so text-only models (and providers that reject the field)
    // are completely unaffected.
    if (imageGenerationCapability(this.provider, input.model).supportsImageGeneration) {
      body.modalities = ["text", "image"];
    }
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
    // `[DONE]` ends the STREAM, not the generator: returning here used to skip
    // the "yield accumulated tool calls" step below, so every native function
    // call from an OpenAI-compatible provider (OpenRouter, Groq, MiniMax, …)
    // was silently discarded and the agent appeared to do nothing at all.
    let streamEnded = false;
    try {
      while (!streamEnded) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on double-newline (SSE event separator)
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (streamEnded) break;
          const lines = event.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(line.charAt(5) === " " ? 6 : 5).trim();
            if (payload === "[DONE]") {
              streamEnded = true;
              break;
            }
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
            // ── Reasoning / thinking content ──
            // OpenAI-compatible providers surface reasoning under different
            // fields: `reasoning_content` (DeepSeek/Groq/OmniRoute), `reasoning`
            // (OpenRouter), and `reasoning_details` (MiniMax M2, an array of
            // typed parts). All are normalized to one reasoning channel.
            const reasoning = (delta as Record<string, unknown>).reasoning_content
              ?? (delta as Record<string, unknown>).reasoning
              ?? (delta as Record<string, unknown>).reasoning_details;
            if (typeof reasoning === "string" && reasoning) {
              yield { type: "reasoning", text: reasoning };
            } else if (Array.isArray(reasoning)) {
              for (const part of reasoning) {
                if (!part) continue;
                const type = typeof part === "object" ? String((part as { type?: unknown }).type ?? "") : "";
                // Only reasoning text parts — never echo a non-reasoning detail.
                if (type && !/reason/i.test(type)) continue;
                const text = typeof part === "string" ? part : (part as { text?: unknown }).text;
                if (typeof text === "string" && text) yield { type: "reasoning", text };
              }
            }
            // Also handle <think>...</think> blocks in text for models that embed thinking in content
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
            // ── Inline image output ──
            // Image-capable OpenAI-compatible models return the picture as an
            // inline image part (or an `images` array). It is handed to the
            // agent on its own channel — never as text, never as a tool call.
            // No image part → no event.
            const imageUrls: string[] = [];
            if (Array.isArray(content)) {
              for (const part of content) {
                const url = (part as { image_url?: { url?: unknown } } | null)?.image_url?.url;
                if (typeof url === "string" && url) imageUrls.push(url);
              }
            }
            const imagesField = (delta as Record<string, unknown>).images;
            if (Array.isArray(imagesField)) {
              for (const img of imagesField) {
                const url = typeof img === "string"
                  ? img
                  : ((img as { image_url?: { url?: unknown } })?.image_url?.url ?? (img as { url?: unknown })?.url);
                if (typeof url === "string" && url) imageUrls.push(url);
              }
            }
            for (const imageUrl of imageUrls) {
              const parsedImage = dataUrlToImage(imageUrl)
                ?? await fetchImageAsBase64(imageUrl, input.signal).catch(() => null);
              if (parsedImage) {
                yield { type: "image", mimeType: parsedImage.mimeType, data: parsedImage.data };
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
