/**
 * ────────────────────────────────────────────────────────────────────────────
 *  LATEX UPDATE CONFIGURATION — the ONLY place these values are declared.
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  Latex has NO account or login system, and updating must never depend on one.
 *  An update is identified purely by { current version, platform, arch,
 *  channel }, exactly like any normal desktop application.
 *
 *  WHERE THE FEED COMES FROM
 *  -------------------------
 *  The updater resolves a source in this order:
 *
 *    1. `LATEX_UPDATE_FEED_URL` below — a generic HTTPS directory that serves
 *       the electron-builder update manifest (`latest.yml`) plus the installer.
 *       Leave it empty when electron-builder already publishes the feed (see
 *       below); it exists as an override for hosting the same manifest somewhere
 *       else, without a rebuild of the packaging config.
 *
 *    2. THE NORMAL PATH: electron-builder's own `build.publish` configuration in
 *       `package.json`. Building a release emits `app-update.yml` into the
 *       packaged `resources/` directory next to the installer, and
 *       electron-updater reads it automatically. This is why the shipped app
 *       needs NO secret and NO account: it only reads a public manifest, and
 *       the publishing credential stays in the release environment.
 *
 *    3. Nothing configured → Latex says so plainly and routes the user to
 *       `LATEX_WEBSITE_URL` to download the newest version by hand. It never
 *       pretends an automatic update is possible, and never fabricates a URL.
 *
 *  `LATEX_WEBSITE_URL` stays empty until the project has a real public download
 *  page; the UI then explains the situation instead of opening a made-up address.
 */
export const LATEX_UPDATE_FEED_URL = "";
/**
 * The official Latex download page, used by the "Download Latest Version"
 * button when automatic updating is unavailable. Leave empty until the real
 * site exists — the UI then explains that updates are distributed by the
 * Latex release page instead of opening a made-up address.
 */
export const LATEX_WEBSITE_URL = "";

/**
 * How often the background update check runs. Several hours: frequent enough to
 * catch a release the same day, rare enough to be invisible. A manual check
 * from Settings → Updates always runs immediately regardless of this.
 */
export const LATEX_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the FIRST background check after launch.
 *
 * Never on the critical path: the window is created and interactive long before
 * this fires, and nothing in startup awaits the updater. Ten seconds is enough
 * that the update request cannot compete with the renderer's first paint, model
 * catalog or provider discovery, while still finding a release soon after the
 * user has settled into the app.
 */
export const LATEX_UPDATE_FIRST_CHECK_DELAY_MS = 10 * 1000;

/**
 * Why an update check could not be completed. The distinction matters to the
 * user: "this build has no update feed" is not a failure, while "the update
 * server did not answer" is.
 */
export type UpdateReason =
  | "not-configured"
  | "development"
  | "unsupported"
  | "network"
  | "server"
  | "metadata"
  | "download"
  | "install"
  | "busy";

/** The complete update state machine. */
export type UpdateState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error"
  | "unsupported";

/**
 * Everything the renderer is allowed to know about the updater. Normalized:
 * internal updater errors never cross this boundary.
 */
export interface UpdateStatus {
  state: UpdateState;
  /** The INSTALLED version, from app.getVersion(). Never hardcoded. */
  currentVersion: string;
  /** The version the update feed offers. Only ever set by the real updater. */
  version?: string;
  releaseName?: string;
  /** Release notes from the release metadata, when the feed provides them. */
  releaseNotes?: string;
  releaseDate?: string;
  /** Download progress, from the updater's real progress events. */
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** A normalized, user-facing sentence. Never a stack trace. */
  message?: string;
  reason?: UpdateReason;
  /** True when an update feed (source 1 or 2) exists at all. */
  feedConfigured: boolean;
  /** Whether the running build can install updates in place. */
  canAutoUpdate: boolean;
  /** The official download page, only when the website route is genuinely there. */
  websiteUrl?: string;
  lastCheckedAt?: string;
}

/** The normalized event pushed to the renderer on every state change. */
export interface UpdateEvent {
  type:
    | "update_state"
    | "update_checking"
    | "update_available"
    | "update_not_available"
    | "update_download_progress"
    | "update_downloaded"
    | "update_error"
    | "update_installing";
  status: UpdateStatus;
}

/** ────────────────────────────────────────────────────────────────────────────
 *  THE RELEASE HISTORY — one maintainable source for "What's New".
 *
 *  Add a new entry at the TOP when you ship a release; the UI, the Settings →
 *  Updates page and the update notification all read from here. The changelog
 *  is deliberately duplicated nowhere.
 *
 *  Rules kept by every entry: only real, shipped changes. Nothing is invented
 *  for the sake of a fuller list.
 *  ──────────────────────────────────────────────────────────────────────────── */
export interface ReleaseEntry {
  version: string;
  /** ISO date (YYYY-MM-DD) — rendered in the user's locale. */
  date: string;
  name?: string;
  added?: string[];
  fixed?: string[];
  improved?: string[];
}

/**
 * The releases a user has NOT acknowledged yet, newest first.
 *
 *  • with a recorded `lastSeen`, every documented release NEWER than it — so a
 *    version jump (1.0.0 → 1.0.3) surfaces the releases it skipped rather than
 *    assuming they were read;
 *  • with nothing recorded (fresh install), only the release the user actually
 *    installed — never the whole back catalogue;
 *  • never a release newer than the INSTALLED version (the changelog can run
 *    ahead of a build).
 */
export function unseenReleases(lastSeen: string | undefined, currentVersion?: string): ReleaseEntry[] {
  const newestFirst = [...LATEX_RELEASES].sort((a, b) => compareVersions(b.version, a.version));
  const capped = currentVersion
    ? newestFirst.filter((entry) => compareVersions(entry.version, currentVersion) <= 0)
    : newestFirst;
  if (lastSeen) return capped.filter((entry) => compareVersions(entry.version, lastSeen) > 0);
  const current = releaseEntryFor(currentVersion);
  return current ? [current] : capped.slice(0, 1);
}

export const LATEX_RELEASES: ReleaseEntry[] = [
  {
    version: "1.2.0",
    date: "2026-10-07",
    name: "Fast startup & real automatic updates",
    added: [
      "Automatic updates: installed releases now detect, download and install new versions on their own — no account, no manual installer download",
      "A quiet update indicator that shows download progress and offers Restart & Update without taking over the window"
    ],
    fixed: [
      "Startup could stall while initializing: the local config (which holds every conversation) was being re-read and re-parsed from disk on each individual read, costing seconds of blocked main-thread work",
      "An Ollama status check spawned a synchronous child process on every poll when the server was not running"
    ],
    improved: [
      "Latex opens noticeably faster and stays responsive while providers and models are discovered in the background",
      "The opening animation was removed — it cost measurable CPU and memory for no functional benefit",
      "Provider and gateway polling now backs off when nothing is listening instead of running at a fixed hot cadence"
    ]
  },
  {
    version: "1.1.0",
    date: "2026-10-03",
    name: "Real-time Thinking & polished workspace",
    added: [
      "Real-time Thinking box: reasoning streams live from the provider instead of appearing at the end",
      "Thinking response box in both Main and Chat; the broken Thinking filter is gone from the Chat composer",
      "Live file-writing previews that stream the real file content as it is produced",
      "Model picker filters are single-select, with a verified Thinking model list",
      "Application update system with release notes (no Latex account required)",
      "Persistent task checkpoints so an interrupted task can be continued after a fresh start",
      "Image generation for providers that expose it"
    ],
    fixed: [
      "Thinking and agent activity could arrive in one final burst instead of streaming",
      "The model filter could keep two filters selected at once",
      "Live Thinking / Agent activity panels could be squeezed to a sliver in long conversations",
      "Assistant responses could feel like they arrived in delayed chunks"
    ],
    improved: [
      "Response streaming is frame-aligned, so text paints as it arrives",
      "Thinking and agent activity are separate, clearly structured panels",
      "Code blocks show a language label with a copy button",
      "Command output is collapsible, with the exit code always visible",
      "Sidebar, Main/Chat switch, dropdowns and selection states animate smoothly",
      "Typography hierarchy: quieter metadata, clearer section headings"
    ]
  },
  {
    version: "1.0.0",
    date: "2026-09-13",
    name: "First release",
    added: [
      "Main agent mode with real file reading, editing and command execution",
      "Chat mode for conversation-only questions",
      "Multiple providers: Gemini, Puter, Ollama, OmniRoute, OpenRouter, Groq, MiniMax",
      "Interactive terminal, explorer, search and change review",
      "Persistent conversations, workspaces, attachments and voice input"
    ]
  }
];

/** The newest release documented in the changelog (never the "latest available" version). */
export function latestDocumentedRelease(): ReleaseEntry {
  return LATEX_RELEASES[0];
}

/** The changelog entry for a specific version, if it is documented. */
export function releaseEntryFor(version?: string): ReleaseEntry | undefined {
  if (!version) return undefined;
  const wanted = normalizeVersion(version);
  return LATEX_RELEASES.find((entry) => normalizeVersion(entry.version) === wanted);
}

/** Strip a leading "v" and any prerelease/build suffix for comparison. */
export function normalizeVersion(version: string): string {
  return String(version).trim().replace(/^v/i, "").split(/[+\-]/)[0];
}

/**
 * Compare two versions numerically (1.10.0 > 1.9.0). Returns a positive number
 * when `a` is newer than `b`. Used so the updater never relies on string order.
 */
export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split(".").map((part) => parseInt(part, 10) || 0);
  const right = normalizeVersion(b).split(".").map((part) => parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Release notes for a version: the feed's own notes win (real metadata), then
 * the documented changelog entry. Returns undefined when neither exists.
 */
export function releaseNotesText(version: string | undefined, feedNotes?: string): string | undefined {
  if (feedNotes && feedNotes.trim()) return feedNotes.trim();
  const entry = releaseEntryFor(version);
  if (!entry) return undefined;
  const lines: string[] = [];
  if (entry.added?.length) lines.push(`New\n${entry.added.map((item) => `• ${item}`).join("\n")}`);
  if (entry.fixed?.length) lines.push(`Fixed\n${entry.fixed.map((item) => `• ${item}`).join("\n")}`);
  if (entry.improved?.length) lines.push(`Improved\n${entry.improved.map((item) => `• ${item}`).join("\n")}`);
  return lines.join("\n\n");
}

/**
 * A friendly release date. Falls back to the raw value so an odd feed date can
 * never crash the renderer.
 */
export function formatReleaseDate(date?: string): string {
  if (!date) return "";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Human-readable byte size, used by the download progress line. */
export function formatUpdateBytes(bytes?: number): string {
  if (!bytes || bytes < 1) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toString()} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}