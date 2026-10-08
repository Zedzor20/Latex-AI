import type { Attachment, GeminiModel, ProviderError } from "../shared/types.js";
import { classifyHttpStatus, classifyNetworkError } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import { attachmentBlock, filesOf, imagesOf, logVision, normalizeImageAttachment } from "../shared/vision.js";
import type { AIProvider, GeminiChunk, GeminiGenerateInput } from "./geminiProvider.js";
import { fetchOllamaModels, isCloudModel, OLLAMA_DEFAULT_BASE } from "./ollamaService.js";
import { toolsToOpenAi } from "./openaiProvider.js";
import { compactOllamaSystemPrompt, estimateTokens, trimTranscriptForOllama } from "./ollamaPrompt.js";

/**
 * Ollama provider — serves models from the local Ollama server
 * (http://localhost:11434) using its native chat API.
 *
 * - Streaming is enabled: tokens are yielded progressively.
 * - Native tool calling is passed through for models that report the `tools`
 *   capability. If the server rejects the tools field (older servers, some
 *   models), the request is retried once WITHOUT tools so the agent's
 *   text-based tool protocol can take over (same fallback as OpenAI providers).
 * - Images are sent as base64 in the `images` array of the user message.
 * - Cloud models (`*-cloud` tags) are served exactly like local models — the
 *   model tag is passed through unchanged.
 */

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_CONTEXT_LENGTH = 32_768;

/** Model tags that cannot serve Latex conversations. */
const NON_CHAT_PATTERNS = /embedding|nomic-embed|all-minilm|bge-|clip|whisper|tts|image-gen|stable-diffusion/i;

/**
 * Dev-only performance profiler. Enable with LATEX_OLLAMA_PERF=1.
 * Logs one line per request: model, prompt tokens, timings.
 */
const PERF_ENABLED = process.env.LATEX_OLLAMA_PERF === "1";
function perfLog(requestId: string, fields: Record<string, string | number>): void {
  if (!PERF_ENABLED) return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  console.log(`[OLLAMA PERF] ${requestId} ${parts.join(" ")}`);
}

/** Parameter size of a model tag like "qwen2.5-coder:1.5b" — 0 when unknown. */
function parameterBillions(modelId: string): number {
  const m = modelId.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (m) return parseFloat(m[1]);
  // Sizes written without a unit: 0.5b, 7b, 13b are matched above; bare digits
  // after the tag separator are usually quantizations (e.g. q4_K_M) — ignore.
  return 0;
}

/**
 * Right-size num_ctx for a local model. Small models on small GPUs get small
 * contexts — a 4096+ KV cache is what makes 1–3B models slow and can crash
 * low-VRAM runners. Returns undefined for cloud models (server decides).
 */
function contextBudgetFor(modelId: string, isCloud: boolean): number {
  if (isCloud) return 0; // cloud — let Ollama decide
  const params = parameterBillions(modelId);
  if (params > 0 && params <= 3) return 2048;
  if (params > 3 && params <= 8) return 4096;
  if (params > 8) return 8192;
  return 4096; // unknown size — moderate default
}

/** Ollama keep-alive so warm models stay resident between messages. */
const KEEP_ALIVE = "10m";

export class OllamaProvider implements AIProvider {
  constructor(private readonly baseUrl: string = OLLAMA_DEFAULT_BASE) {}

  async testConnection(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw classifyHttpStatus("ollama", "", res.status, `Ollama server responded with HTTP ${res.status}.`);
  }

  async listModels(forceRefresh = false): Promise<GeminiModel[]> {
    // ListModels is cheap and dynamic — always hit the server so newly pulled
    // models appear immediately. The cache lives in the caller (ProviderFactory).
    const discovered = await fetchOllamaModels(this.baseUrl);
    return discovered.filter((d) => !NON_CHAT_PATTERNS.test(d.model.name)).map((d) => d.model);
  }

  async *generate(input: GeminiGenerateInput): AsyncGenerator<GeminiChunk> {
    const modelId = normalizeModelId(input.model);
    const isCloud = isCloudModel(modelId);
    const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const t0 = Date.now();
    // Carry per-message image attachments through transcript trimming so
    // vision context survives follow-ups (trim preserves extra fields).
    const messages = trimTranscriptForOllama(input.messages.map((message) => ({
      role: message.role === "model" ? "assistant" : "user",
      content: message.parts.map((part) => part.text).join(""),
      attachments: message.attachments as Attachment[] | undefined
    })));
    const promptTokens = estimateTokens(messages.map((m) => m.content).join(" ") + (input.system ?? ""));
    perfLog(requestId, { model: modelId, promptTokens, msgCount: messages.length, t: "start" });

    // ── Vision pipeline ─────────────────────────────────────────────────
    // 1) Replay images persisted per message → Ollama `images: [base64]`.
    // 2) Fresh attachments on the last user message (never duplicated).
    // The internal `attachments` field is stripped before the request body.
    let visionImages = 0;
    let visionBytes = 0;
    for (const m of messages) {
      const carried = m.attachments;
      delete m.attachments;
      // Replay persisted FILE content — visible messages stay compact (file
      // text lives only in meta), so the request layer re-injects it here.
      const fileParts = filesOf(carried);
      if (fileParts.length > 0) m.content += fileParts.map(attachmentBlock).join("");
      const imgs = imagesOf(carried);
      if (imgs.length === 0) continue;
      const images: string[] = [];
      for (const att of imgs) {
        const norm = normalizeImageAttachment(att);
        if (norm) {
          images.push(norm.base64);
          visionImages += 1;
          visionBytes += norm.bytes;
        }
      }
      if (images.length > 0) (m as Record<string, unknown>).images = images;
    }

    const attachments = input.attachments?.filter((a) => a.kind === "image" || a.kind === "text");
    const lastSource = input.messages[input.messages.length - 1];
    const lastAlreadyHasImages = imagesOf(lastSource?.attachments).length > 0;
    // File attachments already replayed from the last message's meta — never send twice.
    const carriedFileNames = new Set(filesOf(lastSource?.attachments).map((a) => a.name));
    if (attachments?.length) {
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        const images: string[] = [];
        const textParts: string[] = [];
        let invalidImage: string | null = null;
        for (const att of attachments) {
          if (att.kind === "image") {
            if (lastAlreadyHasImages) continue; // already replayed from this message's meta
            const norm = normalizeImageAttachment(att);
            if (!norm) { invalidImage = att.name ?? "attachment"; break; }
            images.push(norm.base64);
            visionImages += 1;
            visionBytes += norm.bytes;
          } else if (att.content && !carriedFileNames.has(att.name)) {
            textParts.push(`\n\n[Attachment: ${att.name}]\n${att.content}`);
          }
        }
        if (invalidImage) {
          throw classifyHttpStatus("ollama", input.model, 400, `Image "${invalidImage}" could not be prepared for the model (invalid image data). The image was NOT sent as text instead.`);
        }
        if (images.length > 0) (last as Record<string, unknown>).images = images;
        if (textParts.length > 0) last.content += textParts.join("\n");
      }
    }
    logVision("ollama", visionImages, visionBytes, messages.length);

    const openAiTools = toolsToOpenAi(input.tools);
    const modelCaps = await this.capabilitiesOf(modelId);

    // ── Compact system prompt for local models ──────────────────────
    // The full 9k-char agent prompt + tool protocol is far too heavy for
    // 1–8B local models (tens of seconds of prompt eval, runner crashes on
    // small GPUs). Locals get a compact prompt; cloud models get the full one.
    const compact = !isCloud && !modelCaps.fullPromptOk;
    const systemText = compact
      ? compactOllamaSystemPrompt(input.system, Boolean(openAiTools?.length))
      : input.system;

    const ctxBudget = contextBudgetFor(modelId, isCloud);
    const buildBody = (withTools: boolean): Record<string, unknown> => {
      const options: Record<string, unknown> = {
        temperature: input.temperature,
        num_predict: Math.min(input.maxOutputTokens || DEFAULT_MAX_TOKENS, 2048)
      };
      if (ctxBudget > 0) options.num_ctx = ctxBudget;
      const body: Record<string, unknown> = {
        model: modelId,
        messages: [{ role: "system", content: systemText }, ...messages],
        stream: true,
        keep_alive: KEEP_ALIVE,
        options
      };
      // Only pass native tools when the model reports tool support — avoids
      // server errors on models/servers that cannot handle the field.
      if (withTools && openAiTools && openAiTools.length > 0 && modelCaps.supportsTools) {
        body.tools = openAiTools;
      }
      return body;
    };
    perfLog(requestId, { compact: compact ? 1 : 0, ctx: ctxBudget || "server", tools: openAiTools?.length ?? 0, t: "built" });

    let res: Response;
    let usedTools = false;
    const requestSentAt = Date.now();
    try {
      res = await this.postChat(buildBody(true), input.signal);
      usedTools = Boolean(openAiTools?.length) && modelCaps.supportsTools;
    } catch (err) {
      throw this.classifyError(input.model, err);
    }
    perfLog(requestId, { t: "headers", ms: Date.now() - requestSentAt, status: res.status });

    // ── Retry once WITHOUT native tools on server errors ──
    // Some Ollama servers/models choke on the tools field (e.g. memory-limited
    // runners return 500). Fall back to the text-based tool protocol.
    if (!res.ok) {
      const detail = await this.errorDetail(res);
      if (usedTools && res.status >= 400) {
        try {
          res = await this.postChat(buildBody(false), input.signal);
          usedTools = false;
        } catch (err) {
          throw this.classifyError(input.model, err);
        }
        if (!res.ok) {
          const retryDetail = await this.errorDetail(res);
          throw classifyHttpStatus("ollama", modelId, res.status, retryDetail);
        }
      } else {
        throw classifyHttpStatus("ollama", modelId, res.status, detail);
      }
    }

    if (!res.body) {
      throw classifyHttpStatus("ollama", modelId, 500, "Ollama returned no response body.");
    }

    // ── NDJSON streaming ──────────────────────────────────────────────
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let yieldedAny = false;
    let firstTokenMs = 0;
    let chunkCount = 0;
    try {
      // Use a labeled outer loop so that `break streamDone` exits BOTH
      // the inner for-loop and the outer while-loop when Ollama signals
      // completion. Previously `break` only exited the inner loop, causing
      // reader.read() to block forever after Ollama closed the connection.
      streamDone: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
          if (!payload || payload === "[DONE]") continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed.error) {
            const errMsg = safeExtractMessage(parsed.error) || "Ollama stream error";
            throw classifyHttpStatus("ollama", modelId, 500, errMsg);
          }
          const msg = parsed.message as Record<string, unknown> | undefined;
          if (!msg) continue;
          if (!firstTokenMs && (typeof msg.content === "string" && msg.content || Array.isArray(msg.tool_calls) && msg.tool_calls.length)) {
            firstTokenMs = Date.now() - t0;
            perfLog(requestId, { t: "firstToken", ms: firstTokenMs });
          }
          // Native tool calls (final chunk typically carries them)
          const toolCalls = msg.tool_calls;
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              const fn = (tc as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
              const name = typeof fn?.name === "string" ? fn.name : "";
              if (!name) continue;
              let args: Record<string, unknown> = {};
              const rawArgs = fn?.arguments;
              if (typeof rawArgs === "string") {
                try {
                  args = rawArgs ? JSON.parse(rawArgs) : {};
                } catch {
                  args = { raw: rawArgs };
                }
              } else if (rawArgs && typeof rawArgs === "object") {
                args = rawArgs as Record<string, unknown>;
              }
              yieldedAny = true;
              yield { type: "functionCall", name, args };
            }
            if (parsed.done === true) break streamDone;
            continue;
          }
          // Reasoning / thinking content (Qwen3, DeepSeek-R1, etc.)
          const reasoning = msg.reasoning_content ?? msg.thinking;
          if (typeof reasoning === "string" && reasoning) {
            yield { type: "reasoning", text: reasoning };
          }
          // Text content
          const content = msg.content;
          if (typeof content === "string" && content) {
            yieldedAny = true;
            chunkCount++;
            yield { type: "text", text: content };
          }
          if (parsed.done === true) break streamDone;
        }
        // Also handle the case where the buffer itself contains a valid
        // JSON object when the stream ends (EOF without final newline).
        if (buffer.trim()) {
          try {
            const finalParsed = JSON.parse(buffer.trim());
            if (finalParsed.done === true) {
              const finalMsg = finalParsed.message as Record<string, unknown> | undefined;
              if (finalMsg?.content && typeof finalMsg.content === "string") {
                yieldedAny = true;
                yield { type: "text", text: finalMsg.content };
              }
            }
          } catch { /* not valid JSON, ignore */ }
          buffer = "";
        }
      }
    } catch (err) {
      // Normalize stream errors (abort, dropped connection, malformed JSON) so
      // the agent/renderer always receive a structured ProviderError.
      throw this.classifyError(input.model, err);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    perfLog(requestId, { t: "done", totalMs: Date.now() - t0, chunks: chunkCount, firstTokenMs });

    if (!yieldedAny) {
      throw classifyHttpStatus("ollama", modelId, 500, `Ollama model \`${modelId}\` returned an empty response. Check that the model is running (Ollama loads it on first use).`);
    }
  }

  private async postChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  }

  private async capabilitiesOf(modelId: string): Promise<{ supportsTools: boolean; fullPromptOk: boolean }> {
    // Cached for 60s — model discovery must never sit on the generation path.
    const cached = OllamaProvider.capCache.get(modelId);
    if (cached && Date.now() - cached.at < 60_000) return cached.caps;
    let caps = { supportsTools: false, fullPromptOk: false };
    try {
      const models = await fetchOllamaModels(this.baseUrl);
      const found = models.find((m) => m.model.name === modelId);
      if (found) {
        const isCloud = found.cloud;
        const params = parameterBillions(modelId);
        // Small local models (≤8B) always get the compact prompt — the full
        // 9k-char prompt is measured to add tens of seconds and crash low-VRAM
        // runners. Larger locals and all cloud models can carry the full prompt.
        caps = { supportsTools: Boolean(found.model.supportsTools), fullPromptOk: isCloud || params > 8 };
      }
    } catch {
      // fall through to default
    }
    OllamaProvider.capCache.set(modelId, { caps, at: Date.now() });
    return caps;
  }

  private static capCache = new Map<string, { caps: { supportsTools: boolean; fullPromptOk: boolean }; at: number }>();

  private async errorDetail(res: Response): Promise<string> {
    let detail = "";
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      detail = safeExtractMessage(data.error ?? data);
    } catch {
      // fall through
    }
    if (detail && !/not found|model/i.test(detail) && res.status === 404) return detail;
    if (res.status === 404 && !detail) return `Ollama model not found. Pull it first: \`ollama pull ${""}\``;
    if (res.status === 500) {
      // Ollama returns 500 when the model fails to load or the server is out of memory.
      return detail || "Ollama failed to process the request. The model may still be loading or your machine may be low on memory. Try again in a moment.";
    }
    return detail || `Ollama request failed (HTTP ${res.status}).`;
  }

  private classifyError(model: string, err: unknown): ProviderError {
    if (err && typeof err === "object" && "errorType" in err) return err as ProviderError;
    const modelId = normalizeModelId(model);
    const netErr = err instanceof Error ? err : new Error(typeof err === "string" ? err : safeExtractMessage(err) || "Ollama request failed");
    // Abort → errorType "aborted" so the renderer can detect user-stopped runs.
    if (netErr.name === "AbortError" || /abort/i.test(netErr.message)) {
      return classifyNetworkError("ollama", modelId, netErr);
    }
    if (/fetch failed|econnrefused|enotfound|network|eai_again/i.test(netErr.message)) {
      return classifyHttpStatus("ollama", modelId, 0, "Cannot reach the Ollama server. Make sure Ollama is running.");
    }
    return classifyHttpStatus("ollama", modelId, 500, netErr.message);
  }
}

/** Strip Latex's provider prefix from an Ollama model tag. */
export function normalizeModelId(id: string): string {
  return id.trim().replace(/^ollama\//, "");
}

/** Context length default used when the server does not report one. */
export function defaultContextLength(): number {
  return DEFAULT_CONTEXT_LENGTH;
}

/** Re-export so UI code can mark cloud models consistently. */
export { isCloudModel };