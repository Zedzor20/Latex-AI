import Store from "electron-store";
import { safeStorage } from "electron";
import type { Conversation, LatexSettings, ModelProvider, Workspace } from "../shared/types.js";

interface StoreShape {
  settings: LatexSettings;
  encryptedGeminiKey?: string;
  encryptedOpenRouterKey?: string;
  encryptedMiniMaxKey?: string;
  encryptedGroqKey?: string;
  puterToken?: string;
  puterUsername?: string;
  workspaces: Workspace[];
  conversations: Conversation[];
}

const defaults: StoreShape = {
  settings: {
    provider: "gemini",
    approvalMode: "always",
    terminalApprovalMode: "always",
    filesystemAccess: "workspace",
    pcControl: "ask",
    temperature: 0.4,
    maxOutputTokens: 8192,
    theme: "dark",
    shell: "powershell",
    autoSelectModel: true,
    voiceInput: true,
    speakResponses: false,
    voiceLang: "auto",
    notifyOnFinish: false
  },
  workspaces: [],
  conversations: []
};

export class AppStore {
  private store = new Store<StoreShape>({ defaults });

  getSettings(): LatexSettings {
    return this.store.get("settings", defaults.settings);
  }

  setSettings(settings: Partial<LatexSettings>): LatexSettings {
    const next = { ...this.getSettings(), ...settings };
    this.store.set("settings", next);
    return next;
  }

  private keyField(provider: ModelProvider): "encryptedGeminiKey" | "encryptedOpenRouterKey" | "encryptedMiniMaxKey" | "encryptedGroqKey" | null {
    switch (provider) {
      case "openrouter": return "encryptedOpenRouterKey";
      case "minimax": return "encryptedMiniMaxKey";
      case "groq": return "encryptedGroqKey";
      case "puter": return null; // Puter does not require an API key
      default: return "encryptedGeminiKey";
    }
  }

  setApiKey(apiKey: string, provider: ModelProvider = "gemini"): void {
    const field = this.keyField(provider);
    if (!field) return; // Puter does not need an API key
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(apiKey).toString("base64")
      : Buffer.from(apiKey, "utf8").toString("base64");
    this.store.set(field, encrypted);
  }

  getApiKey(provider: ModelProvider = "gemini"): string | undefined {
    if (provider === "puter") return undefined; // Puter has no API key
    const field = this.keyField(provider);
    if (!field) return undefined;
    const encrypted = this.store.get(field);
    if (!encrypted) return undefined;
    const buffer = Buffer.from(encrypted, "base64");
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buffer)
      : buffer.toString("utf8");
  }

  // ── Puter token persistence ───────────────────────────────────────
  getPuterToken(): string | undefined {
    return this.store.get("puterToken") || undefined;
  }

  setPuterToken(token: string | null): void {
    if (token) {
      this.store.set("puterToken", token);
    } else {
      this.store.delete("puterToken" as any);
      this.store.delete("puterUsername" as any);
    }
  }

  getPuterUsername(): string | undefined {
    return this.store.get("puterUsername") || undefined;
  }

  setPuterUsername(username: string | null): void {
    if (username) {
      this.store.set("puterUsername", username);
    } else {
      this.store.delete("puterUsername" as any);
    }
  }

  /** Which providers have a key stored. */
  configuredProviders(): ModelProvider[] {
    return (["gemini", "openrouter", "minimax", "groq"] as ModelProvider[]).filter((provider) => Boolean(this.getApiKey(provider)));
  }

  clearApiKey(provider: ModelProvider = "gemini"): void {
    const field = this.keyField(provider);
    if (!field) return; // Puter has no key to clear
    this.store.delete(field);
  }

  getWorkspaces(): Workspace[] {
    return this.store.get("workspaces", []);
  }

  saveWorkspace(workspace: Workspace): Workspace[] {
    const current = this.getWorkspaces().filter((item) => item.path !== workspace.path);
    const next = [workspace, ...current].slice(0, 20);
    this.store.set("workspaces", next);
    return next;
  }

  removeWorkspace(workspaceId: string): void {
    const next = this.getWorkspaces().filter((item) => item.id !== workspaceId);
    this.store.set("workspaces", next);
  }

  getConversations(): Conversation[] {
    return this.store.get("conversations", []);
  }

  saveConversation(conversation: Conversation): Conversation[] {
    const next = [conversation, ...this.getConversations().filter((item) => item.id !== conversation.id)];
    this.store.set("conversations", next);
    return next;
  }

  deleteConversation(conversationId: string): Conversation[] {
    const next = this.getConversations().filter((item) => item.id !== conversationId);
    this.store.set("conversations", next);
    return next;
  }

  clearConversations(): void {
    this.store.set("conversations", []);
  }
}
