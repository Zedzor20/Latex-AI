import type { AgentTaskPhase } from "../../../shared/types";

/**
 * Human label for a real request phase.
 *
 * The activity header renders THIS so a long provider wait reads as
 * "Waiting for model response" instead of a generic "Thinking" that pretends
 * local reasoning is still being produced. Every label maps 1:1 to a phase the
 * main process actually reported — nothing here is inferred from text.
 */
export function phaseLabel(phase: AgentTaskPhase): string {
  switch (phase) {
    case "starting": return "Starting task";
    case "planning": return "Analyzing request";
    case "requesting_model": return "Connecting to model";
    case "waiting_for_provider": return "Waiting for model response";
    case "streaming": return "Receiving response";
    case "tool_execution": return "Running tools";
    case "finalizing": return "Finalizing response";
    case "completed": return "Finished";
    case "failed": return "Failed";
    case "cancelled": return "Stopped";
    default: return "Working";
  }
}

/** True when the phase means the task is blocked on the provider, not on Latex. */
export function isWaitingForProvider(phase: AgentTaskPhase | null | undefined): boolean {
  return phase === "waiting_for_provider" || phase === "requesting_model";
}
