/**
 * Provider Usage Service
 *
 * Fetches REAL usage/credit/quota information from each provider.
 * No fake data — only what the provider actually exposes.
 */

import type { ModelProvider } from "../shared/types.js";

export interface ProviderUsageData {
  provider: ModelProvider;
  label: string;

  /** Connection status. */
  status: "connected" | "disconnected" | "error" | "unsupported";

  /** Credit/balance information. */
  creditsRemaining: number | null;
  creditsUsed: number | null;
  creditsLimit: number | null;
  creditsCurrency: string | null;

  /** Request rate-limit information. */
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsUsed: number | null;

  /** Token rate-limit information. */
  tokensRemaining: number | null;
  tokensLimit: number | null;

  /** When the rate limit resets. */
  resetAt: number | null;

  /** Where this data came from. */
  source: "api" | "headers" | "local" | "unavailable";

  /** Additional info. */
  subtitle: string | null;

  /** When this data was fetched. */
  fetchedAt: number;

  /** Error message if fetch failed. */
  error: string | null;
}

// ── OpenRouter Credits ─────────────────────────────────────────────────

async function fetchOpenRouterUsage(apiKey: string): Promise<ProviderUsageData> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      return {
        provider: "openrouter", label: "OpenRouter", status: "error",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: "USD",
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "api", subtitle: null, fetchedAt: Date.now(),
        error: `OpenRouter API returned HTTP ${res.status}`
      };
    }

    const data = await res.json() as {
      data?: {
        label?: string;
        usage?: number;
        limit?: number;
        is_free_tier?: boolean;
        rate_limit?: {
          requests?: number;
          interval?: string;
        };
      }
    };

    const keyData = data?.data;
    const usage = keyData?.usage ?? null;
    const limit = keyData?.limit ?? null;

    return {
      provider: "openrouter", label: "OpenRouter",
      status: "connected",
      creditsRemaining: limit !== null && usage !== null ? Math.max(0, limit - usage) : null,
      creditsUsed: usage,
      creditsLimit: limit,
      creditsCurrency: "USD",
      requestsRemaining: keyData?.rate_limit?.requests ?? null,
      requestsLimit: null,
      requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "api",
      subtitle: keyData?.is_free_tier ? "Free tier" : null,
      fetchedAt: Date.now(), error: null
    };
  } catch (err) {
    return {
      provider: "openrouter", label: "OpenRouter", status: "error",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "unavailable", subtitle: null, fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : "Failed to fetch OpenRouter usage"
    };
  }
}

// ── Gemini — rate-limit headers from a test request ────────────────────

async function fetchGeminiUsage(apiKey: string): Promise<ProviderUsageData> {
  try {
    // Make a lightweight request to capture rate-limit headers
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) }
    );

    const headers = res.headers;
    const limitHeader = headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit");
    const remainingHeader = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
    const resetHeader = headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");

    const requestsLimit = limitHeader ? parseInt(limitHeader, 10) : null;
    const requestsRemaining = remainingHeader ? parseInt(remainingHeader, 10) : null;
    const resetAt = resetHeader ? (parseInt(resetHeader, 10) > 1e12 ? parseInt(resetHeader, 10) : Date.now() + parseInt(resetHeader, 10) * 1000) : null;

    if (!res.ok && res.status !== 429) {
      return {
        provider: "gemini", label: "Gemini", status: "error",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "unavailable", subtitle: null, fetchedAt: Date.now(),
        error: `Gemini API returned HTTP ${res.status}`
      };
    }

    return {
      provider: "gemini", label: "Gemini",
      status: "connected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining,
      requestsLimit: isNaN(requestsLimit ?? NaN) ? null : requestsLimit,
      requestsUsed: (requestsLimit && requestsRemaining && !isNaN(requestsLimit) && !isNaN(requestsRemaining)) ? requestsLimit - requestsRemaining : null,
      tokensRemaining: null, tokensLimit: null,
      resetAt: isNaN(resetAt ?? NaN) ? null : resetAt,
      source: "headers",
      subtitle: "Google AI — rate limits from API headers",
      fetchedAt: Date.now(), error: null
    };
  } catch (err) {
    return {
      provider: "gemini", label: "Gemini", status: "error",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "unavailable", subtitle: null, fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : "Failed to fetch Gemini usage"
    };
  }
}

// ── Groq — rate-limit headers from a test request ──────────────────────

async function fetchGroqUsage(apiKey: string): Promise<ProviderUsageData> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });

    const headers = res.headers;
    const limitHeader = headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit");
    const remainingHeader = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
    const resetHeader = headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");

    const requestsLimit = limitHeader ? parseInt(limitHeader, 10) : null;
    const requestsRemaining = remainingHeader ? parseInt(remainingHeader, 10) : null;
    const resetAt = resetHeader ? (parseInt(resetHeader, 10) > 1e12 ? parseInt(resetHeader, 10) : Date.now() + parseInt(resetHeader, 10) * 1000) : null;

    if (!res.ok && res.status !== 429) {
      return {
        provider: "groq", label: "Groq", status: "error",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "unavailable", subtitle: null, fetchedAt: Date.now(),
        error: `Groq API returned HTTP ${res.status}`
      };
    }

    return {
      provider: "groq", label: "Groq",
      status: "connected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining,
      requestsLimit: isNaN(requestsLimit ?? NaN) ? null : requestsLimit,
      requestsUsed: (requestsLimit && requestsRemaining && !isNaN(requestsLimit) && !isNaN(requestsRemaining)) ? requestsLimit - requestsRemaining : null,
      tokensRemaining: null, tokensLimit: null,
      resetAt: isNaN(resetAt ?? NaN) ? null : resetAt,
      source: "headers",
      subtitle: "Rate limits from API response headers",
      fetchedAt: Date.now(), error: null
    };
  } catch (err) {
    return {
      provider: "groq", label: "Groq", status: "error",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "unavailable", subtitle: null, fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : "Failed to fetch Groq usage"
    };
  }
}

// ── Puter — check account status ───────────────────────────────────────

async function fetchPuterUsage(): Promise<ProviderUsageData> {
  // Check if Puter is actually connected by hitting the /whoami endpoint
  try {
    // Try to get the Puter token from the store
    const res = await fetch("https://api.puter.com/whoami", {
      signal: AbortSignal.timeout(5_000)
    });
    if (res.ok) {
      const data = await res.json() as { username?: string };
      return {
        provider: "puter", label: "Puter",
        status: "connected",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "api",
        subtitle: data.username ? `Signed in as ${data.username} — usage varies by model` : "Cloud AI — usage varies by model",
        fetchedAt: Date.now(), error: null
      };
    }
    return {
      provider: "puter", label: "Puter", status: "disconnected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "unavailable",
      subtitle: "Not connected — sign in via Puter settings",
      fetchedAt: Date.now(), error: null
    };
  } catch {
    return {
      provider: "puter", label: "Puter", status: "disconnected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "unavailable",
      subtitle: "Unable to check Puter status",
      fetchedAt: Date.now(), error: null
    };
  }
}

// ── Ollama — local server ──────────────────────────────────────────────

async function fetchOllamaUsage(): Promise<ProviderUsageData> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/version", {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json() as { version?: string };
      return {
        provider: "ollama", label: "Ollama",
        status: "connected",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "local",
        subtitle: `Local — v${data.version ?? "unknown"} · No cloud quota`,
        fetchedAt: Date.now(), error: null
      };
    }
    return {
      provider: "ollama", label: "Ollama", status: "disconnected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "local", subtitle: "Local server not running", fetchedAt: Date.now(), error: null
    };
  } catch {
    return {
      provider: "ollama", label: "Ollama", status: "disconnected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "local", subtitle: "Local server not running", fetchedAt: Date.now(), error: null
    };
  }
}

// ── OmniRoute — gateway ────────────────────────────────────────────────

async function fetchOmniRouteUsage(): Promise<ProviderUsageData> {
  try {
    const res = await fetch("http://127.0.0.1:20128/v1/models", {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id: string }> };
      const modelCount = data?.data?.length ?? 0;
      return {
        provider: "omniroute", label: "OmniRoute",
        status: "connected",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "local",
        subtitle: `Gateway — ${modelCount} model${modelCount === 1 ? "" : "s"} · Upstream usage depends on connected provider`,
        fetchedAt: Date.now(), error: null
      };
    }
    return {
      provider: "omniroute", label: "OmniRoute", status: "disconnected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "local", subtitle: "Gateway not running", fetchedAt: Date.now(), error: null
    };
  } catch {
    return {
      provider: "omniroute", label: "OmniRoute", status: "disconnected",
      creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
      requestsRemaining: null, requestsLimit: null, requestsUsed: null,
      tokensRemaining: null, tokensLimit: null, resetAt: null,
      source: "local", subtitle: "Gateway not running", fetchedAt: Date.now(), error: null
    };
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export async function fetchProviderUsage(
  provider: ModelProvider,
  apiKey?: string | null
): Promise<ProviderUsageData> {
  switch (provider) {
    case "openrouter":
      return apiKey ? fetchOpenRouterUsage(apiKey) : {
        provider: "openrouter", label: "OpenRouter", status: "disconnected",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "unavailable", subtitle: "API key not configured", fetchedAt: Date.now(), error: null
      };
    case "gemini":
      return apiKey ? fetchGeminiUsage(apiKey) : {
        provider: "gemini", label: "Gemini", status: "disconnected",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "unavailable", subtitle: "API key not configured", fetchedAt: Date.now(), error: null
      };
    case "groq":
      return apiKey ? fetchGroqUsage(apiKey) : {
        provider: "groq", label: "Groq", status: "disconnected",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "unavailable", subtitle: "API key not configured", fetchedAt: Date.now(), error: null
      };
    case "puter":
      return fetchPuterUsage();
    case "ollama":
      return fetchOllamaUsage();
    case "omniroute":
      return fetchOmniRouteUsage();
    default:
      return {
        provider, label: provider, status: "unsupported",
        creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
        requestsRemaining: null, requestsLimit: null, requestsUsed: null,
        tokensRemaining: null, tokensLimit: null, resetAt: null,
        source: "unavailable", subtitle: "Provider not supported for usage tracking", fetchedAt: Date.now(), error: null
      };
  }
}

export async function fetchAllProviderUsage(
  getApiKey: (provider: ModelProvider) => string | undefined
): Promise<ProviderUsageData[]> {
  const providers: ModelProvider[] = ["gemini", "openrouter", "groq", "puter", "ollama", "omniroute"];
  const results = await Promise.allSettled(
    providers.map((p) => fetchProviderUsage(p, getApiKey(p)))
  );
  return results.map((r, i) => r.status === "fulfilled" ? r.value : {
    provider: providers[i], label: providers[i], status: "error" as const,
    creditsRemaining: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null,
    requestsRemaining: null, requestsLimit: null, requestsUsed: null,
    tokensRemaining: null, tokensLimit: null, resetAt: null,
    source: "unavailable" as const, subtitle: null, fetchedAt: Date.now(),
    error: "Failed to fetch usage"
  });
}
