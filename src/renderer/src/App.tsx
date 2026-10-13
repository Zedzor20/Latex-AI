import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, KeyRound, Settings as SettingsIcon, MessageSquare, Sparkles, X } from "lucide-react";
import type {
  AgentActivityStep,
  AgentTaskPhase,
  AgentTaskTimings,
  AgentEvent,
  AgentTaskRecord,
  ApprovalMode,
  ApprovalRequest,
  Attachment,
  ChatMessage,
  Conversation,
  FileOperationEvent,
  FileOperationPreview,
  FileTreeNode,
  GeneratedImage,
  GeneratedResult,
  GeminiModel,
  LatexSettings,
  ModelProvider,
  PendingChange,
  OmniRouteState,
  OmniRouteStatus,
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
import { Terminal } from "./components/Terminal";
import { DiffViewer } from "./components/DiffViewer";
import { FilePreview } from "./components/FilePreview";
import { WhatsNewModal } from "./components/WhatsNewModal";
import { translateError, safeMessage, type ErrorInfo, modelShortName } from "./lib/errors";
import { mergeGeneratedResults } from "../../shared/generatedResults";
import { normalizeAnswerText, reconcileFinalAnswer } from "../../shared/finalAnswer";
import { flattenTree } from "./lib/format";
import { classifyRequest, isWorkspaceOperation, pickModel, providerOfModel, PROVIDER_LABELS, type ModelChoice, type TaskKind } from "./lib/modelRouter";
import { stabilizeStreamingMarkdown } from "./lib/streamMarkdown";
import { phaseLabel } from "./lib/phases";
import { modelSupportsThinking, modelSupportsThinkingUI, resolveThinkingUIEnabled } from "../../shared/modelCapabilities";
import { applyFileOperationEvent } from "../../shared/fileOperations";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { mark } from "./lib/startupTrace";
import { once } from "./lib/startupCoordinator";
import "./styles.css";

type ViewMode = "home" | "chat" | "settings";
type RunMode = "chat" | "agent" | "image";

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

/**
 * AUTHENTICATION STATUS for OmniRoute, derived from the full status the main
 * process reports. Readiness requires BOTH a running server and a usable
 * credential — a live gateway that rejects us is not "ready".
 */
function isOmniRouteStatusReady(status: OmniRouteStatus | null | undefined): boolean {
  return Boolean(status?.running && (status.state === "online_authenticated" || status.state === "online_no_auth_required"));
}

function isOmniRouteModelSelected(settings: SettingsState): boolean {
  return (settings.selectedModel?.startsWith("omniroute/") ?? false) || settings.provider === "omniroute";
}

/**
 * Why OmniRoute can't be used right now, phrased from the SERVER state rather
 * than as a blanket "connect your API key": a running gateway that wants a key
 * must never be described as offline, and an invalid key must never be silent.
 */
function omniRouteBlockMessage(status: OmniRouteStatus | null | undefined): string | null {
  if (!status) return null;
  if (status.state === "starting") {
    // A just-launched gateway is booting — never describe it as "not running".
    return "OmniRoute is starting… Latex will connect automatically once the gateway is ready.";
  }
  if (!status.running) {
    return `OmniRoute is not running at ${status.baseUrl || "http://127.0.0.1:20128"}. Start it from Settings → AI → OmniRoute, or launch it yourself — Latex will detect it automatically.`;
  }
  switch (status.state) {
    case "online_api_key_required":
      return "OmniRoute is running, but this instance requires an API key. Add your OmniRoute endpoint key in Settings → AI → OmniRoute to connect Latex.";
    case "auth_failed":
      return "OmniRoute is running, but the saved API key was rejected. Update the OmniRoute endpoint key in Settings and save it again.";
    case "unknown_error":
      return status.error ?? "OmniRoute is running, but its API did not answer as expected. Check the endpoint in Settings.";
    default:
      return null;
  }
}

/** Text for the top-of-content setup banner, contextual to OmniRoute's state. */
function setupBannerText(
  isOmniRoute: boolean,
  status: OmniRouteStatus | null | undefined,
  providerLabel: string
): string {
  if (isOmniRoute) {
    const specific = omniRouteBlockMessage(status);
    if (specific) return specific;
  }
  return `Connect your ${providerLabel} API key to start working.`;
}

/**
 * Ollama's two INDEPENDENT facts, presented as ONE honest state.
 *
 * Liveness and model discovery are different questions: the server can be
 * perfectly reachable while the catalog is empty (nothing pulled yet), and a
 * catalog fetch can fail while the server is up. Conflating them is what
 * produced "Ollama says running but no models" — and the worse error of showing
 * "Ollama Offline" for a server that was actually answering.
 *
 *   OLLAMA_OFFLINE            → not_running / not_installed
 *   OLLAMA_STARTING           → connecting / unknown
 *   OLLAMA_ONLINE_NO_MODELS   → connected, catalog empty
 *   OLLAMA_ONLINE_WITH_MODELS → connected, N models discovered
 *   OLLAMA_ERROR              → the check itself failed
 */
function ollamaConnection(status: import("../../shared/types").OllamaStatus): {
  state: "ok" | "idle" | "fail";
  message: string;
} {
  const models = status.localModelCount ?? 0;
  switch (status.state) {
    case "connected":
      // Reachable. How many models it serves is reported SEPARATELY, so an
      // empty catalog is never mistaken for the server being down.
      return models > 0
        ? { state: "ok", message: `Ollama Online — ${models} model${models === 1 ? "" : "s"}` }
        : { state: "idle", message: "Ollama Online — no models installed" };
    case "connecting":
    case "unknown":
      return { state: "idle", message: "Starting Ollama…" };
    case "not_running":
      return { state: "idle", message: status.error ?? "Ollama is not running." };
    case "not_installed":
      return { state: "idle", message: status.error ?? "Ollama is not installed." };
    default:
      return { state: "fail", message: status.error ?? "Ollama reported an error." };
  }
}

export default function App() {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  // Always-current settings for callbacks captured in first-render closures
  // (status listeners, agent events). Prevents stale autoSelectModel/provider
  // state from silently overwriting the user's saved model selection.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | undefined>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation>(() => newConversation());
  // ── Persistent per-chat composer drafts (Part A) ──────────────────
  // One draft per chat, keyed by chatId (+ tab), stored in localStorage —
  // survives Main↔Chat switches, chat switches, project switches, renderer
  // reload and full app restart. Never a single global composer variable.
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraft>>(() => loadComposerDrafts());
  const composer = composerDrafts[conversation.id]?.draft ?? "";
  const setComposer = (updater: string | ((current: string) => string)): void => {
    const chatId = conversation.id;
    setComposerDrafts((prev) => {
      const current = prev[chatId]?.draft ?? "";
      const next = typeof updater === "function" ? updater(current) : updater;
      const map = { ...prev };
      if (next) {
        map[chatId] = { chatId, tab: conversation.mode ?? "main", draft: next, updatedAt: Date.now() };
      } else {
        delete map[chatId];
      }
      try {
        localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(map));
      } catch { /* storage may be unavailable (private mode/quota) */ }
      return map;
    });
  };
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
  // ── Per-response activity lifecycle ─────────────────────────────────
  // One timer + outcome per assistant response. Reset at every runTurn so
  // prompt 2+ gets a fresh lifecycle instead of inheriting prompt 1's.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [turnOutcome, setTurnOutcome] = useState<"stopped" | "error" | null>(null);
  // Ref mirror of activitySteps so async completions read CURRENT steps
  // instead of the stale render-time snapshot (source of the prompt-2 bug).
  const activityStepsRef = useRef<AgentActivityStep[]>([]);
  // True once this run's `done` event delivered a saved conversation.
  const doneRunRef = useRef(false);
  // Ref mirror of streamed text so Stop can preserve partial output.
  const streamTextRef = useRef("");

  // applyActivitySteps / resetActivityState were replaced by the
  // per-conversation run-state registry below (Parts B/C/AB): navigation
  // now SAVES/RESTORES per-chat state instead of resetting it.

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  /**
   * The change set the Review modal is showing, when it was opened from a
   * message's PERSISTED records rather than from the live turn.
   *
   * `null` means "the turn in flight", which is the only case where Accept /
   * Reject / Undo make sense — a restored review is a record of work that is
   * already on disk, so it is shown read-only.
   */
  const [reviewChanges, setReviewChanges] = useState<PendingChange[] | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [workspaceInfoOpen, setWorkspaceInfoOpen] = useState(false);
  /** Whether the What's New modal is currently on screen. The main process
      decides *whether* it should be shown (version vs. lastSeen); the renderer
      owns *when* it opens and *when* it closes, and tells the main process when
      it is showing so dev reloads don't re-pop it. */
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  // Every release the user has not acknowledged yet, newest first. Usually one;
  // a version jump carries the releases that were skipped.
  const [whatsNewReleases, setWhatsNewReleases] = useState<import("../../shared/updates").ReleaseEntry[]>([]);
  const [stream, setStream] = useState("");
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  // Live mirror of the durable GENERATED RESULTS (images, graphs, charts,
  // artifacts) for the visible turn. On completion the saved assistant message
  // owns them, exactly like generatedImages — so the graph does not vanish when
  // the live task UI ends.
  const [generatedResults, setGeneratedResults] = useState<GeneratedResult[]>([]);
  const [thinkingText, setThinkingText] = useState("");
  // Live high-level APPLICATION status. This is the AGENT ACTIVITY channel
  // (phase transitions, tool start/finish, verification) — a DIFFERENT stream
  // from `thinkingText`, which carries the model's own provider reasoning. The
  // two are never mixed: activity never reaches the Thinking box, reasoning
  // never reaches the Activity timeline.
  const [activityStatus, setActivityStatus] = useState("");
  // Live per-file previews of REAL Main Agent file operations (aggregated by
  // path). Frozen (never re-rendered) once their operation commits.
  const [fileOperations, setFileOperations] = useState<FileOperationPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  // Real request phase for the visible chat (mirrors that chat's run state).
  const [phase, setPhase] = useState<AgentTaskPhase | null>(null);
  const [timings, setTimings] = useState<AgentTaskTimings | null>(null);

  // ── Per-conversation run state (Parts B/C/AB/AC) ──────────────────
  // A running task belongs to taskId/chatId — NOT the visible component.
  // Streaming text, thinking, activity, busy and errors are kept PER CHAT so
  // switching chats/tabs never clears or cancels work; returning restores it.
  const activeChatIdRef = useRef<string>(conversation.id);
  activeChatIdRef.current = conversation.id;
  const runStatesRef = useRef<Map<string, ConvRunState>>(new Map());
  // Task id that owns the currently displayed approval request.
  const approvalTaskIdRef = useRef<string | null>(null);
  const [recoverableTask, setRecoverableTask] = useState<AgentTaskRecord | null>(null);

  function runStateFor(chatId: string): ConvRunState {
    let state = runStatesRef.current.get(chatId);
    if (!state) {
      state = createEmptyRunState();
      runStatesRef.current.set(chatId, state);
    }
    return state;
  }

  /** Registry-aware activity-step updater (routes to the owning chat). */
  const applyActivityStepsTo = (chatId: string, fn: (prev: AgentActivityStep[]) => AgentActivityStep[]) => {
    const state = runStateFor(chatId);
    state.steps = fn(state.steps);
    if (chatId === activeChatIdRef.current) {
      activityStepsRef.current = state.steps;
      // URGENT on purpose. These updates used to be marked as transitions
      // (non-urgent), but a continuous stream of urgent text updates starves
      // the transition lane: the activity/thinking/file state then commits
      // only when the response STOPS, which reads as a single dump at the
      // end. Live task state must commit on arrival.
      setActivitySteps(state.steps);
    }
  };

  /** Load the view mirrors from a chat's run state (used on navigation). */
  function loadViewState(chatId: string): void {
    activeChatIdRef.current = chatId;
    const state = runStateFor(chatId);
    streamTextRef.current = state.stream;
    activityStepsRef.current = state.steps;
    doneRunRef.current = state.doneRun;
    setStream(state.stream);
    setThinkingText(state.thinking);
    setActivityStatus(state.activityStatus);
    setGeneratedImages(state.images);
    setGeneratedResults(state.results);
    setFileOperations(state.files);
    setActivity(state.activity);
    setActivitySteps(state.steps);
    setActivityComplete(state.activityComplete);
    setBusy(state.busy);
    setError(state.error);
    setTurnStartedAt(state.turnStartedAt);
    setTurnOutcome(state.turnOutcome);
    setPhase(state.phase);
    setTimings(state.timings);
  }
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
  const [terminalOpen, setTerminalOpen] = useState(false);
  /**
   * Whether the terminal has been opened at least once in this session.
   *
   * The panel stays MOUNTED from then on and is merely hidden, so minimizing
   * (or switching chats/tabs) can never tear down a running shell. `onClose`
   * clears this, which is the only path that unmounts the terminal.
   */
  const [terminalEverOpened, setTerminalEverOpened] = useState(false);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  // Raw OmniRoute status from the main process (SERVER status + AUTH status).
  // Kept separately from `connections` so the UI can reason about
  // "running but needs a key" instead of only ok/fail.
  const [omniRouteStatus, setOmniRouteStatus] = useState<OmniRouteStatus | null>(null);
  const [connections, setConnections] = useState<Record<ModelProvider, ConnectionState>>({
    gemini: { state: "idle", message: "" },
    openrouter: { state: "idle", message: "" },
    minimax: { state: "idle", message: "" },
    groq: { state: "idle", message: "" },
    puter: { state: "idle", message: "" },
    ollama: { state: "idle", message: "" },
    omniroute: { state: "idle", message: "" }
  });
  const [puterConnected, setPuterConnected] = useState(false);
  const [puterUsername, setPuterUsername] = useState<string | undefined>(undefined);
  const [puterLoading, setPuterLoading] = useState(true); // true until first status check completes
  // ── Ollama state ──────────────────────────────────────────────────
  const [ollamaStatus, setOllamaStatus] = useState<import("../../shared/types").OllamaStatus | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(true);

  // Initialize Ollama connection status on mount — non-blocking.
  useEffect(() => {
    let mounted = true;
    // One applier for every path that learns Ollama's state, so the initial
    // check and the push updates can never disagree about it.
    const apply = (status: import("../../shared/types").OllamaStatus, refreshCatalog: boolean) => {
      if (!mounted) return;
      setOllamaStatus(status);
      setOllamaLoading(false);
      setConnections((current) => ({ ...current, ollama: ollamaConnection(status) }));
      // Health succeeding is NOT the same as the catalog being loaded. Whenever
      // the server is reachable we (re)discover its models, so "Ollama is
      // running" is immediately followed by its actual models appearing — the
      // previous code refreshed only on a state CHANGE, which missed the common
      // case of Ollama already running before Latex started.
      if (refreshCatalog && status.state === "connected") {
        void fetchModels().catch(() => undefined);
      }
    };

    void window.latex.ollama
      .getStatus()
      .then((status: import("../../shared/types").OllamaStatus) => apply(status, true))
      .catch(() => {
        if (mounted) setOllamaLoading(false);
      });

    const unsubscribe = window.latex.ollama.onStatusChanged((status: import("../../shared/types").OllamaStatus) => {
      // A change means the server appeared, disappeared or restarted — always
      // re-read the catalog when it is up (Ollama started after Latex).
      apply(status, true);
    });
    // The MODEL LIST is its own channel. Pulling or removing a model never
    // changes the connection state, so without this the picker kept whatever it
    // had until the user pressed "Refresh Models". The main process only pushes
    // when the catalog really changed, so an idle 5-second check runs nothing
    // here at all.
    //
    // The refresh goes through the existing single-flight catalog loader: that
    // is where "is the selected model still available?" lives, so a removed
    // model is handled exactly as it always was (warning, or the existing
    // auto-select fallback) instead of being reimplemented here. It replaces
    // the MODEL LIST only — never the open conversation, the stream, the
    // composer or the scroll position.
    const unsubscribeCatalog = window.latex.ollama.onCatalogChanged?.(() => {
      if (!mounted) return;
      void fetchModels().catch(() => undefined);
    });
    return () => { mounted = false; unsubscribe(); unsubscribeCatalog?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize OmniRoute connection status on mount — auto-detect already-running server.
  // Mirrors the Ollama pattern: poll + onStatusChanged listener.
  useEffect(() => {
    let mounted = true;
    // Initial probe
    void window.latex.omniroute.getStatus().then((status: OmniRouteStatus) => {
      if (!mounted) return;
      setOmniRouteStatus(status);
      setConnections((current) => ({
        ...current,
        omniroute: parseOmniRouteStatus(status)
      }));
      if (status.running) {
        void fetchModels().catch(() => undefined);
      }
    }).catch(() => {
      // OmniRoute not available — leave as idle
    });
    // Background listener — the main process polls the gateway and pushes every
    // server/auth state transition, so an externally started or restarted
    // OmniRoute connects (or drops) without restarting Latex.
    const unsubscribe = window.latex.omniroute.onStatusChanged((status: OmniRouteStatus) => {
      if (!mounted) return;
      setOmniRouteStatus(status);
      setConnections((current) => ({
        ...current,
        omniroute: parseOmniRouteStatus(status)
      }));
      // Refresh models whenever OmniRoute availability changes.
      void fetchModels().catch(() => undefined);
    });
    return () => { mounted = false; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── What's New on first launch after a new version ──────────────────────────
  // The main process already persisted `lastSeenWhatsNewVersion` in the local
  // store; the renderer asks it once whether the current version is newer than
  // what the user has acknowledged, and opens the modal if so. The modal itself
  // is what persists the seen version when the user clicks Got it.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const latex = window.latex;
      if (!latex?.whatsnew || !latex?.updates) return;
      // Tell the main process the modal is now showing so a dev reload
      // (fresh renderer) doesn't re-open the same dialog.
      const { shouldShow, release, unseen } = await latex.whatsnew.getState();
      if (!shouldShow || !mounted) return;
      const releases = unseen && unseen.length ? unseen : release ? [release] : [];
      if (releases.length === 0) return;
      try {
        await latex.whatsnew.show();
      } catch {
        // Best-effort — the modal opens either way.
      }
      if (!mounted) return;
      setWhatsNewReleases(releases);
      setWhatsNewOpen(true);
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Open the Ollama desktop app and wait for the server to come up. */
  async function openOllama() {
    setConnections((current) => ({ ...current, ollama: { state: "testing", message: "Starting Ollama server…" } }));
    try {
      const result: { ok: boolean; error?: string; status?: import("../../shared/types").OllamaStatus } = await window.latex.ollama.open();
      if (result.ok && result.status) {
        const status = result.status;
        setOllamaStatus(status);
        setConnections((current) => ({
          ...current,
          ollama: status.state === "connected"
            ? { state: "ok", message: `Ollama connected — ${status.localModelCount ?? 0} local models` }
            : { state: "idle", message: status.error ?? "" }
        }));
        await fetchModels().catch(() => undefined);
      } else {
        setConnections((current) => ({ ...current, ollama: { state: "fail", message: result.error ?? "Could not open Ollama" } }));
      }
    } catch (err) {
      setConnections((current) => ({ ...current, ollama: { state: "fail", message: safeMessage(err) } }));
    }
  }

  /** Start Ollama server from the Models picker - opens visible CMD */
  async function startOllama() {
    setConnections((current) => ({ ...current, ollama: { state: "testing", message: "Starting Ollama server…" } }));
    try {
      const result: { ok: boolean; error?: string; status?: import("../../shared/types").OllamaStatus } = await window.latex.ollama.start();
      if (result.ok && result.status) {
        const status = result.status;
        setOllamaStatus(status);
        setConnections((current) => ({
          ...current,
          ollama: status.state === "connected"
            ? { state: "ok", message: `Ollama connected — ${status.localModelCount ?? 0} local models` }
            : { state: "idle", message: status.error ?? "" }
        }));
        await fetchModels().catch(() => undefined);
      } else {
        setConnections((current) => ({ ...current, ollama: { state: "fail", message: result.error ?? "Could not start Ollama" } }));
      }
    } catch (err) {
      setConnections((current) => ({ ...current, ollama: { state: "fail", message: safeMessage(err) } }));
    }
  }

  /** Re-check the Ollama connection and refresh models. */
  async function refreshOllama() {
    setConnections((current) => ({ ...current, ollama: { state: "testing", message: "Checking connection…" } }));
    try {
      const status: import("../../shared/types").OllamaStatus = await window.latex.ollama.refresh();
      setOllamaStatus(status);
      setConnections((current) => ({
        ...current,
        ollama: status.state === "connected"
          ? { state: "ok", message: `Ollama connected — ${status.localModelCount ?? 0} local models` }
          : { state: status.state === "error" ? "fail" : "idle", message: status.error ?? "" }
      }));
      await fetchModels().catch(() => undefined);
    } catch (err) {
      setConnections((current) => ({ ...current, ollama: { state: "fail", message: safeMessage(err) } }));
    }
  }

  // ── OmniRoute Start / Stop / Refresh ──────────────────────────────────
  const [omniRouteStarting, setOmniRouteStarting] = useState(false);
  const [omniRouteElapsed, setOmniRouteElapsed] = useState(0);
  const omniRouteTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Map the main-process OmniRoute status into the renderer's connection state.
   * `running` mirrors SERVER status so the settings card can present a live
   * gateway that still needs a credential as "Running" rather than "Offline".
   */
  function parseOmniRouteStatus(
    status: OmniRouteStatus
  ): { state: "idle" | "testing" | "ok" | "fail"; message: string; running: boolean } {
    if (!status.running) {
      return { state: "fail", running: false, message: status.error ?? `OmniRoute is not running at ${status.baseUrl}` };
    }
    switch (status.state) {
      case "online_authenticated":
        return {
          state: "ok",
          running: true,
          message: `Connected — ${status.modelCount} model${status.modelCount === 1 ? "" : "s"} (saved API key accepted)`
        };
      case "online_no_auth_required":
        return {
          state: "ok",
          running: true,
          message: `Connected — ${status.modelCount} model${status.modelCount === 1 ? "" : "s"} (this instance needs no API key)`
        };
      case "online_api_key_required":
        return {
          state: "fail",
          running: true,
          message: status.error ?? "OmniRoute is running, but this instance requires an API key. Add your OmniRoute endpoint key below."
        };
      case "auth_failed":
        return {
          state: "fail",
          running: true,
          message: status.error ?? "OmniRoute is running, but the saved API key was rejected. Update the key below and save it again."
        };
      case "unknown_error":
        return { state: "fail", running: true, message: status.error ?? "OmniRoute is running, but its API did not answer as expected." };
      default:
        return {
          state: "ok",
          running: true,
          message: `Connected — ${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`
        };
    }
  }

  async function startOmniRoute() {
    setOmniRouteStarting(true);
    setOmniRouteElapsed(0);
    setConnections((current) => ({ ...current, omniroute: { state: "testing", message: "Starting OmniRoute…" } }));
    // Start elapsed timer
    const startTime = Date.now();
    omniRouteTimerRef.current = setInterval(() => {
      setOmniRouteElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    try {
      const result = await window.latex.omniroute.start();
      if (result.ok) {
        // The gateway may be up yet still require a key — report the real state
        // instead of optimistically claiming "connected".
        const status = result.status ?? await window.latex.omniroute.getStatus();
        setOmniRouteStatus(status);
        setConnections((current) => ({ ...current, omniroute: parseOmniRouteStatus(status) }));
        await fetchModels().catch(() => undefined);
      } else {
        setConnections((current) => ({ ...current, omniroute: { state: "fail", message: result.error ?? "Failed to start OmniRoute" } }));
      }
    } catch (err) {
      setConnections((current) => ({ ...current, omniroute: { state: "fail", message: safeMessage(err) } }));
    } finally {
      if (omniRouteTimerRef.current) { clearInterval(omniRouteTimerRef.current); omniRouteTimerRef.current = null; }
      setOmniRouteStarting(false);
      setOmniRouteElapsed(0);
    }
  }

  async function stopOmniRoute() {
    try {
      const result = await window.latex.omniroute.stop();
      if (!result.ok) {
        // Latex only stops a gateway it started itself.
        setNotice(result.error ?? "OmniRoute was not started by Latex, so it keeps running.");
        await refreshOmniRoute();
        return;
      }
      setConnections((current) => ({ ...current, omniroute: { state: "idle", running: false, message: "OmniRoute stopped" } }));
      await refreshOmniRoute();
    } catch (err) {
      setConnections((current) => ({ ...current, omniroute: { state: "fail", running: true, message: safeMessage(err) } }));
    }
  }

  async function refreshOmniRoute() {
    setConnections((current) => ({ ...current, omniroute: { state: "testing", running: current.omniroute?.running ?? false, message: "Checking OmniRoute…" } }));
    try {
      // `refresh` re-probes in the main process and broadcasts the result, so
      // every view converges on the same server/auth state.
      const status = await window.latex.omniroute.refresh();
      setOmniRouteStatus(status);
      setConnections((current) => ({
        ...current,
        omniroute: parseOmniRouteStatus(status)
      }));
      if (status.running) {
        await fetchModels().catch(() => undefined);
      }
    } catch (err) {
      setConnections((current) => ({ ...current, omniroute: { state: "fail", running: false, message: safeMessage(err) } }));
    }
  }

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

  // Runs as the FIRST effect after React's initial commit, so the gap from
  // `startup:renderer-boot` to here is the real cost of building the first tree.
  // That number is what a user experiences as "laggy immediately after opening":
  // the window can be on screen while the renderer's main thread is still busy
  // and therefore NOT yet clickable.
  useEffect(() => {
    mark("startup:renderer-mounted");
  }, []);

  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme === "system") {
      return watchSystemTheme(() => applyTheme("system"));
    }
  }, [settings.theme]);

  // ---- boot --------------------------------------------------------------

  useEffect(() => {
    let mounted = true;

    // ── Progressive boot ────────────────────────────────────────────────────
    // Each subsystem loads INDEPENDENTLY and commits the moment it arrives.
    // This used to be a single `Promise.all`, which made the SLOWEST of the
    // four calls gate every other one — so a slow provider probe, an
    // unresponsive handler or a large chat history held back the sidebar, the
    // composer and the first paint. A slow call can now only delay the feature
    // it actually belongs to, and every one has a failure path so a rejected
    // IPC cannot leave the app half-initialized.
    let settingsLoaded: SettingsState | null = null;
    let workspacesLoaded: Workspace[] | null = null;
    // Restoring the saved workspace needs BOTH answers, so it runs as soon as
    // the second of the two arrives — and blocks neither of them.
    const restoreSavedWorkspace = () => {
      if (!mounted || !settingsLoaded || !workspacesLoaded) return;
      const list = workspacesLoaded;
      if (list.length === 0) return;
      const savedWsId = settingsLoaded.lastWorkspaceId;
      if (savedWsId) {
        // A saved workspace that no longer exists selects nothing — never a
        // random project.
        const saved = list.find((w: Workspace) => w.id === savedWsId);
        if (saved) setWorkspace(saved);
      } else {
        // No previously saved workspace — use the first as a fallback.
        setWorkspace(list[0]);
      }
    };

    // Every read below goes through the idempotent coordinator, so a StrictMode
    // remount or a window reload reuses the first result instead of repeating
    // the whole startup pipeline in the main process (see startupCoordinator).
    // The preload bridge is intentionally untyped (`any`) at this boundary, so
    // the expected shape is stated explicitly rather than inferred.
    const settingsPromise = once<SettingsState>("boot:settings", () => window.latex.settings.get())
      .then((nextSettings: SettingsState) => {
        if (!mounted) return nextSettings;
        settingsLoaded = nextSettings;
        setSettings(nextSettings);
        mark("startup:settings");
        restoreSavedWorkspace();
        return nextSettings;
      })
      .catch(() => undefined);

    void once<Workspace[]>("boot:workspaces", () => window.latex.workspace.list())
      .then((nextWorkspaces: Workspace[]) => {
        if (!mounted) return;
        workspacesLoaded = nextWorkspaces;
        setWorkspaces(nextWorkspaces);
        mark("startup:workspaces", `${nextWorkspaces.length} project(s)`);
        restoreSavedWorkspace();
      })
      .catch(() => undefined);

    void once<Conversation[]>("boot:conversations", () => window.latex.conversation.list())
      .then((nextConversations: Conversation[]) => {
        if (!mounted) return;
        // The list is the whole sidebar contract; selecting a chat is what
        // loads its messages. Nothing here parses message bodies.
        setConversations(nextConversations);
        mark("startup:history", `${nextConversations.length} conversation(s)`);
      })
      .catch(() => undefined);

    void once<AgentTaskRecord[]>("boot:recoverable-tasks", () => window.latex.tasks.recoverable())
      .then((recoverableTasks: AgentTaskRecord[]) => {
        // Restore any interrupted task checkpoint → offer Continue (Parts H/I).
        if (!mounted || recoverableTasks.length === 0) return;
        setRecoverableTask(recoverableTasks[0]);
      })
      .catch(() => undefined);

    // Startup selects NO conversation. The history is persisted and listed in
    // the sidebar, but opening one is the user's decision — the app must not
    // restore "whatever was last active" into the centre.
    setView("home");

    // `startup:ready` means THE WINDOW IS INTERACTIVE — clickable, scrollable,
    // able to type and able to open a chat. It is reported after the first
    // painted frame and deliberately waits for none of the loads above, so it
    // states what the user can actually do rather than pretending everything
    // has finished. Nothing is faked: the loads above keep running and their
    // results appear progressively.
    requestAnimationFrame(() => mark("startup:ready", "first interactive frame"));

    // The model catalog is the most expensive startup call (it can reach every
    // enabled provider), so it starts only AFTER settings are known and only
    // after the first paint — it can never delay an interactive window. The
    // freshly loaded settings are passed so auto-select can never overwrite a
    // saved model from stale closure state.
    void settingsPromise.then((loaded: SettingsState | undefined) => {
      if (!mounted) return;
      requestAnimationFrame(() => {
        if (!mounted) return;
        void fetchModels((loaded ?? undefined) as SettingsState | undefined).catch(() => undefined);
      });
    });

    // ── Stream batch (performance + per-chat routing, Parts B/AB) ───
    // Chunks are TAGGED with their chat id so Chat A's stream keeps
    // accumulating while Chat B is visible. Flushed at ~32ms (~30fps) for
    // smooth word/chunk animation without re-rendering per token — the
    // provider's own chunk rate drives progress; no artificial typing delay.
    // Durable partial-response checkpoints happen in the MAIN process
    // (AgentTaskManager, Parts E/F) — the renderer only owns the view.
    let streamBuffer: Array<{ chatId: string; text: string }> = [];
    // ── Frame-aligned stream batching ────────────────────────────────
    // Deliberately NOT a fixed-interval timer. A timer fires on its own
    // schedule, which lands between paints: some frames get two flushes and
    // some get none, so text arrives in visible stutters. A rAF flush commits
    // exactly one batched update per frame, which is the smoothest cadence the
    // display can actually show (target ~16ms, 60fps).
    //
    // The watchdog exists only for the case rAF cannot serve: a hidden,
    // occluded or off-screen window stops receiving animation frames, and
    // without a fallback text would stop appearing until the window is shown
    // again. It is TWO frames (~32ms), so in the normal visible case the rAF
    // always wins the race and cancels it — the frame-aligned cadence is never
    // disturbed — while a throttled window still updates at ~30fps instead of
    // stalling until the next animation frame it happens to receive.
    let streamFlushFrame: number | null = null;
    let streamFlushWatchdog: number | null = null;
    const cancelScheduledFlush = () => {
      if (streamFlushFrame !== null) { window.cancelAnimationFrame(streamFlushFrame); streamFlushFrame = null; }
      if (streamFlushWatchdog !== null) { window.clearTimeout(streamFlushWatchdog); streamFlushWatchdog = null; }
    };
    const flushStream = () => {
      cancelScheduledFlush();
      if (streamBuffer.length === 0) return;
      const batch = streamBuffer;
      streamBuffer = [];
      // Coalesce by chat in ONE pass — a burst of deltas for the same chat must
      // never be concatenated with repeated string copies of a growing buffer.
      const byChat = new Map<string, string>();
      for (const item of batch) byChat.set(item.chatId, (byChat.get(item.chatId) ?? "") + item.text);
      for (const [chatId, text] of byChat) {
        const state = runStateFor(chatId);
        state.stream += text;
        if (chatId === activeChatIdRef.current) {
          streamTextRef.current = state.stream;
          setStream(state.stream);
        }
      }
    };
    const queueStreamChunk = (chatId: string, chunk: string) => {
      streamBuffer.push({ chatId, text: chunk });
      if (streamFlushFrame !== null || streamFlushWatchdog !== null) return;
      streamFlushFrame = window.requestAnimationFrame(() => { streamFlushFrame = null; flushStream(); });
      streamFlushWatchdog = window.setTimeout(flushStream, 32);
    };
    // Flush any pending buffer when the run finishes or is interrupted.
    const flushStreamNow = () => { cancelScheduledFlush(); flushStream(); };

    // ── Thinking batch (performance, per-chat) ─────────────────────
    // Kicked off with requestAnimationFrame so a burst of reasoning deltas
    // paints in the same frame it arrives (frame-aligned, at most ONE React
    // commit per frame, and ONLY for the Thinking box) with a 32 ms watchdog in
    // case the frame is starved. This is what makes the reasoning appear
    // progressively while the model is still thinking, instead of arriving as
    // one block at the end.
    let thinkBuffer: Array<{ chatId: string; text: string }> = [];
    let thinkFlushFrame: number | null = null;
    let thinkFlushWatchdog: number | null = null;
    const cancelScheduledThink = () => {
      if (thinkFlushFrame !== null) { window.cancelAnimationFrame(thinkFlushFrame); thinkFlushFrame = null; }
      if (thinkFlushWatchdog !== null) { window.clearTimeout(thinkFlushWatchdog); thinkFlushWatchdog = null; }
    };
    const flushThink = () => {
      cancelScheduledThink();
      if (thinkBuffer.length === 0) return;
      const batch = thinkBuffer;
      thinkBuffer = [];
      const byChat = new Map<string, string>();
      for (const item of batch) byChat.set(item.chatId, (byChat.get(item.chatId) ?? "") + item.text);
      for (const [chatId, text] of byChat) {
        const state = runStateFor(chatId);
        state.thinking += text;
        // URGENT: each real provider delta must paint as it arrives. Never a
        // transition — a transition would be starved by the text stream and
        // the whole reasoning summary would appear at the very end.
        if (chatId === activeChatIdRef.current) setThinkingText(state.thinking);
      }
    };
    const queueThinkChunk = (chatId: string, chunk: string) => {
      thinkBuffer.push({ chatId, text: chunk });
      if (thinkFlushFrame !== null || thinkFlushWatchdog !== null) return;
      thinkFlushFrame = window.requestAnimationFrame(() => { thinkFlushFrame = null; flushThink(); });
      thinkFlushWatchdog = window.setTimeout(flushThink, 32);
    };
    const flushThinkNow = () => flushThink();

    return window.latex.agent.onEvent((event: AgentEvent) => {
      // ── Deterministic per-chat routing (Part AB) ───────────────────
      // Every event is stored under its owning chat id; view mirrors update
      // only when that chat is the visible one. Background chats keep
      // accumulating while another chat/tab is open.
      const rawChatId = typeof event.conversationId === "string" ? event.conversationId : "";
      const chatId = rawChatId && rawChatId !== "mcp" && rawChatId !== "active"
        ? rawChatId
        : activeChatIdRef.current;
      const isActive = chatId === activeChatIdRef.current;
      const state = runStateFor(chatId);

      if (event.type === "status") {
        state.activity = [...state.activity, safeMessage(event.payload)].slice(-8);
        if (isActive) setActivity(state.activity);
      }
      if (event.type === "thinking") {
        queueThinkChunk(chatId, safeMessage(event.payload));
      }
      if (event.type === "activity_status") {
        // Latex's own high-level status (real events only). This is the ACTIVITY
        // channel — it feeds the Agent Activity timeline header and never the
        // Thinking box. It never touches `state.thinking`, so provider reasoning
        // and application activity cannot contaminate each other.
        const payload = event.payload as { text?: unknown } | undefined;
        const line = typeof payload?.text === "string" ? payload.text.trim() : "";
        if (line) {
          state.activityStatus = line;
          if (isActive) setActivityStatus(line);
        }
      }
      if (event.type === "phase") {
        // Real lifecycle transition from the main process. The header renders
        // this, so it always names what is actually happening.
        const payload = event.payload as { phase?: AgentTaskPhase; timings?: AgentTaskTimings };
        if (payload?.phase) {
          state.phase = payload.phase;
          state.timings = payload.timings ?? state.timings;
          if (isActive) {
            setPhase(state.phase);
            setTimings(state.timings);
          }
        }
      }
      if (event.type === "message") {
        // When real text starts, flush and freeze thinking
        flushThinkNow();
        queueStreamChunk(chatId, safeMessage(event.payload));
      }
      if (event.type === "image") {
        // A REAL image from the provider — its own channel. The text stream
        // and activity timeline are untouched; this only adds the picture.
        const payload = event.payload as { mimeType?: unknown; base64?: unknown } | undefined;
        const base64 = typeof payload?.base64 === "string" ? payload.base64 : "";
        const mimeType = typeof payload?.mimeType === "string" ? payload.mimeType : "image/png";
        if (base64) {
          state.images = [...state.images, {
            id: uid("img"),
            name: `generated-${state.images.length + 1}.${mimeType.includes("jpeg") ? "jpg" : "png"}`,
            kind: "image",
            base64,
            mimeType
          }];
          if (isActive) setGeneratedImages(state.images);
        }
      }
      if (event.type === "generated_result") {
        // A REAL generated result committed by the agent (image / graph /
        // chart / artifact). Its own durable list, deduplicated by resultId so
        // a repeated event cannot stack the same graph twice.
        const result = event.payload as GeneratedResult | undefined;
        if (result && typeof result.resultId === "string") {
          state.results = mergeGeneratedResults(state.results, result);
          if (isActive) setGeneratedResults(state.results);
        }
      }
      if (event.type === "file_operation") {
        // Live file-writing preview (ACTIVITY channel). Aggregated by path, so
        // repeated writes to the same file update ONE entry instead of stacking
        // duplicate cards. Preview content comes from the real tool args — the
        // committed filesystem content is never sent through this channel.
        const p = event.payload as FileOperationEvent | undefined;
        if (p && typeof p.filePath === "string" && p.filePath) {
          // The event's own task/chat/message identity is carried into the record
          // so an entry is never an anonymous renderer row: it names the message
          // that produced it, which is what lets the same record be read back
          // from disk when the chat is reopened.
          state.files = applyFileOperationEvent(state.files, p, {
            taskId: event.taskId,
            chatId,
            messageId: event.messageId
          });
          if (isActive) setFileOperations(state.files);
        }
      }
      if (event.type === "tool") {
        const payload = event.payload as { name?: string; status?: string; path?: string };
        const name = String(payload.name ?? "tool").replace(/_/g, " ");
        const where = payload.path ? ` ${payload.path}` : "";
        const line = payload.status === "error" ? `✕ ${name}${where} failed`
          : payload.status === "rejected" ? `Rejected ${name}${where}`
          : `✓ ${name}${where}`;
        state.activity = [...state.activity, line].slice(-8);
        if (isActive) setActivity(state.activity);
      }
      if (event.type === "activity_step") {
        const step = event.payload as AgentActivityStep;
        // Route through the registry so async completions see CURRENT steps.
        applyActivityStepsTo(chatId, (prev) => {
          // A completion call reuses the active step's id: update that row in
          // place so it gains its command output / exit code / line count
          // instead of leaving a duplicate row behind. Each tool invocation
          // gets its own id in the main process, so consecutive commands stay
          // separate rows.
          const existingIdx = step.id ? prev.findIndex((s) => s.id === step.id) : -1;
          if (existingIdx >= 0) {
            const updated = [...prev];
            const existing = updated[existingIdx];
            updated[existingIdx] = {
              ...existing,
              label: step.label || existing.label,
              status: step.status,
              detail: step.detail ?? existing.detail,
              kind: step.kind ?? existing.kind,
              tool: step.tool ?? existing.tool,
              command: step.command ?? existing.command,
              output: step.output ?? existing.output,
              exitCode: step.exitCode ?? existing.exitCode,
              path: step.path ?? existing.path,
              lines: step.lines ?? existing.lines,
              id: existing.id,
              startedAt: existing.startedAt,
              duration: existing.startedAt ? Date.now() - existing.startedAt : existing.duration,
              timestamp: step.timestamp ?? Date.now()
            };
            return updated;
          }
          // Mark any currently active step as done, then add the new one
          const closed = prev.map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s);
          return [...closed, step].slice(-20);
        });
      }
      if (event.type === "activity_complete") {
        // Mark all active steps as done
        applyActivityStepsTo(chatId, (prev) => prev.map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s));
        state.activityComplete = true;
        if (isActive) setActivityComplete(true);
      }
      if (event.type === "done") {
        // Flush pending stream and thinking text so nothing is lost before the final
        // conversation replaces the stream.
        flushThinkNow();
        flushStreamNow();
        const doneConvRaw = event.payload as Conversation | undefined;
        const targetId = doneConvRaw?.id ?? chatId;
        const targetState = runStateFor(targetId);
        // ── The streamed answer is authoritative ──────────────────────
        // Captured BEFORE the stream buffer is cleared. Everything the user
        // already read for this run, per chat.
        const streamedThisRun = targetState.stream;
        // Defensive reconciliation at the UI boundary: a completion payload can
        // never make the visible answer shorter or different from the answer
        // that was just streamed. (The main process already guarantees this;
        // this is the net that catches a stale/partial payload arriving late.)
        const doneConv = doneConvRaw ? repairDroppedStreamedAnswer(doneConvRaw, streamedThisRun) : doneConvRaw;
        if (doneConvRaw && doneConv && doneConv !== doneConvRaw) {
          // The persisted record lost streamed text — persist the repaired
          // message so a chat switch, restart or restoration shows the same
          // complete answer instead of the shortened one.
          void window.latex.conversation.save(doneConv).catch(() => undefined);
        }
        targetState.doneRun = true;
        targetState.busy = false;
        targetState.activityComplete = true;
        targetState.stream = ""; // the final message now lives in the conversation
        targetState.thinking = "";
        // The task that owned a displayed approval is finished — clear it.
        if (event.taskId && approvalTaskIdRef.current && event.taskId === approvalTaskIdRef.current) {
          approvalTaskIdRef.current = null;
          setApproval(null);
        }
        // The "done" event carries the final saved conversation.
        // Update the conversation list immediately (always) so a background
        // run's result is durable even while another chat is visible.
        if (doneConv && doneConv.messages && doneConv.messages.length > 0) {
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === doneConv.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = doneConv;
              return updated;
            }
            return [doneConv, ...prev];
          });
          // The saved message owns the activity display now (persisted row).
          // Clear the live steps so the panel doesn't duplicate the message row.
          const lastDone = doneConv.messages[doneConv.messages.length - 1];
          const persistedSteps = lastDone?.meta?.activitySteps as AgentActivityStep[] | undefined;
          if (lastDone?.role === "assistant" && persistedSteps && persistedSteps.length > 0) {
            targetState.steps = [];
            targetState.activityComplete = true;
          }
          // Same handover for FILE ACTIVITY. The message now carries the durable
          // record of every file this turn touched (with how many real writes
          // each one took), so the live panel stands down instead of leaving a
          // duplicate — and switching chats, sending another message or
          // restarting the app no longer loses it.
          const persistedFiles = lastDone?.meta?.fileOperations as FileOperationPreview[] | undefined;
          if (lastDone?.role === "assistant" && persistedFiles && persistedFiles.length > 0) {
            targetState.files = [];
          }
          // Same handover for the CHANGE REVIEW. The saved message now owns the
          // per-file records (kind, path, net diff, write count), so the live
          // set stands down — the review stays on screen, but it is rendered
          // from the conversation instead of from the turn that produced it.
          const persistedReview = lastDone?.meta?.reviewChanges as PendingChange[] | undefined;
          if (
            lastDone?.role === "assistant"
            && persistedReview && persistedReview.length > 0
            && targetId === activeChatIdRef.current
          ) {
            setPendingChanges([]);
            setReviewChanges(null);
          }
          // Only swap the VISIBLE conversation when it owns this result —
          // a background finish must never yank the user to another chat.
          if (targetId === activeChatIdRef.current) {
            doneRunRef.current = true;
            streamTextRef.current = "";
            setStream("");
            setThinkingText("");
            setActivityStatus("");
            setFileOperations(targetState.files);
            setConversation(doneConv);
            if (targetState.steps.length === 0) {
              activityStepsRef.current = [];
              setActivitySteps([]);
            }
            setActivityComplete(true);
            setBusy(false);
          }
        } else if (isActive) {
          doneRunRef.current = true;
          setActivityComplete(true);
          setBusy(false);
        }
      }
      if (event.type === "approval") {
        const request = event.payload as ApprovalRequest;
        // Approvals are global — the task waits regardless of which chat is
        // visible, and navigation never hides the prompt (Part B/T).
        approvalTaskIdRef.current = event.taskId ?? null;
        setApproval(request);
        // Mark the owning chat's activity step as waiting for permission
        applyActivityStepsTo(chatId, (prev) => {
          const updated = prev.map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s);
          return [...updated, {
            id: `perm_${Date.now().toString(36)}`,
            label: "Permission Required",
            status: "active" as const,
            detail: `${request.title}: ${request.path ?? request.description}`,
            timestamp: Date.now(),
            startedAt: Date.now()
          }].slice(-20);
        });
      }
      if (event.type === "changes") setPendingChanges(event.payload as PendingChange[]);
      if (event.type === "error") {
        const info = translateError(event.payload);
        state.error = info;
        if (isActive) setError(info);
      }
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

  // ── Provider-exposed thinking capability for the SELECTED model ──────
  // `thinkingSupported` is the model's REAL capability; `thinkingOn` folds in the
  // user's explicit per-model preference. Sending thinking is ON by default for
  // a supported model and never carried onto a model that cannot use it.
  const thinkingSupported = useMemo(() => {
    if (!settings.selectedModel) return false;
    const found = models.find((model) => model.name === settings.selectedModel);
    return modelSupportsThinking(found ?? { name: settings.selectedModel, provider: settings.provider as ModelProvider, capabilities: [] });
  }, [models, settings.selectedModel, settings.provider]);

  // The UI half of Thinking, and the fix for "Thinking is restricted to models
  // with explicit reasoning": ANY text-chat model can show the Thinking
  // experience, so GPT and Claude are eligible even though their APIs expose no
  // displayable reasoning to us. `thinkingSupported` above still decides whether
  // real reasoning text can appear — the box never invents any.
  const thinkingUiSupported = useMemo(() => {
    if (!settings.selectedModel) return false;
    const found = models.find((model) => model.name === settings.selectedModel);
    return modelSupportsThinkingUI(found ?? { name: settings.selectedModel, provider: settings.provider as ModelProvider, capabilities: [] });
  }, [models, settings.selectedModel, settings.provider]);

  const thinkingUiOn = useMemo(() => {
    if (!settings.selectedModel) return false;
    const found = models.find((model) => model.name === settings.selectedModel);
    const provider = (found?.provider ?? settings.provider) as ModelProvider;
    return resolveThinkingUIEnabled(settings.thinkingPreferences, provider, settings.selectedModel);
  }, [models, settings.selectedModel, settings.provider, settings.thinkingPreferences]);

  // The Thinking box is available whenever the EXPERIENCE is available and the
  // user has not turned it off for this model. It is deliberately NOT gated on
  // provider-exposed reasoning; what the box may display IS.
  const thinkingAvailable = thinkingUiSupported && thinkingUiOn;

  const toggleThinking = (enabled: boolean) => {
    const model = settings.selectedModel;
    if (!model) return;
    const found = models.find((m) => m.name === model);
    const provider = (found?.provider ?? settings.provider) as ModelProvider;
    const key = `${provider}:${model}`;
    void (async () => {
      const prefs = { ...(settings.thinkingPreferences ?? {}), [key]: enabled };
      const saved = await window.latex.settings.save({ thinkingPreferences: prefs } as Partial<LatexSettings>);
      setSettings((current) => ({ ...current, ...saved }));
    })();
  };


  const modelLabel = useMemo(() => {
    if (settings.autoSelectModel) return "Auto";
    if (!settings.selectedModel) return "Select model";
    const found = models.find((model) => model.name === settings.selectedModel);
    return found?.displayName ?? modelShortName(settings.selectedModel);
  }, [models, settings.selectedModel, settings.autoSelectModel]);

  const activeMessages = useMemo(
    () => [
      ...conversation.messages,
      ...(stream || generatedImages.length > 0 || generatedResults.length > 0
        ? [{
            id: "stream",
            role: "assistant" as const,
            // Streaming-safe markdown: an unterminated code fence is closed for
            // display so the answer keeps rendering as prose while it arrives.
            content: stabilizeStreamingMarkdown(stream),
            createdAt: Date.now(),
            meta: {
              streaming: true,
              // Live generated images/results ride on the streaming message so
              // they render through the SAME code path as a persisted message.
              ...(generatedImages.length > 0 ? { generatedImages } : {}),
              ...(generatedResults.length > 0 ? { generatedResults } : {})
            }
          }]
        : [])
    ],
    [conversation, stream, generatedImages, generatedResults]
  );

  const hasChat = activeMessages.length > 0;
  /**
   * The chat the user explicitly opened, or null when nothing is selected.
   *
   * Derived from the PERSISTED list, so it is null on startup (the state holds a
   * fresh, unsaved conversation) and null for a brand-new chat until it is
   * saved — the centre stays on the "no chat selected" state until the user
   * picks a chat. This is deliberately separate from "last opened": history is
   * kept and listed, but is never restored into the centre automatically.
   */
  const selectedChatId = conversations.some((item) => item.id === conversation.id) ? conversation.id : null;
  const searchFiles = useMemo(() => flattenTree(tree), [tree]);
  const isPuterModel = (settings.selectedModel?.startsWith("puter/") ?? false) || settings.provider === "puter";
  const isOllamaModel = (settings.selectedModel?.startsWith("ollama/") ?? false) || settings.provider === "ollama";
  // OmniRoute readiness is a live SERVER + AUTH decision, not the presence of a
  // stored key: a keyless gateway is perfectly usable, and a running gateway
  // that rejects our key is not.
  const isOmniRouteModel = isOmniRouteModelSelected(settings);
  const omniRouteReady = isOmniRouteModel && isOmniRouteStatusReady(omniRouteStatus);
  const providerReady = Boolean(settings.hasApiKey) || isPuterModel || isOllamaModel || omniRouteReady;
  const setupNotice = setupBannerText(isOmniRouteModel, omniRouteStatus, PROVIDER_LABELS[settings.provider ?? "gemini"]);
  const connectionStatus: ConnectionStatus = !providerReady
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
    // ONLY if auto-select is enabled or no model was previously selected.
    // Manual model selections must never be overwritten.
    // Skip if caller is already providing a selectedModel (prevents re-trigger loops).
    if (partial.provider && partial.provider !== settings.provider && !partial.selectedModel) {
      const newProvider = partial.provider;
      const currentModel = settings.selectedModel;
      const currentModelProvider = currentModel ? (models.find((m) => m.name === currentModel)?.provider ?? providerOfModel(currentModel)) : null;
      const shouldAutoSelect = (settings.autoSelectModel || !currentModel) && (!currentModel || currentModelProvider !== newProvider);
      if (shouldAutoSelect) {
        const providerModels = models.filter((m) => (m.provider ?? providerOfModel(m.name)) === newProvider);
        if (providerModels.length > 0) {
          const choice = pickModel(providerModels, "chat");
          if (choice.model) {
            const modelSaved = await window.latex.settings.save({ selectedModel: choice.model, provider: newProvider, autoSelectModel: settings.autoSelectModel });
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
    // A freshly saved OmniRoute key is tested immediately against the real
    // gateway — the user never has to press Test to learn whether it works.
    if (provider === "omniroute") await testProviderConnection("omniroute");
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
    if (provider === "omniroute") {
      // OmniRoute's "test" is a server-health + API-auth check performed in the
      // main process; mirror its verdict (including "running but key required")
      // rather than collapsing everything into ok/fail.
      setConnections((current) => ({ ...current, omniroute: { state: "testing", running: current.omniroute?.running ?? false, message: "Testing OmniRoute connection…" } }));
      try {
        await window.latex.ai.test("omniroute");
        const status = await window.latex.omniroute.getStatus();
        setOmniRouteStatus(status);
        setConnections((current) => ({ ...current, omniroute: parseOmniRouteStatus(status) }));
        await fetchModels().catch(() => undefined);
      } catch (err) {
        const status = await window.latex.omniroute.getStatus().catch(() => null);
        if (status) setOmniRouteStatus(status);
        const info = translateError(err, provider);
        setConnections((current) => ({
          ...current,
          omniroute: status?.running
            ? parseOmniRouteStatus(status)
            : { state: "fail", running: false, message: info.message }
        }));
      }
      return;
    }
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

  function modelsForActiveProvider(list: GeminiModel[], provider?: ModelProvider): GeminiModel[] {
    const active = provider ?? settingsRef.current.provider ?? "gemini";
    return list.filter((model) => (model.provider ?? providerOfModel(model.name)) === active);
  }

  /**
   * Refresh the model catalog.
   * `useSettings` lets callers pass freshly loaded settings (e.g. from the boot
   * effect) so stale React closure state can never auto-select a different
   * model than the one the user actually saved.
   */
  /** The catalog refresh currently running, if any (see `fetchModels`). */
  const modelsInFlightRef = useRef<Promise<GeminiModel[]> | null>(null);

  /**
   * Refresh the model catalog, sharing ONE in-flight request.
   *
   * Startup legitimately triggers this from several independent places (the
   * boot load, an Ollama status change, an OmniRoute status change). Each
   * refresh can reach EVERY enabled provider, so concurrent triggers must join
   * the request already running instead of duplicating provider traffic — that
   * duplication was itself a startup cost.
   */
  function fetchModels(useSettings?: SettingsState): Promise<GeminiModel[]> {
    if (modelsInFlightRef.current) return modelsInFlightRef.current;
    const inFlight = fetchModelsOnce(useSettings).finally(() => {
      modelsInFlightRef.current = null;
    });
    modelsInFlightRef.current = inFlight;
    return inFlight;
  }

  async function fetchModelsOnce(useSettings?: SettingsState): Promise<GeminiModel[]> {
    setModelsState("loading");
    setModelsError("");
    try {
      const list: GeminiModel[] = await window.latex.ai.models();
      setModels(list);
      setModelsState("ready");
      mark("startup:model-catalog", `${list.length} model(s)`);
      // Probe provider health in the background (non-blocking)
      window.latex.ai
        .healthProbe()
        .then((health: Parameters<typeof setProviderHealth>[0]) => {
          setProviderHealth(health);
          mark("startup:providers", "health probe complete");
        })
        .catch(() => undefined);
      const current = useSettings ?? settingsRef.current;
      const activeProvider = current.provider ?? "gemini";
      const activeList = modelsForActiveProvider(list, activeProvider);
      const selectedModel = current.selectedModel;
      const hasSelected = Boolean(selectedModel) && activeList.some((model: GeminiModel) => model.name === selectedModel);
      if (!hasSelected) {
        if (current.autoSelectModel && activeList.length > 0) {
          const choice = pickModel(activeList, "chat");
          if (selectedModel) {
            setNotice(`${modelShortName(selectedModel)} is no longer available. Latex auto-selected ${modelShortName(choice.model ?? "")}.`);
          }
          await saveSettings({ selectedModel: choice.model });
          setModelReason(choice.reason);
          setModelWarning(null);
        } else if (selectedModel) {
          setModelWarning(selectedModel);
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
      // Persist last selected workspace for next startup
      void saveSettings({ lastWorkspaceId: next.id });
    }
  }

  function selectWorkspace(next: Workspace) {
    setWorkspace(next);
    // Persist last selected workspace for next startup
    void saveSettings({ lastWorkspaceId: next.id });
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
    const nextConv = restored ?? { ...newConversation(), mode: nextMode };
    setConversation(nextConv);
    setAppMode(nextMode);
    // Tab switch = UI visibility only: restore this tab's run state from the
    // registry. Never clear streaming/activity/busy and NEVER cancel the
    // other tab's task (Parts B/C) — only explicit Stop cancels work.
    loadViewState(nextConv.id);
    setPendingChanges([]);
  }

  function newChat() {
    const nextConv = { ...newConversation(), mode: appMode };
    setConversation(nextConv);
    if (appMode === "main") mainConversationRef.current = nextConv;
    else chatConversationRef.current = nextConv;
    // Fresh chat → fresh run state; the previous chat's draft, stream and
    // activity stay in their registry entries untouched (Parts A/B).
    loadViewState(nextConv.id);
    setPendingChanges([]);
    setAttachments([]);
    // Show the start screen (logo + quick actions) with the composer under it,
    // exactly as when Latex launches — the first message, a quick action or a
    // sidebar pick opens the conversation from there. The new conversation is
    // already selected, so anything typed goes into it.
    setView("home");
    setExplorerOpen(false);
    // Focus the composer for the new chat once the view has rendered.
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      textarea?.focus();
    });
  }

  function selectConversation(next: Conversation) {
    setConversation(next);
    // Keep both mode refs coherent with the selection.
    if (appMode === "main") mainConversationRef.current = next;
    else chatConversationRef.current = next;
    if (next.mode && next.mode !== appMode) {
      if (next.mode === "main") mainConversationRef.current = next;
      else chatConversationRef.current = next;
      setAppMode(next.mode);
    }
    // Chat switch = UI visibility only (Part B): restore this chat's run
    // state; the previously visible chat's task keeps running in background.
    // Drafts are derived per chat — nothing is cleared here (Part A).
    loadViewState(next.id);
    setPendingChanges([]);
    setView("chat");
  }

  async function deleteConversation(id: string) {
    await window.latex.conversation.delete(id);
    setConversations((items) => items.filter((item) => item.id !== id));
    if (conversation.id === id) {
      newChat();
    }
  }

  /**
   * Resume an interrupted task FROM ITS CHECKPOINT (Part I): restore the
   * partial response + activity into the conversation, restore the exact
   * provider/model, then continue — never restart from zero, and never
   * repeat file edits that already completed (they are on disk and listed
   * in the checkpoint).
   */
  async function continueRecoveredTask(task: AgentTaskRecord) {
    const conv = conversations.find((c) => c.id === task.chatId);
    if (!conv) {
      // Conversation is gone — nothing to resume; dismiss the checkpoint.
      void window.latex.tasks.dismiss(task.taskId).catch(() => undefined);
      setRecoverableTask(null);
      setNotice("The interrupted task's conversation no longer exists.");
      return;
    }
    let restored = conv;
    const partial = (task.assistantContent ?? "").trim();
    const lastMsg = conv.messages[conv.messages.length - 1];
    const alreadySaved = Boolean(
      lastMsg && lastMsg.role === "assistant" && partial && lastMsg.content.includes(partial.slice(0, 120))
    );
    if (partial && !alreadySaved) {
      // Materialize the checkpointed partial response + activity so the
      // restored conversation shows exactly where the task left off.
      const interruptedMsg: ChatMessage = {
        id: uid("msg"),
        role: "assistant",
        content: partial + "\n\n_(Task interrupted — continuing from checkpoint)_",
        createdAt: Date.now(),
        startedAt: task.startedAt,
        completedAt: Date.now(),
        model: task.model,
        provider: task.provider,
        meta: {
          activitySteps: task.activity ?? [],
          activityComplete: true,
          activityKind: task.mode === "chat" ? "chat" : "agent",
          interrupted: true
        }
      };
      restored = { ...conv, messages: [...conv.messages, interruptedMsg], updatedAt: Date.now() };
      setConversations((items) => [restored, ...items.filter((item) => item.id !== restored.id)]);
      void window.latex.conversation.save(restored).catch(() => undefined);
    }
    // Restore the exact provider/model the task started with (Parts V/W).
    if (task.model) {
      await saveSettings({
        selectedModel: task.model,
        ...(task.provider ? { provider: task.provider } : {})
      }).catch(() => undefined);
    }
    setRecoverableTask(null);
    void window.latex.tasks.dismiss(task.taskId).catch(() => undefined);
    // Navigate to the task's chat/tab, then continue from the checkpoint.
    if (task.mode === "main") mainConversationRef.current = restored;
    else chatConversationRef.current = restored;
    setConversation(restored);
    setAppMode(task.mode);
    loadViewState(restored.id);
    setView("chat");
    const wsForTask = workspace?.id === task.workspaceId
      ? workspace
      : workspaces.find((w) => w.id === task.workspaceId);
    // Checkpoint brief (facts only, straight from the persisted record) so the
    // model CONTINUES from the last completed step instead of restarting.
    const doneFiles = (task.filesChanged ?? []).filter((f) => f.status === "completed").map((f) => f.path);
    const partialFiles = (task.filesChanged ?? []).filter((f) => f.status === "started").map((f) => f.path);
    const doneTools = Array.from(new Set((task.toolCalls ?? []).filter((c) => c.status === "completed").map((c) => c.tool)));
    const pendingTools = Array.from(new Set((task.toolCalls ?? []).filter((c) => c.status === "started").map((c) => c.tool)));
    const resumeNote = [
      `Original request: ${task.userPrompt ?? "(not recorded)"}`,
      `Mode: ${task.mode === "main" ? "Main workspace agent" : "Chat"}`,
      task.model ? `Model: ${task.model}` : "",
      `Last phase reached: ${task.phase ?? "unknown"}`,
      doneFiles.length ? `Already completed file operations: ${doneFiles.join(", ")}` : "",
      partialFiles.length ? `File operations that were interrupted: ${partialFiles.join(", ")}` : "",
      doneTools.length ? `Already completed tools: ${doneTools.join(", ")}` : "",
      pendingTools.length ? `Tools in flight when it stopped: ${pendingTools.join(", ")}` : "",
      task.error ? `What stopped it: ${task.error}` : "It was stopped by the user."
    ].filter(Boolean).join("\n");
    await runTurn(restored, task.mode === "main" ? "agent" : "chat", wsForTask, [], resumeNote);
  }

  async function completeRun(saved: Conversation) {
    const chatId = saved.id;
    const state = runStateFor(chatId);
    const isActive = chatId === activeChatIdRef.current;
    // Read CURRENT steps for THIS chat — not the stale render-time state
    // that previously leaked prompt 1's steps into prompt 2.
    const finalSteps = (isActive ? activityStepsRef.current : state.steps)
      .map((s) => s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s);
    state.activityComplete = true;
    state.busy = false;
    state.doneRun = true;
    state.stream = "";
    state.thinking = "";
    state.activityStatus = "";
    state.error = null;
    // The generated images now live on the SAVED assistant message meta; clear
    // the live mirror so only one copy renders.
    state.images = [];
    state.results = [];
    if (isActive) {
      setActivityComplete(true);
      setBusy(false);
      setThinkingText("");
      setActivityStatus("");
      setGeneratedImages([]);
      setGeneratedResults([]);
      setError(null);
    }
    // The agent persists activity steps in the message meta for every
    // assistant turn. Use the agent's version if present, otherwise fall
    // back to the live event-tracked steps.
    let target = saved;
    if (saved.messages.length > 0) {
      const lastMsg = saved.messages[saved.messages.length - 1];
      if (lastMsg.role === "assistant") {
        const existingSteps = lastMsg.meta?.activitySteps as AgentActivityStep[] | undefined;
        if (!existingSteps || existingSteps.length === 0) {
          if (finalSteps.length > 0) {
            // Fallback: persist from live event tracking
            const updatedMsg = { ...lastMsg, meta: { ...lastMsg.meta, activitySteps: finalSteps, activityComplete: true } };
            target = { ...saved, messages: [...saved.messages.slice(0, -1), updatedMsg], updatedAt: Date.now() };
            void window.latex.conversation.save(target).catch(() => undefined);
          }
        }
      }
    }
    // Success path: the saved message owns the activity row now. Clear the
    // live panel so only ONE collapsed activity row exists per response.
    state.steps = [];
    if (isActive) {
      streamTextRef.current = "";
      setStream("");
      setConversation(target);
      activityStepsRef.current = [];
      setActivitySteps([]);
      if (appMode === "main") mainConversationRef.current = target;
      else chatConversationRef.current = target;
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

  async function runTurn(next: Conversation, mode: RunMode, ws?: Workspace, atts: Attachment[] = [], resumeNote?: string) {
    lastRun.current = { conversation: next, workspace: mode === "agent" ? ws : undefined };
    const isImageTurn = mode === "image";
    // ── Fresh lifecycle for THIS response, stored PER CHAT (Parts B/AC) ──
    // The task belongs to next.id — not to whichever chat is visible — so
    // later navigation can never inherit or clobber this state.
    const runState = runStateFor(next.id);
    runState.stream = "";
    runState.thinking = "";
    runState.activityStatus = "";
    runState.images = [];
    runState.files = [];
    // Image generation is a plain request (no tools/workspace), so its activity
    // lifecycle behaves like Chat's, apart from the initial label.
    runState.activity = mode === "agent" ? ["Inspecting workspace"] : isImageTurn ? ["Generating image"] : [];
    runState.steps = [];
    runState.activityComplete = false;
    runState.busy = true;
    runState.error = null;
    runState.turnStartedAt = Date.now();
    runState.turnOutcome = null;
    runState.doneRun = false;
    // The task is starting NOW: the header reflects it before the first IPC
    // event arrives, and the main process confirms/corrects it immediately.
    runState.phase = "starting";
    runState.timings = { taskStartedAt: runState.turnStartedAt };
    activeChatIdRef.current = next.id;
    setBusy(true);
    setStream("");
    setError(null);
    setPendingChanges([]);
    setActivity(runState.activity);
    // ── Fresh activity lifecycle for EVERY response ────────────────────
    // Prompt 2+ must not inherit prompt 1's steps, timer, thinking or
    // outcome. All per-response state is re-initialized here.
    activityStepsRef.current = [];
    streamTextRef.current = "";
    doneRunRef.current = false;
    setActivitySteps([]);
    setActivityComplete(false);
    setThinkingText("");
    setActivityStatus("");
    setFileOperations([]);
    setTurnStartedAt(runState.turnStartedAt);
    setTurnOutcome(null);
    setPhase(runState.phase);
    setTimings(runState.timings);
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
    let runError: ErrorInfo | null = null;
    let runRawError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const saved =
          mode === "agent"
            ? await window.latex.agent.run(next, ws, atts, resumeNote)
            : mode === "image"
              ? await window.latex.agent.generateImage(next, ws, atts)
              : await window.latex.agent.chat(next, ws, atts, resumeNote);
        await completeRun(saved);
        break;
      } catch (err) {
        // CRITICAL: detect provider from the error itself, not settings.provider
        runRawError = err;
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
        // Capture in a LOCAL variable — the render-time `error` state in the
        // old code was always null here, so stop/error finalization no-oped.
        runError = info;
        break;
      }
    }
    // ── Finalize THIS chat's run state (registry first, view second) ────
    const runStateEnd = runStateFor(next.id);
    const runIsActive = next.id === activeChatIdRef.current;
    runStateEnd.busy = false;
    if (runIsActive) setBusy(false);
    // ── Finalize this response's activity lifecycle ────────────────────
    const raw = (runRawError && typeof runRawError === "object") ? runRawError as Record<string, unknown> : undefined;
    const wasStopped = Boolean(
      raw && (raw.errorType === "aborted" || (typeof raw.message === "string" && /abort|stop/i.test(raw.message)))
    );
    const markLiveStepsFailed = (detail: string): AgentActivityStep[] => {
      const updated = runStateEnd.steps.map((s) =>
        s.status === "active" ? { ...s, status: "failed" as const, detail, timestamp: Date.now() } : s
      );
      runStateEnd.steps = updated;
      if (runIsActive) {
        activityStepsRef.current = updated;
        setActivitySteps(updated);
      }
      return updated;
    };
    if (wasStopped) {
      // Stopped — settle the activity with a clear end state instead of
      // leaving "Thinking..." running forever.
      const stoppedSteps = markLiveStepsFailed("Stopped by user");
      runStateEnd.turnOutcome = "stopped";
      runStateEnd.activityComplete = true;
      if (runIsActive) {
        setTurnOutcome("stopped");
        setActivityComplete(true);
      }
      // Preserve partial output only if the agent didn't already deliver a
      // saved conversation via its own done event.
      const partialSource = (runIsActive ? streamTextRef.current : runStateEnd.stream).trim();
      if (!runStateEnd.doneRun && (stoppedSteps.length > 0 || partialSource)) {
        const partialContent = partialSource
          ? partialSource + "\n\n_(Generation stopped by user)_"
          : "_(Generation stopped by user)_";
        const partialMsg: ChatMessage = {
          id: uid("msg"),
          role: "assistant",
          content: partialContent,
          createdAt: Date.now(),
          model: settings.selectedModel,
          provider: settings.provider ?? "gemini",
          meta: { activitySteps: stoppedSteps, activityComplete: true, stopped: true, activityKind: mode === "agent" ? "agent" : "chat" }
        };
        const updated = { ...next, messages: [...next.messages, partialMsg], updatedAt: Date.now() };
        setConversations((items) => [updated, ...items.filter((item) => item.id !== updated.id)]);
        void window.latex.conversation.save(updated).catch(() => undefined);
        if (runIsActive) setConversation(updated);
        // The partial now lives in the conversation — don't also show it as stream.
        runStateEnd.stream = "";
        if (runIsActive) streamTextRef.current = "";
      }
      runStateEnd.error = null;
      if (runIsActive) setError(null);
    } else if (runError) {
      // Error — show the activity that happened, then settle it so the UI
      // never hangs on "Thinking...". Future prompts start fresh anyway.
      markLiveStepsFailed(runError.message);
      runStateEnd.turnOutcome = "error";
      runStateEnd.activityComplete = true;
      runStateEnd.error = runError;
      if (runIsActive) {
        setTurnOutcome("error");
        setActivityComplete(true);
        setError(runError);
      }
    }
    // Clear THIS run's live stream/activity mirrors. Only touch the view when
    // this chat is still the visible one — a background run finishing must
    // not wipe the visible chat's state (Parts B/AB).
    if (runIsActive) {
      if (!runError) setStream("");
      setApproval(null);
      approvalTaskIdRef.current = null;
      setActivity([]);
    }
    runStateEnd.activity = [];
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
    // ── Natural-language resume of an interrupted task (§9) ───────────────
    // "Continue", "keep going", "finish the task", "continue from where you
    // stopped" resume the interrupted task for THIS chat from its saved
    // checkpoint instead of starting the work over. When the interrupted task
    // belongs to another chat we never guess — the recovery banner's Continue
    // button remains the explicit choice.
    if (!busy && recoverableTask && isContinueRequest(content) && recoverableTask.chatId === conversation.id) {
      setComposer("");
      setNotice("Resuming the interrupted task from its checkpoint…");
      await continueRecoveredTask(recoverableTask);
      return;
    }
    if (busy) return;
    const activeProvider = settings.provider ?? "gemini";
    const isPuter = (settings.selectedModel?.startsWith("puter/") ?? false) || activeProvider === "puter";
    const isOllama = (settings.selectedModel?.startsWith("ollama/") ?? false) || activeProvider === "ollama";
    const omniRouteActive = (settings.selectedModel?.startsWith("omniroute/") ?? false) || activeProvider === "omniroute";
    const omniRouteUsable = omniRouteActive && isOmniRouteStatusReady(omniRouteStatus);
    if (!settings.hasApiKey && !isPuter && !isOllama && !omniRouteUsable) {
      // Never claim "connect your API key" when the gateway is simply offline,
      // running-but-unauthenticated, or holding a key that was rejected.
      setError({
        message: (omniRouteActive ? omniRouteBlockMessage(omniRouteStatus) : null)
          ?? `Connect your ${PROVIDER_LABELS[activeProvider]} API key in Settings to start chatting.`,
        detail: "",
        action: "settings",
        actionLabel: omniRouteActive ? "Open OmniRoute Settings" : "Open Settings"
      });
      setView("chat");
      return;
    }
    // Ollama guard: if the selected model is an Ollama model but the local
    // server is unreachable, surface a friendly, actionable error immediately.
    if (isOllama && !isPuter && ollamaStatus && ollamaStatus.state !== "connected") {
      setError({
        message: "Ollama is not running.",
        detail: ollamaStatus.error ?? "",
        action: "retry",
        actionLabel: "Start Ollama"
      });
      setView("chat");
      return;
    }

    // Vision is checked ONLY when an image is actually attached to THIS prompt.
    // A text-only turn never requires vision support, so a normal chat works on
    // a text-only model even in a conversation that once contained an image.
    // Local Ollama models report vision reliably, so an image turn on a
    // non-vision Ollama model is blocked with a clear message instead of a raw
    // server error. Other providers keep their existing behaviour — their
    // adapter reports the real reason only for a genuine image request.
    const hasImageAttachment = attachments.some((a) => a.kind === "image");
    if (hasImageAttachment) {
      const selectedModelObj = models.find((m) => m.name === settings.selectedModel);
      if (isOllama && selectedModelObj && selectedModelObj.supportsVision !== true) {
        setError({
          message: "This Ollama model does not support image input.",
          detail: "Choose a vision-capable Ollama model or remove the image, then send again.",
          action: "settings",
          actionLabel: "Open Settings"
        });
        setView("chat");
        return;
      }
      if (selectedModelObj && selectedModelObj.supportsVision === false) {
        setNotice("This model may not support image/vision input. The image was attached but the model might ignore it.");
      }
    }

    // CHAT MODE: no filesystem tools — plain conversation only.
    if (appMode === "chat") {
      // Keep the VISIBLE message compact — only the user's text. File content
      // and images persist as attachment metadata (meta.attachments); the main
      // process replays them into the provider request, so the model still
      // reads the file while the chat renders a small attachment card instead
      // of the entire file.
      const userMessage: ChatMessage = {
        id: uid("msg"),
        role: "user",
        content,
        createdAt: Date.now(),
        meta: buildAttachmentMeta(attachments)
      };
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

    // Same compact-message rule as Chat mode: content is only the user's
    // text; attachments persist via meta and are replayed by the main process.
    const userMessage: ChatMessage = {
      id: uid("msg"),
      role: "user",
      content,
      createdAt: Date.now(),
      meta: buildAttachmentMeta(attachments)
    };
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

  async function sendImageGeneration(text?: string) {
    const content = (text ?? composer).trim();
    if (!content) return;
    if (busy) return;
    const activeProvider = settings.provider ?? "gemini";
    const isPuter = (settings.selectedModel?.startsWith("puter/") ?? false) || activeProvider === "puter";
    const isOllama = (settings.selectedModel?.startsWith("ollama/") ?? false) || activeProvider === "ollama";
    const omniRouteActive = (settings.selectedModel?.startsWith("omniroute/") ?? false) || activeProvider === "omniroute";
    const omniRouteUsable = omniRouteActive && isOmniRouteStatusReady(omniRouteStatus);
    if (!settings.hasApiKey && !isPuter && !isOllama && !omniRouteUsable) {
      setError({
        message: (omniRouteActive ? omniRouteBlockMessage(omniRouteStatus) : null)
          ?? `Connect your ${PROVIDER_LABELS[activeProvider]} API key in Settings to start chatting.`,
        detail: "",
        action: "settings",
        actionLabel: omniRouteActive ? "Open OmniRoute Settings" : "Open Settings"
      });
      setView("chat");
      return;
    }
    const userMessage: ChatMessage = {
      id: uid("msg"),
      role: "user",
      content,
      createdAt: Date.now(),
      meta: buildAttachmentMeta(attachments)
    };
    const next: Conversation = {
      ...conversation,
      mode: appMode,
      workspaceId: workspace?.id,
      title: conversation.title === "New chat" ? content.slice(0, 48) : conversation.title,
      messages: [...conversation.messages, userMessage],
      updatedAt: Date.now()
    };
    setComposer("");
    // Runs through the SAME turn lifecycle as Chat/Main, so busy state, the
    // activity panel, Stop, the generated image and error recovery all behave
    // identically — only the main-process request differs (image output).
    await runTurn(next, "image", workspace, attachments);
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
    } else if (action === "retry") {
      // If the error was about Ollama not running, start the server first
      const isOllamaError = settings.selectedModel?.startsWith("ollama/") || settings.provider === "ollama";
      if (isOllamaError && ollamaStatus && ollamaStatus.state !== "connected") {
        void openOllama().then(() => {
          if (lastRun.current) {
            const useAgentMode = appMode === "main";
            void runTurn(lastRun.current.conversation, useAgentMode ? "agent" : "chat", lastRun.current.workspace);
          }
        });
      } else if (lastRun.current) {
        const useAgentMode = appMode === "main";
        void runTurn(lastRun.current.conversation, useAgentMode ? "agent" : "chat", lastRun.current.workspace);
      }
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
      onTestProvider={(provider) => void testProviderConnection(provider)}      onPuterSignIn={puterSignIn}
      onPuterSignOut={puterSignOut}
      onPuterRefresh={puterRefresh}
      puterConnected={puterConnected}
      puterUsername={puterUsername}
      puterLoading={puterLoading}
      ollamaStatus={ollamaStatus}
      ollamaLoading={ollamaLoading}
      onOpenOllama={() => void openOllama()}
      onRefreshOllama={() => void refreshOllama()}
      onOmniRouteStart={() => startOmniRoute()}
      onOmniRouteStop={() => stopOmniRoute()}
      onOmniRouteRefresh={() => refreshOmniRoute()}
      omniRouteStarting={omniRouteStarting}
      omniRouteElapsed={omniRouteElapsed}
      omniRouteStatus={omniRouteStatus}

    />
  );

  const chatView = (
    <ChatView
      messages={activeMessages}
      busy={busy}
      phase={phase}
      timings={timings}
      /* NEVER the preference. This channel carries ONLY reasoning the provider
         actually streamed; hiding it because a capability/preference check said
         "off" while the saved message still shows the reasoning afterwards is
         exactly the inconsistency that made Thinking appear only at the end.
         A provider that has no off switch (Ollama sets no `think` flag) keeps
         streaming, so the live box must follow what really arrived. */
      thinkingText={thinkingText}
      activityStatus={activityStatus}
      thinkingAvailable={thinkingAvailable}
      thinkingExposesReasoning={thinkingSupported}
      fileOperations={fileOperations}
      activity={activity}
      activitySteps={activitySteps}
      activityComplete={activityComplete}
      turnStartedAt={turnStartedAt}
      turnOutcome={turnOutcome}
      appMode={appMode}
      approval={approval}
      onApproveApproval={() => void resolveApproval(true)}
      onRejectApproval={() => void resolveApproval(false)}
      pendingChanges={pendingChanges}
      error={error}
      modelLabel={modelLabel}
      onOpenDiff={() => { setReviewChanges(null); setDiffOpen(true); }}
      onOpenPersistedReview={(changes) => { setReviewChanges(changes); setDiffOpen(true); }}
      onErrorAction={handleErrorAction}
      onOpenInExplorer={(relativePath) => {
        if (!workspace) return;
        void window.latex.shell.showInFolder(workspace.path + (relativePath ? `\\${relativePath.replace(/\//g, "\\")}` : ""));
      }}
      onRegenerate={(id) => void regenerate(id)}
      onEditMessage={editMessage}
      selectedChatId={selectedChatId}
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
          terminalOpen={terminalOpen}
          onToggleTerminal={() => { setTerminalEverOpened(true); setTerminalOpen((open) => !open); }}
        />

        <div className="content">          {!providerReady && (
            <div className="setupBanner">
              <KeyRound size={15} />
              <span>{setupNotice}</span>
              {isOmniRouteModel && !(omniRouteStatus?.running ?? false) && omniRouteStatus?.state !== "starting" && (
                <button className="btn sm" onClick={() => void startOmniRoute()} disabled={omniRouteStarting}>
                  {omniRouteStarting ? `Starting…${omniRouteElapsed > 0 ? ` ${omniRouteElapsed}s` : ""}` : "Start OmniRoute"}
                </button>
              )}
              <button className="btn sm primary" onClick={() => { setSettingsPage("ai"); setView("settings"); }}>
                <SettingsIcon size={13} /> Open Settings
              </button>
            </div>
          )}

          {/* Three states, never a blank centre:
              • settings          → the settings screen
              • nothing selected  → the start screen (logo + quick actions),
                                    the previous New Chat experience
              • anything else     → the conversation */}
          {view === "settings" ? settingsScreen
            : view === "home" && !hasChat ? (
                <HomeScreen onStartPrompt={(prompt) => void sendMessage(prompt)} />
              )
            : (
                chatView
              )}
        </div>

        {view !== "settings" && (
          <div className={`composerWrap${activeMessages.some((message) => message.role === "user") ? " withRail" : ""}`}>
            {recoverableTask && (
              <div className="noticeBanner recoveryBanner">
                <span>
                  <strong>Previous task interrupted</strong> — {(recoverableTask.userPrompt ?? "Untitled task").slice(0, 90)}
                  {" · "}{recoverableTask.provider ? PROVIDER_LABELS[recoverableTask.provider] : ""}
                  {recoverableTask.model ? ` · ${modelShortName(recoverableTask.model)}` : ""}
                  {" · "}Progress restored
                </span>
                <button className="btn sm primary" onClick={() => void continueRecoveredTask(recoverableTask)}>
                  Continue
                </button>
                <button
                  className="textButton"
                  onClick={() => {
                    void window.latex.tasks.dismiss(recoverableTask.taskId).catch(() => undefined);
                    setRecoverableTask(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}
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
              onGenerateImage={() => void sendImageGeneration()}
              busy={busy}
              appMode={appMode}
              approvalMode={settings.approvalMode}
              // The composer pill is ONE execution mode: choosing it has to
              // govern files AND commands together. Saving only approvalMode
              // is why "Autonomous" still stopped to ask before running a
              // command (the two settings stay independent when they are
              // changed separately on their own Settings pages).
              onSelectApprovalMode={(mode) =>
                void saveSettings({ approvalMode: mode, terminalApprovalMode: mode })
              }
              showApprovalMenu={showApprovalMenu}
              onToggleApprovalMenu={setShowApprovalMenu}
              // The toggle follows the EXPERIENCE, not the exposure: every
              // text-chat model (GPT, Claude, Gemini, Ollama…) can turn the
              // Thinking panel on or off. What the panel may DISPLAY is still
              // decided by provider-exposed reasoning.
              thinkingSupported={thinkingUiSupported}
              thinkingOn={thinkingUiOn}
              onToggleThinking={toggleThinking}
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
            onOpenTerminal={() => { setTerminalEverOpened(true); setTerminalOpen(true); setSearchOpen(false); }}
            onClose={() => setSearchOpen(false)}
          />
        )}

        {diffOpen && (
          <DiffViewer
            changes={reviewChanges ?? pendingChanges}
            /* A restored review records work that is already on disk: it shows
               the real final diff, but offers no Accept/Reject/Undo, because
               undoing it would rewrite a file whose content has moved on. */
            readOnly={reviewChanges !== null}
            onAccept={(change) => void acceptChange(change)}
            onReject={rejectChange}
            onUndo={(change) => void undoChange(change)}
            onAcceptAll={() => void acceptAllChanges()}
            onRejectAll={rejectAllChanges}
            onClose={() => { setDiffOpen(false); setReviewChanges(null); }}
          />
        )}

        {previewFile && (
          <FilePreview
            file={previewFile}
            workspace={workspace}
            onClose={() => setPreviewFile(null)}
          />
        )}

        {/* The panel is mounted once and then SHOWN/HIDDEN, never unmounted.
            Hiding it (minimize, a tab switch, a chat switch, an activity
            update) must not restart the shell: the PTY, the xterm instance and
            its scrollback all live in this component, so unmounting it is what
            used to kill the user's PowerShell. Only the explicit close action
            tears it down. */}
        {terminalEverOpened && (
          <Terminal
            cwd={workspace?.path}
            visible={terminalOpen}
            onClose={() => { setTerminalOpen(false); setTerminalEverOpened(false); }}
            onMinimize={() => setTerminalOpen(false)}
            onRestore={() => setTerminalOpen(true)}
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

        {/* What's New — shown once per new version, on the first launch after it
            is installed. Dismissed by clicking Got it (which persists
            lastSeenWhatsNewVersion in the main-process store). */}
        <WhatsNewModal
          releases={whatsNewReleases}
          open={whatsNewOpen}
          onClose={() => setWhatsNewOpen(false)}
          onSeeAll={() => {
            // Opening Settings is an explicit navigation, not a dismissal, so it
            // records the seen version too — the history is then on screen.
            setWhatsNewOpen(false);
            setSettingsPage("about");
            setView("settings");
          }}
        />
      </div>
    </div>
  );
}

/**
 * Persisted attachment metadata for a user message. Images keep their base64
 * (chat preview + vision replay); files keep their extracted content so the
 * MAIN PROCESS can replay it into provider requests. The visible message
 * `content` stays the user's plain text — ChatView renders these as compact
 * attachment cards and NEVER dumps `content` into the conversation.
 */
function buildAttachmentMeta(attachments: Attachment[]): Record<string, unknown> | undefined {
  const items: Attachment[] = [];
  for (const a of attachments) {
    if (a.kind === "image" && a.base64 && a.mimeType) {
      items.push({ id: a.id, name: a.name, kind: a.kind, base64: a.base64, mimeType: a.mimeType, size: a.size });
    } else if (
      (a.kind === "text" || a.kind === "workspace" || a.kind === "conversation") &&
      a.content
    ) {
      items.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        content: a.content,
        truncated: a.truncated,
        size: a.size,
        label: a.label
      });
    }
  }
  return items.length > 0 ? { attachments: items } : undefined;
}

/**
 * Repair a completion payload whose assistant message dropped text the user
 * already saw stream.
 *
 * The main process already refuses to replace a streamed answer, so this is the
 * last line of defence at the UI boundary: if a payload arrives late, partial
 * or empty and its final message does NOT carry the streamed answer, the streamed
 * text is folded back in. A payload that already contains everything is
 * returned untouched (identical object), so nothing is rewritten needlessly.
 */
function repairDroppedStreamedAnswer(conversation: Conversation, streamedThisRun: string): Conversation {
  const streamed = (streamedThisRun ?? "").trim();
  if (!streamed || conversation.messages.length === 0) return conversation;
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last || last.role !== "assistant" || last.meta?.streaming) return conversation;
  const body = (last.content ?? "").split("\n\n_(Generation stopped by user)_")[0];
  const streamedNorm = normalizeAnswerText(streamed);
  const bodyNorm = normalizeAnswerText(body);
  // The message already carries (at least) the streamed answer — nothing to do.
  if (bodyNorm.includes(streamedNorm)) return conversation;
  const reconciled = reconcileFinalAnswer(streamed, body);
  if (!reconciled.content || reconciled.content === body) return conversation;
  const repaired: ChatMessage = { ...last, content: reconciled.content };
  return { ...conversation, messages: [...conversation.messages.slice(0, -1), repaired], updatedAt: Date.now() };
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

// ── Persistent composer drafts (Part A) ────────────────────────────────
const DRAFTS_STORAGE_KEY = "latex.composerDrafts.v1";

/** One composer draft, associated with chat + tab, durable across restarts. */
interface ComposerDraft {
  chatId: string;
  sessionId?: string;
  tab: "main" | "chat";
  draft: string;
  updatedAt: number;
}

function loadComposerDrafts(): Record<string, ComposerDraft> {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ComposerDraft>) : {};
  } catch {
    return {};
  }
}

// ── Per-conversation run state (Parts B/C/AB/AC) ───────────────────────
/** Everything the UI shows for ONE chat's current/last response. */
interface ConvRunState {
  stream: string;
  thinking: string;
  /** Latest high-level ACTIVITY status line for this chat (Main mode). */
  activityStatus: string;
  /** Images REALLY generated during this response (live mirror; persisted on the message). */
  images: GeneratedImage[];
  /** Generated results (images, graphs, charts, artifacts) for this turn. */
  results: GeneratedResult[];
  /** Live, aggregated per-file previews of real Main Agent file operations. */
  files: FileOperationPreview[];
  activity: string[];
  steps: AgentActivityStep[];
  activityComplete: boolean;
  busy: boolean;
  error: ErrorInfo | null;
  turnStartedAt: number | null;
  turnOutcome: "stopped" | "error" | null;
  doneRun: boolean;
  /** Real request phase reported by the main process (never guessed). */
  phase: AgentTaskPhase | null;
  /** Task timing milestones; the header derives its labels from these. */
  timings: AgentTaskTimings | null;
}

function createEmptyRunState(): ConvRunState {
  return {
    stream: "",
    thinking: "",
    activityStatus: "",
    images: [],
    results: [],
    files: [],
    activity: [],
    steps: [],
    activityComplete: false,
    busy: false,
    error: null,
    turnStartedAt: null,
    turnOutcome: null,
    doneRun: false,
    phase: null,
    timings: null
  };
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

/**
 * A bare "keep going" style instruction — as opposed to a long new request that
 * merely mentions the word "continue". Deliberately narrow: a false negative
 * just sends a normal prompt, while a false positive would hijack a real ask.
 */
const CONTINUE_REQUEST = /^(?:please\s+|ok(?:ay)?\s+)*(?:continue|resume|keep\s+going|carry\s+on|go\s+on|proceed|finish\s+(?:it|that|the\s+task)|pick\s+up\s+where\s+you\s+left\s+off)\b/i;
function isContinueRequest(text: string): boolean {
  const t = text.trim().replace(/[.!?\s]+$/, "");
  if (t.length > 120) return false;
  return CONTINUE_REQUEST.test(t) || /^(?:continue|resume)\b.*\b(?:where|stopped|left\s+off|failed|interrupted)\b/i.test(t);
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
