/**
 * Provider Usage & Limits Tracking
 *
 * Normalized structure for displaying provider quota/limit information.
 * Every field can be null if the provider does not expose it.
 */

export interface ProviderUsage {
  /** Provider identifier. */
  provider: string;
  /** Human-readable label. */
  label: string;

  /** Request counts. */
  requestsUsed: number | null;
  requestsLimit: number | null;

  /** Token counts. */
  inputTokensUsed: number | null;
  inputTokensLimit: number | null;
  outputTokensUsed: number | null;
  outputTokensLimit: number | null;

  /** Credit/cost information. */
  creditsUsed: number | null;
  creditsLimit: number | null;
  creditsCurrency: string | null;

  /** When the quota resets. */
  resetAt: number | null;

  /** Additional info (e.g. "Local", "Gateway"). */
  subtitle: string | null;

  /** Where this data came from. */
  source: "headers" | "api" | "local" | "unavailable";

  /** When this data was fetched. */
  fetchedAt: number;
}

/**
 * Extract usage info from provider response headers.
 * Providers may use different header names for rate limiting.
 */
export function extractUsageFromHeaders(
  provider: string,
  headers: Headers
): Partial<ProviderUsage> {
  const result: Partial<ProviderUsage> = {};

  // Common rate-limit header patterns
  const limitHeader = headers.get("x-ratelimit-limit")
    ?? headers.get("x-rate-limit-limit")
    ?? headers.get("ratelimit-limit");
  const remainingHeader = headers.get("x-ratelimit-remaining")
    ?? headers.get("x-rate-limit-remaining")
    ?? headers.get("ratelimit-remaining");
  const resetHeader = headers.get("x-ratelimit-reset")
    ?? headers.get("x-rate-limit-reset")
    ?? headers.get("ratelimit-reset");

  if (limitHeader) {
    const limit = parseInt(limitHeader, 10);
    if (!isNaN(limit)) result.requestsLimit = limit;
  }

  if (remainingHeader) {
    const remaining = parseInt(remainingHeader, 10);
    if (!isNaN(remaining)) {
      result.requestsUsed = (result.requestsLimit ?? 0) - remaining;
    }
  }

  if (resetHeader) {
    const reset = parseInt(resetHeader, 10);
    if (!isNaN(reset)) {
      // Could be epoch seconds or relative seconds
      result.resetAt = reset > 1e12 ? reset : Date.now() + reset * 1000;
    }
  }

  return result;
}

/** Format a usage percentage for display. */
export function usagePercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit === 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** Format a time until reset. */
export function formatResetTime(resetAt: number | null): string | null {
  if (!resetAt) return null;
  const diff = resetAt - Date.now();
  if (diff <= 0) return "Now";

  const hours = Math.floor(diff / 3600_000);
  const minutes = Math.floor((diff % 3600_000) / 60_000);

  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

/** Format a large number for display (e.g. 1200000 → "1.2M"). */
export function formatNumber(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format credits/cost for display. */
export function formatCredits(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  if (currency) return `${currency}${amount.toFixed(2)}`;
  return `$${amount.toFixed(2)}`;
}
