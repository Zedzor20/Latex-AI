import type { Attachment, GeminiModel, ProviderError } from "../shared/types.js";
import { imageGenerationCapability, thinkingCapability } from "../shared/modelCapabilities.js";
import { classifyHttpStatus } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import { attachmentBlock, filesOf, imagesOf, logVision, normalizeImageAttachment } from "../shared/vision.js";

export interface AIProvider {
  testConnection(): Promise<void>;
  listModels(forceRefresh?: boolean): Promise<GeminiModel[]>;
  generate(input: GeminiGenerateInput): AsyncGenerator<GeminiChunk>;
}

export interface GeminiGenerateInput {
  model: string;
  system: string;
  /**
   * Transcript messages. `attachments` carries the images persisted in a
   * message's meta so VISION CONTEXT IS REPLAYED on follow-up prompts —
   * not just the current turn's fresh attachments.
   */
  messages: { role: "user" | "model"; parts: Array<{ text: string }>; attachments?: Attachment[] }[];
  attachments?: Attachment[];
  tools?: unknown[];
  temperature: number;
  maxOutputTokens: number;
  /**
   * Whether the caller wants provider-side thinking.
   *
   * `undefined` → the model's real capability decides (default ON when the
   * provider API exposes reasoning). An explicit `false` is a user choice and
   * suppresses the reasoning-control parameter (Gemini `includeThoughts`).
   * Only providers that require a control parameter read this.
   */
  thinking?: boolean;
  /** Optional abort signal to cancel the generation mid-stream. */
  signal?: AbortSignal;
  /**
   * What the user is asking for: a text answer, or an image.
   *
   * OmniRoute serves those on two DIFFERENT endpoints and rejects an
   * image-generation model posted to `/v1/chat/completions`, so a provider that
   * can do both must be told which one this turn is. `undefined` means chat,
   * which keeps every existing caller's behaviour unchanged.
   */
  intent?: import("../shared/imageRouting.js").RequestIntent;
}

export type GeminiChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Real generated image data returned inline by an image-output model. */
  | { type: "image"; mimeType: string; data: string }
  | { type: "functionCall"; name: string; args: Record<string, unknown> };

/** Model name tokens that do not serve Latex's text/agent conversation. */
const NON_CHAT_TOKENS = [
  "embedding",
  "tts",
  "imagen",
  "veo",
  "video",
  "audio",
  "music",
  "live",
  "dragonfish",
  "flash-lite-preview"
];

/** Cache discovered models per API key so startup doesn't re-query every time. */
const modelCache = new Map<string, { list: GeminiModel[]; at: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Normalize a model id: strip a double prefix, ensure exactly one models/ prefix. */
export function normalizeModelId(model: string): string {
  let id = model.trim();
  id = id.replace(/^models\/models\//, "models/");
  if (!id.startsWith("models/")) id = `models/${id}`;
  return id;
}

export class GeminiProvider implements AIProvider {
  constructor(private readonly apiKey: string) {}

  async testConnection(): Promise<void> {
    const models = await this.listModels(true);
    if (models.length === 0) throw new Error("No Gemini models were returned for this API key.");
  }

  async listModels(forceRefresh = false): Promise<GeminiModel[]> {
    const cached = modelCache.get(this.apiKey);
    if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.list;
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`);
    if (!res.ok) throw new Error(await geminiError(res, "Gemini model discovery failed."));
    const data = (await res.json()) as { models?: GeminiModel[] };
    const models = (data.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .filter((model) => !NON_CHAT_TOKENS.some((token) => model.name.toLowerCase().includes(token)))
      .filter((model) => {
        // Filter out old Gemini models — keep only Gemini 2.5+ and Gemini 3+
        const name = model.name.toLowerCase();
        const display = (model.displayName ?? "").toLowerCase();
        const combined = name + " " + display;
        // Filter out Gemini 1.x models (e.g. gemini-1.5-pro, gemini-1.0-pro)
        if (/gemini-1\./i.test(combined)) return false;
        // Filter out Gemini 2.0 models (keep 2.5+)
        if (/gemini-2\.0/i.test(combined) || /gemini\s+2\.0/i.test(combined)) return false;
        // Filter out experimental preview models older than 2.5
        if (/gemini-2\.[0-4]/i.test(combined)) return false;
        return true;
      });
    modelCache.set(this.apiKey, { list: models, at: Date.now() });
    return models;
  }

  async *generate(input: GeminiGenerateInput): AsyncGenerator<GeminiChunk> {
    const model = normalizeModelId(input.model);
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    // ── Vision pipeline ─────────────────────────────────────────────────
    // 1) Replay images persisted in each message's meta (follow-up prompts
    //    keep their image context). 2) Attach this turn's fresh attachments
    //    to the last user message — but never duplicate images the message
    //    already carries. Every image is normalized (raw base64 + MIME).
    let visionImages = 0;
    let visionBytes = 0;
    const contents = input.messages.map((message) => {
      const parts: ContentPart[] = message.parts.map((part) => ({ text: part.text }));
      for (const att of imagesOf(message.attachments)) {
        const norm = normalizeImageAttachment(att);
        if (norm) {
          parts.push({ inlineData: { mimeType: norm.mimeType, data: norm.base64 } });
          visionImages += 1;
          visionBytes += norm.bytes;
        }
      }
      // Replay persisted FILE content — the visible message stays compact
      // (content lives only in meta), so the request layer re-injects it here.
      for (const att of filesOf(message.attachments)) {
        parts.push({ text: attachmentBlock(att) });
      }
      return { role: message.role, parts };
    });
    const attachments = input.attachments?.filter((a) => a.kind === "image" || a.kind === "text");
    const lastIndex = contents.length - 1;
    const lastSource = input.messages[lastIndex];
    const lastAlreadyHasImages = imagesOf(lastSource?.attachments).length > 0;
    // File attachments already replayed from the last message's meta — never send twice.
    const carriedFileNames = new Set(filesOf(lastSource?.attachments).map((a) => a.name));
    if (attachments?.length && !lastAlreadyHasImages) {
      const last = contents[lastIndex];
      if (last && last.role === "user") {
        for (const att of attachments) {
          if (att.kind === "image") {
            const norm = normalizeImageAttachment(att);
            if (!norm) {
              throw classifyHttpStatus("gemini", input.model, 400, `Image "${att.name ?? "attachment"}" could not be prepared for the model (invalid image data). The image was NOT sent as text instead.`);
            }
            last.parts.push({ inlineData: { mimeType: norm.mimeType, data: norm.base64 } });
            visionImages += 1;
            visionBytes += norm.bytes;
          } else if (att.content && !carriedFileNames.has(att.name)) {
            const truncated = att.truncated ? `\n\n_(This file was truncated; showing the first ${att.content.length} characters.)_` : "";
            last.parts.push({ text: `\n\n[Attachment: ${att.name}]${truncated}\n${att.content}` });
          }
        }
      }
    }
    logVision("gemini", visionImages, visionBytes, contents.length);

    // ── Image output (only for models the provider really serves images for) ──
    // Image-capable Gemini models return generated image data as inline parts
    // instead of prose, but ONLY when IMAGE is among the requested response
    // modalities. Text-only models must never receive this block.
    const imageOutput = imageGenerationCapability("gemini", input.model).supportsImageGeneration;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents,
        tools: input.tools,
        generationConfig: {
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
          ...(imageOutput ? { responseModalities: ["TEXT", "IMAGE"] } : {}),
          // ── Provider-exposed thinking (only when the MODEL supports it) ──
          // Gemini returns human-readable thought summaries as parts flagged
          // `thought: true`, but ONLY when includeThoughts is enabled. Models
          // without thinking (1.x/2.0, imagen, embedding, …) must never receive
          // this block — they reject it, which would break normal requests.
          ...((input.thinking ?? thinkingCapability("gemini", input.model).supportsThinking)
            ? { thinkingConfig: { includeThoughts: true } }
            : {})
        }
      }),
      signal: input.signal
    });
    if (!res.ok || !res.body) {
      const msg = await geminiError(res, "Gemini request failed.");
      throw classifyHttpStatus("gemini", input.model, res.status, msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Gemini can use either LF or CRLF event separators; handle both.
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.split(/\r?\n/).find((part) => part.startsWith("data: "));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          // Detect Gemini stream-level errors (e.g. safety block, quota exhaustion mid-stream)
          if (payload.error) {
            const errMsg = safeExtractMessage(payload.error);
            const errStatus = payload.error?.status ?? payload.error?.code ?? 500;
            throw classifyHttpStatus("gemini", input.model, typeof errStatus === "number" ? errStatus : 500, errMsg || "Gemini stream error");
          }
          if (payload.promptFeedback?.blockReason) {
            throw classifyHttpStatus("gemini", input.model, 400, `Blocked by Gemini: ${String(payload.promptFeedback.blockReason)}`);
          }
          // Detect safety/finish-reason blocks that indicate the response was blocked
          const candidate = payload.candidates?.[0];
          if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "RECITATION") {
            throw classifyHttpStatus("gemini", input.model, 400, `Gemini response blocked: ${String(candidate.finishReason)}`);
          }
          for (const part of candidate?.content?.parts ?? []) {
            if (part.text) {
              // Defensive: ensure text is always a string to prevent [object Object].
              const rawText = part.text;
              const text = typeof rawText === "string" ? rawText
                : rawText != null && typeof rawText === "object" ? safeExtractMessage(rawText) || ""
                : String(rawText ?? "");
              if (text) {
                // ── Thinking vs answer channel ─────────────────────────────
                // A thought summary is the model's OWN reasoning summary, and
                // it belongs in the Thinking box — never in the assistant text
                // and never in the execution timeline. The two streams are
                // tagged here so the renderer can keep them separate.
                if (part.thought === true) yield { type: "reasoning", text };
                else yield { type: "text", text };
              }
            }
            // ── Real image output ─────────────────────────────────────
            // Generated image data arrives as an inline part. It is handed to
            // the agent on its own channel so it can NEVER be mixed into the
            // assistant text or the activity timeline. No image part → no event.
            const inline = part.inlineData;
            if (inline?.data && typeof inline.data === "string") {
              yield {
                type: "image",
                mimeType: inline.mimeType && typeof inline.mimeType === "string" ? inline.mimeType : "image/png",
                data: inline.data
              };
            }
            if (part.functionCall) yield { type: "functionCall", name: part.functionCall.name, args: part.functionCall.args ?? {} };
          }
        }
      }
    } catch (err) {
      // If it's already a ProviderError, re-throw as-is
      if (err && typeof err === "object" && "errorType" in err) throw err;
      // Network / abort errors during streaming
      if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
        throw classifyHttpStatus("gemini", input.model, 0, "Request aborted.");
      }
      // Extract a safe human-readable message from any thrown value.
      // NEVER use String(err) — it produces [object Object] for non-primitives.
      const streamErrorMsg = err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : safeExtractMessage(err) || "unknown stream error";
      throw classifyHttpStatus("gemini", input.model, 500, `Stream error: ${streamErrorMsg}`);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

type ContentPart = {
  text?: string;
  /** Input image (image editing) OR generated image output, per Gemini. */
  inlineData?: { mimeType: string; data: string };
  /** Gemini thought summary part (reasoning exposed by the API). */
  thought?: boolean;
};

async function geminiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown; message?: unknown };
    // CRITICAL: use safeExtractMessage to handle ANY error shape from the API.
    // Gemini can return {error: {message: "..."}}, {error: "string"}, nested objects, etc.
    // NEVER use String() on an object — it produces [object Object].
    const msg = safeExtractMessage(data.error ?? data);
    return msg ? `${fallback} ${msg}` : fallback;
  } catch {
    return `${fallback} HTTP ${res.status}`;
  }
}
