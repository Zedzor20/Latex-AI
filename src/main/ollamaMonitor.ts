import type { GeminiModel, OllamaStatus } from "../shared/types.js";
import { checkOllamaStatus, fetchOllamaModels } from "./ollamaService.js";

/**
 * The ONE Ollama model monitor.
 *
 * Latex used to learn about Ollama's models only when the user clicked
 * "Refresh Models": the background probe ran every 15 seconds but published
 * only a connection STATE change, so a model pulled while the server stayed up
 * was invisible, and a server that appeared late was noticed up to 15 seconds
 * later at best. Components that wanted to be correct therefore polled for
 * themselves, which is how one machine ends up with several timers, several
 * identical `/api/tags` requests and a picker that re-renders to no effect.
 *
 * This service is the single owner of that work:
 *
 *   • ONE timer, owned by the main process — never by a React component, so
 *     mounting a chat, opening the model picker or switching tabs cannot create
 *     a second loop;
 *   • an IN-FLIGHT guard — a probe that outlives its 5-second slot makes the
 *     next tick a no-op instead of stacking a concurrent request;
 *   • CHANGE DETECTION — the catalog is compared against the last one and
 *     listeners are only told when the connection state or the model list
 *     actually moved. An unchanged catalog publishes NOTHING, so the renderer
 *     never rebuilds the model list, never resets the selected model and never
 *     re-renders the conversation for a poll that found nothing;
 *   • the existing Ollama API discovery (`checkOllamaStatus` /
 *     `fetchOllamaModels`) — no second Ollama implementation, no model names
 *     hardcoded anywhere.
 *
 * Capabilities come from the same `/api/tags` payload the model list does, so a
 * 5-second check costs one local HTTP request and infers nothing per model
 * unless that model actually changed. No per-model probing is added here.
 */

/** How often Ollama is checked while Latex runs. */
export const OLLAMA_MONITOR_INTERVAL_MS = 5_000;

/** The cached catalog: what the last successful probe really found. */
export interface OllamaCatalog {
  status: OllamaStatus;
  models: GeminiModel[];
}

/** Which parts of the catalog moved — the renderer refreshes only those. */
export interface OllamaCatalogChange {
  status: boolean;
  models: boolean;
}

type OllamaCatalogListener = (catalog: OllamaCatalog, change: OllamaCatalogChange) => void;

/**
 * Everything about a model the picker and the request layer read. Two catalogs
 * with the same signature are indistinguishable to the UI, so one must not be
 * published for the other.
 */
function catalogSignature(models: GeminiModel[]): string {
  return models
    .map((model) => [
      model.name,
      model.displayName ?? "",
      model.contextLength ?? "",
      model.supportsTools ? 1 : 0,
      model.supportsVision ? 1 : 0,
      model.supportsReasoning ? 1 : 0,
      model.supportsStreaming ? 1 : 0,
      (model.capabilities ?? []).join(",")
    ].join("|"))
    .join("\n");
}

/** Connection-relevant fields only — `checkedAt` alone is never a change. */
function sameStatus(a: OllamaStatus, b: OllamaStatus): boolean {
  return a.state === b.state
    && (a.version ?? "") === (b.version ?? "")
    && (a.localModelCount ?? 0) === (b.localModelCount ?? 0)
    && (a.cloudModelCount ?? 0) === (b.cloudModelCount ?? 0)
    && Boolean(a.cloudAvailable) === Boolean(b.cloudAvailable)
    && (a.appPath ?? "") === (b.appPath ?? "")
    && (a.error ?? "") === (b.error ?? "");
}

export class OllamaMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private listeners = new Set<OllamaCatalogListener>();
  private last: OllamaCatalog | null = null;
  private lastStatus: OllamaStatus | null = null;
  private lastSignature = "";

  /**
   * Begin the loop. Idempotent: calling it twice must not create a second
   * interval, which is what makes it safe to call from more than one startup
   * path.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, OLLAMA_MONITOR_INTERVAL_MS);
  }

  /** Stop the loop. Called on quit so no timer outlives the app. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** The last catalog, or null before the first probe answered. */
  getCatalog(): OllamaCatalog | null {
    return this.last;
  }

  /** Subscribe to REAL changes only. Returns the unsubscribe function. */
  onUpdate(listener: OllamaCatalogListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Probe NOW (a manual refresh, or right after Latex started the server).
   * Shares the same in-flight guard as the loop, so an explicit refresh can
   * never race the scheduled one into two concurrent requests.
   */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  /**
   * One probe. Never overlaps another and never throws: a probe that fails
   * leaves the previous catalog in place, so a server that blinked does not
   * empty the model list.
   */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const status = await checkOllamaStatus();
      let models: GeminiModel[];
      if (status.state === "connected") {
        try {
          models = (await fetchOllamaModels()).map((discovered) => discovered.model);
        } catch {
          // The server answered its version route but not the catalog route —
          // a transient hiccup. Keep the list we already showed rather than
          // blanking the picker over one failed read.
          models = this.last?.models ?? [];
        }
      } else {
        // No server, no models. This is a real change when it happens.
        models = [];
      }
      this.publish(status, models);
    } catch {
      // checkOllamaStatus never throws — defensive only.
    } finally {
      this.inFlight = false;
    }
  }

  private publish(status: OllamaStatus, models: GeminiModel[]): void {
    const signature = catalogSignature(models);
    const statusChanged = !this.lastStatus || !sameStatus(this.lastStatus, status);
    const modelsChanged = signature !== this.lastSignature;
    // Record the new state FIRST, so a throwing listener can never make the
    // next tick re-publish the same change.
    this.lastStatus = status;
    this.lastSignature = signature;
    this.last = { status, models };
    if (!statusChanged && !modelsChanged) return;
    const change: OllamaCatalogChange = { status: statusChanged, models: modelsChanged };
    for (const listener of this.listeners) {
      try {
        listener(this.last, change);
      } catch {
        // One listener must never break the loop for the others.
      }
    }
  }
}

/** The app-wide monitor. Exactly one instance, owned by the main process. */
export const ollamaMonitor = new OllamaMonitor();
