/**
 * WHEN may the conversation move on its own, and WHERE may it go?
 *
 * Isolated from the component deliberately: this is the rule that decides
 * whether a streaming response is allowed to touch the reader's scroll position,
 * and it is the rule that was wrong. Keeping it pure means the invariant below
 * can be tested directly instead of being argued about in a 2000-line view.
 *
 * Two rules, and nothing else:
 *   1. a REAL gesture (wheel, drag, touch, key) outranks automatic scrolling for
 *      a short grace period, so a reader moving inside the follow threshold is
 *      never nudged on the next frame;
 *   2. following may only ever move DOWN, towards newer content. It may never
 *      pull the view back towards older content.
 *
 * Rule 2 is the fix. The send-anchor used to be re-applied on every follow, and
 * because its cushioned target always resolved to the same offset it pinned the
 * just-sent message at 24% of the viewport for the WHOLE response — so a reader
 * who scrolled down to watch the answer arrive was dragged straight back up.
 */

/** Whether automatic following is permitted at all right now. */
export function shouldAutoFollow(input: {
  /** Is the reader already within the follow threshold of the newest content? */
  nearBottom: boolean;
  /** Milliseconds since the reader's last real gesture. */
  sinceUserGestureMs: number;
  /** How long a gesture outranks automatic following. */
  graceMs: number;
  /** Set once a turn has ended: the resting position must not be disturbed. */
  holdAfterTurn: boolean;
}): boolean {
  if (input.holdAfterTurn) return false;
  if (input.sinceUserGestureMs < input.graceMs) return false;
  return input.nearBottom;
}

/**
 * The scroll offset a follow should move to — or `null` to leave the reader
 * exactly where they are.
 *
 * Guaranteed to be either `null` or `>= scrollTop`: a caller that assigns the
 * result can therefore never move the reader upwards.
 */
export function resolveFollowTarget(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number | null {
  const maxTop = Math.max(0, input.scrollHeight - input.clientHeight);
  // Only a real gap to cover is worth a write; a sub-pixel one is not.
  if (maxTop <= input.scrollTop + 0.5) return null;
  return maxTop;
}
