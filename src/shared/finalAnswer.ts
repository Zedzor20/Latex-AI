/**
 * FINAL ANSWER STABILITY — the answer the user watched stream is the answer.
 *
 * The bug this module exists to kill: during generation the chat showed a
 * detailed, useful answer; when generation ended the message was replaced by a
 * shorter or different text (a summary, a checkpoint, a late/empty payload).
 *
 * The rule implemented here is deliberately narrow and one-directional:
 *
 *   The streamed assistant text is AUTHORITATIVE. A finalization payload may
 *   only ever APPEND to it. It can never shrink, rewrite, replace or truncate
 *   it — and an empty or partial payload is ignored outright.
 *
 * Everything is a pure function over strings, so the exact behaviour is tested
 * directly (see test-final-answer-stability.mjs) instead of being asserted about
 * a running UI.
 */

/** Whitespace-insensitive comparison form (never used for display). */
export function normalizeAnswerText(text: string | undefined | null): string {
  return (text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** True when `text` carries no visible content. */
export function isEmptyAnswer(text: string | undefined | null): boolean {
  return normalizeAnswerText(text).length === 0;
}

export type FinalAnswerSource =
  /** The streamed answer was the whole result. */
  | "streamed"
  /** Nothing was streamed; the finalization payload stood alone. */
  | "final"
  /** The streamed answer was kept and the finalization payload appended. */
  | "streamed+final"
  /** Nothing on either side. */
  | "empty";

export interface FinalAnswerReconciliation {
  /** The text to persist as the assistant's visible answer. */
  content: string;
  source: FinalAnswerSource;
  /** True when a non-empty streamed answer was preserved verbatim. */
  preservedStreamed: boolean;
  /** True when an empty / whitespace-only finalization payload was ignored. */
  ignoredEmptyFinal: boolean;
  /** True when the finalization payload tried to replace a longer answer. */
  rejectedReplacement: boolean;
  /**
   * The part of `content` the renderer has NOT seen yet — the only text the
   * finalization phase may stream. Empty when nothing new was added.
   */
  pendingStream: string;
}

/**
 * Reconcile the streamed answer with the finalization payload.
 *
 * `streamed` is exactly what the user has already seen (every `message` event
 * this turn, in order). `final` is what the finalizer composed from the task
 * result (headline + model prose + report sections).
 */
export function reconcileFinalAnswer(streamed: string, final: string): FinalAnswerReconciliation {
  const streamTrimmed = (streamed ?? "").trim();
  const finalTrimmed = (final ?? "").trim();

  // Nothing was streamed: the composed answer is all we have.
  if (!streamTrimmed) {
    if (!finalTrimmed) {
      return {
        content: "",
        source: "empty",
        preservedStreamed: false,
        ignoredEmptyFinal: true,
        rejectedReplacement: false,
        pendingStream: ""
      };
    }
    return {
      content: finalTrimmed,
      source: "final",
      preservedStreamed: false,
      ignoredEmptyFinal: false,
      rejectedReplacement: false,
      pendingStream: finalTrimmed
    };
  }

  // An empty / whitespace-only completion payload can NEVER overwrite a valid
  // streamed answer.
  if (!finalTrimmed) {
    return {
      content: streamTrimmed,
      source: "streamed",
      preservedStreamed: true,
      ignoredEmptyFinal: true,
      rejectedReplacement: false,
      pendingStream: ""
    };
  }

  const a = normalizeAnswerText(streamTrimmed);
  const b = normalizeAnswerText(finalTrimmed);

  // The streamed answer already contains everything the finalizer composed
  // (e.g. the model streamed its own closing prose). Keep it VERBATIM — no
  // whitespace "cleanup", no re-formatting, so Markdown/code blocks are
  // byte-identical to what the user read.
  if (a === b || a.includes(b)) {
    return {
      content: streamTrimmed,
      source: "streamed",
      preservedStreamed: true,
      ignoredEmptyFinal: false,
      rejectedReplacement: false,
      pendingStream: ""
    };
  }

  // The finalizer's text is a superset of the streamed answer (it re-emitted
  // the prose and then added sections): stream ONLY the genuinely new tail so
  // the on-screen answer grows instead of being reprinted.
  if (b.includes(a)) {
    const appended = appendedTail(streamTrimmed, finalTrimmed);
    return {
      content: appended ? `${streamTrimmed}\n\n${appended}` : finalTrimmed,
      source: appended ? "streamed+final" : "final",
      preservedStreamed: true,
      ignoredEmptyFinal: false,
      rejectedReplacement: false,
      pendingStream: appended
    };
  }

  // Genuinely different text. The streamed answer stays and the composed
  // result is appended after it — never substituted for it.
  return {
    content: `${streamTrimmed}\n\n${finalTrimmed}`,
    source: "streamed+final",
    preservedStreamed: true,
    ignoredEmptyFinal: false,
    // A shorter, unrelated payload is a replacement attempt even though we
    // refuse it; flag it so the diagnostic trail shows what was attempted.
    rejectedReplacement: b.length < a.length,
    pendingStream: finalTrimmed
  };
}

/**
 * The part of `final` that follows `streamed` in reading order.
 *
 * Both strings are trimmed copies of the same committed answer, so a simple
 * line-anchored search is enough: if the streamed text is not found as a whole
 * block, the composed line that carries it is skipped and the rest is returned.
 */
function appendedTail(streamed: string, final: string): string {
  const trimmedFinal = final.trim();
  const head = streamed.split(/\n/)[0]?.trim() ?? "";
  if (head) {
    const lines = trimmedFinal.split(/\n/);
    const at = lines.findIndex((line) => line.trim() === head);
    if (at >= 0) {
      // Skip the composed answer's own copy of the streamed block: everything
      // after the LAST line of the streamed text is genuinely new.
      const streamedLines = streamed.trim().split(/\n/).map((line) => line.trim());
      const lastLine = streamedLines[streamedLines.length - 1] ?? "";
      const endAt = lines.indexOf(lastLine, at);
      const cut = (endAt >= 0 ? endAt : at) + 1;
      const tail = lines.slice(cut).join("\n").trim();
      if (tail) return tail;
    }
  }
  // Fall back to trimming the normalized prefix, which handles a single-line
  // composed answer such as "Done — ... **Done — ...**".
  const a = normalizeAnswerText(streamed);
  const b = normalizeAnswerText(final);
  if (b.startsWith(a)) return b.slice(a.length).trim();
  return trimmedFinal;
}

/**
 * The suffix that must still be streamed for `content` to be visible.
 *
 * When the composed content IS the streamed answer plus an appended tail, only
 * the tail is new. When the streamed answer already contained everything,
 * nothing is streamed again.
 */
export function pendingStreamText(content: string, streamed: string): string {
  const streamTrimmed = (streamed ?? "").trim();
  if (!streamTrimmed) return (content ?? "").trim();
  const a = normalizeAnswerText(streamTrimmed);
  const b = normalizeAnswerText(content);
  if (a === b || b.includes(a)) {
    // Compute the tail relative to the real (un-normalized) strings.
    const idx = content.indexOf(streamTrimmed);
    if (idx >= 0) return content.slice(idx + streamTrimmed.length).trim();
    return "";
  }
  // Content was not derived from the streamed text: show nothing extra rather
  // than re-printing an answer the user already read.
  return "";
}

/**
 * ONCE-PER-MESSAGE COMPLETION GUARD.
 *
 * A task must never finalize the same message twice: a duplicate `done` would
 * append a second assistant message (or replace the first), and a late
 * activity/phase event must not be able to re-run finalization at all.
 */
export class CompletionGuard {
  private readonly done = new Set<string>();

  /** True the FIRST time a key is claimed; false for every later attempt. */
  claim(key: string | undefined | null): boolean {
    const id = typeof key === "string" ? key.trim() : "";
    if (!id) return true; // unkeyed runs are not deduplicated
    if (this.done.has(id)) return false;
    this.done.add(id);
    return true;
  }

  has(key: string | undefined | null): boolean {
    const id = typeof key === "string" ? key.trim() : "";
    return id ? this.done.has(id) : false;
  }

  clear(key?: string): void {
    if (key) this.done.delete(key);
    else this.done.clear();
  }
}

/** Stable dedupe key for one run's finalization (task first, then message). */
export function finalizationKey(taskId: string | null | undefined, messageId: string | null | undefined): string {
  const task = typeof taskId === "string" ? taskId.trim() : "";
  const message = typeof messageId === "string" ? messageId.trim() : "";
  if (task || message) return `${task || "task"}::${message || "msg"}`;
  return "";
}

export interface FinalAnswerDiagnostic {
  taskId?: string;
  messageId?: string;
  /** What produced this final text ("finalize", "incomplete", "done-dedupe", …). */
  stage: string;
  streamedLength: number;
  finalLength: number;
  source: FinalAnswerSource | "skipped";
  preservedStreamed: boolean;
  ignoredEmptyFinal: boolean;
  rejectedReplacement: boolean;
}

/**
 * One compact, content-free diagnostic record for the development log.
 *
 * It records WHAT happened to the final text (stage, lengths, decision) and
 * never any of the text itself, so no message content and no credential can
 * ever reach the log through this path.
 */
export function finalAnswerDiagnostic(input: FinalAnswerDiagnostic): string {
  const parts = [
    `stage=${input.stage}`,
    `task=${input.taskId ?? "-"}`,
    `message=${input.messageId ?? "-"}`,
    `streamed=${input.streamedLength}`,
    `final=${input.finalLength}`,
    `source=${input.source}`,
    `preserved=${input.preservedStreamed ? "yes" : "no"}`,
    `emptyFinal=${input.ignoredEmptyFinal ? "yes" : "no"}`,
    `rejectedReplacement=${input.rejectedReplacement ? "yes" : "no"}`
  ];
  return `[FinalAnswer] ${parts.join(" ")}`;
}
