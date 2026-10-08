import { Check, ChevronDown, ChevronRight, Clipboard, X } from "lucide-react";
import { useState } from "react";
import type { PendingChange } from "../../../shared/types";
import { diffStats } from "../lib/format";
import { copyToClipboard } from "./ChatView";
import { DiffLines } from "./DiffLines";
import { Modal } from "./ui";

interface DiffViewerProps {
  changes: PendingChange[];
  /**
   * A RESTORED review — the records came off a finished message, not off the
   * live turn. It renders the same real diffs but offers no Accept / Reject /
   * Undo: that work is already committed to disk, and "undo" would rewrite a
   * file whose content has moved on since.
   */
  readOnly?: boolean;
  onAccept: (change: PendingChange) => void;
  onReject: (id: string) => void;
  onUndo: (change: PendingChange) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onClose: () => void;
}

/** Net effect of the turn on a file (one entry per path). */
const KIND_LABELS: Record<"created" | "modified" | "deleted" | "renamed", string> = {
  created: "Created",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed"
};

function CopyDiffButton({ diff }: { diff: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(diff);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <button className="iconButton" title="Copy diff" onClick={() => void copy()}>
      {copied ? <Check size={13} /> : <Clipboard size={13} />}
    </button>
  );
}

export function DiffViewer({ changes, readOnly = false, onAccept, onReject, onUndo, onAcceptAll, onRejectAll, onClose }: DiffViewerProps) {
  const pending = changes.filter((c) => c.status === "pending");
  const accepted = changes.filter((c) => c.status === "accepted");
  // Every file's diff is expanded by default; the user can collapse any of
  // them to scan a long review. Tracked by id so it survives re-renders.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const total = changes.reduce(
    (acc, change) => {
      const stats = diffStats(change.diff);
      acc.added += stats.added;
      acc.removed += stats.removed;
      return acc;
    },
    { added: 0, removed: 0 }
  );

  return (
    <Modal onClose={onClose} width={1160}>
      <div className="diffViewer">
        <div className="diffHeader">
          <div className="diffTitle">Review changes</div>
          <div className="diffSummary">
            {changes.length} file{changes.length === 1 ? "" : "s"} changed · <span className="statAdded">+{total.added}</span> <span className="statRemoved">-{total.removed}</span>
          </div>
          <div className="diffHeaderActions">
            {!readOnly && pending.length > 0 && (
              <button className="btn sm primary" onClick={onAcceptAll}>
                <Check size={14} /> Accept All
              </button>
            )}
            {!readOnly && pending.length > 0 && (
              <button className="btn sm" onClick={onRejectAll}>
                <X size={14} /> Reject All
              </button>
            )}
          </div>
        </div>
        <div className="diffBody">
          {changes.length === 0 && <div className="diffEmpty">No file changes to review.</div>}
          {changes.map((change) => {
            const stats = diffStats(change.diff);
            const isPending = change.status === "pending";
            const kind = change.kind ?? (change.existed === false ? "created" : "modified");
            const isOpen = !collapsed.has(change.id);
            return (
              <section key={change.id} className="diffCard">
                <div className="diffCardHead">
                  <button
                    className="iconButton"
                    title={isOpen ? "Collapse diff" : "Expand diff"}
                    onClick={() => setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(change.id)) next.delete(change.id);
                      else next.add(change.id);
                      return next;
                    })}
                  >
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <span className={`changeKind ${kind}`}>{KIND_LABELS[kind]}</span>
                  <span className="diffFilePath" title={change.filePath}>
                    {change.renamedFrom ? `${change.renamedFrom} → ${change.filePath}` : change.filePath}
                  </span>
                  {change.description && <span className="changeDesc">{change.description}</span>}
                  {(change.operations ?? 1) > 1 && <span className="changeOpsCount">×{change.operations}</span>}
                  <span className="changesStats">
                    <span className="statAdded">+{stats.added}</span>
                    <span className="statRemoved">-{stats.removed}</span>
                  </span>
                  <span className={`changeStatus ${change.status}`}>{change.status}</span>
                  <CopyDiffButton diff={change.diff} />
                  {!readOnly && (isPending ? (
                    <>
                      <button className="btn sm" onClick={() => onAccept(change)}><Check size={13} /> Accept</button>
                      <button className="btn sm" onClick={() => onReject(change.id)}><X size={13} /> Reject</button>
                    </>
                  ) : (
                    change.status === "accepted" && (
                      <button className="btn sm" onClick={() => onUndo(change)}>Undo</button>
                    )
                  ))}
                </div>
                {isOpen && <DiffLines diff={change.diff} />}
              </section>
            );
          })}
        </div>
        <div className="diffFooter">
          <span>
            {readOnly
              ? "Restored from this turn's records — the changes are already on disk."
              : <>{accepted.length} accepted · {changes.filter((c) => c.status === "rejected").length} rejected</>}
          </span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
