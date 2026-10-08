/**
 * LatexUpdateService — the application updater, owned by the Electron MAIN
 * process (never the renderer).
 *
 * Rules this file follows:
 *
 *  1. NO ACCOUNT. An update is identified only by the installed version and
 *     what the release feed offers. No Latex account, user id, email, cloud
 *     session or third-party sign-in exists anywhere in this path. The renderer
 *     never sees a URL, a token or a file path — only a normalized status.
 *
 *  2. REAL updater, never a fake one. When a feed exists the real
 *     electron-updater pipeline runs: it downloads the installer named by the
 *     update manifest, verifies it against the manifest checksum and installs
 *     it through the normal NSIS mechanism. Latex never downloads an arbitrary
 *     .exe, never accepts an update URL from the renderer, and never replaces
 *     app.asar or the .exe by hand.
 *
 *  3. THE USER IS NEVER INTERRUPTED. The download happens silently in the
 *     background and Latex stays fully usable while it runs. The restart is
 *     always an explicit choice, and it is REFUSED while an agent task or a
 *     terminal session is live, so a running job can never be killed by an
 *     update the user forgot about.
 *
 *  4. NEVER BLOCK STARTUP, NEVER TRAP THE USER. The first check runs on its own
 *     timer after the window is up, every check is async, and nothing in app
 *     startup awaits any of it. A failed, offline or unsupported check leaves
 *     the app running normally: the state simply reports why, and startup is
 *     never gated on "Checking for updates…".
 *
 *  5. HONEST states. A build with no update feed and an unpackaged development
 *     run report `unsupported` with a reason — not a fake error and not a fake
 *     success — so the About page can tell the truth instead of claiming
 *     automatic updates that do not exist.
 *
 * The renderer only ever receives a normalized UpdateStatus.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  LATEX_UPDATE_FEED_URL,
  LATEX_UPDATE_CHECK_INTERVAL_MS,
  LATEX_UPDATE_FIRST_CHECK_DELAY_MS,
  LATEX_WEBSITE_URL,
  releaseNotesText,
  type UpdateEvent,
  type UpdateReason,
  type UpdateStatus
} from "../shared/updates.js";

export interface UpdateServiceDeps {
  /** How many Main/agent tasks are running right now. */
  activeTaskCount: () => number;
  /** How many interactive terminal sessions are live right now. */
  activeTerminalCount?: () => number;
  /** Send one normalized event to the renderer (never throws). */
  send: (event: UpdateEvent) => void;
}

/** The real electron-updater instance, typed from the package itself. */
type AutoUpdater = typeof import("electron-updater").autoUpdater;

export class UpdateService {
  private status: UpdateStatus;
  /** The real autoUpdater instance, resolved lazily (see ensureUpdater). */
  private updater: AutoUpdater | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /**
   * The single in-flight check. Several things can ask for a check at the same
   * moment — the startup timer, the background interval, and the user pressing
   * "Check for Updates" on the About page — and they must never produce
   * concurrent requests against the update server. Whoever arrives second joins
   * the promise that is already running instead of starting another one.
   */
  private checkInFlight: Promise<void> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    const feed = this.resolveFeed();
    this.status = {
      state: feed ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      feedConfigured: Boolean(feed),
      canAutoUpdate: Boolean(feed) && app.isPackaged,
      websiteUrl: LATEX_WEBSITE_URL || undefined,
      ...(feed ? {} : { reason: "not-configured" as UpdateReason })
    };
  }

  /**
   * Where updates come from, in order:
   *   1. the configured feed URL (LATEX_UPDATE_FEED_URL),
   *   2. electron-builder's own app-update.yml in the packaged resources —
   *      emitted automatically from the `build.publish` configuration, which is
   *      the normal release path, and read by electron-updater itself.
   * Returns null when neither exists — the honest "not configured" case.
   */
  private resolveFeed(): { provider: "generic"; url: string } | null {
    const configured = LATEX_UPDATE_FEED_URL.trim();
    if (configured) return { provider: "generic", url: configured };
    try {
      const resourcesPath = process.resourcesPath;
      if (!resourcesPath) return null;
      for (const candidate of [
        path.join(resourcesPath, "app-update.yml"),
        path.join(resourcesPath, "..", "app-update.yml")
      ]) {
        if (fs.existsSync(candidate)) return { provider: "generic", url: "" };
      }
    } catch {
      // Unreadable resources — treat as not configured.
    }
    return null;
  }

  /**
   * The honest explanation for a build that cannot update itself.
   *
   * An UNPACKAGED run (`npm run dev`, or an Electron instance started from the
   * checkout) is reported as `development` BEFORE anything is said about the
   * feed, because that is the truer reason a developer sees no updates — and it
   * is what stops `npm run dev` from looking like a broken release.
   */
  private unsupported(): { reason: UpdateReason; message: string } {
    if (!app.isPackaged) {
      return {
        reason: "development",
        message: "Automatic updates are available for installed production builds."
      };
    }
    return {
      reason: "not-configured",
      message: "This build does not include an automatic update feed. Updates are available from the Latex release page."
    };
  }

  /** Whether an update may be installed right now without interrupting work. */
  private isBusy(): boolean {
    if (this.deps.activeTaskCount() > 0) return true;
    return (this.deps.activeTerminalCount?.() ?? 0) > 0;
  }

  /**
   * Start the background updater. Called after the window is created and never
   * awaited by app startup: the first check is delayed, then hours apart.
   *
   * This is deliberately NOT part of the startup readiness path — the window is
   * already interactive before this is ever called, and nothing here is awaited
   * by anything on that path.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Two honest "there is no automatic update here" outcomes. Neither is an
    // error — the UI shows the release history and the download route instead
    // of ever printing "Update failed" for a build that simply has no feed.
    if (!this.status.canAutoUpdate) {
      this.setState({ state: "unsupported", ...this.unsupported() });
      return;
    }
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.checkForUpdates(false);
    }, LATEX_UPDATE_FIRST_CHECK_DELAY_MS);
    this.intervalTimer = setInterval(() => {
      void this.checkForUpdates(false);
    }, LATEX_UPDATE_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstTimer = null;
    this.intervalTimer = null;
    this.started = false;
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /**
   * Move the state machine and push the normalized result to the renderer.
   * Nothing else in this class is allowed to talk to the UI, so an internal
   * updater error can never leak past the boundary in raw form.
   */
  private setState(patch: Partial<UpdateStatus>, type: UpdateEvent["type"] = "update_state"): void {
    this.status = { ...this.status, ...patch };
    try {
      this.deps.send({ type, status: this.getStatus() });
    } catch (err) {
      console.warn("[Update] could not reach the renderer:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Resolve the real electron-updater instance, wire its events once, and
   * return it. Never before `canAutoUpdate` is true: a packaged build with a
   * feed. Everything here is lazy, so app startup never pays for the import.
   */
  private async ensureUpdater(): Promise<AutoUpdater | null> {
    if (this.updater) return this.updater;
    if (!this.status.canAutoUpdate) return null;
    try {
      const mod = await import("electron-updater");
      const autoUpdater: AutoUpdater = mod.autoUpdater ?? (mod as { default?: { autoUpdater?: AutoUpdater } }).default?.autoUpdater;
      if (!autoUpdater) throw new Error("electron-updater could not be loaded");
      // AUTOMATIC download, EXPLICIT restart. A detected update is fetched in
      // the background without asking, so a user who never opens Settings still
      // receives new versions — but nothing restarts behind their back, and a
      // downloaded update is installed only from "Restart & Update".
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.logger = null;
      const feed = this.resolveFeed();
      if (feed?.url) autoUpdater.setFeedURL({ provider: "generic", url: feed.url });

      autoUpdater.on("checking-for-update", () => {
        this.setState({ state: "checking", message: undefined, reason: undefined }, "update_checking");
      });
      autoUpdater.on("update-available", (info) => {
        // autoDownload is on, so the download is already starting. Report it as
        // downloading immediately rather than leaving the UI on "available"
        // waiting for a click that is not required.
        this.setState(
          {
            state: "downloading",
            version: info.version,
            percent: 0,
            releaseName: info.releaseName ?? undefined,
            releaseNotes: releaseNotesText(info.version, typeof info.releaseNotes === "string" ? info.releaseNotes : undefined),
            releaseDate: info.releaseDate,
            message: undefined,
            reason: undefined,
            lastCheckedAt: new Date().toISOString()
          },
          "update_available"
        );
      });
      autoUpdater.on("update-not-available", () => {
        this.setState(
          {
            state: "up-to-date",
            version: undefined,
            releaseName: undefined,
            releaseNotes: undefined,
            percent: undefined,
            message: `You're up to date. Latex ${this.status.currentVersion} is the latest version.`,
            reason: undefined,
            lastCheckedAt: new Date().toISOString()
          },
          "update_not_available"
        );
      });
      autoUpdater.on("download-progress", (progress) => {
        // Real numbers from the updater — never an animated fake bar.
        this.setState(
          {
            state: "downloading",
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond
          },
          "update_download_progress"
        );
      });
      autoUpdater.on("update-downloaded", (info) => {
        this.setState(
          {
            state: "downloaded",
            version: info.version,
            releaseName: info.releaseName ?? undefined,
            releaseNotes: releaseNotesText(info.version, typeof info.releaseNotes === "string" ? info.releaseNotes : undefined),
            releaseDate: info.releaseDate,
            percent: 100,
            // Busy right now? Say so up front instead of letting the user press
            // Restart and be refused.
            ...(this.isBusy()
              ? { reason: "busy" as UpdateReason, message: "Latex is still working. Restart Latex when you're finished to install." }
              : { reason: undefined, message: `Latex ${info.version} is ready to install.` })
          },
          "update_downloaded"
        );
      });
      autoUpdater.on("error", (err: unknown) => this.recordError(err));
      this.updater = autoUpdater;
      return autoUpdater;
    } catch (err) {
      this.recordError(err);
      return null;
    }
  }

  /**
   * Check for an update. Called on a delay at startup, on the background
   * interval, and on demand from Settings → Updates.
   *
   * SINGLE IN-FLIGHT: concurrent callers all receive the promise of the check
   * that is already running, so the About page opening while the startup timer
   * fires cannot produce two requests (or two downloads) against the server.
   */
  checkForUpdates(manual = false): Promise<void> {
    if (this.checkInFlight) return this.checkInFlight;
    this.checkInFlight = this.runCheck(manual).finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async runCheck(manual: boolean): Promise<void> {
    // Always enter "checking" first so a manual press has visible feedback even
    // on a build that turns out to have no feed. This is real: the check is
    // genuinely attempted, and it genuinely has nowhere to go.
    this.setState({ state: "checking", message: undefined, reason: undefined }, "update_checking");
    try {
      if (!this.status.feedConfigured || !this.status.canAutoUpdate) {
        // No feed / development build: there is nothing to ask. Settle on the
        // honest answer without pretending an update could be downloaded.
        await new Promise((resolve) => setTimeout(resolve, 250));
        this.setState(
          { state: "unsupported", ...this.unsupported(), lastCheckedAt: new Date().toISOString() },
          "update_state"
        );
        return;
      }
      const updater = await this.ensureUpdater();
      if (updater) {
        if (manual) console.log("[Update] manual check requested");
        await updater.checkForUpdates();
      }
    } catch (err) {
      this.recordError(err);
    }
  }

  /**
   * Start (or retry) the real download of the offered version.
   *
   * Not required for the normal path — `autoDownload` starts it as soon as an
   * update is detected — but kept so a download that failed can be retried from
   * the About page without waiting for the next scheduled check.
   */
  async downloadUpdate(): Promise<void> {
    if (this.status.state !== "available" && this.status.state !== "error" && this.status.state !== "downloading") return;
    const updater = await this.ensureUpdater();
    if (!updater) return;
    this.setState({ state: "downloading", percent: this.status.percent ?? 0, message: undefined, reason: undefined }, "update_state");
    try {
      await updater.downloadUpdate();
    } catch (err) {
      this.recordError(err);
    }
  }

  /**
   * Install the downloaded update by restarting through electron-updater's own
   * NSIS flow.
   *
   * REFUSED while work is in flight: an agent mid-edit, or a shell the user is
   * using, must never be terminated by a restart the user did not intend. The
   * update stays downloaded, and the About page keeps offering Restart & Update.
   */
  async installUpdate(): Promise<void> {
    if (this.status.state !== "downloaded") return;
    if (this.isBusy()) {
      this.setState({
        state: "downloaded",
        reason: "busy",
        message: "Latex is still working. Restart Latex when you're finished to install."
      });
      return;
    }
    this.setState({ state: "installing", reason: undefined, message: undefined }, "update_installing");
    try {
      const updater = await this.ensureUpdater();
      updater?.quitAndInstall();
    } catch (err) {
      this.recordError(err);
    }
  }

  /**
   * Turn any updater failure into ONE plain sentence plus a reason code.
   * Raw errors, stack traces and paths stay in the developer log — the UI only
   * ever sees what the user should actually do about it.
   */
  private recordError(err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    console.warn("[Update] updater error:", raw);
    const reason: UpdateReason =
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|offline|network|net::/i.test(raw)
        ? "network"
        : /sha512|checksum|signature|not signed|malformed|yaml/i.test(raw)
          ? "metadata"
          : /download|aborted|interrupted/i.test(raw)
            ? "download"
            : /install|exit code|registry/i.test(raw)
              ? "install"
              : /timeout|ECONNRESET|503|502|500/i.test(raw)
                ? "server"
                : "server";
    const message =
      reason === "network"
        ? "Couldn't check for updates. Check your internet connection and try again."
        : reason === "download"
          ? "The update download was interrupted. Try again, or download the latest version from the Latex release page."
          : reason === "metadata"
            ? "The update could not be verified, so it was not installed. Download the latest version from the Latex release page instead."
            : reason === "install"
              ? "The update could not be installed. Try again, or download the latest version from the Latex release page."
              : "Couldn't reach the update server. Try again in a few minutes.";
    this.setState({ state: "error", reason, message }, "update_error");
  }
}
