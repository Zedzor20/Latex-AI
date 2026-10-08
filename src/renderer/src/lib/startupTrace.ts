/**
 * Startup timeline (renderer side).
 *
 * Mirrors the main-process module: `mark()` records a named instant and
 * forwards it to the main process so the whole boot — process start through
 * first interactive paint — reads as ONE timeline on the same clock. The epoch
 * is what makes the two clocks comparable; the local `performance.now()` value
 * is only for the devtools console.
 *
 * Marking is intentionally tiny and fire-and-forget: it must never be able to
 * slow down, throw into, or re-render the component that calls it.
 */
const T0 = performance.now();

const seen = new Set<string>();

export function mark(name: string, extra?: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  const localMs = Math.round(performance.now() - T0);
  try {
    console.log(`[startup] ${name}${extra ? `  ${extra}` : ""}  (+${localMs}ms in renderer)`);
  } catch {
    // console unavailable — never fatal
  }
  try {
    window.latex?.diagnostics?.startupMark?.(name, Date.now(), extra);
  } catch {
    // preload missing (browser dev mode) — the console mark above still exists
  }
}

/** True until `mark` has already recorded `name` — guards one-shot boot work. */
export function isFirstMark(name: string): boolean {
  return !seen.has(name);
}
