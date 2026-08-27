import type { GeminiModel } from "../shared/types.js";
import { classifyHttpStatus } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import type { AIProvider, GeminiChunk, GeminiGenerateInput } from "./geminiProvider.js";

/**
 * Puter provider — uses Puter's official API for live model discovery and chat.
 *
 * Streaming returns NDJSON where each line is a ChatResponseChunk.
 *
 * NOTE: Puter wraps multiple providers through its own API interface.
 * Tool schemas are NOT supported by the Puter driver, so we do NOT pass
 * tools in the request. Instead, models use the text-based tool protocol
 * defined in the system prompt to request tool calls as structured text
 * (e.g. {"name":"create_file","arguments":{...}}), which the agent's
 * parseTextToolCalls() function detects and executes.
 *
 * For models that do support native function calling through Puter's
 * backend, the provider also handles function_call response chunks.
 */

const PUTER_API = "https://api.puter.com";

// ── Model cache ─────────────────────────────────────────────────────

let liveModelsCache: { token: string; models: GeminiModel[]; at: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** A raw model entry from Puter's model details endpoint. */
interface PuterRawModel {
  id: string;
  provider?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  max_tokens?: number;
  capabilities?: string[];
  aliases?: string[];
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────

const KNOWN_TOOL_NAMES = new Set([
  "read_file", "write_file", "create_file", "edit_file", "delete_file",
  "rename_file", "move_file", "list_directory", "search_files",
  "create_directory", "get_workspace_info", "run_command", "list_files"
]);

/** Try to unwrap a JSON-encoded string that Puter wraps in quotes. */
function tryUnwrapJsonString(s: string): string {
  if (s.length < 2 || s[0] !== '"') return s;
  try {
    const decoded = JSON.parse(s);
    if (typeof decoded === "string") return decoded;
    return s;
  } catch {
    return s;
  }
}

/** Check if unwrapped text looks like a tool call JSON. */
function looksLikeToolJson(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes("\"name\"")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.name === "string") {
        if (KNOWN_TOOL_NAMES.has(obj.name.toLowerCase())) return true;
        if (obj.arguments && typeof obj.arguments === "object") return true;
        if (obj.args && typeof obj.args === "object") return true;
      }
    } catch {
      return true;
    }
  }
  if (/<tool_call|<function_call/.test(text)) return true;
  if (text.includes('\\"name\\"')) return true;
  return false;
}

// ── Curated model categories ────────────────────────────────────────

export interface CuratedPuterModels {
  powerful: GeminiModel[];
  fast: GeminiModel[];
  automation: GeminiModel[];
  recommended: GeminiModel[];
  all: GeminiModel[];
}

export function categorizePuterModels(models: GeminiModel[]): CuratedPuterModels {
  const powerful: GeminiModel[] = [];
  const fast: GeminiModel[] = [];
  const automation: GeminiModel[] = [];
  const recommended: GeminiModel[] = [];

  for (const model of models) {
    const name = (model.displayName ?? model.name).toLowerCase();
    const id = model.name.toLowerCase();
    const desc = (model.description ?? "").toLowerCase();
    const caps = (model.capabilities ?? []).join(" ").toLowerCase();
    const combined = `${name} ${id} ${desc} ${caps}`;

    if (/embedding|rerank|moderation|whisper|tts|audio|speech|dall.e|flux|stable|transcri|image.?gen|txt2img|txt2vid/.test(combined)) continue;

    const isPowerful = /max|ultra|large|72b|70b|405b|400b|o1|o3|claude|gpt-4|gemini-2|deepseek.r1|qwen.?3|command.r|mistral.large/i.test(combined)
      || (model.contextLength ?? 0) >= 100000;
    const isFast = /flash|mini|small|fast|light|nano|turbo|haiku|instant/i.test(combined);
    const isAutomation = /code|coder|coding|agent|assistant|instruct|chat/i.test(combined)
      && !/embedding|image|speech|audio/.test(combined);

    if (isPowerful) powerful.push(model);
    if (isFast) fast.push(model);
    if (isAutomation) automation.push(model);

    const score = (model.contextLength ?? 0) / 10000
      + (model.supportsTools ? 3 : 0)
      + (model.supportsReasoning ? 2 : 0)
      + (model.supportsVision ? 1 : 0)
      + (isPowerful ? 2 : 0)
      + (isAutomation ? 1 : 0);
    if (score >= 3) recommended.push(model);
  }

  const cap = (arr: GeminiModel[], n: number) => {
    arr.sort((a, b) => {
      const aCtx = a.contextLength ?? 0;
      const bCtx = b.contextLength ?? 0;
      if (bCtx !== aCtx) return bCtx - aCtx;
      return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
    });
    return arr.slice(0, n);
  };

  return {
    powerful: cap(powerful, 15),
    fast: cap(fast, 12),
    automation: cap(automation, 12),
    recommended: cap(recommended, 10),
    all: models
  };
}

// ── Provider ────────────────────────────────────────────────────────

export class PuterProvider implements AIProvider {
  private authToken: string | null;

  constructor(authToken: string | null) {
    this.authToken = authToken;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  isAuthenticated(): boolean {
    return Boolean(this.authToken);
  }

  async testConnection(): Promise<void> {
    if (!this.authToken) {
      throw classifyHttpStatus("puter", "", 401, "Puter authentication required. Sign in to Puter Cloud in Settings → AI Providers → Puter Cloud.");
    }
    try {
      const res = await fetch(`${PUTER_API}/whoami`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.authToken}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        throw classifyHttpStatus("puter", "", res.status, `Puter authentication failed (HTTP ${res.status}). Please sign in again.`);
      }
      const data = await res.json() as { username?: string; [key: string]: unknown };
      console.log(`[PUTER] Connection verified — user: ${data.username ?? "unknown"}`);
    } catch (err) {
      if (err && typeof err === "object" && "errorType" in err) throw err;
      throw classifyHttpStatus("puter", "", 500, "Puter connection test failed. Check your network connection.");
    }
  }

  async listModels(forceRefresh = false): Promise<GeminiModel[]> {
    if (!this.authToken) return [];

    if (!forceRefresh && liveModelsCache && liveModelsCache.token === this.authToken && Date.now() - liveModelsCache.at < MODEL_CACHE_TTL_MS) {
      return liveModelsCache.models;
    }

    try {
      const res = await fetch(`${PUTER_API}/puterai/chat/models/details`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.authToken}` },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        console.log(`[PUTER] Model list fetch failed: HTTP ${res.status}`);
        return liveModelsCache?.models ?? [];
      }

      const data = await res.json() as { models?: PuterRawModel[] };
      const rawModels = Array.isArray(data.models) ? data.models : [];

      console.log(`[PUTER] Live model list: ${rawModels.length} models from ${new Set(rawModels.map(m => m.provider)).size} providers`);

      const models: GeminiModel[] = [];
      const seenIds = new Set<string>();

      for (const m of rawModels) {
        const id = String(m.id ?? "").trim();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const displayName = String(m.display_name ?? m.name ?? id).trim();
        const provider = String(m.provider ?? "unknown").trim();
        const description = String(m.description ?? "").trim();
        const caps = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
        const capsLower = caps.join(" ").toLowerCase();
        const nameAndDesc = `${id} ${displayName} ${description} ${capsLower}`.toLowerCase();

        const supportsVision = /vision|multimodal|image/.test(nameAndDesc);
        const supportsReasoning = /reason|think|thinking/.test(nameAndDesc);
        const excluded = /embedding|rerank|moderation|whisper|tts|audio|speech|dall.e|flux|stable|transcri/.test(nameAndDesc);
        const supportsTools = !excluded && /chat|code|coder|assistant|instruct|agent/.test(nameAndDesc);

        models.push({
          name: id,
          displayName,
          description: description || `Puter model — ${provider}`,
          provider: "puter",
          contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
          supportsTools,
          supportsVision,
          supportsReasoning,
          supportsStreaming: true,
          isFree: true,
          capabilities: ["free", "puter", provider, ...caps]
        });
      }

      models.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));

      liveModelsCache = { token: this.authToken, models, at: Date.now() };
      return models;
    } catch (err) {
      console.log(`[PUTER] Model list error: ${err instanceof Error ? err.message : err}`);
      return liveModelsCache?.models ?? [];
    }
  }

  async *generate(input: GeminiGenerateInput): AsyncGenerator<GeminiChunk> {
    if (!this.authToken) {
      throw classifyHttpStatus("puter", input.model, 401, "Puter authentication required. Sign in to Puter Cloud in Settings → AI Providers.");
    }

    const modelId = input.model.replace(/^puter\//, "").trim();
    const modelParts = modelId.split("/");
    const providerHint = modelParts.length > 1 ? modelParts[0] : undefined;

    const messages = input.messages.map((message) => ({
      role: message.role === "model" ? "assistant" : message.role,
      content: message.parts.map((part) => part.text).join("")
    }));

    const args: Record<string, unknown> = {
      messages: [{ role: "system", content: input.system }, ...messages],
      model: modelId,
      stream: true,
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens || 8192
    };
    if (providerHint) {
      args.provider = providerHint;
    }

    // NOTE: Puter wraps multiple providers through its own API interface.
    // Tool schemas are NOT supported by the Puter driver, so we do NOT pass
    // tools in the request. Instead, models use the text-based tool protocol
    // defined in the system prompt to request tool calls as structured text,
    // which the agent's parseTextToolCalls() will detect and execute.

    const body = {
      interface: "puter-chat-completion",
      driver: "ai-chat",
      method: "complete",
      args,
      auth_token: this.authToken
    };

    let res: Response;
    try {
      res = await fetch(`${PUTER_API}/drivers/call`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;actually=json" },
        body: JSON.stringify(body),
        signal: input.signal
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
        throw classifyHttpStatus("puter", input.model, 0, "Puter request was stopped.");
      }
      const netMsg = err instanceof Error ? err.message : typeof err === "string" ? err : safeExtractMessage(err) || "Network error";
      throw classifyHttpStatus("puter", input.model, 500, `Puter connection failed: ${netMsg}`);
    }

    if (!res.ok) {
      const detail = await extractPuterError(res);
      if (res.status === 401) throw classifyHttpStatus("puter", input.model, 401, "Puter authentication expired. Please sign in again in Settings → AI Providers → Puter Cloud.");
      if (res.status === 404) throw classifyHttpStatus("puter", input.model, 404, `Puter model not found: \`${modelId}\`. The model may no longer be available. Try refreshing the model list in Settings.`);
      throw classifyHttpStatus("puter", input.model, res.status, detail);
    }

    if (!res.body) {
      throw classifyHttpStatus("puter", input.model, res.status || 500, "No response body from Puter.");
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isNdjson = contentType.includes("application/x-ndjson") || contentType.includes("text/event-stream") || contentType.includes("text/plain");

    if (isNdjson) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let yieldedAny = false;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "[DONE]") continue;
            try {
              const parsed = JSON.parse(trimmed) as Record<string, unknown>;

              if (parsed.error) {
                const errMsg = safeExtractMessage(parsed.error);
                throw classifyHttpStatus("puter", input.model, 500, errMsg || "Puter stream error");
              }

              const chunkType = parsed.type as string | undefined;

              if (chunkType === "error") {
                const errMsg = (parsed.message as string) ?? (parsed.error as string) ?? "Unknown streaming error";
                throw classifyHttpStatus("puter", input.model, 500, `Puter error: ${errMsg}`);
              }

              // Handle native function calls (if Puter backend supports them)
              if (chunkType === "function_call" || chunkType === "function_call_delta" || chunkType === "function_call_chunk") {
                const src = (chunkType === "function_call_delta" || chunkType === "function_call_chunk") ? (parsed.delta as Record<string, unknown> ?? parsed) : parsed;
                const funcObj = (parsed.function as Record<string, unknown>) || undefined;
                const funcName = (src?.name as string) || (funcObj?.name as string) || "";
                const funcArgs = (src as Record<string, unknown>)?.arguments ?? funcObj?.arguments ?? {};
                if (funcName) {
                  yieldedAny = true;
                  yield {
                    type: "functionCall",
                    name: funcName,
                    args: typeof funcArgs === "string" ? (() => { try { return JSON.parse(funcArgs); } catch { return {}; } })() : (funcArgs as Record<string, unknown>)
                  };
                  continue;
                }
              }

              if (chunkType === "text" && typeof parsed.text === "string" && parsed.text) {
                const rawText = parsed.text;
                const unwrapped = tryUnwrapJsonString(rawText);

                if (looksLikeToolJson(unwrapped) || looksLikeToolJson(rawText)) {
                  yieldedAny = true;
                  yield { type: "text", text: unwrapped };
                } else {
                  yieldedAny = true;
                  yield { type: "text", text: rawText };
                }
                continue;
              }

              if (chunkType === "reasoning" && typeof parsed.text === "string" && parsed.text) {
                yieldedAny = true;
                yield { type: "text", text: parsed.text };
                continue;
              }

              // Handle driver envelope with result
              if (parsed.result && typeof parsed.result === "object") {
                const result = parsed.result as Record<string, unknown>;

                // Native function call in result envelope
                if (result.type === "function_call") {
                  const funcName = result.name as string || (result.function as Record<string, unknown>)?.name as string || "";
                  const funcArgs = result.arguments ?? (result.function as Record<string, unknown>)?.arguments ?? {};
                  if (funcName) {
                    yieldedAny = true;
                    yield {
                      type: "functionCall",
                      name: funcName,
                      args: typeof funcArgs === "string" ? (() => { try { return JSON.parse(funcArgs); } catch { return {}; } })() : (funcArgs as Record<string, unknown>)
                    };
                    continue;
                  }
                }

                const chunkType2 = result.type as string | undefined;

                if (chunkType2 === "text" && typeof result.text === "string" && result.text) {
                  yieldedAny = true;
                  yield { type: "text", text: result.text };
                  continue;
                }
                if (chunkType2 === "error") {
                  const errMsg = (result.message as string) ?? "Unknown streaming error";
                  throw classifyHttpStatus("puter", input.model, 500, `Puter error: ${errMsg}`);
                }

                const message = result.message as Record<string, unknown> | undefined;
                const content = message?.content ?? result.content;
                if (typeof content === "string" && content) {
                  yieldedAny = true;
                  yield { type: "text", text: content };
                  continue;
                }
                if (Array.isArray(content)) {
                  for (const part of content) {
                    if (typeof part === "object" && part !== null) {
                      const partObj = part as Record<string, unknown>;
                      if (partObj.type === "function_call" || partObj.function_call) {
                        const funcPart = partObj.function_call as Record<string, unknown> | undefined;
                        const funcName = (funcPart?.name as string) || (partObj.name as string) || "";
                        const funcArgs = funcPart?.arguments ?? partObj.arguments ?? {};
                        if (funcName) {
                          yieldedAny = true;
                          yield {
                            type: "functionCall",
                            name: funcName,
                            args: typeof funcArgs === "string" ? (() => { try { return JSON.parse(funcArgs); } catch { return {}; } })() : (funcArgs as Record<string, unknown>)
                          };
                          continue;
                        }
                      }
                    }
                    const t = typeof part === "string" ? part : (part as Record<string, unknown>)?.text;
                    if (typeof t === "string" && t) {
                      yieldedAny = true;
                      yield { type: "text", text: t };
                    }
                  }
                  continue;
                }
              }
            } catch (err) {
              if (err && typeof err === "object" && "errorType" in err) throw err;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      if (!yieldedAny) {
        throw classifyHttpStatus("puter", input.model, 500, `Puter model \`${modelId}\` returned an empty response. The model may not support this format. Try a different model or refresh Puter models in Settings.`);
      }
    } else {
      const text = await res.text();
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        if (data.error) {
          const errMsg = safeExtractMessage(data.error);
          throw classifyHttpStatus("puter", input.model, 500, errMsg || "Puter error");
        }
        const result = data.result as Record<string, unknown> | undefined;
        const message = result?.message as Record<string, unknown> | undefined;
        const rawContent = message?.content ?? result?.content ?? (data as Record<string, unknown>).content ?? "";
        const content = typeof rawContent === "string" ? rawContent : Array.isArray(rawContent) ? rawContent : "";

        if (typeof content === "string" && content) {
          yield { type: "text", text: content };
        } else if (Array.isArray(content)) {
          for (const part of content) {
            const t = typeof part === "string" ? part : (part as Record<string, unknown>)?.text;
            if (typeof t === "string" && t) yield { type: "text", text: t };
          }
        } else {
          throw classifyHttpStatus("puter", input.model, 500, "Puter returned an empty response.");
        }
      } catch (err) {
        if (err && typeof err === "object" && "errorType" in err) throw err;
        if (text && text.trim()) {
          yield { type: "text", text };
        } else {
          throw classifyHttpStatus("puter", input.model, 500, "Puter returned an empty response.");
        }
      }
    }
  }
}

async function extractPuterError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown; success?: boolean };
    return safeExtractMessage(data.error ?? data) || `Puter request failed (HTTP ${res.status})`;
  } catch {
    return `Puter request failed (HTTP ${res.status})`;
  }
}
