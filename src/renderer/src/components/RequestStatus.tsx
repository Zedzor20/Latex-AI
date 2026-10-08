import { memo, useEffect, useRef, useState } from "react";
import type { AgentTaskPhase, AgentTaskTimings } from "../../../shared/types";
import { Spinner } from "./ui";

/**
 * Compact live response status: "● Working · 4s".
 *
 * Everything it renders comes from the REAL request lifecycle the main process
 * already reports (`phase` + `timings` milestones) — this component never
 * invents progress and never guesses a provider state. It is purely
 * observational: no IPC, no provider calls, no state writes.
 *
 * Isolation is the point. The timer keeps its own 1s interval INSIDE this
 * component, so the conversation above it never re-renders per tick: the parent
 * re-renders ~30×/s while streaming, and this row re-renders ~1×/s on its own.
 */
export type RequestOutcome = "stopped" | "error" | null;

/** Whole seconds, floored — never a fractional ticker. */
function seconds(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 1000));
}

/**
 * The honest label for a phase.
 *
 * `thinkingActive` means the model has actually streamed reasoning, so the row
 * says "Thinking" instead of the vaguer "Waiting for model". It is never true
 * for a model whose provider exposes no reasoning — no thinking is ever
 * fabricated.
 *
 * Ordering note: a reasoning delta is a REAL provider event, but the lifecycle
 * only reaches `streaming` on the first *visible* token. So for a model that
 * thinks before it answers, `thinkingActive` has to outrank `waiting_for_provider`
 * — otherwise the row would claim the model is still silent while its reasoning
 * is already on screen, which is exactly the dishonesty this row exists to avoid.
 */
function statusLabel(
  phase: AgentTaskPhase | null | undefined,
  thinkingActive: boolean,
  outcome: RequestOutcome
): string {
  // Terminal states win over the phase: after a stop/failure the phase is no
  // longer the truth the user cares about.
  if (outcome === "stopped") return "Cancelled";
  if (outcome === "error") return "Failed";
  switch (phase) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "tool_execution":
      return "Working";
    case "finalizing":
      return "Responding";
    default:
      break;
  }
  // Reasoning is genuinely arriving → the model IS working, just quietly.
  if (thinkingActive) return "Thinking";
  switch (phase) {
    case "streaming":
      return "Responding";
    case "requesting_model":
    case "waiting_for_provider":
      return "Waiting for model";
    default:
      // starting / planning / unknown → generic, honest "Working".
      return "Working";
  }
}

/** True when the row should be on screen at all. */
export function shouldShowRequestStatus(
  busy: boolean,
  outcome: RequestOutcome
): boolean {
  return busy || outcome != null;
}

export const RequestStatus = memo(function RequestStatus({
  busy,
  phase,
  timings,
  startedAt,
  outcome,
  thinkingActive
}: {
  /** True while this chat has a request in flight. */
  busy: boolean;
  /** Real lifecycle phase from the main process (never inferred here). */
  phase?: AgentTaskPhase | null;
  /** Real timing milestones: requestStartedAt, firstProviderEventAt, … */
  timings?: AgentTaskTimings | null;
  /** Epoch ms the renderer dispatched this turn — the floor for the timer. */
  startedAt?: number | null;
  /** Terminal state of this response; null while it runs. */
  outcome?: RequestOutcome;
  /** The model has streamed real reasoning during this turn. */
  thinkingActive?: boolean;
}) {
  // Timer base: the EARLIEST real start instant we have.
  //
  // `startedAt` is stamped in the renderer at the moment the turn is dispatched
  // (so the row reads "Working · 0s" on the very first frame), and the main
  // process milestones are the fallback for a restored/backgrounded run.
  // Earliest-first matters: picking `requestStartedAt` would EXCLUDE local
  // planning and context building, so the number would jump forward the instant
  // that milestone landed. One timer, one base, never reset on a phase change.
  const base =
    startedAt ?? timings?.taskStartedAt ?? timings?.requestStartedAt ?? null;

  const [tick, setTick] = useState(0);
  const [settledSeconds, setSettledSeconds] = useState<number | null>(null);
  const baseRef = useRef<number | null>(base);
  baseRef.current = base;

  // Freeze the elapsed time the moment the run settles. Reading Date.now()
  // during render would keep a finished row counting forever.
  useEffect(() => {
    if (!busy) {
      const start = baseRef.current;
      if (start != null) setSettledSeconds(seconds(start, Date.now()));
    } else {
      setSettledSeconds(null);
    }
  }, [busy]);

  // One tick per second, and ONLY while this row is actually visible and
  // counting. A hidden or settled row schedules nothing.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  if (!shouldShowRequestStatus(busy, outcome ?? null)) return null;

  const label = statusLabel(phase, Boolean(thinkingActive), outcome ?? null);
  const elapsed = busy
    ? base != null
      ? seconds(base, Date.now())
      : null
    : settledSeconds;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  void tick;

  return (
    <div className="requestStatus" role="status" aria-live="polite">
      <span className="requestStatusIcon">
        {busy ? (
          <Spinner size={11} />
        ) : outcome === "stopped" || outcome === "error" ? (
          <span className="requestStatusStopDot" />
        ) : (
          <span className="requestStatusDoneDot" />
        )}
      </span>
      <span className="requestStatusLabel">{label}</span>
      {elapsed != null && <span className="requestStatusElapsed"> · {elapsed}s</span>}
    </div>
  );
});