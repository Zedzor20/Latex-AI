import { useEffect, useState } from "react";
import { Download, RotateCw } from "lucide-react";
import type { UpdateStatus } from "../../../shared/updates";

/**
 * Subtle, app-wide update indicator.
 *
 * The updater runs entirely in the main process; this only renders the
 * normalized status it streams over `updates:event`. It exists because an
 * automatic download must be visible SOMEWHERE without hijacking the app: a
 * modal for "an update is downloading" would be a worse experience than the
 * update itself, but a completely silent background download leaves the user
 * with no idea why the app will later offer a restart.
 *
 * Deliberately cheap and quiet:
 *   • ONE initial `status()` read and ONE event subscription — no polling, no
 *     timers, no re-render per byte;
 *   • it renders NOTHING at all in the ordinary states (idle, checking,
 *     up-to-date, unsupported, error), so a normal launch never sees it;
 *   • it appears only when there is something the user can actually do or wait
 *     for — a download in progress, or an update ready to install.
 */
export function UpdateIndicator() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const updates = window.latex?.updates;
    if (!updates) return () => { alive = false; };
    void updates
      .status()
      .then((next: UpdateStatus) => { if (alive) setStatus(next); })
      .catch(() => undefined);
    const off = updates.onEvent((event: { status: UpdateStatus }) => {
      if (alive) setStatus(event.status);
    });
    return () => { alive = false; off(); };
  }, []);

  const state = status?.state;
  if (state !== "downloading" && state !== "downloaded" && state !== "installing") return null;

  const version = status?.version ? `Latex ${status.version}` : "the update";
  const percent = Math.max(0, Math.min(100, Math.round(status?.percent ?? 0)));

  if (state === "downloading") {
    return (
      <span className="updateChip downloading" role="status" title={`Downloading ${version} in the background — Latex stays fully usable.`}>
        <Download size={13} />
        <span className="updateChipLabel">
          Downloading {version}{percent > 0 ? ` · ${percent}%` : "…"}
        </span>
        <span className="updateChipBar" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
      </span>
    );
  }

  if (state === "installing") {
    return (
      <span className="updateChip installing" role="status">
        <RotateCw size={13} className="spin" />
        <span className="updateChipLabel">Restarting to install…</span>
      </span>
    );
  }

  // downloaded — the one state where an action genuinely helps the user.
  // The main process refuses the install while an agent task or terminal is
  // live, so pressing this can never kill running work.
  return (
    <button
      className="updateChip ready"
      title={status?.message ?? `${version} is ready to install.`}
      onClick={() => { void window.latex?.updates?.install().catch(() => undefined); }}
    >
      <RotateCw size={13} />
      <span className="updateChipLabel">Restart &amp; Update</span>
    </button>
  );
}
