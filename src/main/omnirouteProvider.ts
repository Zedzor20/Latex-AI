import type { GeminiModel, ModelProvider, OmniRouteStatus, ProviderError } from "../shared/types.js";
import { imageGenerationCapability, thinkingCapability } from "../shared/modelCapabilities.js";
import {
  resolveProviderEndpoint,
  type RequestIntent,
  type RouteableCapabilities
} from "../shared/imageRouting.js";
import { classifyHttpStatus, classifyNetworkError } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import { attachmentBlock, filesOf, imageBytes, imageDataUrl, imagesOf, logVision } from "../shared/vision.js";
import type { AIProvider, GeminiChunk, GeminiGenerateInput } from "./geminiProvider.js";
import { toolsToOpenAi } from "./openaiProvider.js";

/**
 * OmniRoute provider — connects to a local OmniRoute server
 * (http://localhost:20128) using its OpenAI-compatible API.
 *
 * OmniRoute is a local AI gateway that proxies requests to various providers.
 * It exposes an OpenAI-compatible chat completions endpoint.
 */

/**
 * OmniRoute endpoint. Defaults to the local gateway; LATEX_OMNIROUTE_BASE_URL
 * points every OmniRoute call — status probes, model discovery AND completions —
 * at another port or host (a remote gateway, or an isolated one in tests).
 * Resolved here, in the provider, so no code path can talk to a different
 * gateway than the one being probed.
 */
const DEFAULT_BASE_URL = process.env.LATEX_OMNIROUTE_BASE_URL?.trim() || "http://127.0.0.1:20128";
const DEFAULT_MAX_TOKENS = 8192;
/** Fast liveness probes — never the heavy monitoring endpoint alone. */
const LIVENESS_TIMEOUT_MS = 1500;
const STATUS_TIMEOUT_MS = 3000;
const MODELS_TIMEOUT_MS = 8000;
/** The monitoring endpoint may aggregate provider/credential health. */
const MONITORING_TIMEOUT_MS = 2500;

/**
 * Normalize a base URL for OmniRoute.
 * Prevents double /v1 when the base URL already ends with /v1.
 * Examples:
 *   http://127.0.0.1:20128      → http://127.0.0.1:20128
 *   http://127.0.0.1:20128/v1   → http://127.0.0.1:20128/v1
 *   http://127.0.0.1:20128/v1/  → http://127.0.0.1:20128/v1
 */
function normalizeBaseUrl(url: string): string {
  // Remove trailing slash
  let normalized = url.replace(/\/+$/, "");
  // If it already ends with /v1, keep it as-is (don't append another /v1)
  // The /v1 is appended by the callers (fetchOmniRouteModels, checkOmniRouteStatus)
  return normalized;
}

/**
 * Build the models endpoint URL.
 * If base URL already contains /v1, just append /models.
 * Otherwise append /v1/models.
 */
function modelsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/v1$/.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

/**
 * The gateway ORIGIN, with any `/v1` API suffix stripped. The monitoring and
 * health routes live beside the API, not inside it — `…/v1/api/monitoring/health`
 * does not exist, so a base URL saved as `http://127.0.0.1:20128/v1` must not
 * have the health path appended naively.
 */
function originUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

/**
 * Liveness endpoints, in the order they are probed. `/api/health` is the cheap
 * API health check documented for OmniRoute; `/healthz` is the conventional
 * fallback; `/api/monitoring/health` is a LAST-RESORT fallback because it is a
 * heavy monitoring route that can aggregate provider/credential health. A fast
 * success on the first two must establish ONLINE immediately — the monitoring
 * route must never be the only proof the server is running.
 */
function apiHealthUrl(baseUrl: string): string {
  return `${originUrl(baseUrl)}/api/health`;
}
function healthzUrl(baseUrl: string): string {
  return `${originUrl(baseUrl)}/healthz`;
}
/** OmniRoute's detailed monitoring endpoint (provider/model health dashboard). */
function monitoringHealthUrl(baseUrl: string): string {
  return `${originUrl(baseUrl)}/api/monitoring/health`;
}

// The state/status shapes live in shared/types.ts so the main process and the
// renderer can never drift apart on what a state means.
export type { OmniRouteState, OmniRouteStatus } from "../shared/types.js";

/**
 * Fetch a URL and report what actually happened.
 *
 * `reachable: false` means the TCP/HTTP request itself failed (connection
 * refused, DNS failure, timeout) — i.e. nothing is listening.
 * `reachable: true` means we got a real HTTP response: the server is up, no
 * matter which status code it returned. 401/403 therefore means "running but
 * not authenticated", never "offline".
 */
async function tryFetch(
  url: string,
  key?: string,
  timeoutMs: number = STATUS_TIMEOUT_MS
): Promise<{ reachable: boolean; status: number; data?: unknown }> {
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let data: unknown;
    try { data = await res.json(); } catch { /* non-JSON body — status is still meaningful */ }
    return { reachable: true, status: res.status, data };
  } catch {
    return { reachable: false, status: 0 };
  }
}

function modelCountOf(data: unknown): number {
  const list = (data as { data?: Array<{ id?: string }> } | undefined)?.data;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Fast, layered liveness probe. Returns the FIRST endpoint that answered with
 * a real HTTP response — any status code counts, because a response means
 * something is listening. The heavy `/api/monitoring/health` endpoint is tried
 * only AFTER `/api/health` and `/healthz` have both failed, so a slow
 * monitoring route can never decide that a running server is offline.
 */
async function probeLiveness(baseUrl: string): Promise<{ reachable: boolean; endpoint?: string; status: number }> {
  const candidates = [
    { path: "/api/health", url: apiHealthUrl(baseUrl) },
    { path: "/healthz", url: healthzUrl(baseUrl) },
    { path: "/api/monitoring/health", url: monitoringHealthUrl(baseUrl) }
  ];
  // A 404/405 means that route does not exist on this build — move on to the
  // next candidate. Any OTHER response (200, 401, 403, 500…) proves the server
  // is running AND the endpoint exists.
  let answeredWithoutRoute: { path: string; status: number } | null = null;
  for (const candidate of candidates) {
    const res = await tryFetch(candidate.url, undefined, LIVENESS_TIMEOUT_MS);
    if (!res.reachable) continue;
    if (res.status !== 404 && res.status !== 405) {
      return { reachable: true, endpoint: candidate.path, status: res.status };
    }
    if (!answeredWithoutRoute) answeredWithoutRoute = { path: candidate.path, status: res.status };
  }
  // The process answered but exposes no recognised health route: still ONLINE
  // (something is listening), just without a health endpoint to name.
  if (answeredWithoutRoute) return { reachable: true, status: answeredWithoutRoute.status };
  return { reachable: false, status: 0 };
}

/**
 * Check OmniRoute, treating SERVER STATUS and AUTHENTICATION STATUS as two
 * separate questions.
 *
 *   1. Liveness: GET /api/monitoring/health. Only a FAILED REQUEST (nothing
 *      listening) means OFFLINE. Any HTTP response means the gateway is running.
 *   2. Authentication: GET /v1/models.
 *        200          → authenticated (with the saved key, or with no key needed)
 *        401/403      → the gateway is up but wants a key:
 *                         - no key saved       → online_api_key_required
 *                         - saved key rejected → auth_failed
 *                         - saved key rejected but the same request WITHOUT
 *                           the key succeeds → the gateway needs no key at all
 *                           (a stale/foreign key was being sent); connect anyway
 *        other        → online, but the API answered something unexpected
 */
export async function checkOmniRouteStatus(baseUrl: string = DEFAULT_BASE_URL, apiKey?: string): Promise<OmniRouteStatus> {
  const url = normalizeBaseUrl(baseUrl);
  const key = apiKey && apiKey.trim() ? apiKey.trim() : undefined;

  // 1) Is the gateway process alive at all? Layered fast probe — NEVER the
  //    heavy monitoring route on its own, and the liveness verdict is made
  //    before any monitoring aggregation can delay it.
  const health = await probeLiveness(url);
  const base = {
    needsKey: false,
    authenticated: false,
    hasKey: Boolean(key),
    modelCount: 0,
    baseUrl: url,
    ...(health.endpoint ? { healthEndpoint: health.endpoint } : {})
  };
  if (!health.reachable) {
    return { ...base, running: false, state: "offline", error: `OmniRoute is not running at ${url}.` };
  }

  // 2) It is running. Now ask the API about authentication separately.
  const models = await tryFetch(modelsUrl(url), key, MODELS_TIMEOUT_MS);

  if (!models.reachable) {
    // The health endpoint answered but the API socket is gone: the gateway
    // stopped or restarted between the two probes. Never claim it is usable —
    // re-check once, then report the API as unreachable (the next poll picks the
    // gateway straight back up if it is in fact still there).
    const confirm = await probeLiveness(url);
    return {
      ...base,
      running: false,
      state: "offline",
      error: confirm.reachable
        ? `OmniRoute is not running at ${url} — its health check answered but the API endpoint refused the connection.`
        : `OmniRoute is not running at ${url}.`
    };
  }

  if (models.status === 200) {
    const modelCount = modelCountOf(models.data);
    return {
      ...base,
      running: true,
      state: key ? "online_authenticated" : "online_no_auth_required",
      authenticated: true,
      modelCount
    };
  }

  if (models.status === 401 || models.status === 403) {
    if (key) {
      // A saved key was rejected. Before calling it invalid, check whether this
      // instance simply ignores auth: sending a bogus Authorization header to a
      // gateway with enforcement DISABLED can still be refused.
      const anon = await tryFetch(modelsUrl(url), undefined, MODELS_TIMEOUT_MS);
      if (anon.status === 200) {
        return {
          ...base,
          running: true,
          state: "online_no_auth_required",
          authenticated: true,
          needsKey: false,
          modelCount: modelCountOf(anon.data)
        };
      }
      return {
        ...base,
        running: true,
        state: "auth_failed",
        needsKey: true,
        error: `OmniRoute is running, but the saved API key was rejected (HTTP ${models.status}). Update the OmniRoute endpoint key in Settings and try again.`
      };
    }
    return {
      ...base,
      running: true,
      state: "online_api_key_required",
      needsKey: true,
      error: `OmniRoute is running, but this instance requires an API key (HTTP ${models.status}). Add your OmniRoute endpoint key in Settings to connect Latex.`
    };
  }

  if (models.status === 404) {
    // Reachable but no OpenAI-compatible API at that path — almost always a
    // wrong base URL, not an offline server.
    return {
      ...base,
      running: true,
      state: "unknown_error",
      error: `OmniRoute answered, but /v1/models was not found at ${url} (HTTP 404). Check the endpoint in Settings.`
    };
  }

  return {
    ...base,
    running: true,
    state: "unknown_error",
    error: `OmniRoute is running, but /v1/models responded HTTP ${models.status}.`
  };
}

/**
 * Fetch models from OmniRoute's /v1/models endpoint.
 */
export async function fetchOmniRouteModels(baseUrl: string = DEFAULT_BASE_URL, apiKey?: string): Promise<GeminiModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const url = modelsUrl(baseUrl);
  console.log(`[OmniRoute] Model discovery: ${url}`);
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      apiKey
        ? `OmniRoute is running, but the saved API key was rejected while loading models (HTTP ${res.status}). Update the OmniRoute endpoint key in Settings.`
        : `OmniRoute is running, but this instance requires an API key to load models (HTTP ${res.status}). Add your OmniRoute endpoint key in Settings.`
    );
  }
  if (!res.ok) {
    throw new Error(`OmniRoute model discovery failed (HTTP ${res.status}).`);
  }
  const data = await res.json() as {
    data?: Array<{
      id: string;
      object?: string;
      created?: number;
      owned_by?: string;
    }>
  };

  const models: GeminiModel[] = [];
  const seen = new Set<string>();
  // Rebuild the fact cache for exactly what this catalog says, so a model that
  // disappeared stops contributing stale capabilities to routing.
  modelFacts.clear();

  for (const entry of data.data ?? []) {
    const id = entry.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // ── REAL capability metadata, straight off the catalog entry ───────
    // Read once, here, and cached: routing must never re-parse the catalog and
    // must never guess from a model name when the provider actually told us.
    const facts = readModelFacts(id, entry as Record<string, unknown>);
    // Stored so the REQUEST path (which only has a model id) routes from the
    // same facts the catalog published, with no second discovery call.
    modelFacts.set(id, facts);
    const routeable = routeableCapabilitiesFor(id, facts);

    // OmniRoute is a ROUTER: thinking support follows the selected model, not
    // the router. A reasoning-capable model behind OmniRoute really does stream
    // reasoning (the adapter reads delta.reasoning_content / delta.reasoning),
    // and a non-reasoning model must not be labelled as thinking-capable.
    const thinking = thinkingCapability("omniroute", id, { capabilities: facts.capabilities });
    const capabilities = ["omniroute", "local"];
    if (thinking.supportsThinking) capabilities.push("reasoning");
    // Marked so the picker can label an image model without re-deriving the
    // capability from its name, and so the same facts drive routing.
    if (routeable.supportsImageGeneration) capabilities.push("image-generation");
    if (facts.supportsVision) capabilities.push("vision");
    if (routeable.supportsChat) capabilities.push("chat");

    models.push({
      name: id,
      provider: "omniroute",
      displayName: id.split("/").pop()?.replace(/[-_]/g, " ") ?? id,
      description: `OmniRoute model — ${id}`,
      supportsTools: true,
      // Vision and image generation are SEPARATE questions. A model that can
      // create an image is not thereby able to understand one, and vice versa.
      supportsVision: facts.supportsVision,
      supportsChat: routeable.supportsChat,
      supportsImageGeneration: routeable.supportsImageGeneration,
      supportsReasoning: thinking.supportsThinking,
      supportsStreaming: true,
      isFree: true,
      capabilities
    });
  }

  return models;
}

// ── OmniRoute capability layer ──────────────────────────────────────────

/**
 * The capability facts one OmniRoute catalog entry really declares.
 *
 * OmniRoute is a gateway in front of many different backends, so the shapes it
 * can echo are varied. Rather than teach the router about each backend, the
 * entry is normalized ONCE into this small, canonical shape and everything
 * downstream reads that. Only fields that exist in the payload are read; a
 * missing field stays `undefined` and is never invented.
 */
interface OmniRouteModelFacts {
  /** Normalized capability tokens (used by the shared capability layer). */
  capabilities: string[];
  supportsVision: boolean;
  /** Provider-declared chat support; `undefined` when the catalog does not say. */
  supportsChat?: boolean;
  /**
   * The provider declared this model produces images and cannot chat — positive
   * evidence, as opposed to "the name looked like an image model".
   */
  declaredImageOnly: boolean;
}

/** Read a string[] from a field that may be an array, a comma list or a string. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
  return [];
}

/** Boolean-ish flags a catalog may use (true, "true", 1, "yes"). */
function booleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "1", "supported", "on"].includes(v)) return true;
    if (["false", "no", "0", "unsupported", "off"].includes(v)) return false;
  }
  return undefined;
}

/**
 * Normalize ONE catalog entry into capability facts.
 *
 * Detection order for image generation is deliberate:
 *   1. an explicit capability/type/modality/endpoint declaration (authoritative);
 *   2. the shared capability layer, whose name-pattern fallback is isolated in
 *      `shared/modelCapabilities.ts` and is only reached when the gateway told
 *      us nothing at all.
 * Nothing here hardcodes a model id — `aihorde/Qwen-Image_fp8`, FLUX, Stable
 * Diffusion and any future image model all flow through the same rule.
 */
function readModelFacts(id: string, entry: Record<string, unknown>): OmniRouteModelFacts {
  // Tokens are grouped by WHAT THEY DESCRIBE, because the distinction is the
  // whole point: `image` among a model's INPUT modalities is vision (it receives
  // pictures), while `image` among its OUTPUT modalities is image generation (it
  // produces them). Flattening the two together would make every vision model
  // look like an image generator.
  const modalities = entry.modalities as { input?: unknown; output?: unknown } | undefined;
  const lower = (values: unknown[]): string[] =>
    values.flatMap((value) => stringList(value)).map((token) => token.toLowerCase());
  /** Declared capability/tag/feature tokens. */
  const capabilityTokens = lower([
    entry.capabilities, entry.capability, entry.capability_tags, entry.tags, entry.features
  ]);
  /** Declared model kind (type/category/task). */
  const typeTokens = lower([entry.type, entry.model_type, entry.category, entry.task, entry.kind]);
  /** What the model PRODUCES. */
  const outputTokens = lower([entry.output_modalities, entry.outputs, modalities?.output]);
  /** What the model ACCEPTS. */
  const inputTokens = lower([entry.input_modalities, modalities?.input]);
  // Flat view for the shared capability layer (its explicit checks match exact
  // capability names, so an input `image` token cannot claim generation there).
  const declared = [...capabilityTokens, ...typeTokens, ...outputTokens, ...inputTokens];

  // Endpoint declarations name what the model can be asked for.
  const endpointTokens = stringList(entry.endpoints)
    .concat(Array.isArray(entry.endpoints) ? [] : entry.endpoints && typeof entry.endpoints === "object" ? Object.keys(entry.endpoints as object) : [])
    .map((token) => token.toLowerCase());

  const flagImage =
    booleanFlag(entry.supports_image_generation) ??
    booleanFlag(entry.supportsImageGeneration) ??
    booleanFlag(entry.image_generation) ??
    booleanFlag(entry.text_to_image);
  const flagChat =
    booleanFlag(entry.supports_chat) ??
    booleanFlag(entry.supportsChat) ??
    booleanFlag(entry.chat);

  const IMAGE_TOKEN = /^(image|images|image[-_]?generation|image[-_]?output|image[-_]?gen|text[-_]?to[-_]?image|txt2img|t2i)$/;
  const CHAT_TOKEN = /^(chat|completion|completions|text|text[-_]?generation|llm|conversational)$/;
  // Image production is claimed by an explicit flag, a capability/type token,
  // an OUTPUT modality, or an endpoint declaration — never by an input modality.
  const declaresImage =
    flagImage === true ||
    capabilityTokens.some((t) => IMAGE_TOKEN.test(t)) ||
    typeTokens.some((t) => IMAGE_TOKEN.test(t)) ||
    outputTokens.some((t) => IMAGE_TOKEN.test(t)) ||
    endpointTokens.some((t) => /images?\/(generations|generate)|images_generations/.test(t));
  const declaresChat =
    flagChat === true ||
    capabilityTokens.some((t) => CHAT_TOKEN.test(t)) ||
    typeTokens.some((t) => CHAT_TOKEN.test(t)) ||
    outputTokens.some((t) => CHAT_TOKEN.test(t)) ||
    endpointTokens.some((t) => /chat\/completions|chat_completions|\/completions$/.test(t));

  // Vision is about ACCEPTING pictures: only flags, capability/type tokens and
  // INPUT modalities can claim it.
  const VISION_TOKEN = /^(vision|image|images|image[-_]?understanding|image[-_]?input|multimodal|visual)$/;
  const supportsVision =
    booleanFlag(entry.supports_vision) === true ||
    booleanFlag(entry.supportsVision) === true ||
    capabilityTokens.some((t) => VISION_TOKEN.test(t)) ||
    typeTokens.some((t) => VISION_TOKEN.test(t)) ||
    inputTokens.some((t) => VISION_TOKEN.test(t));

  // "Image only" needs POSITIVE evidence: the model is declared to produce
  // images and NOTHING anywhere declares chat. An explicit `supports_chat:
  // false` is positive evidence too.
  const outputsText = outputTokens.some((t) => /^(text|chat|completion|completions)$/.test(t));
  const declaredImageOnly =
    flagChat === false ||
    (declaresImage && !declaresChat && !outputsText);

  const supportsChat =
    flagChat !== undefined
      ? flagChat
      : declaresChat || outputsText
        ? true
        : declaredImageOnly
          ? false
          : undefined;

  return {
    capabilities: [
      ...declared,
      ...(declaresImage ? ["image-generation"] : []),
      ...(supportsVision ? ["vision"] : []),
      ...(supportsChat ? ["chat"] : [])
    ],
    supportsVision,
    supportsChat,
    declaredImageOnly
  };
}

/**
 * Cache of the last catalog's facts, keyed by the model id the gateway uses.
 *
 * This IS the model-metadata cache the routing decision reads: the catalog is
 * fetched on startup, on reconnect and on an explicit refresh, and routing
 * never performs discovery of its own. A model missing from the cache keeps its
 * name-based fallback rather than being treated as unknown-and-hopefully-fine.
 */
const modelFacts = new Map<string, OmniRouteModelFacts>();

/** Strip Latex's provider prefix from an OmniRoute model id. */
function bareModelId(modelId: string): string {
  return (modelId ?? "").trim().replace(/^omniroute\//, "");
}

/** The facts for a model, or undefined when the catalog has not been read. */
function factsFor(modelId: string): OmniRouteModelFacts | undefined {
  return modelFacts.get(bareModelId(modelId));
}

/**
 * The two capabilities the endpoint rule needs for one model.
 *
 * `supportsImageGeneration` comes from the shared capability layer: the
 * gateway's own declared tokens when it has them, and its name-pattern fallback
 * only when it does not.
 *
 * `supportsChat` prefers what the catalog declared. When the catalog said
 * nothing, an image-generation model is treated as IMAGE-ONLY — the fail-safe,
 * because sending a chat request to a model that names itself an image
 * generator is exactly the invalid request this routing exists to prevent, and
 * the user gets a clear message instead of a gateway error. A model the
 * gateway explicitly declares chat-capable is always allowed to chat, even when
 * its name looks like an image model, which is what keeps a future model that
 * supports BOTH working on both endpoints.
 */
export function routeableCapabilitiesFor(modelId: string, facts?: OmniRouteModelFacts): RouteableCapabilities {
  const id = bareModelId(modelId);
  const resolved = facts ?? factsFor(id);
  const supportsImageGeneration = imageGenerationCapability("omniroute", id, { capabilities: resolved?.capabilities }).supportsImageGeneration;
  let supportsChat = resolved?.supportsChat;
  if (supportsChat === undefined) supportsChat = !supportsImageGeneration;
  return { supportsChat, supportsImageGeneration };
}

/**
 * The image-generation endpoint, derived from the same base URL as every other
 * OmniRoute call so a test gateway (or a remote one) is honoured identically.
 */
function imagesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return /\/v1$/.test(normalized) ? `${normalized}/images/generations` : `${normalized}/v1/images/generations`;
}

/** A generated picture, normalized for Latex's own message pipeline. */
interface NormalizedGeneratedImage {
  mimeType: string;
  /** Base64 only — the renderer, the persisted message and vision replay all use it. */
  data: string;
}

/** Cap on a downloaded image, so a bad URL cannot exhaust memory. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** MIME type from the data's magic bytes — never from a filename. */
function mimeTypeFromBase64(data: string): string | undefined {
  const head = data.slice(0, 16);
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("R0lGOD")) return "image/gif";
  if (head.startsWith("UklGR")) return "image/webp";
  if (head.startsWith("Qk")) return "image/bmp";
  return undefined;
}

/** MIME type from a data URL or a URL's extension, as a last resort. */
function mimeTypeFromUrl(value: string): string | undefined {
  const dataUrl = /^data:([^;,]+)[;,]/.exec(value);
  if (dataUrl) return dataUrl[1];
  const ext = /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.exec(value)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

/** Strip a data-URL prefix off inline base64, keeping the declared mime type. */
function splitDataUrl(value: string): { mimeType?: string; data: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) return { data: value };
  return { mimeType: match[1] || undefined, data: match[3] ?? "" };
}

/**
 * Turn whatever an image endpoint returned into normalized images.
 *
 * Image endpoints are NOT chat completions and their payloads differ between
 * backends: some return base64 (`b64_json`), some a URL, some a data URL, and
 * some a normalized `{ type: "image", url, mimeType }` object. All of them are
 * accepted here and reduced to one shape, so the rest of Latex — persistence,
 * vision replay, the chat image card — sees a single representation. A remote
 * URL is downloaded once, because Latex stores the picture WITH the message
 * rather than a link that can rot.
 */
async function extractGeneratedImages(payload: unknown): Promise<NormalizedGeneratedImage[]> {
  const out: NormalizedGeneratedImage[] = [];
  const root = payload as { data?: unknown; images?: unknown; image?: unknown; b64_json?: unknown; url?: unknown } | undefined;
  const candidates: unknown[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) candidates.push(...value);
    else if (value) candidates.push(value);
  };
  push(root?.data);
  push(root?.images);
  if ((root?.b64_json || root?.url || root?.image) && candidates.length === 0) candidates.push(root);

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const image = await normalizeImageSource(candidate, undefined);
      if (image) out.push(image);
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    // A nested `{ image: { url } }` / `{ image_url: { url } }` wrapper.
    const nestedRaw = item.image ?? item.image_url ?? item.imageBase64 ?? item.image_base64;
    const nested = nestedRaw && typeof nestedRaw === "object" ? (nestedRaw as Record<string, unknown>) : undefined;
    const source =
      (typeof item.b64_json === "string" && item.b64_json) ||
      (typeof item.base64 === "string" && item.base64) ||
      (typeof nestedRaw === "string" && nestedRaw) ||
      (typeof item.url === "string" && item.url) ||
      (nested && typeof nested.url === "string" && nested.url) ||
      (nested && typeof nested.b64_json === "string" && nested.b64_json) ||
      undefined;
    if (!source) continue;
    const declaredMime =
      (typeof item.mime_type === "string" && item.mime_type) ||
      (typeof item.mimeType === "string" && item.mimeType) ||
      (nested && typeof nested.mimeType === "string" && nested.mimeType) ||
      (nested && typeof nested.mime_type === "string" && nested.mime_type) ||
      undefined;
    const image = await normalizeImageSource(source, declaredMime || undefined);
    if (image) out.push(image);
  }
  return out;
}

/** One image source (base64, data URL or remote URL) → normalized base64 image. */
async function normalizeImageSource(source: string, declaredMime?: string): Promise<NormalizedGeneratedImage | undefined> {
  // Inline base64, with or without a data-URL prefix.
  const looksRemote = /^https?:\/\//i.test(source);
  if (!looksRemote) {
    const { mimeType, data } = splitDataUrl(source);
    const clean = data.replace(/\s+/g, "");
    if (!clean) return undefined;
    return {
      mimeType: declaredMime || mimeType || mimeTypeFromBase64(clean) || "image/png",
      data: clean
    };
  }
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return undefined;
    return {
      mimeType: declaredMime || res.headers.get("content-type")?.split(";")[0] || mimeTypeFromUrl(source) || "image/png",
      data: buffer.toString("base64")
    };
  } catch {
    // An unreachable or oversized image URL degrades to "no image data" and is
    // reported as such — it never becomes a conversation message.
    return undefined;
  }
}

/**
 * The prompt an image request should carry: the user's own words.
 * The image endpoint takes a single prompt, so the chat transcript is NOT sent.
 */
function imagePromptFrom(input: { messages: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> }): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i];
    if (message.role !== "user") continue;
    const text = message.parts.map((part) => part.text).join("").trim();
    if (text) return text;
  }
  return "";
}

/**
 * Is this gateway error the "image model on the chat endpoint" rejection?
 *
 * OmniRoute states the rule and names the correct endpoint; matching it lets
 * Latex answer with a clear instruction instead of echoing a low-level gateway
 * error the user cannot act on.
 */
function isImageModelOnChatEndpointError(message: string): boolean {
  return (
    /image[-_ ]?generation model/i.test(message) && /chat\/completions|chat completions/i.test(message)
  ) || /cannot be used on \/?v1\/chat\/completions/i.test(message);
}

/** Language a backend uses when it will not accept one of our body fields. */
const UNSUPPORTED_FIELD =
  /unsupported|not supported|does not (support|allow|accept)|unknown (parameter|field|argument)|unrecognized|unexpected|extra (field|parameter)|invalid (parameter|field|argument)/i;

/**
 * A clear, actionable message for an image-generation model asked to chat.
 * Says what the model cannot do and what the user should do instead.
 */
export const IMAGE_ONLY_CHAT_MESSAGE =
  "This model is an image-generation model. Use an image-generation request or select a chat model for normal conversation.";

/**
 * OmniRoute provider implementation.
 * Routes requests to the local OmniRoute server using OpenAI-compatible API.
 */
export class OmniRouteProvider implements AIProvider {
  constructor(
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly apiKey?: string
  ) {}

  async testConnection(): Promise<void> {
    const status = await checkOmniRouteStatus(this.baseUrl, this.apiKey);
    switch (status.state) {
      // Server up + API usable (key accepted, or no key required).
      case "online_no_auth_required":
      case "online_authenticated":
        return;
      case "offline":
        throw classifyHttpStatus("omniroute", "", 0, status.error ?? `OmniRoute is not running on ${this.baseUrl}`);
      case "online_api_key_required":
        // The server IS running — the missing piece is a credential, so say so.
        throw classifyHttpStatus("omniroute", "", 401, status.error ?? "OmniRoute is running, but this instance requires an API key.");
      case "auth_failed":
        throw classifyHttpStatus("omniroute", "", 401, status.error ?? "OmniRoute is running, but the saved API key was rejected.");
      case "unknown_error":
        throw classifyHttpStatus("omniroute", "", 0, status.error ?? "OmniRoute is not reachable.");
    }
  }

  async listModels(forceRefresh = false): Promise<GeminiModel[]> {
    return fetchOmniRouteModels(this.baseUrl, this.apiKey);
  }

  async *generate(input: GeminiGenerateInput): AsyncGenerator<GeminiChunk> {
    const modelId = input.model.replace(/^omniroute\//, "");
    // ── ENDPOINT DECISION — before any request is constructed ─────────
    // Intent (what the user asked for) plus capability (what this model really
    // is) decide the endpoint. An image-generation model posted to
    // /v1/chat/completions is rejected by OmniRoute outright, so that request
    // is never built: either it goes to /v1/images/generations, or the user is
    // told plainly why this model cannot serve the request.
    const intent: RequestIntent = input.intent ?? "chat";
    const decision = resolveProviderEndpoint(intent, routeableCapabilitiesFor(modelId));
    if (!decision.ok) {
      throw classifyHttpStatus("omniroute", modelId, 400, decision.reason);
    }
    if (decision.endpoint === "/v1/images/generations") {
      // A different endpoint AND a different response format — its own adapter,
      // never the chat SSE parser.
      yield* this.generateImage(input, modelId);
      return;
    }

    const normalized = normalizeBaseUrl(this.baseUrl);
    const url = /\/v1$/.test(normalized) ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
    const messages = input.messages.map((message) => ({
      role: message.role === "model" ? "assistant" : "user",
      content: message.parts.map((part) => part.text).join("")
    }));

    // ── Vision pipeline ─────────────────────────────────────────────────
    // Replay per-message images from persisted meta, then fresh attachments
    // on the last user message (deduped). Images are always normalized.
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
          throw classifyHttpStatus("omniroute", input.model, 400, `Image "${att.name ?? "attachment"}" could not be prepared for the model (invalid image data). The image was NOT sent as text instead.`);
        }
        contentParts.push({ type: "image_url", image_url: { url } });
        visionImages += 1;
        visionBytes += imageBytes([att]);
      }
      (messages[index] as Record<string, unknown>).content = contentParts;
    });

    // Handle attachments — images use OpenAI-compatible vision format
    const attachments = input.attachments?.filter((a) => a.kind === "text" || a.kind === "image");
    const lastIndex = messages.length - 1;
    const lastSource = input.messages[lastIndex];
    const lastAlreadyHasImages = imagesOf(lastSource?.attachments).length > 0;
    // File attachments already replayed from the last message's meta — never send twice.
    const carriedFileNames = new Set(filesOf(lastSource?.attachments).map((a) => a.name));
    if (attachments?.length && !lastAlreadyHasImages) {
      const last = messages[lastIndex];
      if (last && last.role === "user") {
        const hasImages = attachments.some((a) => a.kind === "image" && a.base64);
        if (hasImages) {
          // Convert to content array format for vision support
          const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
          if (typeof last.content === "string" && last.content.trim()) {
            contentParts.push({ type: "text", text: last.content });
          }
          for (const att of attachments) {
            if (att.kind === "image") {
              const url = imageDataUrl(att);
              if (!url) {
                throw classifyHttpStatus("omniroute", input.model, 400, `Image "${att.name ?? "attachment"}" could not be prepared for the model (invalid image data). The image was NOT sent as text instead.`);
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
          // Text-only attachments
          for (const att of attachments) {
            if (att.content && !carriedFileNames.has(att.name)) {
              last.content += `\n\n[Attachment: ${att.name}]\n${att.content}`;
            }
          }
        }
      }
    }
    logVision("omniroute", visionImages, visionBytes, messages.length);

    const body: Record<string, unknown> = {
      model: input.model.replace(/^omniroute\//, ""),
      messages: [{ role: "system", content: input.system }, ...messages],
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens || DEFAULT_MAX_TOKENS,
      stream: true
    };

    const openAiTools = toolsToOpenAi(input.tools);
    if (openAiTools && openAiTools.length > 0) {
      body.tools = openAiTools;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: input.signal
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
        throw classifyHttpStatus("omniroute", modelId, 0, "Request aborted.");
      }
      const netMsg = err instanceof Error ? err.message : typeof err === "string" ? err : safeExtractMessage(err) || "Network error";
      throw classifyNetworkError("omniroute", modelId, new Error(netMsg));
    }

    if (!res.ok) {
      const message = await this.errorDetail(res);
      // The gateway's way of saying "this model can only make images". Name what
      // the model is and what the user should do instead of echoing an internal
      // endpoint error. `fallbackAllowed` stays true, so Auto can move to a
      // model that really can hold the conversation.
      if (isImageModelOnChatEndpointError(message)) {
        throw classifyHttpStatus("omniroute", modelId, 400, IMAGE_ONLY_CHAT_MESSAGE);
      }
      throw classifyHttpStatus("omniroute", modelId, res.status, message);
    }

    if (!res.body) {
      throw classifyHttpStatus("omniroute", modelId, 500, "No response body from OmniRoute.");
    }

    // SSE streaming (same as OpenAI-compatible providers)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallAccum = new Map<number, { id: string; name: string; argsJson: string }>();
    // `[DONE]` ends the STREAM, not the generator: returning here skipped the
    // "yield accumulated tool calls" step below, so OmniRoute never executed a
    // native function call — the agent finished having changed nothing.
    let streamEnded = false;

    try {
      while (!streamEnded) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
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
              continue;
            }
            if (parsed.error) {
              const errObj = parsed.error as Record<string, unknown>;
              const errMsg = safeExtractMessage(errObj);
              throw classifyHttpStatus("omniroute", modelId, 500, errMsg || "OmniRoute stream error");
            }
            const choice = (parsed.choices as any[])?.[0];
            if (!choice) continue;
            if (choice.finish_reason === "content_filter" || choice.finish_reason === "error") {
              throw classifyHttpStatus("omniroute", modelId, 400, `Response blocked by OmniRoute: ${choice.finish_reason}`);
            }
            const delta = choice.delta ?? choice.message;
            if (!delta) continue;
            // Reasoning / thinking content — normalize the fields the routed
            // model may use (reasoning_content / reasoning / reasoning_details).
            const reasoning = (delta as Record<string, unknown>).reasoning_content
              ?? (delta as Record<string, unknown>).reasoning
              ?? (delta as Record<string, unknown>).reasoning_details;
            if (typeof reasoning === "string" && reasoning) {
              yield { type: "reasoning", text: reasoning };
            } else if (Array.isArray(reasoning)) {
              for (const part of reasoning) {
                if (!part) continue;
                const type = typeof part === "object" ? String((part as { type?: unknown }).type ?? "") : "";
                if (type && !/reason/i.test(type)) continue;
                const text = typeof part === "string" ? part : (part as { text?: unknown }).text;
                if (typeof text === "string" && text) yield { type: "reasoning", text };
              }
            }
            const content = delta.content;
            if (typeof content === "string" && content) {
              yield { type: "text", text: content };
            } else if (Array.isArray(content)) {
              for (const part of content) {
                const t = typeof part === "string" ? part : part?.text;
                if (t) yield { type: "text", text: t };
              }
            }
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

      // Yield accumulated tool calls
      for (const [, tc] of toolCallAccum) {
        if (!tc.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = tc.argsJson ? JSON.parse(tc.argsJson) : {};
        } catch {
          args = { raw: tc.argsJson };
        }
        yield { type: "functionCall", name: tc.name, args };
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorType" in err) throw err;
      const netErr = err instanceof Error ? err : new Error(safeExtractMessage(err) || "OmniRoute request failed");
      throw this.classifyError(modelId, netErr);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * IMAGE-GENERATION REQUEST — `POST /v1/images/generations`.
   *
   * The request is built from the image endpoint's own contract, NOT from the
   * chat body: `messages`, `tools`, `tool_choice`, `reasoning`, `temperature`
   * and `stream` are meaningless here and are never sent. Latex sends only what
   * the endpoint defines, and falls back to a smaller body — one field at a
   * time — when a backend says it does not accept a field, rather than
   * assuming which backends accept what.
   *
   * The response is NOT an SSE chat stream, so it is normalized by its own
   * adapter into real images and yielded on the existing image channel; nothing
   * here can be mistaken for assistant text or reasoning.
   */
  private async *generateImage(input: GeminiGenerateInput, modelId: string): AsyncGenerator<GeminiChunk> {
    const url = imagesUrl(this.baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Same authentication as every other OmniRoute call — one key, one store.
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const prompt = imagePromptFrom(input);
    if (!prompt) {
      throw classifyHttpStatus("omniroute", modelId, 400, "An image request needs a prompt describing the image to generate.");
    }

    // Richest accepted body first; each retry drops ONE optional field, and only
    // after the gateway said that field is the problem.
    const attemptBodies: Array<Record<string, unknown>> = [
      { model: modelId, prompt, n: 1, response_format: "b64_json" },
      { model: modelId, prompt, n: 1 },
      { model: modelId, prompt }
    ];

    let ok: Response | null = null;
    let lastMessage = "";
    for (const body of attemptBodies) {
      const res = await this.postImage(url, headers, body, input.signal, modelId);
      if (res.ok) { ok = res; break; }
      lastMessage = await this.errorDetail(res);
      const retryableField = (res.status === 400 || res.status === 422) && UNSUPPORTED_FIELD.test(lastMessage);
      if (!retryableField) throw classifyHttpStatus("omniroute", modelId, res.status, lastMessage);
    }
    if (!ok) {
      throw classifyHttpStatus("omniroute", modelId, 400, lastMessage || "OmniRoute rejected the image request.");
    }

    let payload: unknown;
    try {
      payload = await ok.json();
    } catch {
      throw classifyHttpStatus("omniroute", modelId, 502, "OmniRoute returned an unreadable image response.");
    }
    // HTTP 200 with an `error` body still means no picture was produced.
    const bodyError = safeExtractMessage((payload as { error?: unknown } | undefined)?.error);
    if (bodyError) throw classifyHttpStatus("omniroute", modelId, 400, bodyError);

    const images = await extractGeneratedImages(payload);
    if (images.length === 0) {
      throw classifyHttpStatus("omniroute", modelId, 502, "OmniRoute returned no image data for this request.");
    }
    for (const image of images) {
      yield { type: "image", mimeType: image.mimeType, data: image.data };
    }
  }

  /** POST to the image endpoint, with abort/network errors classified. */
  private async postImage(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    modelId: string
  ): Promise<Response> {
    try {
      return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
        throw classifyHttpStatus("omniroute", modelId, 0, "Request aborted.");
      }
      const netMsg = err instanceof Error ? err.message : typeof err === "string" ? err : safeExtractMessage(err) || "Network error";
      throw classifyNetworkError("omniroute", modelId, new Error(netMsg));
    }
  }

  private async errorDetail(res: Response): Promise<string> {
    try {
      const data = await res.json() as { error?: unknown; message?: unknown };
      return safeExtractMessage(data.error ?? data) || `OmniRoute request failed (HTTP ${res.status}).`;
    } catch {
      return `OmniRoute request failed (HTTP ${res.status}).`;
    }
  }

  private classifyError(model: string, err: Error): ProviderError {
    if (/fetch failed|econnrefused|enotfound|network|eai_again/i.test(err.message)) {
      return classifyHttpStatus("omniroute", model, 0, "Cannot reach OmniRoute. Make sure OmniRoute is running on " + this.baseUrl);
    }
    return classifyHttpStatus("omniroute", model, 500, err.message);
  }
}
