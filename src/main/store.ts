import Store from "electron-store";
import { safeStorage } from "electron";
import type { AgentTaskRecord, Conversation, LatexSettings, ModelProvider, Workspace } from "../shared/types.js";

type CredentialField = "encryptedGeminiKey" | "encryptedOpenRouterKey" | "encryptedMiniMaxKey" | "encryptedGroqKey" | "encryptedOmniRouteKey";

/** Every credential slot, including the ones written before scoped storage. */
const CREDENTIAL_FIELDS: CredentialField[] = [
  "encryptedGeminiKey",
  "encryptedOpenRouterKey",
  "encryptedMiniMaxKey",
  "encryptedGroqKey",
  "encryptedOmniRouteKey"
];

interface AccountScope {
  settings: LatexSettings;
  conversations: Conversation[];
  credentials: Partial<Record<CredentialField, string>>;
  /** Persistent agent-task checkpoints (background execution + recovery). */
  tasks?: AgentTaskRecord[];
  /** Persisted in the same local scope so account switching never corrupts it. */
  lastSeenWhatsNewVersion?: string;
}

export interface LocalAccountData {
  settings: LatexSettings;
  conversations: Conversation[];
}

interface StoreShape {
  settings: LatexSettings;
  encryptedGeminiKey?: string;
  encryptedOpenRouterKey?: string;
  encryptedMiniMaxKey?: string;
  encryptedGroqKey?: string;
  encryptedOmniRouteKey?: string;
  puterToken?: string;
  puterUsername?: string;
  workspaces: Workspace[];
  conversations: Conversation[];
  /** Per-user local caches prevent account switching from exposing old data. */
  accountScopes?: Record<string, AccountScope>;
  /** Last release version whose "What's New" content the user has acknowledged. */
  lastSeenWhatsNewVersion?: string;
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
  conversations: [],
  lastSeenWhatsNewVersion: undefined
};

const GUEST_SCOPE = "guest";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyScope(): AccountScope {
  return { settings: clone(defaults.settings), conversations: [], credentials: {} };
}

/**
 * Local, scoped persistence for everything Latex keeps on this machine.
 *
 * ── WHY THIS CLASS HOLDS ITS OWN COPY OF THE CONFIG ─────────────────────────
 * `conf` (electron-store's engine) implements `get(key)` as
 *
 *     const { store } = this;   //  →  readFileSync(path) + JSON.parse(...)
 *
 * i.e. EVERY property read re-reads and re-parses the whole config file, and
 * every `set` re-reads it again before writing. For a small config that is
 * invisible. Latex keeps the entire conversation history in this one file, so
 * it had grown to ~6 MB — which made each read ~240 ms of SYNCHRONOUS main
 * thread work. Startup alone called `get` a dozen times (settings, workspaces,
 * conversations, one per provider credential, the guest scope…), so the main
 * process spent ~3.6 s of blocking CPU re-parsing the same unchanged file, and
 * every IPC the renderer made during that window had to wait behind it. That is
 * what the user experienced as "Latex is stuck initializing".
 *
 * The fix keeps electron-store as the file layer (same file, same path, same
 * format, same directory) but parses it ONCE and serves every read from memory:
 *
 *   • ONE `readFileSync` + `JSON.parse` per launch — in the constructor;
 *   • reads are plain in-memory property access, so they cannot block startup;
 *   • writes go through `this.store.store = this.data`, which in `conf` only
 *     serializes and writes — crucially it does NOT read the file back first.
 */
export class AppStore {
  private store = new Store<StoreShape>({ defaults });
  private activeScope = GUEST_SCOPE;
  /**
   * The parsed config, loaded exactly once. Every read below serves from here;
   * every write updates here first and then persists. Nothing else in Latex is
   * allowed to touch `this.store` directly, or the two would drift apart.
   */
  private data: StoreShape;

  constructor() {
    this.data = this.readOnce();
    this.ensureScopes();
    this.backfillLegacyCredentials();
  }

  /**
   * The single synchronous read of the config file for the whole process.
   * Failure is not fatal: an unreadable or corrupt config starts from defaults
   * rather than preventing Latex from opening at all.
   */
  private readOnce(): StoreShape {
    try {
      return { ...defaults, ...(this.store.store as StoreShape) };
    } catch (err) {
      console.warn("[Store] config unreadable; starting from defaults:", err instanceof Error ? err.message : err);
      return { ...defaults };
    }
  }

  /**
   * Persist the in-memory config. Uses the `store` setter, which only
   * serializes and writes — it never re-reads the file, so a write costs one
   * serialization instead of a read + a parse + a serialization.
   */
  private flush(): void {
    this.store.store = this.data;
  }

  /** Select the isolated local cache for a cloud account or guest mode. */
  selectAccountScope(userId: string | null): void {
    this.activeScope = userId ? `account:${userId}` : GUEST_SCOPE;
    this.getActiveScope();
  }

  getSettings(): LatexSettings {
    return clone(this.getActiveScope().settings);
  }

  setSettings(settings: Partial<LatexSettings>): LatexSettings {
    const scope = this.getActiveScope();
    const next = { ...scope, settings: { ...scope.settings, ...settings } };
    this.setActiveScope(next);
    return clone(next.settings);
  }

  /** The last release version whose What's New the user has seen.
   * Persisted in the active scope like other local state, so it survives
   * provider/model changes but is never synced to any account. */
  getLastSeenWhatsNewVersion(): string | undefined {
    return this.getActiveScope().lastSeenWhatsNewVersion;
  }

  setLastSeenWhatsNewVersion(version: string | undefined): void {
    const scope = this.getActiveScope();
    this.setActiveScope({ ...scope, lastSeenWhatsNewVersion: version });
  }


  private keyField(provider: ModelProvider): CredentialField | null {
    switch (provider) {
      case "openrouter": return "encryptedOpenRouterKey";
      case "minimax": return "encryptedMiniMaxKey";
      case "groq": return "encryptedGroqKey";
      case "omniroute": return "encryptedOmniRouteKey";
      case "puter": return null; // Puter does not require an API key
      case "ollama": return null; // Ollama needs no API key — local server only
      default: return "encryptedGeminiKey";
    }
  }

  setApiKey(apiKey: string, provider: ModelProvider = "gemini"): void {
    const field = this.keyField(provider);
    if (!field) return; // Puter does not need an API key
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this device.");
    }
    const scope = this.getActiveScope();
    this.setActiveScope({
      ...scope,
      credentials: { ...scope.credentials, [field]: safeStorage.encryptString(apiKey).toString("base64") }
    });
  }

  getApiKey(provider: ModelProvider = "gemini"): string | undefined {
    const field = this.keyField(provider);
    if (!field || !safeStorage.isEncryptionAvailable()) return undefined;
    const encrypted = this.getActiveScope().credentials[field];
    if (!encrypted) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      return undefined;
    }
  }

  // ── Puter token persistence ───────────────────────────────────────
  getPuterToken(): string | undefined {
    return this.data.puterToken || undefined;
  }

  setPuterToken(token: string | null): void {
    if (token) {
      this.data.puterToken = token;
    } else {
      delete this.data.puterToken;
      delete this.data.puterUsername;
    }
    this.flush();
  }

  getPuterUsername(): string | undefined {
    return this.data.puterUsername || undefined;
  }

  setPuterUsername(username: string | null): void {
    if (username) {
      this.data.puterUsername = username;
    } else {
      delete this.data.puterUsername;
    }
    this.flush();
  }

  /** Which providers have a key stored. */
  configuredProviders(): ModelProvider[] {
    return (["gemini", "openrouter", "minimax", "groq", "omniroute"] as ModelProvider[]).filter((provider) => Boolean(this.getApiKey(provider)));
  }

  clearApiKey(provider: ModelProvider = "gemini"): void {
    const field = this.keyField(provider);
    if (!field) return; // Puter has no key to clear
    const scope = this.getActiveScope();
    const credentials = { ...scope.credentials };
    delete credentials[field];
    // The guest scope inherits legacy credentials (backfillLegacyCredentials).
    // Clearing one has to remove the legacy copy too, or the next launch would
    // hand the deleted credential straight back. Done BEFORE the scope write so
    // the whole change is one persisted update instead of two.
    if (this.activeScope === GUEST_SCOPE) delete this.data[field];
    this.setActiveScope({ ...scope, credentials });
  }

  getWorkspaces(): Workspace[] {
    return this.data.workspaces ?? [];
  }

  saveWorkspace(workspace: Workspace): Workspace[] {
    const current = this.getWorkspaces().filter((item) => item.path !== workspace.path);
    const next = [workspace, ...current].slice(0, 20);
    this.data.workspaces = next;
    this.flush();
    return next;
  }

  removeWorkspace(workspaceId: string): void {
    this.data.workspaces = this.getWorkspaces().filter((item) => item.id !== workspaceId);
    this.flush();
  }

  getConversations(): Conversation[] {
    return clone(this.getActiveScope().conversations);
  }

  saveConversation(conversation: Conversation): Conversation[] {
    const scope = this.getActiveScope();
    const conversations = [clone(conversation), ...scope.conversations.filter((item) => item.id !== conversation.id)];
    this.setActiveScope({ ...scope, conversations });
    return clone(conversations);
  }

  replaceConversations(conversations: Conversation[]): Conversation[] {
    const scope = this.getActiveScope();
    this.setActiveScope({ ...scope, conversations: clone(conversations) });
    return clone(conversations);
  }

  deleteConversation(conversationId: string): Conversation[] {
    const scope = this.getActiveScope();
    const conversations = scope.conversations.filter((item) => item.id !== conversationId);
    this.setActiveScope({ ...scope, conversations });
    return clone(conversations);
  }

  clearConversations(): void {
    const scope = this.getActiveScope();
    this.setActiveScope({ ...scope, conversations: [], tasks: [] });
  }

  // ── Persistent agent tasks (checkpoints owned by the main process) ──

  getAgentTasks(): AgentTaskRecord[] {
    return clone(this.getActiveScope().tasks ?? []);
  }

  /** Insert-or-update one task checkpoint (electron-store writes atomically). */
  saveAgentTask(task: AgentTaskRecord): void {
    const scope = this.getActiveScope();
    const tasks = [clone(task), ...(scope.tasks ?? []).filter((item) => item.taskId !== task.taskId)];
    // Keep the store bounded: only the most recent 50 tasks are retained.
    this.setActiveScope({ ...scope, tasks: tasks.slice(0, 50) });
  }

  deleteAgentTask(taskId: string): void {
    const scope = this.getActiveScope();
    this.setActiveScope({ ...scope, tasks: (scope.tasks ?? []).filter((item) => item.taskId !== taskId) });
  }

  /** Drop all checkpoints belonging to a conversation (chat deleted/cleared). */
  deleteAgentTasksForChat(chatId: string): void {
    const scope = this.getActiveScope();
    this.setActiveScope({ ...scope, tasks: (scope.tasks ?? []).filter((item) => item.chatId !== chatId) });
  }

  hasGuestData(): boolean {
    const guest = this.getScope(GUEST_SCOPE);
    return guest.conversations.length > 0 || JSON.stringify(guest.settings) !== JSON.stringify(defaults.settings);
  }

  getGuestData(): LocalAccountData {
    const guest = this.getScope(GUEST_SCOPE);
    return { settings: clone(guest.settings), conversations: clone(guest.conversations) };
  }

  applyGuestDataToActiveScope(): LocalAccountData {
    const guest = this.getScope(GUEST_SCOPE);
    const active = this.getActiveScope();
    this.setActiveScope({ ...active, settings: clone(guest.settings), conversations: clone(guest.conversations) });
    return { settings: clone(guest.settings), conversations: clone(guest.conversations) };
  }

  discardGuestData(): void {
    this.setScope(GUEST_SCOPE, emptyScope());
  }

  private ensureScopes(): void {
    const scopes = this.data.accountScopes;
    if (scopes && Object.keys(scopes).length > 0) return;
    const credentials: Partial<Record<CredentialField, string>> = {};
    for (const field of CREDENTIAL_FIELDS) {
      const value = this.data[field];
      if (value) credentials[field] = value;
    }
    this.data.accountScopes = {
      [GUEST_SCOPE]: {
        settings: clone(this.data.settings ?? defaults.settings),
        conversations: clone(this.data.conversations ?? []),
        credentials
      }
    };
    this.flush();
  }

  /**
   * One-time backfill of credentials written before scoped storage existed.
   *
   * `ensureScopes()` only migrates when NO scope exists at all, so a credential
   * stored after the first scope was created (OmniRoute, in practice) stayed in
   * the legacy top-level field where `getApiKey()` never looks — the app then
   * reported "no key stored" for a key the user had already saved and asked for
   * it again. Copy whichever legacy fields the guest scope is missing; an
   * existing scoped value always wins, so this can never resurrect a key the
   * user cleared or replaced.
   */
  private backfillLegacyCredentials(): void {
    const guest = this.getScope(GUEST_SCOPE);
    const stranded = CREDENTIAL_FIELDS.filter((field) => !guest.credentials[field] && this.data[field]);
    if (stranded.length === 0) return;
    const credentials = { ...guest.credentials };
    for (const field of stranded) credentials[field] = this.data[field] as string;
    this.setScope(GUEST_SCOPE, { ...guest, credentials });
  }

  private getScope(scopeId: string): AccountScope {
    this.ensureScopes();
    const scopes = this.data.accountScopes ?? {};
    if (scopes[scopeId]) return scopes[scopeId];
    const scope = emptyScope();
    this.data.accountScopes = { ...scopes, [scopeId]: scope };
    this.flush();
    return scope;
  }

  private getActiveScope(): AccountScope {
    return this.getScope(this.activeScope);
  }

  private setScope(scopeId: string, scope: AccountScope): void {
    const scopes = this.data.accountScopes ?? {};
    this.data.accountScopes = { ...scopes, [scopeId]: clone(scope) };
    this.flush();
  }

  private setActiveScope(scope: AccountScope): void {
    this.setScope(this.activeScope, scope);
  }
}
