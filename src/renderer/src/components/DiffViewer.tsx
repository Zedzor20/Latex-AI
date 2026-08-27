import { Check, Clipboard, X } from "lucide-react";
import { useState } from "react";
import type { PendingChange } from "../../../shared/types";
import { diffStats } from "../lib/format";
import { copyToClipboard } from "./ChatView";
import { DiffLines } from "./DiffLines";
import { Modal } from "./ui";

interface DiffViewerProps {
  changes: PendingChange[];
  onAccept: (change: PendingChange) => void;
  onReject: (id: string) => void;
  onUndo: (change: PendingChange) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onClose: () => void;
}

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

export function DiffViewer({ changes, onAccept, onReject, onUndo, onAcceptAll, onRejectAll, onClose }: DiffViewerProps) {
  const pending = changes.filter((c) => c.status === "pending");
  const accepted = changes.filter((c) => c.status === "accepted");
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
    <Modal onClose={onClose} width={820}>
      <div className="diffViewer">
        <div className="diffHeader">
          <div className="diffTitle">Review changes</div>
          <div className="diffSummary">
            {changes.length} file{changes.length === 1 ? "" : "s"} changed · <span className="statAdded">+{total.added}</span> <span className="statRemoved">-{total.removed}</span>
          </div>
          <div className="diffHeaderActions">
            {pending.length > 0 && (
              <button className="btn sm primary" onClick={onAcceptAll}>
                <Check size={14} /> Accept All
              </button>
            )}
            {pending.length > 0 && (
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
            return (
              <section key={change.id} className="diffCard">
                <div className="diffCardHead">
                  <span className="diffFilePath">{change.filePath}</span>
                  <span className="changesStats">
                    <span className="statAdded">+{stats.added}</span>
                    <span className="statRemoved">-{stats.removed}</span>
                  </span>
                  <span className={`changeStatus ${change.status}`}>{change.status}</span>
                  <CopyDiffButton diff={change.diff} />
                  {isPending ? (
                    <>
                      <button className="btn sm" onClick={() => onAccept(change)}><Check size={13} /> Accept</button>
                      <button className="btn sm" onClick={() => onReject(change.id)}><X size={13} /> Reject</button>
                    </>
                  ) : (
                    change.status === "accepted" && (
                      <button className="btn sm" onClick={() => onUndo(change)}>Undo</button>
                    )
                  )}
                </div>
                <DiffLines diff={change.diff} />
              </section>
            );
          })}
        </div>
        <div className="diffFooter">
          <span>{accepted.length} accepted · {changes.filter((c) => c.status === "rejected").length} rejected</span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
