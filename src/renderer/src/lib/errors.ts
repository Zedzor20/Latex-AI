import type { ModelProvider } from "../../../shared/types";

export interface ErrorInfo {
  /** Short friendly message shown to the user. */
  message: string;
  /** Raw technical detail, shown in expandable <details>. */
  detail: string;
  /** Optional action the user can take from the error card. */
  action?: "settings" | "retry" | "fixModel" | "openFolder";
  actionLabel?: string;
}

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  gemini: "Gemini",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  groq: "Groq",
  puter: "Puter",
  ollama: "Ollama",
  omniroute: "OmniRoute"
};

/** Detect the provider from the raw error text when the caller doesn't know it. */
function providerFromMessage(raw: string): ModelProvider | undefined {
  const lower = raw.toLowerCase();
  if (lower.includes("openrouter")) return "openrouter";
  if (lower.includes("minimax")) return "minimax";
  if (lower.includes("groq")) return "groq";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("ollama")) return "ollama";
  return undefined;
}

/**
 * Resolve the correct provider label for an error.
 * Priority: explicit provider param → provider detected from error text → fallback.
 */
function resolveProvider(err: unknown, provider?: ModelProvider): ModelProvider {
  // If the error is a serialized ProviderError, extract its provider field
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.provider === "string" && obj.provider in PROVIDER_LABELS) {
      return obj.provider as ModelProvider;
    }
  }
  const raw = err instanceof Error ? err.message : String(err ?? "");
  // Try to detect from error message
  const detected = providerFromMessage(raw);
  if (detected) return detected;
  // Fall back to explicit provider parameter
  return provider ?? "gemini";
}

/**
 * Turn an arbitrary thrown value (usually an ipcRenderer.invoke rejection) into
 * a friendly, actionable message. Strips Electron's "Error invoking remote
 * method 'x': " prefix and maps known failure classes. Never surfaces secrets.
 *
 * When `provider` is known (e.g. a connection test), its label is used; the
 * provider is also detected from the error text itself so agent errors from any
 * provider are never mislabeled as Gemini.
 */
/** Safely extract a human-readable message from any value (avoids [object Object]). */
export function safeMessage(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    // Structured ProviderError from the main process (preserved by serializeError)
    if (typeof obj.message === "string" && obj.message) {
      // Check if the message itself is a safe string (not [object Object])
      if (obj.message !== "[object Object]" && obj.message !== "[object Array]") {
        return obj.message;
      }
      // message is [object Object] — extract a better message from other fields
    }
    // Common nested error shapes: { error: { message } } or { error: { error: { message } } }
    if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === "string" && inner.message && !inner.message.startsWith("[object")) return inner.message;
      if (inner.error && typeof inner.error === "object") {
        const deep = inner.error as Record<string, unknown>;
        if (typeof deep.message === "string" && deep.message && !deep.message.startsWith("[object")) return deep.message;
      }
      if (typeof inner.error === "string") return inner.error;
    }
    if (typeof obj.error === "string" && obj.error) return obj.error;
    if (typeof obj.detail === "string" && obj.detail && !obj.detail.startsWith("[object")) return obj.detail;
    if (typeof obj.details === "string" && obj.details) return obj.details;
    if (typeof obj.reason === "string" && obj.reason) return obj.reason;
    if (typeof obj.statusText === "string") return obj.statusText;
    // For HTTP-like response objects, extract status + text
    if (typeof obj.status === "number" && typeof obj.statusText === "string") {
      return `HTTP ${obj.status}: ${obj.statusText}`;
    }
    // data.error.message pattern (Axios-style errors)
    if (obj.data && typeof obj.data === "object") {
      const dataObj = obj.data as Record<string, unknown>;
      if (dataObj.error && typeof dataObj.error === "object") {
        const errInner = dataObj.error as Record<string, unknown>;
        if (typeof errInner.message === "string" && errInner.message) return errInner.message;
      }
      if (typeof dataObj.error === "string") return dataObj.error;
      if (typeof dataObj.message === "string" && dataObj.message) return dataObj.message;
    }
    // Last resort: serialize with circular-reference safety
    try {
      const seen = new WeakSet();
      const safe = JSON.stringify(obj, (key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[circular]";
          seen.add(value);
        }
        return value;
      });
      const parsed = JSON.parse(safe) as Record<string, unknown>;
      const parts: string[] = [];
      for (const [k, v] of Object.entries(parsed)) {
        // Skip internal fields that could contain objects
        if (k === "stack") continue;
        if (typeof v === "string" && v && !v.startsWith("[object")) parts.push(`${k}: ${v}`);
        else if (typeof v === "number") parts.push(`${k}: ${v}`);
      }
      if (parts.length) return parts.join(" | ");
      // If nothing useful, return a truncated version of the JSON
      if (safe.length > 0 && safe !== "{}" && safe !== "[]") {
        return safe.length > 500 ? safe.slice(0, 500) + "..." : safe;
      }
    } catch { /* fall through */ }
  }
  // Final fallback — NEVER return "[object Object]"
  try {
    const s = String(err);
    if (s === "[object Object]" || s === "[object Array]") {
      return "An error occurred (details unavailable).";
    }
    return s;
  } catch {
    return "An error occurred (details unavailable).";
  }
}

export function translateError(err: unknown, provider?: ModelProvider): ErrorInfo {
  let raw = safeMessage(err);
  raw = raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "");

  // CRITICAL: double-check that raw never contains [object Object]
  if (raw.includes("[object Object]") || raw.includes("[object Array]")) {
    // Re-extract from the raw value without String()
    raw = safeMessage(err);
    // If still bad, use a safe fallback
    if (raw.includes("[object Object]") || raw.includes("[object Array]") || !raw) {
      raw = "An unexpected error occurred.";
    }
  }

  const detail = raw.trim() || "No additional details available.";

  // Extract provider from the error object itself
  // (serialized ProviderError has .provider as own property after serializeError)
  const errObj: Record<string, unknown> | undefined =
    (err && typeof err === "object") ? err as Record<string, unknown> : undefined;

  // Use the error's own provider if available, otherwise fall back to the parameter
  const errorProvider = errObj?.provider && typeof errObj.provider === "string" && errObj.provider in PROVIDER_LABELS
    ? errObj.provider as ModelProvider
    : undefined;
  const resolvedProvider = errorProvider ?? resolveProvider(err, provider);
  const label = PROVIDER_LABELS[resolvedProvider];

  // Extract structured fields for rich display — always coerce to string
  const status = errObj?.status != null ? String(errObj.status) : (detail.match(/HTTP\s+(\d{3})/i) || [])[1];
  const model = errObj?.model != null ? String(errObj.model) : undefined;
  const errorType = errObj?.errorType != null ? String(errObj.errorType) : undefined;

  // Build rich detail string with provider / model / status
  // CRITICAL: only use string values — never allow an object to appear here
  const richDetailParts: string[] = [];
  if (model && typeof model === "string") richDetailParts.push(`Model: ${model}`);
  if (status && typeof status === "string") richDetailParts.push(`HTTP: ${status}`);
  const safeDetail = typeof detail === "string" ? detail : safeMessage(detail);
  // Final safety check: ensure safeDetail never contains [object Object]
  const cleanDetail = safeDetail.includes("[object Object]") ? "An unexpected error occurred." : safeDetail;
  if (cleanDetail) richDetailParts.push(`Reason: ${cleanDetail}`);
  const richDetail = richDetailParts.length > 0 ? richDetailParts.join("\n") : cleanDetail;

  // Timeout / aborted requests: use the error's OWN provider+model metadata
  // so the card names the model that actually stalled — never whatever model
  // happens to be selected now (the old "Ollama qwen…" misattribution bug).
  if (errObj?.errorType === "timeout" || /did not respond within|timed out/i.test(raw)) {
    const m = model ? ` (${modelShortName(model)})` : "";
    // Task-level 30-minute maximum (shared request policy) — say so plainly
    // instead of implying the model was merely slow (Part S).
    if (/30-minute maximum runtime/i.test(raw)) {
      return {
        message: "Generation reached the 30-minute maximum runtime",
        detail: richDetail,
        action: "retry",
        actionLabel: "Retry"
      };
    }
    return {
      message: `${label}${m} timed out — the model didn't respond in time`,
      detail: richDetail,
      action: "retry",
      actionLabel: "Retry"
    };
  }
  if (errObj?.errorType === "aborted" || /operation was aborted/i.test(raw)) {
    const attributed = Boolean(errorProvider || model);
    const m = model ? ` (${modelShortName(model)})` : "";
    return {
      message: attributed
        ? `${label}${m} — request stopped before the model finished`
        : "The request was stopped before the model responded.",
      detail: richDetail,
      action: "retry",
      actionLabel: "Retry"
    };
  }

  // Handle structured ProviderError messages (they already contain the correct provider)
  // Pattern: "OpenRouter request failed (HTTP 402). ..."
  const structuredMatch = raw.match(/^(OpenRouter|Gemini|Groq|MiniMax)\s+(request failed|hit|error)/i);
  if (structuredMatch) {
    const structuredLabel = structuredMatch[1];
    if (/402|insufficient.*(credit|balance)|payment|billing|no credit/i.test(raw)) {
      return {
        message: `${structuredLabel} request failed — credits unavailable`,
        detail: richDetail,
        action: "retry",
        actionLabel: "Switch Model"
      };
    }
    if (/403|forbidden|permission|guardrail|restricted/i.test(raw)) {
      return {
        message: `${structuredLabel} request forbidden — model may be restricted`,
        detail: richDetail,
        action: "fixModel",
        actionLabel: "Switch Model"
      };
    }
    if (/404|not found|model.*(not|unavailable)/i.test(raw)) {
      return {
        message: `${structuredLabel} model not found or unavailable`,
        detail: richDetail,
        action: "fixModel",
        actionLabel: "Refresh Models"
      };
    }
    if (/401|unauthorized|invalid.*api key|authentication/i.test(raw)) {
      return {
        message: `${structuredLabel} authentication failed — API key may be invalid`,
        detail: richDetail,
        action: "settings",
        actionLabel: "Open Settings"
      };
    }
    if (/429|rate limit|quota|resource exhausted/i.test(raw)) {
      return {
        message: `${structuredLabel} rate limited — try again later or switch models`,
        detail: richDetail,
        action: "retry",
        actionLabel: "Retry"
      };
    }
    if (/400|invalid|unsupported|unexpected/i.test(raw)) {
      return {
        message: `${structuredLabel} rejected the request`,
        detail: richDetail,
        action: "fixModel",
        actionLabel: "Switch Model"
      };
    }
    // Generic structured error
    return {
      message: `${structuredLabel} request failed`,
      detail: richDetail,
      action: "retry",
      actionLabel: "Retry"
    };
  }

  // Fallback to legacy text-based classification
  if (/model.*(not found|no longer available|unavailable)|not found.*model|404/i.test(raw)) {
    return {
      message: `${label} model is unavailable for your API key`,
      detail: richDetail,
      action: "fixModel",
      actionLabel: "Refresh Models"
    };
  }
  if (/choose a gemini model|no gemini model|no model (is )?(selected|chosen)/i.test(raw)) {
    return {
      message: "No model is selected yet — open Settings to choose one.",
      detail,
      action: "settings",
      actionLabel: "Open AI Settings"
    };
  }
  if (/connect gemini in settings|no gemini api key|no (openrouter|minimax|groq) api key|api key has been saved/i.test(raw)) {
    return {
      message: `${label} needs an API key — open Settings to configure it.`,
      detail,
      action: "settings",
      actionLabel: "Open Settings"
    };
  }
  if (/no api key|no api key is configured/i.test(raw)) {
    return {
      message: `${label} needs an API key — open Settings to configure it.`,
      detail,
      action: "settings",
      actionLabel: "Open Settings"
    };
  }
  if (/invalid api key|api key not valid|unauthorized|permission denied/i.test(raw)) {
    return {
      message: `${label} rejected the request — API key may be invalid`,
      detail: richDetail,
      action: "settings",
      actionLabel: "Open Settings"
    };
  }
  if (/ollama.*(not running|isn't running|server|reach the ollama|start ollama)/i.test(raw)) {
    return {
      message: "Ollama isn't running — open the Ollama app to use local models.",
      detail: richDetail,
      action: "retry",
      actionLabel: "Open Ollama"
    };
  }
  if (/ollama.*(not installed|download it)/i.test(raw)) {
    return {
      message: "Ollama is not installed. Download it from ollama.com",
      detail: richDetail,
      action: "retry",
      actionLabel: "Open Settings"
    };
  }
  if (/ollama.*(not found|pull it first|model.*not)/i.test(raw)) {
    return {
      message: "The selected Ollama model is not available locally. Pull it with `ollama pull <model>` and refresh models.",
      detail: richDetail,
      action: "fixModel",
      actionLabel: "Refresh Models"
    };
  }
  if (/network|fetch failed|failed to fetch|enotfound|econnrefused|eai_again|unable to reach/i.test(raw)) {
    return {
      message: `${label} is unavailable — check your internet connection`,
      detail: richDetail,
      action: "retry",
      actionLabel: "Retry"
    };
  }
  if (/429|quota|rate limit|resource exhausted/i.test(raw)) {
    return {
      message: `${label} rate limited — try again later`,
      detail: richDetail,
      action: "retry",
      actionLabel: "Retry"
    };
  }
  if (/402|insufficient.*(credit|balance)|payment|billing|no credit/i.test(raw)) {
    return {
      message: `${label} credits unavailable`,
      detail: richDetail,
      action: "retry",
      actionLabel: "Switch Model"
    };
  }
  if (/outside the approved workspace/i.test(raw)) {
    return {
      message: "Path access blocked — not inside the approved workspace.",
      detail
    };
  }
  if (/open a workspace/i.test(raw)) {
    return {
      message: "This task needs an approved workspace. Open a folder first.",
      detail
    };
  }
  // Build a meaningful error message even for unknown errors
  const providerLabel = label ? `${label} ` : "";
  return { message: `${providerLabel}request failed — ${detail || "unknown error"}`, detail };
}

/** Strip the models/ prefix for compact display, e.g. models/gemini-2.5-flash -> gemini-2.5-flash. */
export function modelShortName(modelName: string): string {
  return modelName.replace(/^models\//, "");
}
