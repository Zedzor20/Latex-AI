import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, Attachment, Conversation, LatexSettings, ModelProvider, PendingChange, Workspace } from "../shared/types.js";

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
    run: (workspace: Workspace, command: string) => ipcRenderer.invoke("terminal:run", workspace, command)
  },
  conversation: {
    list: () => ipcRenderer.invoke("conversation:list"),
    save: (conversation: Conversation) => ipcRenderer.invoke("conversation:save", conversation),
    delete: (conversationId: string) => ipcRenderer.invoke("conversation:delete", conversationId),
    clear: () => ipcRenderer.invoke("conversation:clear")
  },
  agent: {
    run: (conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]) => ipcRenderer.invoke("agent:run", conversation, workspace, attachments),
    chat: (conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]) => ipcRenderer.invoke("agent:chat", conversation, workspace, attachments),
    stop: () => ipcRenderer.invoke("agent:stop"),
    resolveApproval: (requestId: string, approved: boolean) => ipcRenderer.invoke("agent:resolveApproval", requestId, approved),
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
      ipcRenderer.on("agent:event", listener);
      return () => {
        ipcRenderer.off("agent:event", listener);
      };
    }
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
  }
};

contextBridge.exposeInMainWorld("latex", api);
export type LatexApi = typeof api;
