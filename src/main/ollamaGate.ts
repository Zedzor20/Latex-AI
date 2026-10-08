import type { ModelProvider } from "../shared/types.js";

/**
 * Ollama request gate — prevents duplicate simultaneous inference requests.
 *
 * Two overlapping requests to the same local model double VRAM/RAM usage and
 * CPU load (a major cause of whole-PC lag on small machines). One active
 * generation per model is allowed; additional requests fail fast with a
 * friendly message instead of piling up.
 */

/** True when a model id belongs to the local Ollama provider. */
export function isOllamaModel(modelName: string | undefined): boolean {
  return Boolean(modelName && modelName.toLowerCase().startsWith("ollama/"));
}

/** True when the model id refers to an Ollama Cloud model. */
export function isOllamaCloudModel(modelName: string | undefined): boolean {
  if (!isOllamaModel(modelName)) return false;
  return /-cloud|:cloud/i.test(modelName ?? "");
}

const active = new Map<string, number>(); // model → startedAt

/** Try to claim the single generation slot for a model. */
export function requestGate(modelName: string): { ok: true } | { ok: false; error: string } {
  const key = modelName.toLowerCase();
  const started = active.get(key);
  if (started && Date.now() - started < 10 * 60_000) {
    return {
      ok: false,
      error: "Another generation with this Ollama model is already running. Wait for it to finish or press Stop."
    };
  }
  active.set(key, Date.now());
  return { ok: true };
}

/** Release the slot when the request finishes (success, error, or stop). */
export function releaseRequest(modelName: string): void {
  active.delete(modelName.toLowerCase());
}

/** How many generations are currently active for a model (diagnostics). */
export function activeRequests(modelName: string): number {
  return active.has(modelName.toLowerCase()) ? 1 : 0;
}

export type { ModelProvider };
