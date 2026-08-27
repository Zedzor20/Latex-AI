/**
 * Safely extract a human-readable message from ANY value.
 * Used throughout the codebase to prevent [object Object] from reaching the UI.
 *
 * Handles: strings, Error instances, nested error objects, API response shapes,
 * HTTP responses, arrays, null/undefined, circular references.
 */
export function safeExtractMessage(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  // Error instances: use message or name
  if (value instanceof Error) return value.message || value.name || "Unknown error";

  // Objects: try to extract useful string fields
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // 1. Direct .message field (ProviderError, standard Error-like objects)
    if (typeof obj.message === "string" && obj.message) return obj.message;

    // 2. { error: { message: "..." } } — common API response shape
    if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === "string" && inner.message) return inner.message;
      // { error: { error: { message: "..." } } } — deeply nested
      if (inner.error && typeof inner.error === "object") {
        const deep = inner.error as Record<string, unknown>;
        if (typeof deep.message === "string" && deep.message) return deep.message;
      }
      // { error: "string" }
      if (typeof inner.error === "string") return inner.error;
      // { error: { detail: "..." } }
      if (typeof inner.detail === "string" && inner.detail) return inner.detail;
    }

    // 3. { error: "string" }
    if (typeof obj.error === "string") return obj.error;

    // 4. { detail: "..." } or { details: "..." }
    if (typeof obj.detail === "string" && obj.detail) return obj.detail;
    if (typeof obj.details === "string" && obj.details) return obj.details;

    // 5. { reason: "..." }
    if (typeof obj.reason === "string" && obj.reason) return obj.reason;

    // 6. HTTP response-like: { status: number, statusText: string }
    if (typeof obj.status === "number" && typeof obj.statusText === "string") {
      return `HTTP ${obj.status}: ${obj.statusText}`;
    }

    // 7. { data: { error: { message } } } — nested API response
    if (obj.data && typeof obj.data === "object") {
      const dataObj = obj.data as Record<string, unknown>;
      if (dataObj.error && typeof dataObj.error === "object") {
        const errInner = dataObj.error as Record<string, unknown>;
        if (typeof errInner.message === "string" && errInner.message) return errInner.message;
      }
      if (typeof dataObj.error === "string") return dataObj.error;
      if (typeof dataObj.message === "string" && dataObj.message) return dataObj.message;
    }

    // 8. Last resort: safe JSON serialization with circular-reference protection
    try {
      const seen = new WeakSet();
      const safe = JSON.stringify(obj, (key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
      const parsed = JSON.parse(safe) as Record<string, unknown>;
      const parts: string[] = [];
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v) parts.push(`${k}: ${v}`);
        else if (typeof v === "number") parts.push(`${k}: ${v}`);
      }
      if (parts.length) return parts.join(" | ");
      if (safe.length > 2 && safe !== "{}" && safe !== "[]") {
        return safe.length > 500 ? safe.slice(0, 500) + "..." : safe;
      }
    } catch { /* fall through */ }
  }

  // Final fallback — NEVER return "[object Object]"
  try {
    const s = String(value);
    if (s === "[object Object]" || s === "[object Array]") {
      return "Unknown provider error";
    }
    return s;
  } catch {
    return "Unknown provider error";
  }
}
