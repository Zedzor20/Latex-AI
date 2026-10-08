import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, Attachment, Conversation, GeminiModel, LatexSettings, ModelProvider, OllamaStatus, PendingChange, Workspace } from "../shared/types.js";

const api = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings: Partial<LatexSettings>) => ipcRenderer.invoke("settings:save", settings),
    saveApiKey: (apiKey: string, provider?: ModelProvider) => ipcRenderer.invoke("settings:saveApiKey", apiKey, provider),
    clearApiKey: (provider?: ModelProvider) => ipcRenderer.invoke("settings:clearApiKey", provider)
  },
  ai: {
    test: (provider: ModelProvider) => ipcRenderer.invoke("ai:test", provider),
    models: () => ipcRenderer.invoke("ai:models"),
    modelsForProvider: (provider: ModelProvider) => ipcRenderer.invoke("ai:models:provider", provider),
    healthProbe: () => ipcRenderer.invoke("ai:health:probe")
  },
  voice: {
    transcribe: (lang?: string) => ipcRenderer.invoke("voice:transcribe", lang)
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("clipboard:write", text)
  },
  workspace: {
    open: () => ipcRenderer.invoke("workspace:open"),
    list: () => ipcRenderer.invoke("workspace:list"),
    remove: (workspaceId: string) => ipcRenderer.invoke("workspace:remove", workspaceId),
    info: (workspace: Workspace) => ipcRenderer.invoke("workspace:info", workspace),
    watch: (workspace: Workspace) => ipcRenderer.invoke("workspace:watch", workspace),
    tree: (workspace: Workspace) => ipcRenderer.invoke("workspace:tree", workspace),
    onChanged: (callback: (path: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, path: string) => callback(path);
      ipcRenderer.on("workspace:changed", listener);
      return () => {
        ipcRenderer.off("workspace:changed", listener);
      };
    }
  },
  file: {
    read: (workspace: Workspace, relativePath: string) => ipcRenderer.invoke("file:read", workspace, relativePath),
    pick: () => ipcRenderer.invoke("file:pick") as Promise<Attachment[]>,
    applyChange: (workspace: Workspace, change: PendingChange) => ipcRenderer.invoke("file:applyChange", workspace, change),
    delete: (workspace: Workspace, relativePath: string) => ipcRenderer.invoke("file:delete", workspace, relativePath),
    open: (workspace: Workspace, relativePath: string) => ipcRenderer.invoke("file:open", workspace, relativePath)
  },
  notifications: {
    send: (title: string, body: string) => ipcRenderer.invoke("notifications:send", title, body)
  },
  shell: {
    showInFolder: (absolutePath: string) => ipcRenderer.invoke("shell:showInFolder", absolutePath)
  },
  terminal: {
    run: (workspace: Workspace, command: string) => ipcRenderer.invoke("terminal:run", workspace, command),
    // Interactive terminal (PTY-based)
    create: (terminalId: string, cwd?: string, shell?: "powershell" | "cmd", cols?: number, rows?: number): Promise<{ id: string; pid: number | undefined; cwd: string; shell: string; status: string }> =>
      ipcRenderer.invoke("terminal:create", terminalId, cwd, shell, cols, rows),
    send: (terminalId: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke("terminal:send", terminalId, data),
    resize: (terminalId: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke("terminal:resize", terminalId, cols, rows),
    minimize: (terminalId: string, minimized: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("terminal:minimize", terminalId, minimized),
    interrupt: (terminalId: string): Promise<boolean> =>
      ipcRenderer.invoke("terminal:interrupt", terminalId),
    clear: (terminalId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("terminal:clear", terminalId),
    close: (terminalId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("terminal:close", terminalId),
    getOutput: (terminalId: string): Promise<string> =>
      ipcRenderer.invoke("terminal:getOutput", terminalId),
    sessions: (): Promise<Array<{ id: string; cwd: string; shell: string; status: string; pid: number | undefined; minimized: boolean; cols: number; rows: number }>> =>
      ipcRenderer.invoke("terminal:sessions"),
    runningCount: (): Promise<number> =>
      ipcRenderer.invoke("terminal:runningCount"),
    onOutput: (callback: (output: { terminalId: string; type: string; data: string; timestamp: number }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, output: { terminalId: string; type: string; data: string; timestamp: number }) => callback(output);
      ipcRenderer.on("terminal:output", listener);
      return () => { ipcRenderer.off("terminal:output", listener); };
    },
    onSessionClosed: (callback: (data: { terminalId: string; code: number | null }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: { terminalId: string; code: number | null }) => callback(data);
      ipcRenderer.on("terminal:sessionClosed", listener);
      return () => { ipcRenderer.off("terminal:sessionClosed", listener); };
    },
    onSessionError: (callback: (data: { terminalId: string; error: string }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: { terminalId: string; error: string }) => callback(data);
      ipcRenderer.on("terminal:sessionError", listener);
      return () => { ipcRenderer.off("terminal:sessionError", listener); };
    }
  },
  conversation: {
    list: () => ipcRenderer.invoke("conversation:list"),
    save: (conversation: Conversation) => ipcRenderer.invoke("conversation:save", conversation),
    delete: (conversationId: string) => ipcRenderer.invoke("conversation:delete", conversationId),
    clear: () => ipcRenderer.invoke("conversation:clear")
  },
  mcp: {
    listTools: (workspaceAvailable: boolean, mode?: "workspace" | "full") => ipcRenderer.invoke("mcp:listTools", workspaceAvailable, mode),
    callTool: (name: string, args: Record<string, unknown>, workspace?: Workspace) => ipcRenderer.invoke("mcp:callTool", name, args, workspace)
  },
  agent: {
    // `resumeNote` carries the checkpoint brief when continuing an interrupted
    // task, so the agent continues instead of restarting the work.
    run: (conversation: Conversation, workspace?: Workspace, attachments?: Attachment[], resumeNote?: string) => ipcRenderer.invoke("agent:run", conversation, workspace, attachments, resumeNote),
    chat: (conversation: Conversation, workspace?: Workspace, attachments?: Attachment[], resumeNote?: string) => ipcRenderer.invoke("agent:chat", conversation, workspace, attachments, resumeNote),
    stop: () => ipcRenderer.invoke("agent:stop"),
    resolveApproval: (requestId: string, approved: boolean) => ipcRenderer.invoke("agent:resolveApproval", requestId, approved),
    generateImage: (conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]) => ipcRenderer.invoke("agent:generateImage", conversation, workspace, attachments),
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
      ipcRenderer.on("agent:event", listener);
      return () => {
        ipcRenderer.off("agent:event", listener);
      };
    }
  },

  // ── Persistent agent tasks (background execution + recovery) ──────
  tasks: {
    list: (): Promise<import("../shared/types.js").AgentTaskRecord[]> => ipcRenderer.invoke("tasks:list"),
    recoverable: (): Promise<import("../shared/types.js").AgentTaskRecord[]> => ipcRenderer.invoke("tasks:recoverable"),
    dismiss: (taskId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("tasks:dismiss", taskId)
  },
  puter: {
    signIn: () => ipcRenderer.invoke("puter:auth:signIn"),
    signOut: () => ipcRenderer.invoke("puter:auth:signOut"),
    getStatus: () => ipcRenderer.invoke("puter:auth:status"),
    refreshStatus: () => ipcRenderer.invoke("puter:auth:refresh"),

    onAuthChanged: (callback: (data: { status: string; username?: string }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: { status: string; username?: string }) => callback(data);
      ipcRenderer.on("puter:auth:changed", listener);
      return () => { ipcRenderer.off("puter:auth:changed", listener); };
    }
  },

  // ── Ollama ─────────────────────────────────────────────────────────────
  ollama: {
    getStatus: (): Promise<OllamaStatus> => ipcRenderer.invoke("ollama:status"),
    refresh: (): Promise<OllamaStatus> => ipcRenderer.invoke("ollama:refresh"),
    open: (): Promise<{ ok: boolean; error?: string; status?: OllamaStatus }> => ipcRenderer.invoke("ollama:open"),
    start: (): Promise<{ ok: boolean; error?: string; status?: OllamaStatus }> => ipcRenderer.invoke("ollama:start"),
    onStatusChanged: (callback: (status: OllamaStatus) => void) => {
      const listener = (_: Electron.IpcRendererEvent, status: OllamaStatus) => callback(status);
      ipcRenderer.on("ollama:statusChanged", listener);
      return () => { ipcRenderer.off("ollama:statusChanged", listener); };
    },
    /**
     * The Ollama MODEL LIST changed (a model was pulled, removed or re-tagged)
     * while the connection itself did not. Pushed only on a real change — the
     * 5-second check that finds the same models sends nothing.
     */
    onCatalogChanged: (callback: (models: GeminiModel[]) => void) => {
      const listener = (_: Electron.IpcRendererEvent, models: GeminiModel[]) => callback(models);
      ipcRenderer.on("ollama:catalogChanged", listener);
      return () => { ipcRenderer.off("ollama:catalogChanged", listener); };
    }
  },  // ── OmniRoute ───────────────────────────────────────────────────────────
  // Server status and authentication status are separate; the full status
  // object (state/needsKey/authenticated) is what the UI reasons about.
  omniroute: {
    getStatus: (): Promise<import("../shared/types.js").OmniRouteStatus> =>
      ipcRenderer.invoke("omniroute:status"),
    refresh: (): Promise<import("../shared/types.js").OmniRouteStatus> =>
      ipcRenderer.invoke("omniroute:refresh"),
    start: (): Promise<{ ok: boolean; error?: string; status?: import("../shared/types.js").OmniRouteStatus }> => ipcRenderer.invoke("omniroute:start"),
    stop: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("omniroute:stop"),
    onStatusChanged:
      (callback: (status: import("../shared/types.js").OmniRouteStatus) => void) => {
        const listener = (_: Electron.IpcRendererEvent, status: import("../shared/types.js").OmniRouteStatus) => callback(status);
        ipcRenderer.on("omniroute:statusChanged", listener);
        return () => { ipcRenderer.off("omniroute:statusChanged", listener); };
      }
  },

  // ── Provider Usage ─────────────────────────────────────────────────────
  usage: {
    fetch: (provider: string): Promise<unknown> =>
      ipcRenderer.invoke("usage:fetch", provider),
    fetchAll: (): Promise<unknown[]> =>
      ipcRenderer.invoke("usage:fetchAll")
  },

  // ── Chat Memory (Chat-only, local) ───────────────────────────────────
  memory: {
    list: (): Promise<Array<{ id: string; text: string; category: string; createdAt: number; updatedAt: number; importance: number }>> =>
      ipcRenderer.invoke("memory:list"),
    add: (memory: { id: string; text: string; category: string; sourceConversationId?: string; createdAt: number; updatedAt: number; importance: number }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("memory:add", memory),
    delete: (memoryId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("memory:delete", memoryId),
    clear: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("memory:clear"),
    analyze: (messageText: string, conversationId: string): Promise<{ id: string; text: string; category: string; createdAt: number; updatedAt: number; importance: number } | null> =>
      ipcRenderer.invoke("memory:analyze", messageText, conversationId),
    findRelevant: (messageText: string): Promise<Array<{ id: string; text: string; category: string; createdAt: number; updatedAt: number; importance: number }>> =>
      ipcRenderer.invoke("memory:findRelevant", messageText),
    getSettings: (): Promise<{ enabled: boolean; useHistory: boolean; useLongTermMemory: boolean }> =>
      ipcRenderer.invoke("memory:settings:get"),
    setSettings: (settings: Partial<{ enabled: boolean; useHistory: boolean; useLongTermMemory: boolean }>): Promise<{ enabled: boolean; useHistory: boolean; useLongTermMemory: boolean }> =>
      ipcRenderer.invoke("memory:settings:set", settings)
  },

  // ── Chat History (cross-chat context) ──────────────────────────────────
  chatHistory: {
    rebuildIndex: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chatHistory:rebuildIndex"),
    retrieveContext: (messageText: string, currentConversationId?: string): Promise<unknown> =>
      ipcRenderer.invoke("chatHistory:retrieveContext", messageText, currentConversationId),
    stats: (): Promise<{ indexedConversations: number; indexedMessages: number; settings: { enabled: boolean; useHistory: boolean; useLongTermMemory: boolean } }> =>
      ipcRenderer.invoke("chatHistory:stats")
  },

  // ── Application updates ─────────────────────────────────────────────────
  // NO ACCOUNT. Updates are identified by installed version + platform only.
  // The renderer gets four verbs and one status stream — never the updater
  // object itself, and never an update URL it could rewrite.
  updates: {
    status: (): Promise<import("../shared/updates.js").UpdateStatus> =>
      ipcRenderer.invoke("updates:status"),
    check: (): Promise<import("../shared/updates.js").UpdateStatus> =>
      ipcRenderer.invoke("updates:check"),
    download: (): Promise<import("../shared/updates.js").UpdateStatus> =>
      ipcRenderer.invoke("updates:download"),
    install: (): Promise<import("../shared/updates.js").UpdateStatus> =>
      ipcRenderer.invoke("updates:install"),
    onEvent: (callback: (event: import("../shared/updates.js").UpdateEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, event: import("../shared/updates.js").UpdateEvent) => callback(event);
      ipcRenderer.on("updates:event", listener);
      return () => {
        ipcRenderer.off("updates:event", listener);
      };
    }
  },

  // ── What's New ────────────────────────────────────────────────────────────
  // Persisted "last seen" version (local only, never synced to an account)
  // plus the release notes the renderer renders in the modal and the Settings
  // page. The main process decides *whether* to show; the renderer owns *when*
  // and *how*.
  whatsnew: {
    getState: (): Promise<{
      currentVersion: string;
      lastSeen: string | undefined;
      shouldShow: boolean;
      release?: import("../shared/updates.js").ReleaseEntry;
      /** Every release the user has not acknowledged yet, newest first. */
      unseen?: import("../shared/updates.js").ReleaseEntry[];
    }> => ipcRenderer.invoke("whatsnew:getState"),
    show: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("whatsnew:show"),
    hide: (): Promise<{ ok: boolean; lastSeen: string | undefined }> =>
      ipcRenderer.invoke("whatsnew:hide")
  },

  // ── Startup diagnostics ───────────────────────────────────────────────
  // One-way and fire-and-forget: the renderer reports named startup instants so
  // the main process can print ONE end-to-end boot timeline on a single clock.
  // It cannot block the renderer and it carries no data the app acts on.
  diagnostics: {
    startupMark: (name: string, epochMs: number, extra?: string): void => {
      ipcRenderer.send("startup:trace", name, epochMs, extra);
    }
  }
};

contextBridge.exposeInMainWorld("latex", api);
export type LatexApi = typeof api;
