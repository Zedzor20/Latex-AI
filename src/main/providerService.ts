import type { GeminiModel, ModelHealth, ModelProvider, ProviderError, ProviderStatus } from "../shared/types.js";
import { classifyHttpStatus, classifyNetworkError } from "../shared/types.js";
import { safeExtractMessage } from "../shared/safeMessage.js";
import { GeminiProvider } from "./geminiProvider.js";
import { OpenAiCompatibleProvider } from "./openaiProvider.js";
import { PuterProvider } from "./puterProvider.js";
import type { AIProvider } from "./geminiProvider.js";

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  groq: "Groq",
  puter: "Puter"
};

/** Keys that map a model name to its provider (default: gemini). */
export function providerOfModel(modelName: string): ModelProvider {
  const lower = modelName.toLowerCase();
  if (lower.startsWith("puter/")) return "puter";
  if (lower.startsWith("openrouter/")) return "openrouter";
  if (lower.startsWith("minimax/")) return "minimax";
  if (lower.startsWith("groq/")) return "groq";
  return "gemini";
}

/** Prefix a model id with its provider so the picker can group and route it. */
export function qualifyModel(model: GeminiModel): GeminiModel {
  if (!model.provider || model.provider === "gemini") {
    const name = model.name.startsWith("models/") ? model.name : `models/${model.name}`;
    return { ...model, name, provider: "gemini" };
  }
  const prefix = `${model.provider}/`;
  return { ...model, name: model.name.startsWith(prefix) ? model.name : `${prefix}${model.name}` };
}

/** True when the provider that serves this model exists and has a key. */
export function isQuotaError(message: string): boolean {
  return /429|quota|rate limit|insufficient_quota|resource exhausted|temporarily unavailable|model (is )?(currently )?(overloaded|unavailable)/i.test(message);
}

// ── Model health registry ────────────────────────────────────────────────

const modelHealth = new Map<string, ModelHealth>();
const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute
const HEALTHY_RESET_AFTER_MS = 300_000; // 5 minutes of no failures → healthy again

export function modelHealthKey(provider: ModelProvider, model: string): string {
  return `${provider}:${model}`;
}

export function getModelHealth(provider: ModelProvider, model: string): ModelHealth {
  const key = modelHealthKey(provider, model);
  const existing = modelHealth.get(key);
  if (existing) {
    // Auto-reset healthy status after cooldown expires
    if (existing.cooldownUntil && Date.now() > existing.cooldownUntil) {
      existing.cooldownUntil = undefined;
      existing.status = existing.failures <= 2 ? "healthy" : "degraded";
    }
    return existing;
  }
  const fresh: ModelHealth = { provider, model, status: "healthy", failures: 0 };
  modelHealth.set(key, fresh);
  return fresh;
}

export function recordModelFailure(provider: ModelProvider, model: string, error: ProviderError): ModelHealth {
  const key = modelHealthKey(provider, model);
  const health = getModelHealth(provider, model);
  health.failures++;
  health.lastFailure = Date.now();
  health.lastStatus = error.status ?? undefined;

  if (error.errorType === "not_found") {
    // 404 = model permanently gone from this provider
    health.status = "unavailable";
  } else if (error.errorType === "auth_failed") {
    // 401 = provider-level auth problem
    health.status = "unavailable";
  } else if (error.errorType === "no_credit") {
    // 402 = provider-level credit problem
    health.status = "unavailable";
  } else if (error.errorType === "forbidden") {
    // 403 = permission/guardrail — could be model or provider level
    health.status = health.failures >= 2 ? "unavailable" : "degraded";
  } else if (error.errorType === "rate_limited") {
    health.status = "degraded";
    health.cooldownUntil = Date.now() + DEFAULT_COOLDOWN_MS;
  } else if (error.status !== null && error.status >= 500) {
    // Server errors — temporary
    health.status = "degraded";
    health.cooldownUntil = Date.now() + DEFAULT_COOLDOWN_MS;
  } else if (health.failures >= 3) {
    health.status = "unavailable";
    health.cooldownUntil = Date.now() + DEFAULT_COOLDOWN_MS * 3;
  } else {
    health.status = "degraded";
  }

  modelHealth.set(key, health);
  return health;
}

export function recordModelSuccess(provider: ModelProvider, model: string): void {
  const key = modelHealthKey(provider, model);
  const health = modelHealth.get(key);
  if (health) {
    health.failures = Math.max(0, health.failures - 1);
    if (health.failures === 0) health.status = "healthy";
    health.cooldownUntil = undefined;
    health.lastStatus = Date.now();
  }
}

/** Check whether a model is currently eligible for AUTO selection. */
export function isModelAvailable(provider: ModelProvider, model: string): boolean {
  const health = getModelHealth(provider, model);
  if (health.status === "unavailable") return false;
  if (health.cooldownUntil && Date.now() < health.cooldownUntil) return false;
  return true;
}

/** Create a ProviderError from any thrown value, ensuring correct provider. */
export function toProviderError(
  provider: ModelProvider,
  model: string,
  err: unknown,
  requestId?: string
): ProviderError {
  if (err && typeof err === "object" && "provider" in err && "errorType" in err) {
    // Already a classified ProviderError — ensure message is a string
    const pe = err as ProviderError;
    if (typeof pe.message !== "string") pe.message = safeExtractMessage(pe.message) || "Provider request failed";
    return pe;
  }
  // CRITICAL: never pass a non-string to Error() — it becomes [object Object]
  let safeMsg = "Provider request failed";
  if (typeof err === "string") safeMsg = err;
  else if (err instanceof Error) safeMsg = err.message || err.name || "Provider request failed";
  else if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") safeMsg = (err as { message: string }).message;
  const error = new Error(safeMsg);
  const msg = error.message;

  // Try to extract HTTP status from the message
  const httpMatch = msg.match(/HTTP\s+(\d{3})/i) || msg.match(/status[:\s]+(\d{3})/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    // Extract detail message after status
    const detail = msg.replace(/HTTP\s+\d{3}[.!,;\s]*/i, "").replace(/.*request failed[.!,;\s]*/i, "").trim();
    return classifyHttpStatus(provider, model, status, detail || msg, requestId);
  }

  return classifyNetworkError(provider, model, error, requestId);
}

export class ProviderFactory {
  constructor(
    private readonly getKey: (provider: ModelProvider) => string | undefined,
    private readonly getPuterToken?: () => string | null
  ) {}

  getProvider(provider: ModelProvider): AIProvider | undefined {
    if (provider === "puter") {
      const token = this.getPuterToken ? this.getPuterToken() : null;
      return new PuterProvider(token);
    }
    const apiKey = this.getKey(provider);
    if (!apiKey) return undefined;
    if (provider === "gemini") return new GeminiProvider(apiKey);
    return new OpenAiCompatibleProvider(provider, apiKey);
  }

  /** Test a specific provider's connection. */
  async test(provider: ModelProvider): Promise<void> {
    const impl = this.getProvider(provider);
    if (!impl) throw new Error(`No ${PROVIDER_LABELS[provider]} API key has been saved.`);
    await impl.testConnection();
  }

  /** Discover models from every configured provider, deduped and qualified. */
  async listAllModels(forceRefresh = false): Promise<GeminiModel[]> {
    const providers: ModelProvider[] = ["gemini", "openrouter", "minimax", "groq", "puter"];
    const results = await Promise.allSettled(providers.map((provider) => {
      const impl = this.getProvider(provider);
      return impl ? impl.listModels(forceRefresh).then((list) => ({ provider, list })) : Promise.resolve({ provider, list: [] as GeminiModel[] });
    }));
    const seen = new Set<string>();
    const all: GeminiModel[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const model of result.value.list) {
        const qualified = qualifyModel({ ...model, provider: model.provider ?? result.value.provider });
        if (seen.has(qualified.name)) continue;
        seen.add(qualified.name);
        all.push(qualified);
      }
    }
    return all;
  }

  /** Status of every provider (configured or not) for the settings UI. */
  statuses(): ProviderStatus[] {
    const puterConnected = this.getPuterToken ? Boolean(this.getPuterToken()) : false;
    return (["gemini", "openrouter", "minimax", "groq", "puter"] as ModelProvider[]).map((provider) => ({
      provider,
      label: PROVIDER_LABELS[provider],
      configured: provider === "puter" ? puterConnected : Boolean(this.getKey(provider))
    }));
  }

  /**
   * Probe every configured provider's health and return per-provider results.
   * Each probe is lightweight: it calls the provider's testConnection() or listModels().
   * Results indicate whether the provider's API key is valid and credits are available.
   */
  async probeAll(): Promise<Array<{
    provider: ModelProvider;
    label: string;
    configured: boolean;
    status: "ok" | "error" | "no_key";
    modelCount: number;
    error?: string;
    httpStatus?: number;
  }>> {
    const providers: ModelProvider[] = ["gemini", "openrouter", "minimax", "groq", "puter"];
    const results = await Promise.allSettled(providers.map(async (provider) => {
      const impl = this.getProvider(provider);
      if (!impl) {
        return {
          provider,
          label: PROVIDER_LABELS[provider],
          configured: false,
          status: "no_key" as const,
          modelCount: 0,
          error: "No API key configured"
        };
      }
      try {
        // Use listModels as the health probe — it validates API key + credits
        const models = await impl.listModels();
        return {
          provider,
          label: PROVIDER_LABELS[provider],
          configured: true,
          status: "ok" as const,
          modelCount: models.length,
          error: undefined,
          httpStatus: undefined
        };
      } catch (err) {
        const msg = safeExtractMessage(err);
        // Extract HTTP status from the error message
        const httpMatch = msg.match(/HTTP\s+(\d{3})/i);
        const httpStatus = httpMatch ? parseInt(httpMatch[1], 10) : undefined;
        return {
          provider,
          label: PROVIDER_LABELS[provider],
          configured: true,
          status: "error" as const,
          modelCount: 0,
          error: msg || "Connection failed",
          httpStatus
        };
      }
    }));
    return results.map((r) => r.status === "fulfilled" ? r.value : {
      provider: "gemini" as ModelProvider,
      label: "Unknown",
      configured: false,
      status: "error" as const,
      modelCount: 0,
      error: "Probe failed"
    });
  }
}

export function providerLabel(provider: ModelProvider): string {
  return PROVIDER_LABELS[provider];
}
