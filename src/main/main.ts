import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import { revealNow, revealWhenReady } from "./windowReveal.js";
import { PuterAuth } from "./puterAuth.js";
import { mark, markFromRenderer, markSkipped, sinceStart, withBudget } from "./startupTrace.js";

import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { AppStore } from "./store.js";
import { getTaskManager } from "./taskManager.js";
import { FileTools } from "./fileTools.js";
import { ProviderFactory } from "./providerService.js";
import { checkOllamaStatus, openOllamaApp, waitForOllama } from "./ollamaService.js";
import { ollamaMonitor, type OllamaCatalog, type OllamaCatalogChange } from "./ollamaMonitor.js";
import { Agent, registerPendingApproval, resolvePendingApproval, stopActiveAgents } from "./agent.js";
import { UpdateService } from "./updateService.js";
import { callMcpTool, listMcpTools } from "./mcpTools.js";
import type { ToolContext } from "./tools.js";
import { id } from "./security.js";
import { runCommand } from "./terminal.js";
import { transcribeMicrophone } from "./voice.js";
import { serializeError } from "../shared/serializeError.js";
import { releaseEntryFor, unseenReleases } from "../shared/updates.js";
import type { Attachment, Conversation, ModelProvider, OmniRouteStatus, PendingChange, Workspace } from "../shared/types.js";

mark("startup:start");
// The config file (which holds every conversation) is read and parsed EXACTLY
// ONCE per launch, here. AppStore holds the parsed copy for the life of the
// process; see the long note in store.ts for why that matters — without it,
// every single property read re-read the whole file, which cost seconds of
// blocking main-thread CPU and was the real cause of the "stuck initializing"
// symptom. Measured here rather than assumed cheap.
const store = new AppStore();
mark("startup:store", `store parsed at +${sinceStart()}ms`);
const fileTools = new FileTools();
// Persistent agent-task registry (owned by the main process — Part D). On
// boot, any task still marked running/waiting was cut off mid-flight: mark it
// interrupted so the renderer can offer Continue with restored state (Parts G/H).
const taskManager = getTaskManager(store);
taskManager.recoverInterrupted();

// Renderer startup marks arrive on a one-way channel and are folded into this
// same timeline, so "process start → first interactive paint" is ONE
// measurement instead of two unrelated clocks.
ipcMain.on("startup:trace", (_event, name: string, epochMs: number, extra?: string) => {
  markFromRenderer(name, epochMs, extra);
  // The renderer itself tells us the moment its UI is interactive, so the
  // window is revealed on that FACT instead of waiting for a paint heuristic.
  if (name === "startup:ready") revealNow();
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

// Remove the native File/Edit/View/Window/Help menu bar.
Menu.setApplicationMenu(null);
let mainWindow: BrowserWindow;
let activeWorkspaceWatcher: { path: string; close: () => void } | null = null;
let watcherTimer: NodeJS.Timeout | null = null;

// ── Application updates (main process owns the updater) ─────────────────────
// No account, no login: an update is identified by installed version +
// platform. The renderer only ever sees a normalized UpdateStatus through the
// four `updates:*` invokes and the `updates:event` stream below.
const updateService = new UpdateService({
  activeTaskCount: () =>
    taskManager.list().filter((task) =>
      task.status === "running" || task.status === "waiting_for_model" || task.status === "waiting_for_tool"
    ).length,
  // A live shell counts as work too: restarting Latex to install an update
  // would kill the user's terminal, so it blocks the automatic install exactly
  // like a running agent task does.
  activeTerminalCount: () => interactiveTerminal.runningCount(),
  send: (event) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("updates:event", event);
      }
    } catch {
      // Window not ready yet — the renderer pulls the current state on mount.
    }
  }
});

ipcMain.handle("updates:status", () => updateService.getStatus());
ipcMain.handle("updates:check", async () => {
  await updateService.checkForUpdates(true);
  return updateService.getStatus();
});
ipcMain.handle("updates:download", async () => {
  await updateService.downloadUpdate();
  return updateService.getStatus();
});
ipcMain.handle("updates:install", async () => {
  await updateService.installUpdate();
  return updateService.getStatus();
});

// ── What's New dialog — persisted seen-version + modal control ───────────────
// The renderer asks once: "should I show the What's New modal now?". The main
// process compares the current app version against the last version the user
// acknowledged, answers honestly, and never opens the modal itself (the
// renderer owns the React tree). The `whatsnew:show`/`whatsnew:hide` IPCs are
// the renderer telling the main process that the modal is currently on screen
// or has been dismissed, so dev reloads can't popcorn the dialog.
ipcMain.handle("whatsnew:getState", () => {
  const currentVersion = app.getVersion();
  const lastSeen = store.getLastSeenWhatsNewVersion();
  // Everything the user has NOT acknowledged yet, newest first (see
  // unseenReleases: a version jump surfaces every release in between, a fresh
  // install shows only the installed release).
  const unseen = unseenReleases(lastSeen, currentVersion);
  // A packaged build opens the modal on the first launch whose release notes
  // have not been acknowledged. Development NEVER auto-opens; an explicit
  // LATEX_WHATS_NEW=1 override is the controlled test path, so ordinary dev
  // reloads cannot re-trigger the dialog or corrupt the seen-version state.
  const forced = process.env.LATEX_WHATS_NEW === "1" || process.env.LATEX_WHATS_NEW === "force";
  const shouldShow = Boolean(currentVersion && (forced || (app.isPackaged && unseen.length > 0)));
  return {
    currentVersion,
    lastSeen,
    shouldShow,
    release: unseen[0] ?? releaseEntryFor(currentVersion),
    unseen: shouldShow ? unseen : []
  };
});

ipcMain.handle("whatsnew:show", () => {
  // Renderer-facing ack: the modal is now on screen. The renderer is the
  // authority here; this is just so a dev reload can tell a fresh renderer
  // not to re-open the dialog that is already showing.
  return { ok: true };
});

ipcMain.handle("whatsnew:hide", async () => {
  const currentVersion = app.getVersion();
  if (currentVersion) {
    store.setLastSeenWhatsNewVersion(currentVersion);
  }
  return { ok: true, lastSeen: store.getLastSeenWhatsNewVersion() };
});

function watchWorkspace(workspace: Workspace): void {
  if (activeWorkspaceWatcher?.path === workspace.path) return;
  activeWorkspaceWatcher?.close();
  activeWorkspaceWatcher = null;
  let fsWatcher: ReturnType<typeof watch> | null = null;
  try {
    fsWatcher = watch(workspace.path, { recursive: true }, () => {
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send("workspace:changed", workspace.path);
      }, 400);
    });
    fsWatcher.on("error", () => { /* watcher dies silently on permission errors */ });
    activeWorkspaceWatcher = { path: workspace.path, close: () => fsWatcher?.close() };
  } catch {
    // fs.watch can throw on some paths — the watcher is best-effort.
  }
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".csv", ".tsv", ".log", ".py", ".java", ".cpp", ".c", ".h", ".hpp", ".cs", ".rs", ".go", ".toml", ".env", ".gitignore", ".sh", ".ps1", ".bat", ".cmd", ".ini", ".cfg", ".sql",
  ".pdf", ".doc", ".docx", ".rtf", ".odt", ".xlsx", ".xls"
]);
const IMAGE_ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const MAX_TEXT_ATTACHMENT_BYTES = 400 * 1024; // 400 KB read into context
const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MB for multimodal parts

/**
 * Extract text content from supported document formats.
 * Returns extracted text or undefined if extraction is not supported.
 */
async function extractDocumentText(filePath: string, ext: string): Promise<string | undefined> {
  try {
    const data = await fs.readFile(filePath);
    // PDF: extract text using a simple marker-based approach
    // For full PDF support, a library like pdf-parse would be needed,
    // but we can at least extract readable text segments
    if (ext === ".pdf") {
      // Simple PDF text extraction: look for text between BT/ET markers
      const text = data.toString("latin1");
      const lines: string[] = [];
      const tjMatches = text.match(/\(([^)]+)\)\s*Tj/g);
      if (tjMatches) {
        for (const m of tjMatches) {
          const content = m.replace(/^\(/, "").replace(/\)\s*Tj$/, "");
          if (content.trim()) lines.push(content);
        }
      }
      if (lines.length > 0) return lines.join("\n");
      // Fallback: extract any readable ASCII sequences
      const ascii = text.match(/[\x20-\x7E\n\r\t]{10,}/g);
      if (ascii) return ascii.join("\n");
      return "[PDF file — text extraction limited. The file is attached for reference.]";
    }
    // DOCX: extract text from the XML content
    if (ext === ".docx") {
      try {
        // DOCX is a ZIP file; the main text is in word/document.xml
        const AdmZip = await import("adm-zip").then(m => m.default).catch(() => null);
        if (AdmZip) {
          const zip = new AdmZip(data);
          const xmlEntry = zip.getEntry("word/document.xml");
          if (xmlEntry) {
            const xml = xmlEntry.getData().toString("utf8");
            const textParts: string[] = [];
            const wMatches = xml.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
            if (wMatches) {
              for (const m of wMatches) {
                const content = m.replace(/<[^>]+>/g, "");
                if (content.trim()) textParts.push(content);
              }
            }
            if (textParts.length > 0) return textParts.join(" ");
          }
        }
      } catch { /* fall through */ }
      // Fallback: try reading as raw text
      const raw = data.toString("utf8");
      const readable = raw.match(/[\x20-\x7E\n\r\t]{8,}/g);
      if (readable) return readable.join("\n");
      return "[DOCX file — text extraction limited.]";
    }
    // XLSX: extract cell values from the XML
    if (ext === ".xlsx") {
      try {
        const AdmZip = await import("adm-zip").then(m => m.default).catch(() => null);
        if (AdmZip) {
          const zip = new AdmZip(data);
          const sheetEntries = zip.getEntries().filter(e => e.entryName.match(/xl\/worksheets\/sheet\d+\.xml/));
          const rows: string[] = [];
          for (const entry of sheetEntries.slice(0, 3)) {
            const xml = entry.getData().toString("utf8");
            const cellMatches = xml.match(/<v>([^<]+)<\/v>/g);
            if (cellMatches) {
              const cells = cellMatches.map(c => c.replace(/<[^>]+>/g, "").trim());
              rows.push(cells.join(" | "));
            }
          }
          if (rows.length > 0) return rows.join("\n");
        }
      } catch { /* fall through */ }
      const raw = data.toString("utf8");
      const readable = raw.match(/[\x20-\x7E]{5,}/g);
      if (readable) return readable.join("\n");
      return "[XLSX file — text extraction limited.]";
    }
    // XLS (old format): try reading as text
    if (ext === ".xls") {
      const raw = data.toString("latin1");
      const readable = raw.match(/[\x20-\x7E]{5,}/g);
      if (readable) return readable.join("\n");
      return "[XLS file — binary format, text extraction limited.]";
    }
    // RTF/ODT: try extracting readable text
    if (ext === ".rtf" || ext === ".odt") {
      const raw = data.toString("utf8");
      // Strip RTF control words
      let cleaned = raw.replace(/\\[a-z]+\d*\s?/g, "").replace(/[{}]/g, "");
      cleaned = cleaned.replace(/\s+/g, " ").trim();
      if (cleaned.length > 50) return cleaned.slice(0, MAX_TEXT_ATTACHMENT_BYTES);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: "Latex",
    // Hidden until it has painted (see revealWhenReady) so the user never sees
    // an unpainted white/black rectangle flash before the UI is there.
    show: false,
    // Pure black: matches the dark theme's #000 canvas, so a window resize can
    // never flash a lighter flash of the previous frame of the previous one.
    backgroundColor: "#000000",
    icon: path.join(app.getAppPath(), "build", "icon.png"),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist/preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // CRITICAL for startup. The window is created hidden and revealed once it
      // has painted. Chromium BACKGROUND-THROTTLES a hidden renderer: timers and
      // deferred work are heavily rate-limited, which delayed React's first
      // commit by seconds and made startup wildly inconsistent (sometimes ~2s,
      // sometimes ~11s). It also slowed streaming, terminals and background
      // agent tasks whenever the window was occluded or minimised. This app is
      // deliberately long-running and must keep working while it is not the
      // focused window, so throttling is disabled.
      backgroundThrottling: false
    }
  });

  // Show the window the moment it has painted — or sooner, if the renderer
  // reports that its UI is interactive before then. There is no longer an
  // opening animation, so nothing is standing between the user and the app.
  revealWhenReady(mainWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"));
  }

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (!app.isPackaged) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  // Dev-only health check: confirms the preload bridge exists and #root is populated.
  if (!app.isPackaged) {
    setTimeout(() => {
      void mainWindow.webContents
        .executeJavaScript(
          `JSON.stringify({
            bridge: typeof window.latex !== "undefined",
            rootLength: document.getElementById("root")?.innerHTML.length ?? 0
          })`
        )
        .then((result) => console.log(`[diag] ${result}`));
    }, 1000);
  }
}

const puterAuth = new PuterAuth(store);

app.whenReady().then(async () => {
  mark("startup:app-ready");
  // NOTE: no opening animation any more. It cost ~0.94s of CPU and ~105 MB of
  // working set in the first five seconds (a transparent, always-on-top window
  // animating at 60 fps) and hid the real window while it played. The window is
  // now revealed as soon as it paints — see windowReveal.ts for the numbers.
  //
  // Allow microphone access for voice input.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  console.log("[MAIN] Creating window...");
  await createWindow();
  mark("startup:window-created");

  // Record what is DELIBERATELY not started, so the timeline shows the real
  // architecture instead of an unexplained gap. These are lazy by design: each
  // one is expensive (process spawn, filesystem walk) and none is needed for
  // the user to read a chat or type a message.
  markSkipped("startup:terminal", "lazy — starts on first terminal open");
  markSkipped("startup:agent-tools", "lazy — starts on first Main Agent run");
  markSkipped("startup:workspace-scan", "lazy — starts on demand");

  // ── Everything below is NON-CRITICAL and starts only now ────────────────
  // The window already exists and its renderer is loading, so none of this can
  // delay the UI. Each step is bounded and independent: a provider, a local
  // service or a network call that hangs degrades its own feature only.

  // Puter session restore performs a network round-trip to puter.com.
  // Deliberately NOT awaited — an unreachable Puter must not hold up anything.
  void withBudget({
    name: "Puter session restore",
    work: () => puterAuth.initialize(),
    slowMs: 1000,
    hardMs: 5000,
    fallback: undefined
  });

  // Background pollers. These used to be module-level intervals, so they began
  // DURING boot and competed with it for the main thread and the network.
  startBackgroundPollers();

  // Starts the background update check. This only schedules it: the first
  // check runs ~20s later on its own timer and every check is async, so app
  // startup is never gated on the updater — the window above is already open.
  updateService.start();
  mark("startup:updates", "scheduled (non-blocking)");
});


app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
const providerFactory = () => new ProviderFactory(
  (provider) => store.getApiKey(provider),
  () => puterAuth.getToken()
);

ipcMain.handle("settings:get", async () => {
  const settings = store.getSettings();
  const provider = settings.provider ?? "gemini";
  const isPuterModel = settings.selectedModel?.startsWith("puter/") ?? false;
  const isOllamaModel = settings.selectedModel?.startsWith("ollama/") ?? false;
  // OmniRoute readiness is a LIVE server + auth verdict, never the mere
  // presence of a stored key: a keyless gateway must work with no key, and a
  // stored-but-rejected key must NOT be treated as ready.
  //
  // CRITICAL: `settings:get` is the FIRST call the renderer makes on boot, so
  // it must never wait on the network. A forced fresh probe used to run here,
  // which meant a slow or silent gateway delayed the ENTIRE boot sequence
  // behind multiple connection timeouts. We now answer from the cache and
  // refresh in the background; the status stream corrects the UI the moment the
  // fresh verdict lands, so the first paint is never held hostage.
  const omnirouteActive = provider === "omniroute" || (settings.selectedModel?.startsWith("omniroute/") ?? false);
  if (omnirouteActive) void refreshOmniRouteStatusInBackground();
  const omnirouteStatus = lastOmniRouteStatus;
  const ready = isPuterModel
    || isOllamaModel
    || (omnirouteActive ? isOmniRouteReady(omnirouteStatus) : Boolean(store.getApiKey(provider)));
  return {
    ...settings,
    hasApiKey: ready,
    providers: providerFactory().statuses()
  };
});
ipcMain.handle("settings:save", (_event, settings) => store.setSettings(settings));
ipcMain.handle("settings:saveApiKey", (_event, apiKey: string, provider?: ModelProvider) => {
  store.setApiKey(apiKey, provider ?? "gemini");
  return { ok: true };
});
ipcMain.handle("settings:clearApiKey", (_event, provider?: ModelProvider) => {
  store.clearApiKey(provider ?? "gemini");
  return { ok: true };
});
ipcMain.handle("ai:test", async (_event, provider: ModelProvider) => {
  try {
    if (provider === "puter") return { ok: true }; // Puter always available
    await providerFactory().test(provider);
    return { ok: true };
  } catch (err) {
    throw serializeError(err);
  }
});

// ── Puter authentication (delegated to PuterAuth service) ─────────────
// See puterAuth.ts for the full implementation.
// Uses a persistent BrowserWindow on puter.com for authentication.
// Initialized after app.whenReady().

// ── Puter auth IPC handlers (delegated to PuterAuth service) ──────────
ipcMain.handle("puter:auth:signIn", async () => puterAuth.signIn());
ipcMain.handle("puter:auth:signOut", async () => { await puterAuth.signOut(); return { ok: true }; });
// Puter session verification is a network round-trip to puter.com, and the
// renderer awaits this during boot. It is therefore BOUNDED: if the check has
// not settled in time we answer with the current (possibly unverified) status
// instead of leaving the UI waiting on an unreachable server.
ipcMain.handle("puter:auth:status", async () => {
  await withBudget({
    name: "Puter status",
    work: () => puterAuth.waitForStartup(),
    slowMs: 800,
    hardMs: 4000,
    fallback: undefined
  });
  return puterAuth.getStatus();
});
ipcMain.handle("puter:auth:refresh", async () => puterAuth.refreshSession());



/** Expose the Puter auth token for the provider to use. */
export function getPuterAuthToken(): string | null {
  return puterAuth.getToken();
}

ipcMain.handle("ai:models", async () => {
  try {
    return await providerFactory().listAllModels();
  } catch (err) {
    throw serializeError(err);
  }
});
ipcMain.handle("ai:health:probe", async () => {
  try {
    return await providerFactory().probeAll();
  } catch (err) {
    throw serializeError(err);
  }
});

// ── Ollama ──────────────────────────────────────────────────────────────

/**
 * Push the Ollama monitor's REAL changes to the renderer.
 *
 * Two channels, because they mean two different things:
 *   • `ollama:statusChanged` — the CONNECTION (connected / not running / not
 *     installed), so the UI can say what is true about the server;
 *   • `ollama:catalogChanged` — the MODEL LIST, so a model pulled (or removed)
 *     while the server stayed up appears without the user clicking Refresh, and
 *     a server started after Latex is followed by its models.
 *
 * The monitor only calls this when something actually changed, so an idle
 * 5-second check sends nothing and touches no renderer state.
 */
function publishOllamaCatalog(catalog: OllamaCatalog, change: OllamaCatalogChange): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (change.status) mainWindow.webContents.send("ollama:statusChanged", catalog.status);
  if (change.models) mainWindow.webContents.send("ollama:catalogChanged", catalog.models);
}

/** Timers owned by the background pollers, cleared on quit. */
let omniroutePollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long until the next OmniRoute liveness probe.
 *
 * The probe chains real HTTP requests against the local gateway, so it must
 * never run on a fixed hot cadence forever. Two honest regimes:
 *
 *   • a gateway was reachable (or is starting) → 5 s, so a stop/restart outside
 *     Latex is noticed quickly, which is the whole point of watching it;
 *   • nothing is listening → 30 s. There is no server to notice the loss of, and
 *     a gateway can only appear because the user started it — which routes
 *     through Latex's own Start button and probes immediately afterwards.
 *
 * Before this, Latex probed every 5 seconds for its entire lifetime, including
 * on every machine that has no OmniRoute installed at all.
 */
const OMNIROUTE_POLL_ACTIVE_MS = 5_000;
const OMNIROUTE_POLL_IDLE_MS = 30_000;

function omniroutePollDelay(): number {
  return lastOmniRouteStatus?.running || omnirouteStartInFlight
    ? OMNIROUTE_POLL_ACTIVE_MS
    : OMNIROUTE_POLL_IDLE_MS;
}

/** Self-rescheduling so each tick can choose its own next delay. */
function scheduleOmniroutePoll(): void {
  if (omniroutePollTimer) clearTimeout(omniroutePollTimer);
  omniroutePollTimer = setTimeout(() => {
    omniroutePollTimer = null;
    void pollOmniRouteStatus().finally(() => scheduleOmniroutePoll());
  }, omniroutePollDelay());
}

/**
 * Start the background liveness pollers.
 *
 * Called ONLY after the window exists, so they can never compete with startup
 * for the main thread or the network. The first poll of each is bounded and
 * recorded on the startup timeline, which is what turns "Ollama detection took
 * 8 seconds" from an invisible hang into a labelled stage.
 */
function startBackgroundPollers(): void {
  void withBudget({
    name: "Ollama detection",
    work: () => ollamaMonitor.pollNow(),
    slowMs: 500,
    hardMs: 4000,
    fallback: undefined
  }).then(() => mark("startup:ollama"));

  // ONE Ollama loop, owned by the main process: a 5-second cadence with an
  // in-flight guard and change detection, so a model that appears after Latex
  // started (Test A) or one installed while the server runs (new/removed model)
  // reaches the picker on its own. Idempotent — no second interval can exist,
  // whatever calls this.
  ollamaMonitor.start();

  // OmniRoute: one bounded detection now, then the steady poll. The previous
  // `setTimeout(…, 2000)` fired blind 2s into boot; this runs the probe inside
  // a budget so a gateway that never answers cannot wedge the pipeline.
  void withBudget({
    name: "OmniRoute detection",
    work: () => pollOmniRouteStatus(),
    slowMs: 500,
    hardMs: 4000,
    fallback: undefined
  }).then(() => mark("startup:omniroute"));

  scheduleOmniroutePoll();
}

/** Stop the poll loops. Called on quit so no timer outlives the app. */
function stopBackgroundPollers(): void {
  ollamaMonitor.stop();
  if (omniroutePollTimer) { clearTimeout(omniroutePollTimer); omniroutePollTimer = null; }
}

// The monitor subscribes ONCE, for the app's lifetime. Nothing else in the
// main process pushes Ollama state, so every renderer update is the same
// change report from the same single probe.
ollamaMonitor.onUpdate(publishOllamaCatalog);

// The cached status when the monitor has already looked (it started at boot),
// so what the UI reads back always agrees with what it was pushed.
ipcMain.handle("ollama:status", () => ollamaMonitor.getCatalog()?.status ?? checkOllamaStatus());

/** Manual Refresh Models — an explicit probe, sharing the monitor's guard. */
ipcMain.handle("ollama:refresh", async () => {
  await ollamaMonitor.pollNow();
  return ollamaMonitor.getCatalog()?.status ?? checkOllamaStatus();
});

ipcMain.handle("ollama:open", async () => {
  const launch = await openOllamaApp();
  if (!launch.ok) return { ok: false, error: launch.error };
  const connected = await waitForOllama();
  // Probe immediately: a server Latex just started must reach the picker now,
  // not on the next scheduled tick.
  await ollamaMonitor.pollNow();
  const status = ollamaMonitor.getCatalog()?.status ?? await checkOllamaStatus();
  return { ok: connected, status };
});

ipcMain.handle("ollama:start", async () => {
  // Start Ollama server - opens visible CMD window running 'ollama serve'
  const launch = await openOllamaApp();
  if (!launch.ok) return { ok: false, error: launch.error };
  const connected = await waitForOllama();
  await ollamaMonitor.pollNow();
  const status = ollamaMonitor.getCatalog()?.status ?? await checkOllamaStatus();
  return { ok: connected, status };
});

// ── OmniRoute ────────────────────────────────────────────────────────────
/**
 * The visible CMD window Latex opened for OmniRoute, and whether Latex started
 * it at all.
 *
 * Ownership rule: Latex only ever stops an instance IT started. A gateway the
 * user launched themselves is adopted for status purposes and never touched.
 */
let omnirouteCmdPid: number | null = null;
/** Non-Windows fallback: the detached process handle, used like the PID above. */
let omnirouteProcess: import("node:child_process").ChildProcess | null = null;
let omnirouteStartedByLatex = false;
/** A Start click already in flight — repeated clicks must not open more windows. */
let omnirouteStartInFlight: Promise<{ ok: boolean; error?: string; status?: OmniRouteStatus }> | null = null;

/** Last known OmniRoute state — used to emit change events to the renderer. */
let lastOmniRouteState: string | null = null;
/** Full last status (cached so sync code paths can reason about readiness). */
let lastOmniRouteStatus: OmniRouteStatus | null = null;
/** When the cached status was captured — keeps `settings:get` from probing twice. */
let lastOmniRouteAt = 0;

/**
 * AUTHENTICATION STATUS derived from the last probe: the gateway is usable
 * either because it needs no key or because it accepted the one we have.
 * Note this is deliberately NOT the same question as `status.running`, which
 * only says the server process is alive.
 */
function isOmniRouteReady(status: OmniRouteStatus | null): boolean {
  return Boolean(
    status?.running && (status.state === "online_authenticated" || status.state === "online_no_auth_required")
  );
}

async function probeOmniRouteStatus(): Promise<OmniRouteStatus> {
  const { checkOmniRouteStatus } = await import("./omnirouteProvider.js");
  const omnirouteKey = store.getApiKey("omniroute");
  // The endpoint (including any LATEX_OMNIROUTE_BASE_URL override) is resolved
  // inside the provider, so status, model discovery and completions can never
  // disagree about which gateway Latex is talking to.
  let status = await checkOmniRouteStatus(undefined, omnirouteKey ?? undefined);
  // While a launch is in flight, a not-yet-listening port must read as
  // "starting", never "not running" — the process was just launched. Applied
  // here so EVERY consumer (poll, IPC getStatus, launch loop) agrees.
  if (omnirouteStartInFlight && !status.running) {
    status = { ...status, state: "starting" };
  }
  lastOmniRouteStatus = status;
  lastOmniRouteAt = Date.now();
  return status;
}

/**
 * Return the cached status, re-probing when it is older than `maxAgeMs`.
 * Pass 0 to force a fresh probe. Never throws.
 */
async function ensureOmniRouteStatus(maxAgeMs = 2000): Promise<OmniRouteStatus | null> {
  if (lastOmniRouteStatus && Date.now() - lastOmniRouteAt <= maxAgeMs) return lastOmniRouteStatus;
  // Bounded: `checkOmniRouteStatus` chains several HTTP probes, so a gateway
  // that accepts the socket but never answers must not hold the caller.
  return withBudget({
    name: "OmniRoute status probe",
    work: () => probeOmniRouteStatus(),
    slowMs: 1500,
    hardMs: 6000,
    fallback: lastOmniRouteStatus
  });
}

/**
 * Refresh OmniRoute status without ever making a caller wait for it.
 *
 * Deduplicated (a second call joins the in-flight one) and failure-tolerant:
 * if the fresh probe fails or times out the cached verdict simply stays. This is
 * the shape every boot path should use — ask, don't wait.
 */
let omnirouteRefreshInFlight: Promise<void> | null = null;
function refreshOmniRouteStatusInBackground(): Promise<void> {
  if (!omnirouteRefreshInFlight) {
    omnirouteRefreshInFlight = withBudget({
      name: "OmniRoute status refresh",
      work: () => pollOmniRouteStatus(),
      slowMs: 800,
      hardMs: 6000,
      fallback: undefined
    })
      .then(() => undefined)
      .finally(() => {
        omnirouteRefreshInFlight = null;
      });
  }
  return omnirouteRefreshInFlight;
}

/** Push a status to the renderer and remember it as the last broadcast state. */
function broadcastOmniRouteStatus(status: OmniRouteStatus): void {
  if (status.state === lastOmniRouteState) return;
  lastOmniRouteState = status.state;
  console.log(`[OmniRoute] State changed: ${status.state}${status.modelCount > 0 ? ` (${status.modelCount} models)` : ""}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("omniroute:statusChanged", status);
  }
}

/**
 * Tell the UI a launch is in flight so it shows "Starting…" instead of
 * "Not running" while the gateway boots. The state is transient: the next
 * successful liveness probe replaces it with a real online state.
 */
function broadcastOmniRouteStarting(): void {
  const starting: OmniRouteStatus = {
    running: false,
    state: "starting",
    needsKey: false,
    authenticated: false,
    hasKey: Boolean(store.getApiKey("omniroute")),
    modelCount: 0,
    baseUrl: lastOmniRouteStatus?.baseUrl ?? "http://127.0.0.1:20128"
  };
  lastOmniRouteStatus = starting;
  lastOmniRouteAt = Date.now();
  broadcastOmniRouteStatus(starting);
}

async function pollOmniRouteStatus(): Promise<void> {
  try {
    const status = await probeOmniRouteStatus();
    // `status.state` is the authoritative source: the server staying alive
    // while auth changes must not be reported as a connect/disconnect flip.
    broadcastOmniRouteStatus(status);
  } catch {
    // Defensive — checkOmniRouteStatus never throws normally
  }
}

// The OmniRoute poll loop is started by `startBackgroundPollers()` once the
// window is up (see `app.whenReady`), together with a bounded first detection
// that is recorded on the startup timeline.

/** Run a PowerShell one-liner and return its trimmed stdout ("" on failure). */
async function powershell(script: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    return (
      await new Promise<string>((resolve, reject) => {
        execFile(
          "powershell",
          ["-NoProfile", "-Command", script],
          { windowsHide: true, timeout: 15_000 },
          (err, out) => (err ? reject(err) : resolve(out))
        );
      })
    ).trim();
  } catch {
    return "";
  }
}

interface VisibleCmdWindow {
  pid: number;
  commandLine: string;
}

/**
 * The cmd.exe processes that own a VISIBLE console window.
 *
 * This is the only reliable way to tell whether a real CMD window appeared: the
 * Electron main process has no console of its own, so a directly spawned
 * `cmd.exe` inherits none and runs completely windowless (verified against the
 * packaged app) — `start` is what allocates a console window, and that window
 * then belongs to a NEW cmd.exe which has to be found here to keep ownership.
 *
 * The command line travels with it because the window TITLE cannot be trusted:
 * OmniRoute renames its own console ("omniroute (v16.3.1)").
 */
async function visibleCmdWindows(): Promise<VisibleCmdWindow[]> {
  const script =
    "$visible = @(Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id }); " +
    "if ($visible.Count -gt 0) { @(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
    "Where-Object { $visible -contains $_.ProcessId } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress }";
  const out = await powershell(script);
  if (!out) return [];
  try {
    const parsed: unknown = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return (list as { ProcessId: number; CommandLine?: string }[]).map((entry) => ({
      pid: Number(entry.ProcessId),
      commandLine: String(entry.CommandLine ?? "")
    }));
  } catch {
    return [];
  }
}

/** The command line of one process, or null when it is already gone. */
async function processCommandLine(pid: number): Promise<string | null> {
  const out = await powershell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`
  );
  return out ? out : null;
}

/**
 * Open a REAL visible Windows CMD window and actually run `omniroute` in it.
 *
 * `cmd.exe /d /c start "" cmd.exe /d /k "<title> & omniroute"` is deliberate:
 *   • `start` is what creates the console window (a direct spawn shows none).
 *   • `/d` skips AutoRun scripts; `/k` keeps the window open AFTER omniroute
 *     exits, so a failure leaves the real Windows error on screen.
 *   • `omniroute` is resolved through the normal PATH lookup — no guessed or
 *     hardcoded install path.
 * Returns the PID of the CMD window it opened, so Stop closes only that one.
 */
async function openOmniRouteWindow(): Promise<{ ok: boolean; error?: string; pid: number | null }> {
  // Snapshot first: the window Latex opens is the one that was not there before
  // AND whose command line actually runs omniroute. That pair is what makes
  // ownership exact — a CMD the user opens at the same moment is neither ours.
  const before = await visibleCmdWindows();
  const { spawn: spawnChild } = await import("node:child_process");
  const launcher = spawnChild(
    "cmd.exe",
    ["/d", "/c", "start", "", "cmd.exe", "/d", "/k", "omniroute"],
    { windowsHide: false, detached: true, stdio: "ignore" }
  );
  let spawnError: Error | null = null;
  launcher.on("error", (err: Error) => { spawnError = err; });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const now = await visibleCmdWindows();
    const ours = now.find(
      (window) =>
        !before.some((previous) => previous.pid === window.pid) && /omniroute/i.test(window.commandLine)
    );
    if (ours) return { ok: true, pid: ours.pid };
  }
  if (spawnError) return { ok: false, error: (spawnError as Error).message, pid: null };
  // The window may still be opening, or Windows could not enumerate it.
  // Report success and let the readiness probe decide the actual state.
  return { ok: true, pid: null };
}

/** Close a process tree — used ONLY for the CMD window Latex itself opened. */
async function closeProcessTree(pid: number): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, (err) =>
        err ? reject(err) : resolve()
      );
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Repeated clicks join the attempt already in flight instead of racing it —
 * five fast clicks open one CMD window, not five.
 */
async function startOmniRouteProcess(): Promise<{ ok: boolean; error?: string; status?: OmniRouteStatus }> {
  if (omnirouteStartInFlight) return omnirouteStartInFlight;
  const attempt = launchAndAwaitOmniRoute();
  omnirouteStartInFlight = attempt;
  try {
    return await attempt;
  } finally {
    omnirouteStartInFlight = null;
  }
}

async function launchAndAwaitOmniRoute(): Promise<{ ok: boolean; error?: string; status?: OmniRouteStatus }> {
  // Liveness first, and from SERVER HEALTH — never `/v1/models` alone, because
  // a keyed gateway answers 401 there while running perfectly well. Anything
  // already reachable is adopted as-is: Latex never opens a second instance.
  const existing = await probeOmniRouteStatus();
  if (existing.running) {
    console.log(`[OmniRoute] Already running (${existing.state}) — adopting it, no new window.`);
    return { ok: true, status: existing };
  }

  // Open a REAL visible Windows CMD window and run the omniroute command.
  // The user must SEE the CMD window with OmniRoute's startup output.
  try {
    if (process.platform === "win32") {
      const opened = await openOmniRouteWindow();
      if (!opened.ok) {
        return { ok: false, error: opened.error ?? "Failed to open a Command Prompt for OmniRoute." };
      }
      omnirouteStartedByLatex = true;
      omnirouteCmdPid = opened.pid;
      // The window is open and the process is booting: report "starting" NOW so
      // the UI never shows "Not running" for a server the user just launched.
      broadcastOmniRouteStarting();
      console.log(
        `[OmniRoute] Opened a visible CMD window${opened.pid ? ` (PID ${opened.pid})` : ""} running: omniroute`
      );
    } else {
      // Non-Windows: same contract through the normal terminal.
      const { spawn } = await import("node:child_process");
      const child = spawn("omniroute", [], {
        windowsHide: false,
        detached: true,
        stdio: "ignore"
      });
      omnirouteProcess = child;
      omnirouteStartedByLatex = true;

      child.on("error", (err) => {
        console.error("[OmniRoute] Process error:", err.message);
        omnirouteProcess = null;
        omnirouteStartedByLatex = false;
      });

      child.on("close", () => {
        omnirouteProcess = null;
        omnirouteStartedByLatex = false;
      });
    }

    // Poll the real OmniRoute endpoint until it responds (up to 60 seconds).
    // Do NOT assume it started — only trust the actual HTTP response.
    // Poll fast at first (the process is warm), then back off so a slow boot
    // does not hammer loopback. The first healthy /api/health wins.
    const pollDelay = (attempt: number): number => Math.min(750 + attempt * 250, 3000);
    const MAX_WAIT_MS = 90_000;
    const startTime = Date.now();
    let attempt = 0;
    console.log("[OmniRoute] Waiting for the gateway to become available...");

    // Wait for SERVER HEALTH, not for an authenticated response: a freshly
    // started gateway may be up and answering 401 until a key is supplied.
    // Treating that 401 as "not started" would abort startup spuriously.
    while (Date.now() - startTime < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, pollDelay(attempt++)));
      try {
        const check = await probeOmniRouteStatus();
        if (check.running) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`[OmniRoute] Gateway is up after ${elapsed}s — state: ${check.state}${check.modelCount > 0 ? `, ${check.modelCount} model(s)` : ""}.`);
          // Emit the state change (health up ≠ authenticated) so the UI can ask
          // for a key only when the gateway actually requires one.
          lastOmniRouteStatus = check;
          lastOmniRouteAt = Date.now();
          broadcastOmniRouteStatus(check);
          return { ok: true, status: check };
        }
        // Log intermediate failures for diagnostics
        if (check.error) {
          console.log(`[OmniRoute] Poll: ${check.error}`);
        }
      } catch (pollErr) {
        console.log(`[OmniRoute] Poll error: ${pollErr instanceof Error ? pollErr.message : pollErr}`);
      }
    }

    return { ok: false, error: "OmniRoute did not become available within 90 seconds. Check the CMD window for errors." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to start OmniRoute. Make sure it is installed and available in PATH." };
  }
}

ipcMain.handle("omniroute:status", async () => ensureOmniRouteStatus(2000));
ipcMain.handle("omniroute:refresh", async () => {
  // A manual refresh always re-probes, and broadcasts the result so every
  // renderer view (settings card, composer, banner) agrees on one state.
  await pollOmniRouteStatus();
  return lastOmniRouteStatus;
});
ipcMain.handle("omniroute:start", async () => {
  return startOmniRouteProcess();
});
ipcMain.handle("omniroute:stop", async () => {
  // Only a gateway Latex started may be closed — a gateway the user launched
  // themselves (startedByLatex = false) is never touched.
  if (!omnirouteStartedByLatex) {
    return { ok: false, error: "OmniRoute was not started by Latex" };
  }
  if (process.platform === "win32") {
    if (omnirouteCmdPid === null) {
      omnirouteStartedByLatex = false;
      return {
        ok: false,
        error: "Latex could not identify the CMD window it opened — close that window to stop OmniRoute."
      };
    }
    // Last safety check before killing anything: that PID must still be the
    // CMD window running omniroute. Nothing else is ever terminated.
    const cmdLine = await processCommandLine(omnirouteCmdPid);
    if (cmdLine === null) {
      omnirouteCmdPid = null;
      omnirouteStartedByLatex = false;
      return { ok: false, error: "The OmniRoute CMD window had already been closed." };
    }
    if (!/omniroute/i.test(cmdLine)) {
      omnirouteCmdPid = null;
      omnirouteStartedByLatex = false;
      return { ok: false, error: "That process is no longer the OmniRoute window Latex opened, so it was left alone." };
    }
    const closed = await closeProcessTree(omnirouteCmdPid);
    omnirouteCmdPid = null;
    omnirouteStartedByLatex = false;
    return closed
      ? { ok: true }
      : { ok: false, error: "The OmniRoute CMD window had already been closed." };
  }
  if (omnirouteProcess) {
    try {
      omnirouteProcess.kill("SIGTERM");
      omnirouteProcess = null;
      omnirouteStartedByLatex = false;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to stop OmniRoute" };
    }
  }
  omnirouteStartedByLatex = false;
  return { ok: false, error: "OmniRoute is no longer running." };
});

// ── Provider Usage ───────────────────────────────────────────────────────
ipcMain.handle("usage:fetch", async (_event, provider: ModelProvider) => {
  try {
    const { fetchProviderUsage } = await import("./providerUsageService.js");
    const apiKey = store.getApiKey(provider);
    return fetchProviderUsage(provider, apiKey ?? undefined);
  } catch (err) {
    return { provider, status: "error", error: err instanceof Error ? err.message : "Failed" };
  }
});
ipcMain.handle("usage:fetchAll", async () => {
  try {
    const { fetchAllProviderUsage } = await import("./providerUsageService.js");
    return fetchAllProviderUsage((p) => store.getApiKey(p) ?? undefined);
  } catch (err) {
    return [];
  }
});

ipcMain.handle("ai:models:provider", async (_event, provider: ModelProvider) => {
  try {
    const factory = providerFactory();
    const impl = factory.getProvider(provider);
    if (!impl) return [];
    return await impl.listModels(true);
  } catch (err) {
    throw serializeError(err);
  }
});

ipcMain.handle("voice:transcribe", async (_event, lang?: string) => transcribeMicrophone(12000, lang));

ipcMain.handle("clipboard:write", (_event, text: string) => {
  if (typeof text === "string") clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle("workspace:open", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return undefined;
  const folderPath = result.filePaths[0];
  const workspace: Workspace = {
    id: id("ws"),
    name: path.basename(folderPath),
    path: folderPath,
    trusted: false,
    lastOpenedAt: Date.now()
  };
  store.saveWorkspace(workspace);
  watchWorkspace(workspace);
  return workspace;
});
ipcMain.handle("workspace:list", () => store.getWorkspaces());
ipcMain.handle("workspace:remove", (_event, workspaceId: string) => {
  const remaining = store.getWorkspaces().filter((item) => item.id !== workspaceId);
  store.removeWorkspace(workspaceId);
  return remaining;
});
ipcMain.handle("workspace:info", (_event, workspace: Workspace) => fileTools.getWorkspaceInfo(workspace.path));
ipcMain.handle("workspace:watch", (_event, workspace: Workspace) => {
  watchWorkspace(workspace);
  return { ok: true };
});
ipcMain.handle("workspace:tree", (_event, workspace: Workspace) => fileTools.tree(workspace.path));
ipcMain.handle("file:read", (_event, workspace: Workspace, relativePath: string) => fileTools.readFile(workspace.path, relativePath));
ipcMain.handle("file:applyChange", (_event, workspace: Workspace, change: PendingChange) => fileTools.applyChange(workspace.path, change));
ipcMain.handle("file:delete", (_event, workspace: Workspace, relativePath: string) => fileTools.deleteFile(workspace.path, relativePath));
ipcMain.handle("file:open", async (_event, workspace: Workspace, relativePath: string) => {
  // Resolve inside the workspace so the model/UI can never open an arbitrary path.
  const resolved = path.resolve(workspace.path, relativePath);
  const prefix = path.resolve(workspace.path) + path.sep;
  if (!resolved.startsWith(prefix)) return { ok: false, error: "Path is outside the workspace." };
  const error = await shell.openPath(resolved);
  return { ok: error === "", error: error || undefined };
});
ipcMain.handle("file:pick", async (): Promise<Attachment[]> => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Attach files",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "All Supported", extensions: [...Array.from(TEXT_ATTACHMENT_EXTENSIONS).map(e => e.slice(1)), ...Array.from(IMAGE_ATTACHMENT_EXTENSIONS).map(e => e.slice(1))] },
      { name: "Text & Code", extensions: Array.from(TEXT_ATTACHMENT_EXTENSIONS).filter(e => !e.startsWith(".pdf") && !e.startsWith(".doc") && !e.startsWith(".xls") && !e.startsWith(".rtf") && !e.startsWith(".odt")).map((e) => e.slice(1)) },
      { name: "Documents", extensions: ["pdf", "doc", "docx", "rtf", "odt", "xlsx", "xls"] },
      { name: "Images", extensions: Array.from(IMAGE_ATTACHMENT_EXTENSIONS).map((e) => e.slice(1)) },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled) return [];
  const attachments: Attachment[] = [];
  for (const filePath of result.filePaths.slice(0, 8)) {
    try {
      const stat = await fs.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const docExts = new Set([".pdf", ".doc", ".docx", ".rtf", ".odt", ".xlsx", ".xls"]);
      if (IMAGE_ATTACHMENT_EXTENSIONS.has(ext)) {
        if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) continue;
        const data = await fs.readFile(filePath);
        let mimeType = `image/${ext.slice(1)}`;
        if (ext === ".jpg") mimeType = "image/jpeg";
        if (ext === ".svg") mimeType = "image/svg+xml";
        attachments.push({
          id: id("att"),
          name: path.basename(filePath),
          kind: "image",
          mimeType,
          base64: data.toString("base64"),
          size: stat.size
        });
      } else if (docExts.has(ext)) {
        // Document files: extract text content for the model
        const extracted = await extractDocumentText(filePath, ext);
        if (extracted) {
          attachments.push({
            id: id("att"),
            name: path.basename(filePath),
            kind: "text",
            content: extracted.slice(0, MAX_TEXT_ATTACHMENT_BYTES),
            truncated: extracted.length > MAX_TEXT_ATTACHMENT_BYTES,
            size: stat.size,
            label: `${ext.toUpperCase().slice(1)} document`
          });
        } else {
          // Fallback: attach as text with metadata
          attachments.push({
            id: id("att"),
            name: path.basename(filePath),
            kind: "text",
            content: `[${ext.toUpperCase().slice(1)} file: ${path.basename(filePath)} — size: ${(stat.size / 1024).toFixed(1)} KB]`,
            size: stat.size,
            label: `${ext.toUpperCase().slice(1)} document`
          });
        }
      } else if (TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
        if (stat.size > MAX_TEXT_ATTACHMENT_BYTES * 2) {
          const data = await fs.readFile(filePath, "utf8");
          attachments.push({
            id: id("att"),
            name: path.basename(filePath),
            kind: "text",
            content: data.slice(0, MAX_TEXT_ATTACHMENT_BYTES),
            truncated: true,
            size: stat.size
          });
        } else {
          attachments.push({
            id: id("att"),
            name: path.basename(filePath),
            kind: "text",
            content: await fs.readFile(filePath, "utf8"),
            size: stat.size
          });
        }
      } else {
        // Unknown extension: try reading as text
        if (stat.size <= MAX_TEXT_ATTACHMENT_BYTES) {
          const data = await fs.readFile(filePath, "utf8");
          attachments.push({
            id: id("att"),
            name: path.basename(filePath),
            kind: "text",
            content: data,
            size: stat.size
          });
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  return attachments;
});
ipcMain.handle("terminal:run", (_event, workspace: Workspace, command: string) => runCommand(workspace.path, command, store.getSettings().shell ?? "powershell"));

// ── Interactive Terminal ──────────────────────────────────────────────────
import { getTerminal } from "./interactiveTerminal.js";

const interactiveTerminal = getTerminal();

// Forward terminal output events to renderer
interactiveTerminal.on("output", (output) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal:output", output);
  }
});

interactiveTerminal.on("session:closed", (data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal:sessionClosed", data);
  }
});

interactiveTerminal.on("session:error", (data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal:sessionError", data);
  }
});

ipcMain.handle("terminal:create", async (_event, terminalId: string, cwd?: string, shell?: "powershell" | "cmd", cols?: number, rows?: number) => {
  const workspacePath = cwd ?? (store.getWorkspaces()[0]?.path ?? process.cwd());
  const shellType = shell ?? (store.getSettings().shell ?? "powershell");
  const session = await interactiveTerminal.createSession(terminalId, workspacePath, shellType, cols ?? 120, rows ?? 30);
  return {
    id: session.id,
    pid: session.pid,
    cwd: session.cwd,
    shell: session.shell,
    status: session.status
  };
});

ipcMain.handle("terminal:send", (_event, terminalId: string, data: string) => {
  return interactiveTerminal.sendInput(terminalId, data);
});

ipcMain.handle("terminal:resize", (_event, terminalId: string, cols: number, rows: number) => {
  return interactiveTerminal.resize(terminalId, cols, rows);
});

ipcMain.handle("terminal:minimize", (_event, terminalId: string, minimized: boolean) => {
  interactiveTerminal.setMinimized(terminalId, minimized);
  return { ok: true };
});

ipcMain.handle("terminal:interrupt", (_event, terminalId: string) => {
  return interactiveTerminal.sendInterrupt(terminalId);
});

ipcMain.handle("terminal:clear", (_event, terminalId: string) => {
  interactiveTerminal.clearOutput(terminalId);
  return { ok: true };
});

ipcMain.handle("terminal:close", (_event, terminalId: string) => {
  interactiveTerminal.destroySession(terminalId);
  return { ok: true };
});

ipcMain.handle("terminal:getOutput", (_event, terminalId: string) => {
  return interactiveTerminal.getOutput(terminalId);
});

ipcMain.handle("terminal:sessions", () => {
  return interactiveTerminal.getActiveSessions();
});

ipcMain.handle("terminal:runningCount", () => {
  return interactiveTerminal.runningCount();
});

// Clean up terminals when app quits
app.on("before-quit", () => {
  // Checkpoint every active task (partial response, activity, tool calls,
  // provider/model, file ops) BEFORE anything is torn down — the main process
  // owns durable task state, not React beforeunload (Part G).
  taskManager.flushAll();
  interactiveTerminal.destroyAll();
  // No poll tick may outlive the window it reports to.
  stopBackgroundPollers();
});

ipcMain.handle("conversation:list", () => store.getConversations());
ipcMain.handle("conversation:save", (_event, conversation: Conversation) => {
  const result = store.saveConversation(conversation);
  // Keep the chat history index in sync
  if (conversation.mode === "chat") {
    chatHistory.indexConversation(conversation);
  }
  return result;
});
ipcMain.handle("conversation:delete", (_event, conversationId: string) => {
  const result = store.deleteConversation(conversationId);
  // Remove deleted conversation from the search index
  chatHistory.removeConversation(conversationId);
  // Drop its task checkpoints too — no orphaned recoverable tasks.
  taskManager.dropChat(conversationId);
  return result;
});
ipcMain.handle("conversation:clear", () => {
  store.clearConversations();
  chatHistory.rebuildIndex([]);
  for (const task of taskManager.list()) taskManager.dropChat(task.chatId);
  return [];
});
ipcMain.handle("agent:run", async (_event, conversation: Conversation, workspace?: Workspace, attachments?: Attachment[], resumeNote?: string) => {
  try {
    return await new Agent(store, mainWindow).run(conversation, workspace, attachments, resumeNote);
  } catch (err) {
    throw serializeError(err);
  }
});
ipcMain.handle("agent:chat", async (_event, conversation: Conversation, workspace?: Workspace, attachments?: Attachment[], resumeNote?: string) => {
  try {
    return await new Agent(store, mainWindow, chatHistory).chat(conversation, workspace, attachments, resumeNote);
  } catch (err) {
    throw serializeError(err);
  }
});
ipcMain.handle("agent:stop", () => {
  stopActiveAgents();
  return { ok: true };
});
ipcMain.handle("agent:resolveApproval", (_event, requestId: string, approved: boolean) => ({
  ok: resolvePendingApproval(requestId, approved)
}));
ipcMain.handle("agent:generateImage", async (_event, conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]) => {
  try {
    return await new Agent(store, mainWindow).generateImage(conversation, workspace, attachments);
  } catch (err) {
    throw serializeError(err);
  }
});


// ── Persistent tasks: recovery + dismissal (Parts D/H/I) ──────────
// The renderer subscribes to task events via agent:event; these handles let
// it list interrupted tasks on boot and offer Continue from the checkpoint.
ipcMain.handle("tasks:list", () => taskManager.list());
ipcMain.handle("tasks:recoverable", () => taskManager.listRecoverable());
ipcMain.handle("tasks:dismiss", (_event, taskId: string) => {
  taskManager.dismiss(taskId);
  return { ok: true };
});

// ── MCP: Model Context Protocol integration ───────────────────────────────
// Exposes Latex's EXISTING verified tool registry through MCP-compatible
// list/call surfaces. Execution stays in the Electron main process behind
// the same approval flow — no duplicate tools, no renderer filesystem access.
ipcMain.handle("mcp:listTools", (_event, workspaceAvailable: boolean, mode?: "workspace" | "full") =>
  listMcpTools(Boolean(workspaceAvailable), mode ?? "workspace")
);
ipcMain.handle("mcp:callTool", async (_event, name: string, args: Record<string, unknown>, workspace?: Workspace) => {
  try {
    const settings = store.getSettings();
    const mode = settings.filesystemAccess === "full" ? "full" : "workspace";
    fileTools.setMode(mode);
    const ctx: ToolContext = {
      workspace,
      settings,
      fileTools,
      mode,
      collectChange: () => undefined
    };
    return await callMcpTool(name, args ?? {}, ctx, async (request) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      // Reuse the agent approval event channel — the existing permission UI
      // handles it, and resolution flows through agent:resolveApproval.
      mainWindow.webContents.send("agent:event", {
        type: "approval",
        conversationId: "mcp",
        payload: request
      });
      return registerPendingApproval(request.requestId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
});
ipcMain.handle("notifications:send", (_event, title: string, body: string) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
  return { ok: true };
});
ipcMain.handle("shell:showInFolder", (_event, absolutePath: string) => {
  if (typeof absolutePath === "string" && absolutePath) shell.showItemInFolder(absolutePath);
  return { ok: true };
});

// ── Chat History & Memory System ────────────────────────────────────────
import type { ChatMemory } from "../shared/types.js";
import { analyzeForMemory, findRelevantMemories, findMemoryToUpdate, mergeMemory } from "./memoryService.js";
import { ChatHistoryService } from "./chatHistoryService.js";

// Instantiate the chat history service and build index from persisted conversations
const chatHistory = new ChatHistoryService();
void chatHistory.rebuildIndex(store.getConversations());

// Store memories in the electron store
ipcMain.handle("memory:list", () => {
  return (store as any).store?.get("chatMemories", []) ?? [];
});

ipcMain.handle("memory:add", (_event, memory: ChatMemory) => {
  const memories: ChatMemory[] = (store as any).store?.get("chatMemories", []) ?? [];
  // Check for similar existing memory and merge/update instead of duplicating
  const existing = findMemoryToUpdate(memory, memories);
  if (existing) {
    const merged = mergeMemory(existing, memory);
    const updated = memories.map(m => m.id === existing.id ? merged : m);
    (store as any).store?.set("chatMemories", updated);
    return { ok: true, merged: true };
  }
  // Avoid exact duplicates
  const exists = memories.some(m => m.text.toLowerCase() === memory.text.toLowerCase());
  if (exists) return { ok: false, error: "Memory already exists" };
  const updated = [memory, ...memories].slice(0, 200); // Limit to 200 memories
  (store as any).store?.set("chatMemories", updated);
  return { ok: true };
});

ipcMain.handle("memory:delete", (_event, memoryId: string) => {
  const memories: ChatMemory[] = (store as any).store?.get("chatMemories", []) ?? [];
  const updated = memories.filter(m => m.id !== memoryId);
  (store as any).store?.set("chatMemories", updated);
  return { ok: true };
});

ipcMain.handle("memory:clear", () => {
  (store as any).store?.set("chatMemories", []);
  return { ok: true };
});

ipcMain.handle("memory:analyze", (_event, messageText: string, conversationId: string) => {
  const memories: ChatMemory[] = (store as any).store?.get("chatMemories", []) ?? [];
  return analyzeForMemory(messageText, conversationId, memories);
});

ipcMain.handle("memory:findRelevant", (_event, messageText: string) => {
  const memories: ChatMemory[] = (store as any).store?.get("chatMemories", []) ?? [];
  return findRelevantMemories(messageText, memories);
});

ipcMain.handle("memory:settings:get", () => chatHistory.getSettings());
ipcMain.handle("memory:settings:set", (_event, settings: Partial<{ enabled: boolean; useHistory: boolean; useLongTermMemory: boolean }>) => {
  chatHistory.updateSettings(settings);
  return chatHistory.getSettings();
});

// ── Chat History (cross-chat context retrieval) ─────────────────────────
ipcMain.handle("chatHistory:rebuildIndex", () => {
  chatHistory.rebuildIndex(store.getConversations());
  return { ok: true };
});
ipcMain.handle("chatHistory:retrieveContext", (_event, messageText: string, currentConversationId?: string) => {
  const memories: ChatMemory[] = (store as any).store?.get("chatMemories", []) ?? [];
  return chatHistory.retrieveContext(messageText, memories, currentConversationId);
});
ipcMain.handle("chatHistory:stats", () => {
  return {
    indexedConversations: (chatHistory as any).indexedConversationIds?.size ?? 0,
    indexedMessages: (chatHistory as any).index?.length ?? 0,
    settings: chatHistory.getSettings()
  };
});




