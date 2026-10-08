/**
 * Idempotent startup coordinator (renderer).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * Latex's boot kicks off several one-time IPC reads (settings, workspaces, chat
 * history, task checkpoints). Two separate mechanisms could each run that work
 * more than once:
 *
 *   • React StrictMode mounts, unmounts and REMOUNTS every effect in
 *     development, so every boot call fired twice; and
 *   • a window/component remount (a reload, a dev HMR update) re-ran the whole
 *     pipeline even though the answers cannot have changed.
 *
 * Running the same startup read twice is pure duplicated main-process work and
 * duplicated IPC traffic — the exact class of "duplicate initialization" that
 * makes a low-end machine stutter for no reason. `once()` collapses it:
 *
 *   first call   → the work starts and its promise is recorded
 *   second call  → the SAME promise is returned; nothing new starts
 *   after settle → the resolved value is reused, so a remount is free
 *   on failure   → the entry is dropped, so a genuine retry is still possible
 *
 * Results are cached because each key describes an immutable-at-boot fact. A
 * key is expected to be a boot-time read, not a live poll: anything that must
 * observe later changes has its own subscription (the status streams) and must
 * not go through here.
 */
const entries = new Map<string, Promise<unknown>>();

/**
 * Run `work` at most once per key for the life of the renderer.
 * Concurrent and subsequent callers share the first promise/result.
 */
export function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = entries.get(key);
  if (existing) return existing as Promise<T>;

  const promise = work().catch((err) => {
    // A failed startup read must be retryable — never cache the failure.
    entries.delete(key);
    throw err;
  });
  entries.set(key, promise);
  return promise as Promise<T>;
}

/** Whether `key` has already been started. Diagnostics/tests only. */
export function hasStarted(key: string): boolean {
  return entries.has(key);
}

/** Forget one key (or all). Used when a remount must genuinely re-read. */
export function resetCoordinator(key?: string): void {
  if (key) entries.delete(key);
  else entries.clear();
}
