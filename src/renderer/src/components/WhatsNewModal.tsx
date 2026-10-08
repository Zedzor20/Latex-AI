import { useRef, useState } from "react";
import { X, Sparkles } from "lucide-react";
import {
  formatReleaseDate,
  latestDocumentedRelease,
  type ReleaseEntry
} from "../../../shared/updates";

interface WhatsNewModalProps {
  /**
   * The releases to show, newest first. Usually one; a version jump
   * (1.0.0 → 1.0.3) carries the releases that were skipped, so nothing the user
   * has not seen is silently assumed read. Empty falls back to the newest
   * documented release.
   */
  releases?: ReleaseEntry[];
  /** Whether the modal is currently on screen. */
  open: boolean;
  /** The user dismissed the dialog (Got it / close / backdrop / Escape). */
  onClose: () => void;
  /** Open Settings → What's New (the full history). Persistence is handled here first. */
  onSeeAll?: () => void;
}

/** One NEW/FIXED/IMPROVED group of a release entry — omitted when empty. */
function ReleaseRow({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
      <span style={{ flex: "0 0 54px", paddingTop: 2, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>
        {label}
      </span>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, i) => (
          <li key={i} style={{ position: "relative", paddingLeft: 12, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-2)" }}>
            <span style={{ position: "absolute", left: 0, top: 2, color: "var(--text-3)" }}>•</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The What's New dialog — rendered IN FRONT of the app by the React tree (the
 * parent owns `open`), never as a second window.
 *
 * It is purely a reader: the release notes come from the one shared changelog
 * (`shared/updates`), and the "seen" version is persisted by the MAIN process
 * when the user dismisses. Closing by any route records the acknowledgement, so
 * the same release cannot be shown twice.
 */
export function WhatsNewModal({ releases, open, onClose, onSeeAll }: WhatsNewModalProps) {
  const [saving, setSaving] = useState(false);
  const done = useRef(false);

  /** Persist the seen version once, then run the caller's close/navigate action. */
  const acknowledge = async (then: () => void) => {
    if (done.current) return;
    done.current = true;
    setSaving(true);
    try {
      await window.latex?.whatsnew?.hide();
    } catch {
      // Best-effort persistence — the dialog closes either way.
    } finally {
      setSaving(false);
      then();
    }
  };

  if (!open) return null;

  const entries = releases && releases.length ? releases : [latestDocumentedRelease()];
  const head = entries[0];

  return (
    <div
      className="modalBackdrop"
      onMouseDown={() => void acknowledge(onClose)}
      role="dialog"
      aria-modal="true"
      aria-label={`What's new in Latex ${head.version}`}
    >
      <div
        className="modalPanel whatsNewModal"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ width: "min(520px, calc(100vw - 48px))" }}
      >
        {/* Head */}
        <div className="whatsNewHead">
          <div className="whatsNewIcon">
            <Sparkles size={18} />
          </div>
          <div className="whatsNewTitleBlock">
            <div className="whatsNewVersion">Latex {head.version}</div>
            <div className="whatsNewDate">Released {formatReleaseDate(head.date)}</div>
          </div>
          <button
            className="iconButton"
            onClick={() => void acknowledge(onClose)}
            title="Close"
            disabled={saving}
            aria-label="Close What's New"
          >
            <X size={16} />
          </button>
        </div>

        {head.name ? <div className="whatsNewName">{head.name}</div> : null}

        {/* Body — the release notes. Extra entries are the releases a version
            jump skipped; each one the user has not acknowledged yet. */}
        <div className="whatsNewBody">
          <ReleaseRow label="New" items={head.added} />
          <ReleaseRow label="Fixed" items={head.fixed} />
          <ReleaseRow label="Improved" items={head.improved} />
          {entries.slice(1).map((entry) => (
            <div className="whatsNewExtraRelease" key={entry.version}>
              <div className="whatsNewExtraHead">
                Latex {entry.version} · {formatReleaseDate(entry.date)}
              </div>
              {entry.name ? <div className="whatsNewExtraName">{entry.name}</div> : null}
              <ReleaseRow label="New" items={entry.added} />
              <ReleaseRow label="Fixed" items={entry.fixed} />
              <ReleaseRow label="Improved" items={entry.improved} />
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="whatsNewFoot">
          <button className="btn primary" onClick={() => void acknowledge(onClose)} disabled={saving}>
            {saving ? "Saving…" : "Got it"}
          </button>
          <button
            className="btn ghost"
            onClick={() => void acknowledge(() => onSeeAll?.())}
            disabled={saving}
          >
            See all releases
          </button>
        </div>
      </div>
    </div>
  );
}
