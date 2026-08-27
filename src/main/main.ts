import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import { PuterAuth } from "./puterAuth.js";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { AppStore } from "./store.js";
import { FileTools } from "./fileTools.js";
import { ProviderFactory } from "./providerService.js";
import { Agent, resolvePendingApproval, stopActiveAgents } from "./agent.js";
import { id } from "./security.js";
import { runCommand } from "./terminal.js";
import { transcribeMicrophone } from "./voice.js";
import { serializeError } from "../shared/serializeError.js";
import type { Attachment, Conversation, ModelProvider, PendingChange, Workspace } from "../shared/types.js";

const store = new AppStore();
const fileTools = new FileTools();

// Remove the native File/Edit/View/Window/Help menu bar.
Menu.setApplicationMenu(null);
let mainWindow: BrowserWindow;
let activeWorkspaceWatcher: { path: string; close: () => void } | null = null;
let watcherTimer: NodeJS.Timeout | null = null;

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
  ".txt", ".md", ".json", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml", ".yaml", ".yml", ".csv", ".log", ".py", ".java", ".cpp", ".c", ".h", ".cs", ".rs", ".go", ".toml", ".env", ".gitignore", ".sh", ".ps1"
]);
const IMAGE_ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024; // 200 KB read into context
const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MB for multimodal parts

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: "Latex",
    backgroundColor: "#0c0d10",
    icon: path.join(app.getAppPath(), "build", "icon.png"),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist/preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

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

app.whenReady().then(() => {
  // Allow microphone access for voice input.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  // Initialize PuterAuth after app is ready (needs session API)
  void puterAuth.initialize();
  return createWindow();
});


app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
const providerFactory = () => new ProviderFactory(
  (provider) => store.getApiKey(provider),
  () => puterAuth.getToken()
);

ipcMain.handle("settings:get", () => {
  const settings = store.getSettings();
  const isPuterModel = settings.selectedModel?.startsWith("puter/") ?? false;
  return {
    ...settings,
    hasApiKey: isPuterModel || Boolean(store.getApiKey(settings.provider)),
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
ipcMain.handle("puter:auth:status", async () => { await puterAuth.waitForStartup(); return puterAuth.getStatus(); });
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
      { name: "Text & Code", extensions: Array.from(TEXT_ATTACHMENT_EXTENSIONS).map((e) => e.slice(1)) },
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
      if (IMAGE_ATTACHMENT_EXTENSIONS.has(ext)) {
        if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) continue;
        const data = await fs.readFile(filePath);
        attachments.push({
          id: id("att"),
          name: path.basename(filePath),
          kind: "image",
          mimeType: ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`,
          base64: data.toString("base64"),
          size: stat.size
        });
      } else if (TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
        if (stat.size > MAX_TEXT_ATTACHMENT_BYTES) {
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
      }
    } catch {
      // Skip unreadable files.
    }
  }
  return attachments;
});
ipcMain.handle("terminal:run", (_event, workspace: Workspace, command: string) => runCommand(workspace.path, command, store.getSettings().shell ?? "powershell"));

ipcMain.handle("conversation:list", () => store.getConversations());
ipcMain.handle("conversation:save", (_event, conversation: Conversation) => store.saveConversation(conversation));
ipcMain.handle("conversation:delete", (_event, conversationId: string) => store.deleteConversation(conversationId));
ipcMain.handle("conversation:clear", () => {
  store.clearConversations();
  return [];
});
ipcMain.handle("agent:run", async (_event, conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]) => {
  try {
    return await new Agent(store, mainWindow).run(conversation, workspace, attachments);
  } catch (err) {
    throw serializeError(err);
  }
});
ipcMain.handle("agent:chat", async (_event, conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]) => {
  try {
    return await new Agent(store, mainWindow).chat(conversation, workspace, attachments);
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
ipcMain.handle("notifications:send", (_event, title: string, body: string) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
  return { ok: true };
});
ipcMain.handle("shell:showInFolder", (_event, absolutePath: string) => {
  if (typeof absolutePath === "string" && absolutePath) shell.showItemInFolder(absolutePath);
  return { ok: true };
});


