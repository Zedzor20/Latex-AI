/**
 * Window reveal — decides WHEN the real Latex window becomes visible.
 *
 * ── WHY THE OPENING ANIMATION IS GONE ────────────────────────────────────────
 * Latex used to open a second frameless, transparent, always-on-top
 * BrowserWindow that played a logo animation (`showSplash`). It was measured,
 * not guessed at — profiling the packaged build with the animation on and off,
 * on the same machine and the same workload:
 *
 *     splash ON   → 7.25 s CPU consumed in the first 5 s, 598.9 MB working set
 *     splash OFF  → 6.31 s CPU consumed in the first 5 s, 493.8 MB working set
 *
 * A whole extra renderer process whose entire job was a 60 fps animation on a
 * TRANSPARENT, always-on-top window (the most expensive compositing path there
 * is, because every frame must be alpha-blended and re-composited over the
 * desktop) cost ~0.94 s of CPU and ~105 MB of memory before the user could do
 * anything. On a low-end PC that is a visible stutter for zero functional value,
 * and it also masked the real startup: it held the real window hidden until the
 * animation had run for at least `SPLASH_MIN_MS`.
 *
 * The requirement was explicit: an animation that costs this much must not be
 * kept just for appearance. So the reveal is now:
 *
 *   • `ready-to-show`  — the moment the renderer has actually painted; the
 *                        honest "the app is on screen" signal, which is why a
 *                        splash was never structurally necessary; and
 *   • `revealNow()`    — called when the renderer reports its UI is INTERACTIVE,
 *                        which can beat `ready-to-show` and gets the user to a
 *                        usable window sooner.
 *
 * Both are idempotent, and a hard ceiling guarantees the window can never stay
 * hidden because the renderer is slow to paint. No second window, no timers, no
 * compositing work: this module costs nothing after startup.
 */
import type { BrowserWindow } from "electron";
import { mark } from "./startupTrace.js";

/**
 * Last-resort ceiling on how long the window may stay hidden.
 *
 * `ready-to-show` can be deferred while a window is hidden (Chromium only
 * paints on demand), so an unconditional fallback is what guarantees the app
 * always appears. It is deliberately short: there is nothing to cover it up.
 */
export const WINDOW_REVEAL_MAX_MS = 3000;

/** The reveal closure for the window currently being revealed, if any. */
let revealWindow: (() => void) | null = null;

/** Reveal the real window NOW. Safe to call at any time; idempotent. */
export function revealNow(): void {
  revealWindow?.();
}

/**
 * Reveal `win` as soon as it has painted, or at `WINDOW_REVEAL_MAX_MS`,
 * whichever comes first — or immediately when `revealNow()` is called.
 */
export function revealWhenReady(win: BrowserWindow): void {
  let revealed = false;
  const reveal = (why: string) => {
    if (revealed) return;
    revealed = true;
    mark("startup:window-revealed", why);
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  };
  revealWindow = () => reveal("renderer interactive");
  win.once("ready-to-show", () => reveal("ready-to-show"));
  setTimeout(() => reveal("fallback ceiling"), WINDOW_REVEAL_MAX_MS).unref?.();
}
