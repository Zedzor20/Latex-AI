import type { FileOperationEvent, FileOperationPreview, PendingChange } from "./types.js";

/** Bound on how many distinct file activities are kept in a run. */
export const MAX_FILE_OPERATIONS = 12;

/**
 * Bound for the PERSISTED record. Higher than the live bound on purpose: the
 * live panel only ever needs the couple of files being written right now, but a
 * recorded task must still show what it did after a restart, so its history is
 * allowed to be longer. A refactor that touched thirty files is still readable.
 */
export const MAX_PERSISTED_FILE_OPERATIONS = 60;

/**
 * Bound on how many Change Review rows are persisted WITH one message.
 *
 * A turn that touched more files than this keeps its first N records rather
 * than growing chat history without limit; the live card still showed every
 * one of them while the turn ran.
 */
export const MAX_PERSISTED_REVIEW_CHANGES = 30;

/**
 * Strip a turn's Change Review records down to what the review UI reads, so
 * they can be written into chat history.
 *
 * It is the DIFF that the review renders (`DiffLines`, `diffStats`), never the
 * before/after buffers — those are the only unbounded part of a record (a
 * generated 2 MB file would otherwise be stored twice, per turn, forever).
 * Dropping them keeps `diff` INTACT, so a reopened conversation still shows the
 * real final change; the buffers are what `undo` needs, which is why the
 * restored review is presented read-only (the file has moved on since).
 */
export function compactReviewChanges(changes: PendingChange[]): PendingChange[] {
  return changes.slice(0, MAX_PERSISTED_REVIEW_CHANGES).map((change) => ({
    ...change,
    previousContent: "",
    nextContent: ""
  }));
}

/** Identity carried by a file-operation event, when the caller knows it. */
export interface FileOperationIdentity {
  taskId?: string;
  chatId?: string;
  messageId?: string;
}

/**
 * Stable id for one file's activity record. Keyed by the owning message when
 * there is one (so two turns that both touch app.tsx stay separate records),
 * falling back to the path alone for a live event that arrived before its
 * message id was known.
 */
export function fileOperationId(filePath: string, identity?: FileOperationIdentity): string {
  return identity?.messageId ? `${identity.messageId}:${filePath}` : filePath;
}

/**
 * Fold one streamed file-operation event into the aggregated preview list.
 *
 * Pure and deterministic so it can be unit-tested without a renderer:
 *  - operations for the SAME path update ONE entry (repeated writes aggregate);
 *  - the preview buffer is only ever what the event actually carried;
 *  - `status` reflects the REAL filesystem outcome (`committed` only after a
 *    verified write; a stop is "stopped", never "committed").
 */
export function applyFileOperationEvent(
  files: FileOperationPreview[],
  event: FileOperationEvent,
  identity?: FileOperationIdentity,
  limit = MAX_FILE_OPERATIONS
): FileOperationPreview[] {
  if (!event || typeof event.filePath !== "string" || !event.filePath) return files;
  const at = typeof event.at === "number" ? event.at : Date.now();
  // An event may carry its own identity (the Main Agent stamps every emit); an
  // explicit argument wins so a caller that knows better can correct it.
  const owner: FileOperationIdentity = {
    taskId: identity?.taskId ?? event.taskId,
    chatId: identity?.chatId ?? event.chatId,
    messageId: identity?.messageId ?? event.messageId
  };
  // ── Which entry does this belong to? ──────────────────────────────
  // Aggregation is per PATH within one message, never across messages: two
  // turns that both edit app.ts must stay two records, because each message
  // owns its own activity (and one turn must never absorb another's history).
  // An entry recorded before its message id was known matches by path alone, so
  // a live event stream that arrives ahead of the id still aggregates instead of
  // stacking duplicates.
  const key = fileOperationId(event.filePath, owner);
  const idx = files.findIndex(
    (f) => f.operationId === key
      || (f.filePath === event.filePath
        && (!f.messageId || !owner.messageId || f.messageId === owner.messageId))
  );
  const prev = idx >= 0 ? files[idx] : undefined;

  const status: FileOperationPreview["status"] = event.phase === "start"
    ? "writing"
    : event.phase === "complete"
      ? "committed"
      : /stopped by the user/i.test(event.error ?? "")
        ? "stopped"
        : "failed";

  const next: FileOperationPreview = {
    filePath: event.filePath,
    // New messages get their own record; an existing entry keeps its own id.
    operationId: prev?.operationId ?? key,
    taskId: owner.taskId ?? prev?.taskId,
    chatId: owner.chatId ?? prev?.chatId,
    messageId: owner.messageId ?? prev?.messageId,
    operation: event.operation ?? prev?.operation ?? "write",
    preview: typeof event.preview === "string" ? event.preview : prev?.preview,
    previousPreview: typeof event.previousPreview === "string" ? event.previousPreview : prev?.previousPreview,
    status,
    verified: event.verified,
    // Count a real operation each time a new start arrives for this path.
    operations: (prev?.operations ?? 0) + (event.phase === "start" ? 1 : 0),
    error: event.error,
    startedAt: prev?.startedAt ?? at,
    updatedAt: at
  };

  const out = idx >= 0 ? [...files] : [...files, next];
  if (idx >= 0) out[idx] = next;
  return out.slice(-limit);
}

/**
 * The path of the operation a viewer should treat as currently active — the
 * most recent entry that is still writing. `null` when nothing is in progress,
 * which is what collapses every completed preview.
 */
export function activeFileOperationPath(files: FileOperationPreview[]): string | null {
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i].status === "writing") return files[i].filePath;
  }
  return null;
}
