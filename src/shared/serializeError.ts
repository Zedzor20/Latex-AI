import { safeExtractMessage } from "./safeMessage.js";

/**
 * Serialize any thrown value into an Error instance that preserves all custom
 * properties across Electron IPC.
 *
 * Electron's structured clone strips non-standard properties from Error
 * subclass instances (e.g. ProviderError's .provider, .model, .status).
 * Converting to an Error instance first keeps .message intact for Electron,
 * then we attach custom properties so the renderer can read them.
 *
 * CRITICAL: NEVER returns an object whose String() is "[object Object]".
 * Uses safeExtractMessage to deeply extract human-readable text from nested
 * structures like { error: { message: "..." } }.
 */
export function serializeError(err: unknown): Error {
  let error: Error;
  if (err instanceof Error) {
    error = new Error(err.message);
    error.name = err.name;
    error.stack = err.stack;
    // Copy ProviderError custom properties (provider, model, status, etc.)
    for (const key of Object.keys(err)) {
      if (key !== "message" && key !== "name" && key !== "stack") {
        (error as any)[key] = (err as any)[key];
      }
    }
  } else if (err && typeof err === "object") {
    // Use safeExtractMessage for deep extraction — handles nested structures
    // like { error: { message: "..." } } that plain .message misses.
    const msg = safeExtractMessage(err) || "Unknown provider error";
    error = new Error(msg);
    error.name = "Error";
    // Copy all properties from the original object onto the Error
    for (const key of Object.keys(err)) {
      (error as any)[key] = (err as any)[key];
    }
  } else {
    const msg = typeof err === "string" ? err : String(err ?? "Unknown error");
    error = new Error(msg);
  }
  // Final safety: NEVER allow [object Object] as the message
  if (error.message === "[object Object]" || error.message === "[object Array]") {
    error.message = safeExtractMessage(err) || "Unknown provider error";
  }
  return error;
}
