import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, KeyRound, Settings as SettingsIcon, MessageSquare, X } from "lucide-react";
import type {
  AgentActivityStep,
  AgentEvent,
  ApprovalMode,
  ApprovalRequest,
  Attachment,
  ChatMessage,
  Conversation,
  FileTreeNode,
  GeminiModel,
  LatexSettings,
  ModelProvider,
  PendingChange,
  Workspace,
  WorkspaceInfo
} from "../../shared/types";
import { Sidebar } from "./components/Sidebar";
import { TopBar, type ConnectionStatus, type AppMode } from "./components/TopBar";
import { HomeScreen } from "./components/HomeScreen";
import { Composer, type ModelsState } from "./components/Composer";
import { ChatView } from "./components/ChatView";
import { ExplorerDrawer } from "./components/ExplorerDrawer";
import { SettingsScreen, type ConnectionState, type SettingsPage } from "./components/SettingsScreen";
import { SearchOverlay } from "./components/SearchOverlay";
import { DiffViewer } from "./components/DiffViewer";
import { FilePreview } from "./components/FilePreview";
import { translateError, safeMessage, type ErrorInfo, modelShortName } from "./lib/errors";
import { flattenTree } from "./lib/format";
import { classifyRequest, isWorkspaceOperation, pickModel, providerOfModel, PROVIDER_LABELS, type ModelChoice, type TaskKind } from "./lib/modelRouter";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import "./styles.css";

type ViewMode = "home" | "chat" | "settings";
type RunMode = "chat" | "agent";

type SettingsState = LatexSettings & { hasApiKey?: boolean };

const defaultSettings: SettingsState = {
  provider: "gemini",
  approvalMode: "always",
  terminalApprovalMode: "always",
  temperature: 0.4,
  maxOutputTokens: 8192,
  theme: "dark",
  shell: "powershell",
  autoSelectModel: true,
  voiceInput: true,
  speakResponses: false,
  voiceLang: "auto",
  notifyOnFinish: false
};

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export default function App() {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | undefined>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation>(() => newConversation());
  const [composer, setComposer] = useState("");
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [modelsState, setModelsState] = useState<ModelsState>("idle");
  const [modelsError, setModelsError] = useState("");
  const [providerHealth, setProviderHealth] = useState<Array<{
    provider: string; label: string; configured: boolean;
    status: "ok" | "error" | "no_key"; modelCount: number; error?: string; httpStatus?: number;
  }>>([]);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [modelReason, setModelReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activity, setActivity] = useState<string[]>([]);
  const [activitySteps, setActivitySteps] = useState<AgentActivityStep[]>([]);
  const [activityComplete, setActivityComplete] = useState(false);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [workspaceInfoOpen, setWorkspaceInfoOpen] = useState(false);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [providerKeyDrafts, setProviderKeyDrafts] = useState<Record<string, string>>({});
  const [appMode, setAppMode] = useState<AppMode>("main");
  const [view, setView] = useState<ViewMode>("home");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("ai");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  const [connections, setConnections] = useState<Record<ModelProvider, ConnectionState>>({
    gemini: { state: "idle", message: "" },
    openrouter: { state: "idle", message: "" },
    minimax: { state: "idle", message: "" },
    groq: { state: "idle", message: "" },
    puter: { state: "idle", message: "" }
  });
  const [puterConnected, setPuterConnected] = useState(false);
  const [puterUsername, setPuterUsername] = useState<string | undefined>(undefined);
  const [puterLoading, setPuterLoading] = useState(true); // true until first status check completes

  // Initialize Puter auth status on mount — waits for startup verification
  useEffect(() => {
    void window.latex.puter.getStatus().then((status: { status?: string; connected?: boolean; username?: string }) => {
      const isConnected = status.status === "connected" || status.connected === true;
      setPuterConnected(isConnected);
      if (status.username) setPuterUsername(status.username);
      setPuterLoading(false);
    }).catch(() => {
      setPuterLoading(false);
    });

    // Listen for auth state changes from main process (e.g. external browser callback)
    const unsubscribe = window.latex.puter.onAuthChanged((data: { status: string; username?: string }) => {
      const isConnected = data.status === "connected";
      setPuterConnected(isConnected);
      setPuterUsername(data.username);
      setPuterLoading(false);
      if (isConnected) {
        // Refresh models to include Puter
        void fetchModels().catch(() => undefined);
      }
    });
    return unsubscribe;
  }, []);

  /** Sign in to Puter Cloud — opens a browser window for OAuth authentication. */
  async function puterSignIn() {
    setConnections((current) => ({ ...current, puter: { state: "testing", message: "Opening Puter sign-in window..." } }));
    try {
      const result: { ok: boolean; username?: string; error?: string } = await window.latex.puter.signIn();
      if (result.ok) {
        setPuterConnected(true);
        setPuterUsername(result.username);
        setConnections((current) => ({ ...current, puter: { state: "ok", message: `Connected as ${result.username ?? "Puter user"}` } }));
        // Refresh models to include Puter
        await fetchModels().catch(() => undefined);
      } else {
        setPuterConnected(false);
        setConnections((current) => ({ ...current, puter: { state: "fail", message: result.error ?? "Sign-in was cancelled" } }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      setConnections((current) => ({ ...current, puter: { state: "fail", message: msg } }));
      setPuterConnected(false);
    }
  }

  /** Sign out of Puter Cloud. */
  async function puterSignOut() {
    try {
      await window.latex.puter.signOut();
    } catch {
      // Ignore
    }
    setPuterConnected(false);
    setPuterUsername(undefined);
    setConnections((current) => ({ ...current, puter: { state: "idle", message: "" } }));
    // Refresh models to remove Puter
    await fetchModels().catch(() => undefined);
  }

  /** Refresh / re-verify Puter session. */
  async function puterRefresh() {
    setConnections((current) => ({ ...current, puter: { state: "testing", message: "Checking Puter session..." } }));
    try {
      const result: { status: string; username?: string } = await window.latex.puter.refreshStatus();
      const isConnected = result.status === "connected";
      setPuterConnected(isConnected);
      setPuterUsername(result.username);
      setConnections((current) => ({
        ...current,
        puter: isConnected
          ? { state: "ok", message: `Signed in as ${result.username ?? "Puter user"}` }
          : { state: "fail", message: "Puter session expired or not authenticated" }
      }));
      // Refresh models
      await fetchModels().catch(() => undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Refresh failed";
      setConnections((current) => ({ ...current, puter: { state: "fail", message: msg } }));
    }
  }

  const lastRun = useRef<{ conversation: Conversation; workspace?: Workspace } | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const spokenMsgRef = useRef<string | null>(null);

  // Main/Chat mode conversation isolation: each mode has its own conversation.
  const mainConversationRef = useRef<Conversation | null>(null);
  const chatConversationRef = useRef<Conversation | null>(null);

  // 3-message model cooldown: track models that failed so they're skipped
  // for the next 3 user messages.
  const cooldownRef = useRef<Map<string, { remainingMessages: number; failedAt: number }>>(new Map());

  /** Add a model to the 3-message cooldown. */
  function cooldownModel(modelKey: string) {
    cooldownRef.current.set(modelKey, { remainingMessages: 3, failedAt: Date.now() });
  }

  /** Decrement cooldown counters and prune expired entries. Called once per user message. */
  function tickCooldown() {
    for (const [key, entry] of cooldownRef.current) {
      entry.remainingMessages--;
      if (entry.remainingMessages <= 0) cooldownRef.current.delete(key);
    }
  }

  /** Check if a model is currently in cooldown. */
  function isCooledDown(modelName: string, provider: ModelProvider): boolean {
    const key = `${provider}:${modelName}`;
    return cooldownRef.current.has(key);
  }

  /** Pick a model from the given provider list, respecting cooldown. */
  function pickModelForProvider(list: GeminiModel[], task: string, provider: ModelProvider): string | undefined {
    const filtered = list.filter((m) => {
      const p = m.provider ?? providerOfModel(m.name);
      return p === provider && !isCooledDown(m.name, provider);
    });
    if (filtered.length === 0) {
      // All models in cooldown — try the full list ignoring cooldown
      const any = list.filter((m) => (m.provider ?? providerOfModel(m.name)) === provider);
      return pickModel(any, task as TaskKind).model;
    }
    return pickModel(filtered, task as TaskKind).model;
  }

  // ---- theme -------------------------------------------------------------

  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme === "system") {
      return watchSystemTheme(() => applyTheme("system"));
    }
  }, [settings.theme]);

  // ---- boot --------------------------------------------------------------

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      window.latex.settings.get(),
      window.latex.workspace.list(),
      window.latex.conversation.list()
    ]).then(([nextSettings, nextWorkspaces, nextConversations]) => {
      if (!mounted) return;
      setSettings(nextSettings);
      setWorkspaces(nextWorkspaces);
      setConversations(nextConversations);
      // Initialize mode-specific conversation refs from persisted data
      const mainConvs = nextConversations.filter((c: Conversation) => c.mode === "main" || !c.mode);
      const chatConvs = nextConversations.filter((c: Conversation) => c.mode === "chat");
      if (mainConvs[0]) mainConversationRef.current = mainConvs[0];
      if (chatConvs[0]) chatConversationRef.current = chatConvs[0];
      if (nextConversations[0]) {
        setConversation(nextConversations[0]);
        setView("chat");
      }
      if (nextWorkspaces[0]) setWorkspace(nextWorkspaces[0]);
      // Always load models on startup — Puter doesn't need an API key, and cached models should appear immediately
      void fetchModels().catch(() => undefined);
    });

    // Throttled persistence: save stream state at most once per 2 seconds during generation
    let lastPersistTime = 0;
    const persistThrottle = 2000;

    return window.latex.agent.onEvent((event: AgentEvent) => {
      if (event.type === "status") setActivity((items) => [...items, safeMessage(event.payload)].slice(-8));
      if (event.type === "message") {
        setStream((text) => {
          const newText = text + safeMessage(event.payload);
          // Persist partial response periodically
          const now = Date.now();
          if (now - lastPersistTime > persistThrottle) {
            lastPersistTime = now;
            // Save the conversation with the partial assistant response
            setConversation((prev) => {
              const lastMsg = prev.messages[prev.messages.length - 1];
              if (lastMsg?.role === "assistant" && lastMsg.meta?.streaming) {
                // Update the existing streaming message
                const updated = { ...prev, messages: [...prev.messages.slice(0, -1), { ...lastMsg, content: newText, updatedAt: Date.now() }], updatedAt: Date.now() };
                void window.latex.conversation.save(updated).catch(() => undefined);
                return updated;
              }
              return prev;
            });
          }
          return newText;
        });
      }
      if (event.type === "tool") {
        const payload = event.payload as { name?: string; status?: string; path?: string };
        const name = String(payload.name ?? "tool").replace(/_/g, " ");
        const where = payload.path ? ` ${payload.path}` : "";
        if (payload.status === "error") setActivity((items) => [...items, `✕ ${name}${where} failed`].slice(-8));
        else if (payload.status === "rejected") setActivity((items) => [...items, `Rejected ${name}${where}`].slice(-8));
        else setActivity((items) => [...items, `✓ ${name}${where}`].slice(-8));
      }
      if (event.type === "activity_step") {
        const step = event.payload as AgentActivityStep;
        setActivitySteps((prev) => {
          // Mark any currently active step as done, then add the new one
          const updated = prev.map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s);
          return [...updated, step].slice(-20);
        });
      }
      if (event.type === "activity_complete") {
        // Mark all active steps as done
        setActivitySteps((prev) => prev.map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s));
        setActivityComplete(true);
      }
      if (event.type === "changes") setPendingChanges(event.payload as PendingChange[]);
      if (event.type === "approval") setApproval(event.payload as ApprovalRequest);
      if (event.type === "error") setError(translateError(event.payload));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (workspace) {
      void window.latex.workspace.tree(workspace).then(setTree);
    } else {
      setTree([]);
    }
  }, [workspace]);

  // Watch the active workspace for external changes (e.g. edits in VS Code).
  useEffect(() => {
    if (!workspace) return;
    void window.latex.workspace.watch(workspace);
    const unsubscribe = window.latex.workspace.onChanged(() => {
      void window.latex.workspace.tree(workspace).then(setTree);
      setNotice("Workspace changed on disk — the file list was refreshed.");
    });
    return unsubscribe;
  }, [workspace?.id]);

  const modelLabel = useMemo(() => {
    if (settings.autoSelectModel) return "Auto";
    if (!settings.selectedModel) return "Select model";
    const found = models.find((model) => model.name === settings.selectedModel);
    return found?.displayName ?? modelShortName(settings.selectedModel);
  }, [models, settings.selectedModel, settings.autoSelectModel]);

  const activeMessages = useMemo(
    () => [
      ...conversation.messages,
      ...(stream
        ? [{ id: "stream", role: "assistant" as const, content: stream, createdAt: Date.now(), meta: { streaming: true } }]
        : [])
    ],
    [conversation, stream]
  );

  const searchFiles = useMemo(() => flattenTree(tree), [tree]);
  const hasChat = activeMessages.length > 0;
  // For Puter models, connection is always available
  const isPuterModel = (settings.selectedModel?.startsWith("puter/") ?? false) || settings.provider === "puter";
  const connectionStatus: ConnectionStatus = (!settings.hasApiKey && !isPuterModel)
    ? "none"
    : modelsState === "loading"
      ? "loading"
      : modelsState === "error"
        ? "offline"
        : "ok";

  // ---- settings ----------------------------------------------------------

  async function saveSettings(partial: Partial<LatexSettings>) {
    const saved = await window.latex.settings.save(partial);
    setSettings((prev) => ({ ...prev, ...saved, hasApiKey: prev.hasApiKey }));

    // Auto-select a suitable mid-tier model when the provider changes
    if (partial.provider && partial.provider !== settings.provider) {
      const newProvider = partial.provider;
      // Only auto-select if user didn't manually pick a model for this provider
      const currentModel = settings.selectedModel;
      const currentModelProvider = currentModel ? (models.find((m) => m.name === currentModel)?.provider ?? providerOfModel(currentModel)) : null;
      // If no model or model belongs to a different provider, pick a new one
      if (!currentModel || currentModelProvider !== newProvider) {
        const providerModels = models.filter((m) => (m.provider ?? providerOfModel(m.name)) === newProvider);
        if (providerModels.length > 0) {
          const choice = pickModel(providerModels, "chat");
          if (choice.model) {
            // Save directly without triggering recursion
            const modelSaved = await window.latex.settings.save({ selectedModel: choice.model, provider: newProvider, autoSelectModel: false });
            setSettings((prev) => ({ ...prev, ...modelSaved, hasApiKey: prev.hasApiKey }));
            setModelReason(`Auto-selected from ${PROVIDER_LABELS[newProvider]}`);
          }
        }
      }
    }
  }

  async function saveApiKey() {
    if (!apiKeyDraft.trim()) return;
    await saveProviderKey("gemini", apiKeyDraft);
    setApiKeyDraft("");
  }

  async function saveProviderKey(provider: ModelProvider, draft: string) {
    if (!draft.trim()) return;
    await window.latex.settings.saveApiKey(draft.trim(), provider);
    setProviderKeyDrafts((drafts) => ({ ...drafts, [provider]: "" }));
    const next = await window.latex.settings.get();
    setSettings(next);
    setConnections((current) => ({ ...current, [provider]: { state: "idle", message: "" } }));
    await fetchModels().catch(() => undefined);
  }

  async function clearApiKey() {
    await clearProviderKey("gemini");
  }

  async function clearProviderKey(provider: ModelProvider) {
    await window.latex.settings.clearApiKey(provider);
    const next = await window.latex.settings.get();
    setSettings(next);
    if (next.providers?.every((status: { configured: boolean }) => !status.configured)) {
      setModels([]);
      setModelsState("idle");
    }
    setModelWarning(null);
    setModelReason(null);
    setNotice(null);
    setConnections((current) => ({ ...current, [provider]: { state: "idle", message: "" } }));
  }

  async function testProviderConnection(provider: ModelProvider) {
    if (provider === "puter") {
      // Puter test: check if authenticated and try a simple request
      setConnections((current) => ({ ...current, puter: { state: "testing", message: "Testing Puter connection..." } }));
      try {
        await window.latex.ai.test(provider);
        setConnections((current) => ({ ...current, puter: { state: "ok", message: "Puter connection working" } }));
      } catch (err) {
        const info = translateError(err, provider);
        setConnections((current) => ({ ...current, puter: { state: "fail", message: info.message } }));
      }
      return;
    }
    setConnections((current) => ({ ...current, [provider]: { state: "testing", message: "" } }));
    try {
      await window.latex.ai.test(provider);
      setConnections((current) => ({ ...current, [provider]: { state: "ok", message: `${PROVIDER_LABELS[provider]} connection successful` } }));
      await fetchModels().catch(() => undefined);
    } catch (err) {
      const info = translateError(err, provider);
      setConnections((current) => ({ ...current, [provider]: { state: "fail", message: info.message } }));
    }
  }

  function modelsForActiveProvider(list: GeminiModel[]): GeminiModel[] {
    const provider = settings.provider ?? "gemini";
    return list.filter((model) => (model.provider ?? providerOfModel(model.name)) === provider);
  }

  async function fetchModels(): Promise<GeminiModel[]> {
    setModelsState("loading");
    setModelsError("");
    try {
      const list: GeminiModel[] = await window.latex.ai.models();
      setModels(list);
      setModelsState("ready");
      // Probe provider health in the background (non-blocking)
      window.latex.ai.healthProbe().then(setProviderHealth).catch(() => undefined);
      const activeList = modelsForActiveProvider(list);
      const hasSelected = Boolean(settings.selectedModel) && activeList.some((model: GeminiModel) => model.name === settings.selectedModel);
      if (!hasSelected) {
        if (settings.autoSelectModel && activeList.length > 0) {
          const choice = pickModel(activeList, "chat");
          if (settings.selectedModel) {
            setNotice(`${modelShortName(settings.selectedModel)} is no longer available. Latex auto-selected ${modelShortName(choice.model ?? "")}.`);
          }
          await saveSettings({ selectedModel: choice.model });
          setModelReason(choice.reason);
          setModelWarning(null);
        } else if (settings.selectedModel) {
          setModelWarning(settings.selectedModel);
        }
      } else {
        setModelWarning(null);
      }
      return list;
    } catch (err) {
      setModelsState("error");
      setModelsError(safeMessage(err));
      throw err;
    }
  }

  async function testConnection() {
    await testProviderConnection(settings.provider ?? "gemini");
  }

  function selectModel(name: string) {
    // CRITICAL: Also update settings.provider to match the selected model's provider.
    // Without this, error handlers and recovery use the stale provider (usually "gemini").
    const model = models.find((m) => m.name === name);
    const provider = (model?.provider ?? providerOfModel(name)) as ModelProvider;
    void saveSettings({ selectedModel: name, provider, autoSelectModel: false });
    setModelWarning(null);
  }

  function selectAutoModel() {
    void saveSettings({ autoSelectModel: true });
    const activeList = modelsForActiveProvider(models);
    const activeProvider = settings.provider ?? "gemini";
    if (activeList.length > 0) {
      const picked = pickModelForProvider(activeList, "chat", activeProvider);
      void saveSettings({ selectedModel: picked });
      setModelReason(`Auto-selected from ${PROVIDER_LABELS[activeProvider]}`);
    }
  }

  // ---- workspace ---------------------------------------------------------

  async function openFolder() {
    const next = await window.latex.workspace.open();
    if (next) {
      setWorkspace(next);
      setWorkspaces(await window.latex.workspace.list());
    }
  }

  function selectWorkspace(next: Workspace) {
    setWorkspace(next);
  }

  // ---- attachments / context ---------------------------------------------

  async function pickFiles() {
    try {
      const picked = await window.latex.file.pick();
      if (picked.length) setAttachments((items) => [...items, ...picked]);
    } catch (err) {
      setError(translateError(err));
    }
  }

  function addContext(kind: "file" | "workspace" | "conversation") {
    if (kind === "file") {
      void pickFiles();
    } else if (kind === "workspace" && workspace) {
      setAttachments((items) => [
        ...items,
        { id: uid("att"), name: workspace.name, kind: "workspace", content: buildWorkspaceContext(workspace, tree), label: "Workspace summary" }
      ]);
    } else if (kind === "conversation") {
      const summary = buildConversationContext(conversation);
      setAttachments((items) => [...items, { id: uid("att"), name: "Conversation", kind: "conversation", content: summary, label: "Conversation summary" }]);
    }
    setContextMenuOpen(false);
  }

  function removeAttachment(id: string) {
    setAttachments((items) => items.filter((item) => item.id !== id));
  }

  // ---- conversations -----------------------------------------------------

  /** Switch between Main and Chat modes, preserving each conversation independently. */
  function switchAppMode(nextMode: AppMode) {
    if (nextMode === appMode) return;
    // Save the current conversation for the mode we're leaving
    if (appMode === "main") {
      mainConversationRef.current = conversation;
    } else {
      chatConversationRef.current = conversation;
    }
    // Restore the conversation for the mode we're entering
    const restored = nextMode === "main"
      ? mainConversationRef.current
      : chatConversationRef.current;
    if (restored) {
      setConversation(restored);
    } else {
      // Create a fresh conversation for the new mode
      setConversation({ ...newConversation(), mode: nextMode });
    }
    setAppMode(nextMode);
    setComposer("");
    setStream("");
    setPendingChanges([]);
    setApproval(null);
    setError(null);
    setActivity([]);
    setActivitySteps([]);
    setActivityComplete(false);
  }

  function newChat() {
    setConversation({ ...newConversation(), mode: appMode });
    setComposer("");
    setStream("");
    setPendingChanges([]);
    setApproval(null);
    setError(null);
    setActivity([]);
    setActivitySteps([]);
    setActivityComplete(false);
    setAttachments([]);
    setView("home");
    setExplorerOpen(false);
  }

  function selectConversation(next: Conversation) {
    setConversation(next);
    // Save current to mode-specific ref
    if (appMode === "main") {
      mainConversationRef.current = next;
    } else {
      chatConversationRef.current = next;
    }
    // Switch to the mode the conversation was created in
    if (next.mode && next.mode !== appMode) {
      switchAppMode(next.mode);
    }
    setComposer("");
    setStream("");
    setPendingChanges([]);
    setApproval(null);
    setError(null);
    setActivity([]);
    setView("chat");
  }

  async function deleteConversation(id: string) {
    await window.latex.conversation.delete(id);
    setConversations((items) => items.filter((item) => item.id !== id));
    if (conversation.id === id) {
      newChat();
    }
  }

  async function completeRun(saved: Conversation) {
    // Mark all activity steps as done and show completion
    const finalSteps = activitySteps.map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s);
    setActivitySteps(finalSteps);
    setActivityComplete(true);
    // The agent already persists activity steps in the message meta.
    // Use the agent's version (from actual tool results) if available,
    // otherwise fall back to the live event-tracked steps.
    if (saved.messages.length > 0) {
      const lastMsg = saved.messages[saved.messages.length - 1];
      if (lastMsg.role === "assistant") {
        const existingSteps = lastMsg.meta?.activitySteps as AgentActivityStep[] | undefined;
        // If agent already persisted steps, keep them (they have real filenames)
        if (existingSteps && existingSteps.length > 0) {
          setConversation(saved);
          if (appMode === "main") mainConversationRef.current = saved;
          else chatConversationRef.current = saved;
        } else if (finalSteps.length > 0) {
          // Fallback: persist from live event tracking
          const updatedMsg = { ...lastMsg, meta: { ...lastMsg.meta, activitySteps: finalSteps, activityComplete: true } };
          const updated = { ...saved, messages: [...saved.messages.slice(0, -1), updatedMsg], updatedAt: Date.now() };
          setConversation(updated);
          if (appMode === "main") mainConversationRef.current = updated;
          else chatConversationRef.current = updated;
          void window.latex.conversation.save(updated).catch(() => undefined);
        } else {
          setConversation(saved);
          if (appMode === "main") mainConversationRef.current = saved;
          else chatConversationRef.current = saved;
        }
      } else {
        setConversation(saved);
        if (appMode === "main") mainConversationRef.current = saved;
        else chatConversationRef.current = saved;
      }
    } else {
      setConversation(saved);
      if (appMode === "main") mainConversationRef.current = saved;
      else chatConversationRef.current = saved;
    }
    setConversations(await window.latex.conversation.list());
    const last = saved.messages[saved.messages.length - 1];
    if (settings.speakResponses && last?.role === "assistant" && last.id !== spokenMsgRef.current) {
      spokenMsgRef.current = last.id;
      speakText(last.content);
    }
    if (settings.notifyOnFinish && document.hidden) {
      void window.latex.notifications.send("Latex finished", "Your task is complete.");
    }
  }

  async function runTurn(next: Conversation, mode: RunMode, ws?: Workspace, atts: Attachment[] = []) {
    lastRun.current = { conversation: next, workspace: mode === "agent" ? ws : undefined };
    setBusy(true);
    setStream("");
    setError(null);
    setPendingChanges([]);
    setApproval(null);
    setActivity(mode === "agent" ? ["Inspecting workspace"] : []);
    setActivitySteps([]);
    setActivityComplete(false);
    setConversation(next);
    // Save to mode-specific ref so tab switching preserves state
    if (appMode === "main") {
      mainConversationRef.current = next;
    } else {
      chatConversationRef.current = next;
    }
    setConversations((items) => [next, ...items.filter((item) => item.id !== next.id)]);
    setView("chat");
    setAttachments([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const saved =
          mode === "agent"
            ? await window.latex.agent.run(next, ws, atts)
            : await window.latex.agent.chat(next, ws, atts);
        await completeRun(saved);
        break;
      } catch (err) {
        // CRITICAL: detect provider from the error itself, not settings.provider
        const errObj = (err && typeof err === "object") ? err as Record<string, unknown> : undefined;
        const errProvider = errObj?.provider && typeof errObj.provider === "string"
          ? errObj.provider as ModelProvider
          : undefined;
        const info = translateError(err, errProvider ?? settings.provider ?? "gemini");
        if (info.action === "fixModel" && attempt === 0 && settings.autoSelectModel) {
          // Add the failed model to cooldown using its actual provider
          const failedModel = errObj?.model ? String(errObj.model) : settings.selectedModel;
          const failedProvider = errProvider ?? settings.provider ?? "gemini";
          if (failedModel) {
            cooldownModel(`${failedProvider}:${failedModel}`);
          }
          await recoverModel();
          continue;
        }
        setError(info);
        break;
      }
    }
    setBusy(false);
    // CRITICAL: If generation was stopped, preserve the partial stream text
    // as a message so the user doesn't lose everything they saw being generated.
    const stopErrObj = error as Record<string, unknown> | null;
    const wasStopped = (stopErrObj && typeof stopErrObj === 'object' && stopErrObj.errorType === 'aborted') || (stopErrObj && typeof stopErrObj === 'object' && typeof stopErrObj.message === 'string' && /abort|stop/i.test(stopErrObj.message as string));
    if (wasStopped && stream && stream.trim()) {
      const partialMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: stream + '\n\n_(Generation stopped by user)_',
        createdAt: Date.now(),
        model: settings.selectedModel,
        provider: settings.provider ?? 'gemini'
      };
      const updated = { ...conversation, messages: [...conversation.messages, partialMsg], updatedAt: Date.now() };
      setConversation(updated);
      void window.latex.conversation.save(updated).catch(() => undefined);
    }
    setStream("");
    setApproval(null);
    setActivity([]);
  }

  async function recoverModel() {
    try {
      const list = await fetchModels();
      const activeList = modelsForActiveProvider(list);
      const activeProvider = settings.provider ?? "gemini";
      if (activeList.length > 0) {
        const task = classifyRequest(lastRun.current?.conversation.messages.at(-1)?.content ?? "");
        const picked = pickModelForProvider(activeList, task, activeProvider);
        if (picked) {
          await saveSettings({ selectedModel: picked });
          const label = list.find((m) => m.name === picked)?.displayName ?? modelShortName(picked);
          setNotice(`Model unavailable. Switched to ${label}.`);
          setModelReason(`Fallback from ${PROVIDER_LABELS[activeProvider]}`);
        }
      }
    } catch {
      // leave the original error visible if refresh fails too
    }
  }

  async function sendMessage(text?: string) {
    const content = (text ?? composer).trim();
    if (!content) return;

    // Handle /clear command
    if (content === "/clear") {
      if (busy) await stop();
      const cleared = { ...conversation, messages: [], updatedAt: Date.now() };
      setConversation(cleared);
      await window.latex.conversation.save(cleared);
      setStream("");
      setError(null);
      setApproval(null);
      setPendingChanges([]);
      setComposer("");
      setNotice("Chat cleared.");
      return;
    }

    // Handle /help command
    if (content === "/help") {
      const helpMsg: ChatMessage = {
        id: uid("msg"),
        role: "assistant",
        content: "**Available commands:**\n\n`/clear` — Clear this conversation\n`/help` — Show this help message",
        createdAt: Date.now()
      };
      const next: Conversation = {
        ...conversation,
        messages: [...conversation.messages, helpMsg],
        updatedAt: Date.now()
      };
      setConversation(next);
      await window.latex.conversation.save(next);
      setComposer("");
      return;
    }
    if (busy) return;
    const activeProvider = settings.provider ?? "gemini";
    const isPuter = (settings.selectedModel?.startsWith("puter/") ?? false) || activeProvider === "puter";
    if (!settings.hasApiKey && !isPuter) {
      setError({
        message: `Connect your ${PROVIDER_LABELS[activeProvider]} API key in Settings to start chatting.`,
        detail: "",
        action: "settings",
        actionLabel: "Open Settings"
      });
      setView("chat");
      return;
    }

    // Warn if images are attached but model likely doesn't support vision
    if (attachments.some((a) => a.kind === "image")) {
      const selectedModelObj = models.find((m) => m.name === settings.selectedModel);
      if (selectedModelObj && !selectedModelObj.supportsVision) {
        setNotice("This model may not support image/vision input. The images were attached but the model might ignore them.");
      }
    }

    // CHAT MODE: no filesystem tools — plain conversation only.
    if (appMode === "chat") {
      const contextBlock = buildAttachmentsContext(attachments);
      const fullContent = contextBlock ? `${contextBlock}\n\n${content}` : content;
      const userMessage: ChatMessage = { id: uid("msg"), role: "user", content: fullContent, createdAt: Date.now() };
      const next: Conversation = {
        ...conversation,
        mode: "chat",
        workspaceId: workspace?.id,
        title: conversation.title === "New chat" ? content.slice(0, 48) : conversation.title,
        messages: [...conversation.messages, userMessage],
        updatedAt: Date.now()
      };
      setComposer("");
      await runTurn(next, "chat", workspace, attachments);
      return;
    }

    // MAIN MODE: agent with full tools.
    // Deterministic guard: a filesystem operation with no approved workspace
    // never reaches the model — it could only narrate it, not do it.
    const fullAccess = settings.filesystemAccess === "full";
    if (!workspace && !fullAccess && isWorkspaceOperation(content)) {
      setError({
        message: "Latex needs a workspace folder for that. Click Open Folder and choose where Latex may read, create, and edit files.",
        detail: "No workspace is currently approved. File operations only run inside the folder you select.",
        action: "openFolder",
        actionLabel: "Open Folder"
      });
      setView("chat");
      return;
    }

    // Decrement cooldown counters for each new user message.
    tickCooldown();

    // Resolve the model: auto-select when enabled, otherwise use the saved pick.
    let modelToUse = settings.selectedModel;
    if (settings.autoSelectModel || !modelToUse) {
      let list = models;
      if (modelsState !== "ready" || list.length === 0) {
        try {
          list = await fetchModels();
        } catch {
          setError({ message: "Unable to load models. Check your API key or network connection.", detail: "", action: "settings", actionLabel: "Open Settings" });
          setView("chat");
          return;
        }
      }
      const task = classifyRequest(content);
      const activeProvider = settings.provider ?? "gemini";
      // Provider-aware Auto: only pick from the selected provider
      const picked = pickModelForProvider(modelsForActiveProvider(list), task, activeProvider);
      if (picked) {
        // Sync both model and provider when auto-selecting
        const pickedProvider = list.find((m) => m.name === picked)?.provider ?? providerOfModel(picked);
        await saveSettings({ selectedModel: picked, provider: pickedProvider });
        setModelReason(`Auto-selected from ${PROVIDER_LABELS[pickedProvider]}`);
        modelToUse = picked;
      } else {
        setError({ message: `No usable models are currently available for ${PROVIDER_LABELS[activeProvider]}.`, detail: "", action: "settings", actionLabel: "Refresh Models" });
        setView("chat");
        return;
      }
    }
    if (!modelToUse) {
      setError({ message: "No model is available. Refresh models in Settings.", detail: "", action: "settings", actionLabel: "Open AI Settings" });
      setView("chat");
      return;
    }

    const contextBlock = buildAttachmentsContext(attachments);
    const fullContent = contextBlock ? `${contextBlock}\n\n${content}` : content;
    const userMessage: ChatMessage = { id: uid("msg"), role: "user", content: fullContent, createdAt: Date.now() };
    const next: Conversation = {
      ...conversation,
      mode: "main",
      workspaceId: workspace?.id,
      title: conversation.title === "New chat" ? content.slice(0, 48) : conversation.title,
      messages: [...conversation.messages, userMessage],
      updatedAt: Date.now()
    };
    setComposer("");
    await runTurn(next, "agent", workspace, attachments);
  }

  async function stop() {
    await window.latex.agent.stop();
    stopSpeaking();
  }

  /** Resolve the agent's outstanding approval request (Approve / Reject). */
  async function resolveApproval(approved: boolean) {
    if (!approval) return;
    const requestId = approval.requestId;
    setApproval(null);
    await window.latex.agent.resolveApproval(requestId, approved);
  }

  // Changes are applied and verified by the agent itself; these helpers only
  // manage the review UI (mark status, revert via a fresh change).
  async function acceptChange(change: PendingChange) {
    setPendingChanges((items) => items.map((item) => (item.id === change.id ? { ...item, status: "accepted" } : item)));
  }

  function rejectChange(id: string) {
    setPendingChanges((items) => items.map((item) => (item.id === id ? { ...item, status: "rejected" } : item)));
  }

  async function undoChange(change: PendingChange) {
    if (!workspace) return;
    try {
      if (change.existed === false && change.previousContent === "") {
        // The change created the file — undoing it removes the file entirely.
        await window.latex.file.delete(workspace, change.filePath);
      } else {
        const current = await window.latex.file.read(workspace, change.filePath);
        const revert: PendingChange = { ...change, previousContent: current, nextContent: change.previousContent, status: "pending" };
        await window.latex.file.applyChange(workspace, revert);
      }
      setPendingChanges((items) => items.map((item) => (item.id === change.id ? { ...item, status: "rejected" } : item)));
      setTree(await window.latex.workspace.tree(workspace));
    } catch (err) {
      setError(translateError(err));
    }
  }

  async function acceptAllChanges() {
    setPendingChanges((items) => items.map((item) => (item.status === "pending" ? { ...item, status: "accepted" } : item)));
  }

  function rejectAllChanges() {
    setPendingChanges((items) => items.map((item) => (item.status === "pending" ? { ...item, status: "rejected" } : item)));
  }

  // ---- workspace info ----------------------------------------------------

  async function openWorkspaceInfo() {
    if (!workspace) return;
    try {
      setWorkspaceInfo(await window.latex.workspace.info(workspace));
      setWorkspaceInfoOpen(true);
    } catch {
      setWorkspaceInfoOpen(true);
    }
  }

  async function removeWorkspace() {
    if (!workspace) return;
    const removedId = workspace.id;
    const remaining = await window.latex.workspace.remove(removedId);
    setWorkspaces(remaining);
    if (workspace.id === removedId) {
      setWorkspace(undefined);
      setTree([]);
    }
    setWorkspaceInfoOpen(false);
  }

  function handleErrorAction(action: "settings" | "retry" | "fixModel" | "openFolder") {
    if (action === "settings") {
      setSettingsPage("ai");
      setView("settings");
    } else if (action === "openFolder") {
      void openFolder();
    } else if (action === "fixModel") {
      void recoverModel().then(() => {
        if (lastRun.current) {
          const useAgentMode = appMode === "main";
          void runTurn(lastRun.current.conversation, useAgentMode ? "agent" : "chat", lastRun.current.workspace);
        }
      });
    } else if (action === "retry" && lastRun.current) {
      const useAgentMode = appMode === "main";
      void runTurn(lastRun.current.conversation, useAgentMode ? "agent" : "chat", lastRun.current.workspace);
    }
  }

  async function regenerate(afterMessageId: string) {
    const idx = conversation.messages.findIndex((message) => message.id === afterMessageId);
    if (idx < 0) return;
    let userIdx = idx - 1;
    while (userIdx >= 0 && conversation.messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;
    const userMsg = conversation.messages[userIdx];
    const next: Conversation = { ...conversation, messages: [...conversation.messages.slice(0, userIdx), userMsg], updatedAt: Date.now() };
    const useAgentMode = appMode === "main";
    await runTurn(next, useAgentMode ? "agent" : "chat", useAgentMode ? workspace : undefined);
  }

  function editMessage(messageId: string) {
    const idx = conversation.messages.findIndex((message) => message.id === messageId);
    if (idx < 0) return;
    const msg = conversation.messages[idx];
    setConversation({ ...conversation, messages: conversation.messages.slice(0, idx), updatedAt: Date.now() });
    setComposer(msg.content);
    setView("chat");
  }

  // ---- voice -------------------------------------------------------------

  async function startListening() {
    setSpeechError(null);
    // Prefer the main-process transcriber (real Windows speech recognition,
    // works in Electron where Chromium ships without the Web Speech API).
    if (typeof window.latex.voice?.transcribe === "function") {
      setListening(true);
      setTranscribing(true);
      try {
        const result = await window.latex.voice.transcribe(settings.voiceLang && settings.voiceLang !== "auto" ? settings.voiceLang : undefined);
        if (result?.text) {
          setComposer((current) => (current.trim() ? `${current.trim()} ${result.text}` : result.text));
        }
      } catch (err) {
        setSpeechError(safeMessage(err));
      } finally {
        setListening(false);
        setTranscribing(false);
      }
      return;
    }
    // Browser fallback (Vite preview): Web Speech API when available.
    const anyWindow = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Recognition = anyWindow.SpeechRecognition ?? anyWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setSpeechError("Speech recognition isn't available in this build.");
      return;
    }
    const rec = new Recognition();
    rec.lang = settings.voiceLang && settings.voiceLang !== "auto" ? settings.voiceLang : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      setComposer((current) => (current ? `${current} ${transcript}` : transcript));
    };
    rec.onerror = (event) => {
      setListening(false);
      setSpeechError(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone access is blocked. Allow microphone access in Windows/application settings."
          : `Voice input error: ${event.error}`
      );
    };
    rec.onend = () => setListening(false);
    try {
      rec.start();
      recognitionRef.current = rec;
      setListening(true);
      setSpeechError(null);
    } catch {
      setSpeechError("Could not start the microphone. Check that it is available.");
    }
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
    setTranscribing(false);
  }

  function speakText(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const clean = text
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/[#*`>_~]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const utterance = new SpeechSynthesisUtterance(clean.slice(0, 3000));
    if (settings.voiceLang && settings.voiceLang !== "auto") utterance.lang = settings.voiceLang;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  // ---- view --------------------------------------------------------------

  const sidebar = (
    <Sidebar
      workspaces={workspaces}
      workspace={workspace}
      conversations={conversations}
      conversation={conversation}
      appMode={appMode}
      onSelectWorkspace={selectWorkspace}
      onOpenFolder={openFolder}
      onNewChat={newChat}
      onSelectConversation={selectConversation}
      onDeleteConversation={(id) => void deleteConversation(id)}
      onOpenSearch={() => setSearchOpen(true)}
      onSettings={() => setView("settings")}
    />
  );

  const settingsScreen = (
    <SettingsScreen
      settings={settings}
      page={settingsPage}
      setPage={setSettingsPage}
      apiKeyDraft={apiKeyDraft}
      setApiKeyDraft={setApiKeyDraft}
      onSaveApiKey={saveApiKey}
      onClearApiKey={clearApiKey}
      connections={connections}
      onTestConnection={testProviderConnection}
      models={models}
      modelsState={modelsState}
      modelsError={modelsError}
      onFetchModels={fetchModels}
      onSelectModel={selectModel}
      onSelectAutoModel={selectAutoModel}
      workspace={workspace}
      onOpenFolder={openFolder}
      onSaveSettings={saveSettings}
      providerKeyDrafts={providerKeyDrafts}
      setProviderKeyDraft={(provider, value) => setProviderKeyDrafts((drafts) => ({ ...drafts, [provider]: value }))}
      onSaveProviderKey={(provider) => void saveProviderKey(provider, providerKeyDrafts[provider] ?? "")}
      onClearProviderKey={(provider) => void clearProviderKey(provider)}
      onTestProvider={(provider) => void testProviderConnection(provider)}
      onPuterSignIn={puterSignIn}
      onPuterSignOut={puterSignOut}
      onPuterRefresh={puterRefresh}
      puterConnected={puterConnected}
      puterUsername={puterUsername}
      puterLoading={puterLoading}
    />
  );

  const chatView = (
    <ChatView
      messages={activeMessages}
      busy={busy}
      activity={activity}
      activitySteps={activitySteps}
      activityComplete={activityComplete}
      appMode={appMode}
      approval={approval}
      onApproveApproval={() => void resolveApproval(true)}
      onRejectApproval={() => void resolveApproval(false)}
      pendingChanges={pendingChanges}
      error={error}
      modelLabel={modelLabel}
      onOpenDiff={() => setDiffOpen(true)}
      onErrorAction={handleErrorAction}
      onOpenInExplorer={(relativePath) => {
        if (!workspace) return;
        void window.latex.shell.showInFolder(workspace.path + (relativePath ? `\\${relativePath.replace(/\//g, "\\")}` : ""));
      }}
      onPreviewFile={(relativePath) => {
        const name = relativePath.split("/").pop() ?? relativePath;
        setPreviewFile({ path: relativePath, name });
      }}
      onRegenerate={(id) => void regenerate(id)}
      onEditMessage={editMessage}
    />
  );

  return (
    <div className="app">
      {sidebar}
      <div className="main">
        <TopBar
          workspace={workspace}
          filesystemAccess={settings.filesystemAccess}
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen((open) => !open)}
          onOpenSearch={() => setSearchOpen(true)}
          onSettings={() => setView((current) => (current === "settings" ? (hasChat ? "chat" : "home") : "settings"))}
          connectionStatus={connectionStatus}
          onOpenWorkspaceInfo={() => void openWorkspaceInfo()}
          appMode={appMode}
          onSetAppMode={switchAppMode}
        />

        <div className="content">
          {!settings.hasApiKey && !isPuterModel && (
            <div className="setupBanner">
              <KeyRound size={15} />
              <span>Connect your {PROVIDER_LABELS[settings.provider ?? "gemini"]} API key to start working.</span>
              <button className="btn sm primary" onClick={() => { setSettingsPage("ai"); setView("settings"); }}>
                <SettingsIcon size={13} /> Open Settings
              </button>
            </div>
          )}

          {view === "settings" ? settingsScreen : view === "home" && !hasChat ? (
            <HomeScreen onStartPrompt={(prompt) => void sendMessage(prompt)} />
          ) : (
            chatView
          )}
        </div>

        {view !== "settings" && (
          <div className="composerWrap">
            {notice && (
              <div className="noticeBanner">
                <span>{notice}</span>
                <button className="textButton" onClick={() => setNotice(null)}>Dismiss</button>
              </div>
            )}
            {modelWarning && (
              <div className="modelWarning">
                <span>Your previously selected model ({modelShortName(modelWarning)}) is no longer available.</span>
                <button className="btn sm" onClick={() => { setSettingsPage("ai"); setView("settings"); }}>
                  Choose another model
                </button>
              </div>
            )}
            {appMode === "chat" && view === "chat" && hasChat && (
              <div className="chatModeBanner">
                <MessageSquare size={14} />
                <span>Chat mode — conversation only. Switch to <strong>Main</strong> for file editing and workspace tools.</span>
              </div>
            )}
            <Composer
              workspace={workspace}
              composer={composer}
              setComposer={setComposer}
              onSend={() => void sendMessage()}
              onStop={() => void stop()}
              busy={busy}
              approvalMode={settings.approvalMode}
              onSelectApprovalMode={(mode) => void saveSettings({ approvalMode: mode })}
              showApprovalMenu={showApprovalMenu}
              onToggleApprovalMenu={setShowApprovalMenu}
              modelLabel={modelLabel}
              models={models}
              modelsState={modelsState}
              modelsError={modelsError}
              onRetryModels={() => void fetchModels().catch(() => undefined)}
              selectedModel={settings.selectedModel}
              autoModel={Boolean(settings.autoSelectModel)}
              modelReason={modelReason}
              onSelectModel={selectModel}
              onSelectAutoModel={selectAutoModel}
              activeProvider={settings.provider ?? "gemini"}
              providerHealth={providerHealth}
              attachments={attachments}
              onRemoveAttachment={removeAttachment}
              onAddAttachments={(atts) => setAttachments((prev) => [...prev, ...atts])}
              onPickFiles={() => void pickFiles()}
              contextMenuOpen={contextMenuOpen}
              onToggleContextMenu={setContextMenuOpen}
              onAddContext={addContext}
              listening={listening || transcribing}
              transcribing={transcribing}
              onStartListening={() => void startListening()}
              onStopListening={stopListening}
              speechError={speechError}
              speaking={speaking}
              onStopSpeaking={stopSpeaking}
            />
          </div>
        )}

        {explorerOpen && (
          <ExplorerDrawer
            workspace={workspace}
            tree={tree}
            onClose={() => setExplorerOpen(false)}
            onRefresh={() => workspace && void window.latex.workspace.tree(workspace).then(setTree)}
            onOpenFile={(node) => setPreviewFile({ path: node.path, name: node.name })}
          />
        )}

        {searchOpen && (
          <SearchOverlay
            conversations={conversations}
            workspaces={workspaces}
            files={searchFiles}
            onSelectConversation={selectConversation}
            onSelectWorkspace={selectWorkspace}
            onClose={() => setSearchOpen(false)}
          />
        )}

        {diffOpen && (
          <DiffViewer
            changes={pendingChanges}
            onAccept={(change) => void acceptChange(change)}
            onReject={rejectChange}
            onUndo={(change) => void undoChange(change)}
            onAcceptAll={() => void acceptAllChanges()}
            onRejectAll={rejectAllChanges}
            onClose={() => setDiffOpen(false)}
          />
        )}

        {previewFile && (
          <FilePreview
            file={previewFile}
            workspace={workspace}
            onClose={() => setPreviewFile(null)}
          />
        )}

        {workspaceInfoOpen && workspace && (
          <div className="modalBackdrop" onClick={() => setWorkspaceInfoOpen(false)}>
            <div className="modalPanel wsModal" onClick={(event) => event.stopPropagation()}>
              <div className="wsModalHead">
                <div className="wsModalTitle"><FolderOpen size={15} /> Workspace</div>
                <button className="iconButton" onClick={() => setWorkspaceInfoOpen(false)} title="Close">
                  <X size={16} />
                </button>
              </div>
              <div className="wsModalBody">
                <div className="wsModalRow">
                  <span className="wsModalLabel">Name</span>
                  <strong>{workspace.name}</strong>
                </div>
                <div className="wsModalRow">
                  <span className="wsModalLabel">Path</span>
                  <code className="wsModalPath">{workspace.path}</code>
                </div>
                <div className="wsModalRow">
                  <span className="wsModalLabel">Filesystem</span>
                  <span className={settings.filesystemAccess === "full" ? "accessOk" : "accessWs"}>
                    {settings.filesystemAccess === "full" ? "● Full PC Access" : "● Workspace Only"}
                  </span>
                </div>
                <div className="wsModalRow">
                  <span className="wsModalLabel">PC Control</span>
                  <span>{settings.pcControl === "on" ? "On" : settings.pcControl === "off" ? "Off" : "Ask before use"}</span>
                </div>
                <div className="wsModalRow">
                  <span className="wsModalLabel">Terminal</span>
                  <span>{terminalModeLabel(settings.terminalApprovalMode)}</span>
                </div>
                {workspaceInfo && (
                  <>
                    <div className="wsModalRow">
                      <span className="wsModalLabel">Git</span>
                      <span>{workspaceInfo.isGitRepository ? `Git repository${workspaceInfo.branch ? ` · branch ${workspaceInfo.branch}` : ""}` : "Not a git repository"}</span>
                    </div>
                    {workspaceInfo.frameworks.length > 0 && (
                      <div className="wsModalRow">
                        <span className="wsModalLabel">Detected</span>
                        <span>{workspaceInfo.frameworks.join(" + ")}</span>
                      </div>
                    )}
                    <div className="wsModalRow">
                      <span className="wsModalLabel">Files</span>
                      <span>{workspaceInfo.fileCount} tracked files (ignoring node_modules, .git, dist…)</span>
                    </div>
                  </>
                )}
              </div>
              <div className="wsModalFoot">
                <button className="btn" onClick={() => void openFolder()}><FolderOpen size={14} /> Change Folder</button>
                <button className="btn danger" onClick={() => void removeWorkspace()}><X size={14} /> Remove Access</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildAttachmentsContext(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";
  const blocks = attachments
    .filter((att) => att.kind === "text" || att.kind === "workspace" || att.kind === "conversation")
    .map((att) => {
      const truncated = att.truncated ? "\n\n_(This file was truncated.)_" : "";
      const prefix = att.label ?? `Attachment: ${att.name}`;
      return `### ${prefix}${truncated}\n${att.content ?? ""}`;
    });
  const imageNote = attachments.some((att) => att.kind === "image")
    ? "\n\n_(The message also includes attached images, provided separately to the model.)_"
    : "";
  return `User provided the following context:\n\n${blocks.join("\n\n")}${imageNote}`;
}

function buildWorkspaceContext(ws: Workspace, tree: FileTreeNode[]): string {
  const lines = [`Workspace: ${ws.name}`, `Path: ${ws.path}`, "", "Structure:"];
  const walk = (nodes: FileTreeNode[], depth: number) => {
    if (depth > 2) return;
    for (const node of nodes) {
      lines.push("  ".repeat(depth) + (node.type === "directory" ? "📁 " : "• ") + node.name);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(tree, 1);
  return lines.join("\n");
}

function buildConversationContext(conversation: Conversation): string {
  const recent = conversation.messages.slice(-8);
  return recent.map((m) => (m.role === "user" ? `Q: ${m.content}` : `A: ${m.content}`)).join("\n\n");
}

function newConversation(): Conversation {
  return { id: uid("conv"), title: "New chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function terminalModeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "autonomous": return "Autonomous (no approval)";
    case "trusted": return "Trusted commands";
    case "destructive": return "Safe commands run";
    default: return "Always ask";
  }
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
