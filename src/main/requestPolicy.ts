/**
 * Shared long-running request policy for EVERY Latex provider/model.
 *
 * History: Latex used to cap a single model call at 90 seconds (180s for
 * local Ollama) via AbortSignal.timeout(...). That terminated legitimately
 * long streaming generations (OmniRoute, OpenRouter, Puter, Gemini, ... ) at
 * ~1m30s. That limit is removed.
 *
 * Policy (applies to all providers through the common agent layer):
 * - One task may run for at most AGENT_MAX_RUNTIME_MS (30 minutes),
 *   measured from TASK START — not per model call, not from UI visibility.
 * - While bytes/tokens are streaming, the request stays alive: every chunk
 *   resets the idle timer. A generation is aborted early ONLY if nothing at
 *   all arrives for AGENT_IDLE_TIMEOUT_MS (safety against a silently dead
 *   socket).
 * - Connection/first-byte probes (status checks, model lists) keep their own
 *   short timeouts elsewhere — those are NOT generation timeouts.
 * - When the guard aborts, callers must report a TIMEOUT
 *   (errorType "timeout" / task status "timed_out"), never a silent finish.
 *
 * Explicit user Stop goes through AbortController.abort() on the agent's own
 * controller (checked via `stopped`) — the guard never replaces it.
 */

/** Maximum continuous runtime of a single agent task/request: 30 minutes. */
export const AGENT_MAX_RUNTIME_MS = 30 * 60 * 1000;

/**
 * Safety net for a stream that goes completely silent (no bytes at all).
 * Reset on every received chunk — active generation never hits this.
 */
export const AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type RuntimeAbortReason = "max_runtime" | "idle";

/**
 * Per-task runtime guard.
 *
 * Created once when a task starts, shared by every model call inside that
 * task (including fallback/retry calls), disposed when the task ends.
 */
export class AgentRuntimeGuard {
  private controller = new AbortController();
  private startedAt = Date.now();
  private reason: RuntimeAbortReason | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxRuntimeMs: number;
  private readonly idleMs: number;

  constructor(options?: { maxRuntimeMs?: number; idleMs?: number }) {
    this.maxRuntimeMs = options?.maxRuntimeMs ?? AGENT_MAX_RUNTIME_MS;
    this.idleMs = options?.idleMs ?? AGENT_IDLE_TIMEOUT_MS;
    this.totalTimer = setTimeout(() => this.abort("max_runtime"), this.maxRuntimeMs);
    this.idleTimer = setTimeout(() => this.abort("idle"), this.idleMs);
  }

  /** Combine with the agent's stop signal for the provider fetch. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds since the TASK started (used for attribution/messages). */
  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Why the guard aborted, if it did. null while alive. */
  get abortReason(): RuntimeAbortReason | null {
    return this.reason;
  }

  /** Call on every received chunk/byte — keeps the stream alive. */
  noteActivity(): void {
    if (this.controller.signal.aborted) return;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.abort("idle"), this.idleMs);
  }

  private abort(reason: RuntimeAbortReason): void {
    if (this.controller.signal.aborted) return;
    this.reason = reason;
    this.controller.abort();
  }

  dispose(): void {
    if (this.totalTimer !== null) clearTimeout(this.totalTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.totalTimer = null;
    this.idleTimer = null;
  }
}
