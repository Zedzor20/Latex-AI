/**
 * Startup timeline + watchdog (main process).
 *
 * Why this exists: startup used to be a single opaque `await` chain, so when the
 * app felt slow or appeared stuck there was no way to tell WHICH operation was
 * holding it. This module makes the whole boot measurable and, more importantly,
 * makes every non-critical step BOUNDED — a slow or silent subsystem can no
 * longer hold the pipeline hostage.
 *
 * Three responsibilities:
 *
 *   1. `mark()`       — a named instant on the timeline, in ms since the process
 *                       started, so main-process and renderer stages can be read
 *                       on the SAME clock (the renderer reports epoch ms, which
 *                       is converted here).
 *   2. `withBudget()`  — run non-critical work under a slow threshold and a hard
 *                       ceiling. Every call terminates in exactly one of
 *                       SUCCESS / FAILED / TIMEOUT / SKIPPED. It never throws and
 *                       never resolves without a value, so a wedged provider, a
 *                       local service that will not answer, or a network call
 *                       that hangs cannot leave a caller waiting forever.
 *   3. a global watchdog — if the renderer never reports `startup:ready`, the
 *                       whole timeline is dumped anyway, with the loudest line
 *                       naming the stage that never finished.
 *
 * Tracing output:
 *   LATEX_STARTUP_TRACE unset → marks are silent in a packaged build, logged in
 *                               development.
 *   LATEX_STARTUP_TRACE=1     → also append every mark to a temp log file
 *                               (needed for the packaged app, whose stdout is
 *                               not attached to any console on Windows).
 *   LATEX_STARTUP_TRACE=<path> → append to that file instead.
 *
 * SLOW / TIMEOUT / FAILED warnings are always logged: they describe real
 * behaviour that a user would otherwise experience as "it just hangs".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

/** Process start, on the same clock as `Date.now()`. */
const T0 = Date.now();

const rawTrace = process.env.LATEX_STARTUP_TRACE;
/** Where the timeline is appended when tracing is on. */
const traceFile =
  rawTrace && rawTrace !== "0"
    ? rawTrace === "1"
      ? path.join(os.tmpdir(), "latex-startup.log")
      : rawTrace
    : null;

interface Mark {
  name: string;
  /** ms since process start. */
  ms: number;
  extra?: string;
}

const marks: Mark[] = [];
const seen = new Set<string>();
let summaryPrinted = false;

function traceEnabled(): boolean {
  return traceFile !== null || !app.isPackaged;
}

function write(line: string, warn = false): void {
  const text = `[startup] ${line}`;
  if (traceEnabled()) {
    if (warn) console.warn(text);
    else console.log(text);
  }
  if (traceFile) {
    // Tracing must never be able to break a launch, so every failure is
    // swallowed: an unwritable log path is not a reason for the app to fail.
    try {
      fs.appendFileSync(traceFile, `${text}\n`);
    } catch {
      /* ignore */
    }
  }
}

function record(name: string, ms: number, extra: string | undefined, source?: string): void {
  marks.push({ name, ms, extra });
  write(`+${String(ms).padStart(6)}ms  ${name}${extra ? `  ${extra}` : ""}${source ? `  (${source})` : ""}`);
}

/** Record a named instant on the startup timeline. Repeats are ignored. */
export function mark(name: string, extra?: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  record(name, Date.now() - T0, extra);
}

/** ms elapsed since the process started — for ad-hoc measurements. */
export function sinceStart(): number {
  return Date.now() - T0;
}

/** The renderer reports epoch-ms marks so both processes share one timeline. */
export function markFromRenderer(name: string, epochMs: number, extra?: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  record(name, Math.max(0, epochMs - T0), extra, "renderer");
  if (name === "startup:ready") printStartupSummary();
}

/** A stage that deliberately does not run yet, recorded so the timeline is honest. */
export function markSkipped(name: string, why: string): void {
  mark(name, `skipped (${why})`);
}

/**
 * Print the whole timeline with the gaps between stages, so the single most
 * expensive span is obvious. This is the measurement the fix is judged on.
 */
export function printStartupSummary(): void {
  if (summaryPrinted) return;
  summaryPrinted = true;

  const ordered = [...marks].sort((a, b) => a.ms - b.ms);
  const lines = ordered.map((m) => `  +${String(m.ms).padStart(6)}ms  ${m.name}${m.extra ? `  ${m.extra}` : ""}`);

  let previous = 0;
  const gaps = ordered.map((m) => {
    const delta = m.ms - previous;
    previous = m.ms;
    return { name: m.name, delta };
  });
  const worst = gaps.reduce<{ name: string; delta: number } | null>(
    (acc, g) => (acc === null || g.delta > acc.delta ? g : acc),
    null
  );

  write(`── timeline (ms since process start) ──\n${lines.join("\n")}`);
  write(
    `── largest gap: ${worst ? `${worst.delta}ms before ${worst.name}` : "n/a"} ──\n` +
      gaps.map((g) => `  ${String(g.delta).padStart(6)}ms  ${g.name}`).join("\n")
  );
  write(`── renderer ready: ${seen.has("startup:ready") ? "YES" : "NO"} ──`);
}

/**
 * Global watchdog: if the renderer never reports itself interactive, dump the
 * timeline anyway. Without this, a genuinely stuck startup produces no output at
 * all — which is exactly how "stuck on a loading screen" stays undiagnosable.
 */
setTimeout(() => {
  if (summaryPrinted) return;
  write("STARTUP NOT READY after 30s — dumping timeline to locate the blocking stage", true);
  printStartupSummary();
}, 30_000).unref?.();

export interface Budget<T> {
  /** Name used in SLOW/TIMEOUT/FAILED logs. */
  name: string;
  /** The work. May be sync or async. */
  work: () => Promise<T> | T;
  /** Log when the work took at least this long. */
  slowMs?: number;
  /** Give up after this long and use `fallback`. */
  hardMs?: number;
  /** Value used on timeout/failure. Required so a caller always gets an answer. */
  fallback: T;
}

/**
 * Run work under a bounded budget.
 *
 * Guarantees, and why each matters:
 *   - SUCCESS  → the real value is returned.
 *   - FAILED   → the error is logged and `fallback` is returned; one provider
 *                failing must never take the app down with it.
 *   - TIMEOUT  → the hard ceiling is enforced INDEPENDENTLY of the work, so a
 *                promise that never settles still releases the caller.
 *   - never throws — callers can chain without try/catch noise, and a single bad
 *                subsystem cannot abort the surrounding pipeline.
 */
export async function withBudget<T>(budget: Budget<T>): Promise<T> {
  const { name, work, fallback } = budget;
  const slowMs = budget.slowMs ?? 1500;
  const hardMs = budget.hardMs ?? 5000;
  const started = Date.now();

  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), hardMs);
    // Never keep the process alive just for a watchdog.
    timer.unref?.();
  });

  try {
    const raced = await Promise.race([
      Promise.resolve()
        .then(work)
        .then((value) => ({ value }) as const),
      ceiling
    ]);

    const took = Date.now() - started;
    if ("timedOut" in raced) {
      write(`STARTUP TIMEOUT: ${name} — exceeded ${hardMs}ms; continuing without it`, true);
      return fallback;
    }
    if (took >= slowMs) {
      write(`STARTUP SLOW: ${name} — ${took}ms`, true);
    }
    return raced.value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`STARTUP FAILED: ${name} — ${message}; continuing without it`, true);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
