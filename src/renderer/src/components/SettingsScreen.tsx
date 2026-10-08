import { Bell, Check, Cloud, ExternalLink, FolderOpen, KeyRound, Link, Mic, Monitor, Moon, Plug, RefreshCw, Shield, Sun, Trash2, Unlink, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import logo from "../assets/latex-logo.png";
import type { ApprovalMode, FilesystemAccess, GeminiModel, LatexSettings, ModelProvider, OmniRouteStatus, PcControlMode, ProviderStatus, ThemePreference, Workspace } from "../../../shared/types";
import type { OllamaStatus } from "../../../shared/types";
import { modelShortName } from "../lib/errors";
import { modelCapability } from "../lib/format";
import { providerOfModel } from "../lib/modelRouter";
import { Spinner } from "./ui";
import type { ModelsState } from "./Composer";
import {
  LATEX_RELEASES,
  LATEX_WEBSITE_URL,
  compareVersions,
  formatReleaseDate,
  formatUpdateBytes,
  type ReleaseEntry,
  type UpdateStatus
} from "../../../shared/updates";

export type SettingsPage = "appearance" | "ai" | "voice" | "workspace" | "terminal" | "permissions" | "notifications" | "usage" | "memory" | "about";

export interface ConnectionState {
  state: "idle" | "testing" | "ok" | "fail";
  message: string;
  /**
   * SERVER status, when it is known independently of authentication. For
   * OmniRoute a live gateway that still needs (or rejected) a key reports
   * `state: "fail"` but `running: true` — it must be shown as Running, not
   * Offline, with the credential problem spelled out.
   */
  running?: boolean;
}

interface SettingsScreenProps {
  settings: LatexSettings & { hasApiKey?: boolean; providers?: ProviderStatus[] };
  page: SettingsPage;
  setPage: (page: SettingsPage) => void;
  apiKeyDraft: string;
  setApiKeyDraft: (value: string) => void;
  onSaveApiKey: () => void;
  onClearApiKey: () => void;
  connections: Record<ModelProvider, ConnectionState>;
  onTestConnection: (provider: ModelProvider) => void;
  models: GeminiModel[];
  modelsState: ModelsState;
  modelsError: string;
  onFetchModels: () => void;
  onSelectModel: (name: string) => void;
  onSelectAutoModel: () => void;
  workspace?: Workspace;
  onOpenFolder: () => void;
  onSaveSettings: (partial: Partial<LatexSettings>) => void;
  providerKeyDrafts: Record<string, string>;
  setProviderKeyDraft: (provider: ModelProvider, value: string) => void;
  onSaveProviderKey: (provider: ModelProvider) => void;
  onClearProviderKey: (provider: ModelProvider) => void;
  onTestProvider: (provider: ModelProvider) => void;
  onPuterSignIn?: () => Promise<void>;
  onPuterSignOut?: () => Promise<void>;
  onPuterRefresh?: () => Promise<void>;
  puterConnected?: boolean;
  puterUsername?: string;
  puterLoading?: boolean;
  // Ollama props
  ollamaStatus?: OllamaStatus | null;
  ollamaLoading?: boolean;
  onOpenOllama?: () => void;
  onRefreshOllama?: () => void;
  // OmniRoute props
  onOmniRouteStart?: () => Promise<void>;
  onOmniRouteStop?: () => Promise<void>;
  onOmniRouteRefresh?: () => Promise<void>;
  omniRouteStarting?: boolean;
  omniRouteElapsed?: number;
  /** Raw OmniRoute server + auth status (state/needsKey/authenticated/hasKey). */
  omniRouteStatus?: OmniRouteStatus | null;
}

const navItems: Array<{ id: SettingsPage; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
  { id: "workspace", label: "Workspace" },
  { id: "terminal", label: "Terminal" },
  { id: "permissions", label: "Permissions" },
  { id: "notifications", label: "Notifications" },
  { id: "usage", label: "Usage" },
  { id: "memory", label: "Chat Memory" },
  { id: "about", label: "About" }
];

export function SettingsScreen(props: SettingsScreenProps) {
  const { page, setPage } = props;
  return (
    <div className="settings">
      <aside className="settingsNav">
        <div className="settingsNavTitle">Settings</div>
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`settingsNavItem ${page === item.id ? "active" : ""}`}
            onClick={() => setPage(item.id)}
          >
            {item.label}
          </button>
        ))}
      </aside>
      <div className="settingsContent">
        {page === "appearance" && <AppearancePage {...props} />}
        {page === "ai" && <AIPage {...props} />}
        {page === "voice" && <VoicePage {...props} />}
        {page === "workspace" && <WorkspacePage {...props} />}
        {page === "terminal" && <TerminalPage {...props} />}
        {page === "permissions" && <PermissionsPage {...props} />}
        {page === "notifications" && <NotificationsPage {...props} />}
        {page === "usage" && <UsagePage />}
        {page === "memory" && <MemoryPage />}
        {page === "about" && <AboutPage />}
      </div>
    </div>
  );
}

function AppearancePage({ settings, onSaveSettings }: SettingsScreenProps) {
  return (
    <div className="settingsPage">
      <h2>Appearance</h2>
      <p className="settingsSubtitle">Theme and generation defaults.</p>
      <div className="settingsGroup">
        <Field label="Theme">
          <div className="themeOptions">
            {(
              [
                { value: "dark", label: "Dark", icon: <Moon size={15} /> },
                { value: "light", label: "Light", icon: <Sun size={15} /> },
                { value: "system", label: "System", icon: <Monitor size={15} /> }
              ] as Array<{ value: ThemePreference; label: string; icon: React.ReactNode }>
            ).map((option) => (
              <button
                key={option.value}
                className={`themeOption ${settings.theme === option.value ? "selected" : ""}`}
                onClick={() => onSaveSettings({ theme: option.value })}
              >
                {option.icon}
                <span>{option.label}</span>
                {settings.theme === option.value && <Check size={14} className="themeOptionCheck" />}
              </button>
            ))}
          </div>
        </Field>
        <Field label={`Temperature (${settings.temperature})`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={settings.temperature}
            onChange={(event) => onSaveSettings({ temperature: Number(event.target.value) })}
          />
        </Field>
        <Field label="Max output tokens">
          <input
            type="number"
            min={256}
            step={256}
            value={settings.maxOutputTokens}
            onChange={(event) => onSaveSettings({ maxOutputTokens: Number(event.target.value) })}
          />
        </Field>
      </div>
    </div>
  );
}

const PROVIDER_ORDER: ModelProvider[] = ["gemini", "openrouter", "minimax", "groq", "puter", "ollama", "omniroute"];

const PROVIDER_KEYS: Record<ModelProvider, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  groq: "Groq",
  puter: "Puter (Free)",
  ollama: "Ollama (Local)",
  omniroute: "OmniRoute"
};

const PROVIDER_HINTS: Record<ModelProvider, string> = {
  gemini: "aistudio.google.com/apikey",
  openrouter: "openrouter.ai/keys",
  minimax: "platform.minimaxi.com",
  groq: "console.groq.com/keys",
  puter: "Sign in with your Puter account (Google)",
  ollama: "Runs on your PC — no API key needed",
  omniroute: "Local OmniRoute gateway"
};

const PROVIDER_API_URLS: Record<ModelProvider, string> = {
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  minimax: "https://platform.minimaxi.com",
  groq: "https://console.groq.com/keys",
  puter: "https://puter.com",
  ollama: "https://ollama.com",
  omniroute: "https://github.com/nicepkg/omniroute"
};

function AIPage({
  settings,
  connections,
  onTestConnection,
  models,
  modelsState,
  modelsError,
  onFetchModels,
  onSelectModel,
  onSelectAutoModel,
  onSaveSettings,
  providerKeyDrafts,
  setProviderKeyDraft,
  onSaveProviderKey,
  onClearProviderKey,
  onTestProvider,
  onPuterSignIn,
  onPuterSignOut,
  onPuterRefresh,
  puterConnected,
  puterUsername,
  puterLoading,
  ollamaStatus,
  ollamaLoading,
  onOpenOllama,
  onRefreshOllama,
  onOmniRouteStart,
  onOmniRouteStop,
  onOmniRouteRefresh,
  omniRouteStarting,
  omniRouteElapsed = 0,
  omniRouteStatus
}: SettingsScreenProps) {
  const [expandedProvider, setExpandedProvider] = useState<ModelProvider | null>(null);
  const providerStatus = (provider: ModelProvider): ProviderStatus | undefined =>
    settings.providers?.find((status) => status.provider === provider);

  // Helper: get models for a specific provider
  const modelsForProvider = (provider: ModelProvider) =>
    models.filter((m) => (m.provider ?? providerOfModel(m.name)) === provider);

  // Helper: render the model list for a provider
  const renderModelList = (provider: ModelProvider) => {
    const providerModels = modelsForProvider(provider);
    if (providerModels.length === 0) return <div className="fieldHint">No models available for this provider.</div>;
    return (
      <div className="modelList" style={{ marginTop: 8 }}>
        {providerModels.map((model) => {
          const selected = model.name === settings.selectedModel && !settings.autoSelectModel;
          const capability = modelCapability(model);
          return (
            <button
              key={model.name}
              className={`modelListItem ${selected ? "selected" : ""}`}
              onClick={() => onSelectModel(model.name)}
            >
              <span className="modelListCheck">{selected ? <Check size={14} /> : <span className="menuCheckSpacer" />}</span>
              <span className="modelListText">
                <span className="modelListName">
                  {model.displayName ?? modelShortName(model.name)}
                  {model.isFree && <span className="modelFreeTag">free</span>}
                </span>
                <span className="modelListId">{modelShortName(model.name)}</span>
              </span>
              {model.supportsTools && <span className="modelTag toolTag">tools</span>}
              {model.supportsVision && <span className="modelTag">vision</span>}
              {capability && <span className="modelTag">{capability}</span>}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="settingsPage">
      <h2>AI</h2>
      <p className="settingsSubtitle">Multiple providers power Latex. Each API key stays on this device.</p>

      <div className="settingsGroup">
        <Field label="Active Provider">
          <div className="fieldRow">
            <select
              value={settings.provider ?? "gemini"}
              onChange={(event) => onSaveSettings({ provider: event.target.value as ModelProvider })}
            >
              {PROVIDER_ORDER.map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDER_KEYS[provider]}
                </option>
              ))}
            </select>
            <span className="fieldHint">The active provider is used for the composer model picker and Auto selection.</span>
          </div>
        </Field>

        {PROVIDER_ORDER.map((provider) => {
          const status = providerStatus(provider);
          const configured = Boolean(status?.configured);

          // Ollama has special UI (local server, no API key)
          if (provider === "ollama") {
            const ollamaState = ollamaStatus?.state ?? "unknown";
            const ollamaConnected = ollamaState === "connected";
            const localCount = ollamaStatus?.localModelCount ?? 0;
            const cloudCount = ollamaStatus?.cloudModelCount ?? 0;
            return (
              <div key="ollama" className="providerCard">
                <div className="providerRow">
                  <span className="providerName">{PROVIDER_KEYS.ollama}</span>
                  {ollamaLoading ? (
                    <span className="providerBadge"><Spinner size={12} /> Checking…</span>
                  ) : ollamaConnected ? (
                    <span className="providerBadge ok"><span className="ollamaDot" /> Connected{ollamaStatus?.version ? ` · v${ollamaStatus.version}` : ""}</span>
                  ) : (
                    <span className="providerBadge">{ollamaState === "not_installed" ? "Not installed" : "Not running"}</span>
                  )}
                </div>
                <div className="fieldHint" style={{ marginBottom: 8 }}>
                  {ollamaConnected
                    ? `Local endpoint: localhost:11434 · ${localCount} local model${localCount === 1 ? "" : "s"}${ollamaStatus?.cloudAvailable ? ` · ${cloudCount} cloud model${cloudCount === 1 ? "" : "s"}` : " · Ollama Cloud not signed in"}`
                    : ollamaStatus?.error ?? "Ollama runs on your PC. Open the Ollama app to use local models."}
                </div>
                <div className="providerActions">
                  {!ollamaConnected && (
                    <button className="btn" onClick={onOpenOllama}>
                      <Link size={14} /> Start Ollama
                    </button>
                  )}
                  <button
                    className="btn sm"
                    onClick={onRefreshOllama}
                    disabled={connections.ollama?.state === "testing"}
                  >
                    {connections.ollama?.state === "testing" ? <><Spinner size={12} /> Checking…</> : <><RefreshCw size={13} /> Refresh Models</>}
                  </button>
                  {ollamaConnected && localCount === 0 && (
                    <span className="fieldHint">No local models yet — pull one with <code>ollama pull &lt;model&gt;</code></span>
                  )}
                </div>
                {!ollamaConnected && (
                  <div className="fieldHint" style={{ marginTop: 6 }}>
                    Ollama Cloud models require signing in to your Ollama account inside the Ollama app. Latex never asks for your Ollama password.
                  </div>
                )}
                {connections.ollama?.state === "ok" && (
                  <div className="fieldHint success">✓ {connections.ollama.message}</div>
                )}
                {connections.ollama?.state === "fail" && (
                  <div className="fieldHint fail">✕ {connections.ollama.message}</div>
                )}
                <button
                  className="textButton"
                  style={{ marginTop: 8, fontSize: 13 }}
                  onClick={() => setExpandedProvider(expandedProvider === "ollama" ? null : "ollama")}
                >
                  {expandedProvider === "ollama" ? "▾ Hide models" : `▸ Show models (${modelsForProvider("ollama").length})`}
                </button>
                {expandedProvider === "ollama" && renderModelList("ollama")}
              </div>
            );
          }

          // Puter has special auth UI (no API key input)
          if (provider === "puter") {
            return (
              <div key="puter" className="providerCard">
                <div className="providerRow">
                  <span className="providerName">{PROVIDER_KEYS.puter}</span>
                  {puterLoading ? (
                    <span className="providerBadge"><Spinner size={12} /> Checking session…</span>
                  ) : puterConnected ? (
                    <span className="providerBadge ok"><Cloud size={13} /> {puterUsername ? `Signed in as ${puterUsername}` : "Connected"}</span>
                  ) : (
                    <span className="providerBadge">Not connected</span>
                  )}
                </div>
                <div className="fieldHint" style={{ marginBottom: 8 }}>
                  Cloud AI — no developer API key required. Sign in with your Puter account via Google.
                </div>
                <div className="providerActions">
                  {puterConnected ? (
                    <>
                      <button
                        className="btn sm"
                        onClick={() => onPuterRefresh?.()}
                        disabled={connections.puter?.state === "testing"}
                      >
                        {connections.puter?.state === "testing" ? <><Spinner size={12} /> Refreshing…</> : <><RefreshCw size={13} /> Refresh Session</>}
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => onTestProvider("puter")}
                        disabled={connections.puter?.state === "testing"}
                      >
                        {connections.puter?.state === "testing" ? <><Spinner size={12} /> Testing...</> : <><Plug size={13} /> Test</>}
                      </button>
                      <button className="btn sm danger" onClick={() => onPuterSignOut?.()}><Unlink size={13} /> Sign out</button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => onPuterSignIn?.()}><Link size={14} /> Sign in with Google</button>
                  )}
                </div>
                {connections.puter?.state === "ok" && (
                  <div className="fieldHint success">✓ {connections.puter.message}</div>
                )}
                {connections.puter?.state === "fail" && (
                  <div className="fieldHint fail">✕ {connections.puter.message}</div>
                )}
                <button
                  className="textButton"
                  style={{ marginTop: 8, fontSize: 13 }}
                  onClick={() => setExpandedProvider(expandedProvider === "puter" ? null : "puter")}
                >
                  {expandedProvider === "puter" ? "▾ Hide models" : `▸ Show models (${modelsForProvider("puter").length})`}
                </button>
                {expandedProvider === "puter" && renderModelList("puter")}
              </div>
            );
          }

          // OmniRoute has special UI: a local gateway that may or may not need
          // a key, so server status and authentication status are shown apart.
          if (provider === "omniroute") {
            const omnirouteState = connections.omniroute;
            const raw = omniRouteStatus ?? null;
            const isStarting = omnirouteState?.state === "testing" || raw?.state === "starting";
            const isBooting = raw?.state === "starting";
            // SERVER status — never inferred from the auth result.
            const isRunning = raw ? raw.running : (omnirouteState?.running ?? omnirouteState?.state === "ok");
            // AUTHENTICATION status.
            const isAuthenticated = raw ? raw.authenticated : omnirouteState?.state === "ok";
            const needsKey = raw?.state === "online_api_key_required";
            const keyRejected = raw?.state === "auth_failed";
            const hasStoredKey = Boolean(raw?.hasKey);
            const baseUrl = raw?.baseUrl ?? "http://127.0.0.1:20128";
            return (
              <div key="omniroute" className="providerCard">
                <div className="providerRow">
                  <span className="providerName">{PROVIDER_KEYS.omniroute}</span>
                  {isBooting ? (
                    // The main process told us the gateway is booting — a server
                    // that is coming up is never "Not running".
                    <span className="providerBadge"><Spinner size={12} /> Starting…</span>
                  ) : isStarting ? (
                    // "Starting…" is reserved for the explicit Start action. A
                    // plain status probe must never imply that Latex launched
                    // something — it only reports what it finds.
                    <span className="providerBadge"><Spinner size={12} /> {omniRouteStarting ? "Starting…" : "Checking…"}{omniRouteStarting && omniRouteElapsed > 0 ? ` ${omniRouteElapsed}s` : ""}</span>
                  ) : !isRunning ? (
                    <span className="providerBadge">○ Not running</span>
                  ) : needsKey ? (
                    <span className="providerBadge">● Running — API key required</span>
                  ) : keyRejected ? (
                    <span className="providerBadge">● Running — saved key rejected</span>
                  ) : isAuthenticated ? (
                    <span className="providerBadge ok">● Running — connected</span>
                  ) : (
                    <span className="providerBadge">● Running</span>
                  )}
                </div>
                <div className="fieldHint" style={{ marginBottom: 8 }}>
                  {isBooting
                    ? `Starting OmniRoute at ${baseUrl}… Latex connects automatically as soon as /api/health answers.`
                    : isRunning
                      ? `Endpoint: ${baseUrl}/v1 · ${omnirouteState?.message ?? "Connected"}${raw?.healthEndpoint ? ` · health: ${raw.healthEndpoint}` : ""}`
                      : `Not reachable at ${baseUrl}. Start it below, or launch OmniRoute yourself — Latex detects an already-running instance and never starts a duplicate.`
                  }
                </div>

                {/* API key — the OmniRoute endpoint key, not an upstream provider key. */}
                <div className="fieldRow">
                  <input
                    type="password"
                    value={providerKeyDrafts.omniroute ?? ""}
                    onChange={(event) => setProviderKeyDraft("omniroute", event.target.value)}
                    placeholder={
                      hasStoredKey
                        ? "•••••••••••••••••••• (key stored)"
                        : needsKey || keyRejected
                          ? "Paste your OmniRoute endpoint API key"
                          : "OmniRoute API key (only if this instance requires one)"
                    }
                  />
                  <button className="btn" onClick={() => onSaveProviderKey("omniroute")}><KeyRound size={14} aria-hidden="true" /> Save</button>
                </div>
                <div className="fieldHint" style={{ marginBottom: 8 }}>
                  This is the key OmniRoute itself asks for at {baseUrl}/v1 — not your OpenAI, Gemini, OpenRouter or Ollama credential.
                </div>

                <div className="providerActions">
                  {!isRunning ? (
                    <button className="btn" onClick={() => onOmniRouteStart?.()} disabled={omniRouteStarting || isStarting}>
                      {isStarting ? (
                        <><Spinner size={14} /> Starting…{omniRouteElapsed > 0 ? ` ${omniRouteElapsed}s` : ""}</>
                      ) : (
                        <><Link size={14} aria-hidden="true" /> Start OmniRoute</>
                      )}
                    </button>
                  ) : (
                    <button className="btn sm danger" onClick={() => onOmniRouteStop?.()}>
                      Stop OmniRoute
                    </button>
                  )}
                  <button
                    className="btn sm"
                    onClick={() => onOmniRouteRefresh?.()}
                    disabled={isStarting}
                  >
                    <RefreshCw size={13} aria-hidden="true" /> Refresh Status
                  </button>
                  {hasStoredKey && (
                    <button className="btn sm danger" onClick={() => onClearProviderKey("omniroute")}><Trash2 size={13} aria-hidden="true" /> Clear key</button>
                  )}
                  <button
                    className="btn sm"
                    onClick={() => window.open(PROVIDER_API_URLS.omniroute, "_blank")}
                    title="Open the OmniRoute project page in your browser"
                  >
                    <ExternalLink size={13} aria-hidden="true" /> Open in Browser
                  </button>
                </div>
                {isRunning && isAuthenticated && (
                  <div className="fieldHint success">✓ {connections.omniroute.message}</div>
                )}
                {isRunning && !isAuthenticated && (
                  <div className="fieldHint fail">✕ {connections.omniroute.message}</div>
                )}
                {!isRunning && !isBooting && (
                  <div className="fieldHint fail">✕ {connections.omniroute?.message ?? "OmniRoute is not running."}</div>
                )}
                <button
                  className="textButton"
                  style={{ marginTop: 8, fontSize: 13 }}
                  onClick={() => setExpandedProvider(expandedProvider === "omniroute" ? null : "omniroute")}
                >
                  {expandedProvider === "omniroute" ? "▾ Hide models" : `▸ Show models (${modelsForProvider("omniroute").length})`}
                </button>
                {expandedProvider === "omniroute" && renderModelList("omniroute")}
              </div>
            );
          }

          return (
            <div key={provider} className="providerCard">
              <div className="providerRow">
                <span className="providerName">{PROVIDER_KEYS[provider]}</span>
                {configured ? (
                  <span className="providerBadge ok">✓ Connected</span>
                ) : (
                  <span className="providerBadge">Not configured</span>
                )}
              </div>
              <div className="fieldRow">
                <input
                  type="password"
                  value={providerKeyDrafts[provider] ?? ""}
                  onChange={(event) => setProviderKeyDraft(provider, event.target.value)}
                  placeholder={configured ? "•••••••••••••••••••• (key stored)" : `Paste your ${PROVIDER_KEYS[provider]} API key`}
                />
                <button className="btn" onClick={() => onSaveProviderKey(provider)}><KeyRound size={14} /> Save</button>
              </div>
              <div className="providerActions">
                <button
                  className="btn sm"
                  onClick={() => onTestProvider(provider)}
                  disabled={connections[provider]?.state === "testing"}
                >
                  {connections[provider]?.state === "testing" ? <><Spinner size={12} /> Testing...</> : <><Plug size={13} /> Test</>}
                </button>
                {configured && (
                  <button className="btn sm danger" onClick={() => onClearProviderKey(provider)}><Trash2 size={13} /> Clear</button>
                )}
                {PROVIDER_API_URLS[provider] && (
                  <button
                    className="btn sm"
                    onClick={() => window.open(PROVIDER_API_URLS[provider], "_blank")}
                    title={`Open ${PROVIDER_KEYS[provider]} API key page in browser`}
                  >
                    <ExternalLink size={13} /> Open in Browser
                  </button>
                )}
              </div>
              {connections[provider]?.state === "ok" && (
                <div className="fieldHint success">✓ {connections[provider]?.message}</div>
              )}
              {connections[provider]?.state === "fail" && (
                <div className="fieldHint fail">✕ {connections[provider]?.message}</div>
              )}
              <button
                className="textButton"
                style={{ marginTop: 8, fontSize: 13 }}
                onClick={() => setExpandedProvider(expandedProvider === provider ? null : provider)}
              >
                {expandedProvider === provider ? "▾ Hide models" : `▸ Show models (${modelsForProvider(provider).length})`}
              </button>
              {expandedProvider === provider && renderModelList(provider)}
            </div>
          );
        })}
      </div>

      <div className="settingsGroup">
        <Field label="Available Models">
          <div className="fieldRow">
            <button className="btn" onClick={onFetchModels} disabled={modelsState === "loading"}>
              {modelsState === "loading" ? <><Spinner size={13} /> Loading models...</> : <><RefreshCw size={14} /> Refresh All</>}
            </button>
            {modelsState === "ready" && (
              <span className="fieldHint">
                {models.length} model{models.length === 1 ? "" : "s"} across {PROVIDER_ORDER.filter((p) => models.some((m) => (m.provider ?? "gemini") === p)).length} provider{PROVIDER_ORDER.filter((p) => models.some((m) => (m.provider ?? "gemini") === p)).length === 1 ? "" : "s"}
              </span>
            )}
            {modelsState === "loading" && <span className="fieldHint">Loading models…</span>}
          </div>
          {modelsState === "ready" && models.length > 0 && (
            <div className="providerModelCounts">
              {PROVIDER_ORDER.map((provider) => {
                const count = models.filter((m) => (m.provider ?? "gemini") === provider).length;
                const configured = Boolean(settings.providers?.find((s) => s.provider === provider)?.configured);
                if (!configured) return null;
                return (
                  <span key={provider} className="providerModelCount">
                    <span className="providerModelCountLabel">{PROVIDER_KEYS[provider]}</span>
                    <span className="providerModelCountValue">{count} model{count === 1 ? "" : "s"}</span>
                  </span>
                );
              })}
            </div>
          )}
          {modelsState === "ready" && models.length > 0 && <span className="fieldHint">Last updated: {new Date().toLocaleTimeString()}</span>}
          {modelsState === "error" && (
            <div className="modelsError">
              <span>Unable to load models. Check your API keys or network connection.</span>
              <button className="textButton" onClick={onFetchModels}><RefreshCw size={13} /> Retry</button>
            </div>
          )}
          {modelsState === "ready" && models.length === 0 && (
            <div className="modelsError">No models were found. Add a provider API key above and refresh.</div>
          )}
          {modelsState === "ready" && models.length > 0 && (
            <div className="modelList">
              {models.map((model) => {
                const selected = model.name === settings.selectedModel && !settings.autoSelectModel;
                const capability = modelCapability(model);
                const provider = model.provider ?? providerOfModel(model.name);
                return (
                  <button
                    key={model.name}
                    className={`modelListItem ${selected ? "selected" : ""}`}
                    onClick={() => onSelectModel(model.name)}
                  >
                    <span className="modelListCheck">{selected ? <Check size={14} /> : <span className="menuCheckSpacer" />}</span>
                    <span className="modelListText">
                      <span className="modelListName">
                        {model.displayName ?? modelShortName(model.name)}
                        {model.isFree && <span className="modelFreeTag">free</span>}
                      </span>
                      <span className="modelListId">{PROVIDER_KEYS[provider] ?? provider} · {modelShortName(model.name)}</span>
                    </span>
                    {model.supportsTools && <span className="modelTag toolTag">tools</span>}
                    {model.supportsVision && <span className="modelTag">vision</span>}
                    {capability && <span className="modelTag">{capability}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </Field>

        <Field label="Selected Model">
          <div className="fieldRow">
            <span className="selectedModelValue">
              {settings.autoSelectModel
                ? "Auto (best model for each task)"
                : settings.selectedModel
                  ? modelShortName(settings.selectedModel)
                  : "No model selected"}
            </span>
          </div>
        </Field>

        <Field label="Auto Select Model">
          <div className="fieldRow">
            <Toggle
              checked={Boolean(settings.autoSelectModel)}
              onChange={(checked) => {
                if (checked) {
                  onSelectAutoModel();
                } else {
                  void onSaveSettings({ autoSelectModel: false });
                }
              }}
            />
            <span className="fieldHint">Latex picks the best available model per task and falls back to another provider when the quota is reached.</span>
          </div>
        </Field>
      </div>
    </div>
  );
}

function VoicePage({ settings, onSaveSettings }: SettingsScreenProps) {
  return (
    <div className="settingsPage">
      <h2>Voice</h2>
      <p className="settingsSubtitle">Speak to Latex and hear responses read aloud.</p>
      <div className="settingsGroup">
        <Field label="Voice Input">
          <div className="fieldRow">
            <Toggle
              checked={settings.voiceInput !== false}
              onChange={(checked) => onSaveSettings({ voiceInput: checked })}
            />
            <span className="fieldHint"><Mic size={13} /> Microphone button in the composer</span>
          </div>
        </Field>
        <Field label="Speak Responses">
          <div className="fieldRow">
            <Toggle
              checked={Boolean(settings.speakResponses)}
              onChange={(checked) => onSaveSettings({ speakResponses: checked })}
            />
            <span className="fieldHint"><Volume2 size={13} /> Latex reads replies aloud</span>
          </div>
        </Field>
        <Field label="Voice">
          <div className="fieldRow">
            <span className="selectedModelValue">Default (system voice)</span>
          </div>
        </Field>
        <Field label="Language">
          <select
            value={settings.voiceLang ?? "auto"}
            onChange={(event) => onSaveSettings({ voiceLang: event.target.value })}
          >
            <option value="auto">Auto</option>
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="es-ES">Spanish</option>
            <option value="fr-FR">French</option>
            <option value="de-DE">German</option>
            <option value="it-IT">Italian</option>
            <option value="pt-BR">Portuguese (BR)</option>
            <option value="ja-JP">Japanese</option>
            <option value="ko-KR">Korean</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function WorkspacePage({ workspace, onOpenFolder, settings, onSaveSettings }: SettingsScreenProps) {
  return (
    <div className="settingsPage">
      <h2>Workspace</h2>
      <p className="settingsSubtitle">Latex only works inside the folder you approve.</p>
      <div className="settingsGroup">
        <Field label="Current Workspace">
          <div className="fieldRow">
            <span className="workspacePath">{workspace?.path ?? "No workspace selected"}</span>
            <button className="btn" onClick={onOpenFolder}><FolderOpen size={14} /> Change Folder</button>
          </div>
        </Field>
        <Field label="File Change Approval">
          <RadioGroup
            name="ws-approval"
            value={settings.approvalMode}
            onChange={(value) => onSaveSettings({ approvalMode: value as ApprovalMode })}
            options={[
              { value: "always", label: "Ask Every Time", hint: "Ask before every file change and command." },
              { value: "destructive", label: "Workspace Only", hint: "Auto-apply safe changes; ask before deleting or destructive operations." },
              { value: "trusted", label: "Allow Workspace Changes", hint: "Apply file changes automatically inside the approved boundary." },
              { value: "autonomous", label: "Autonomous", hint: "Apply changes and run commands without asking." }
            ]}
          />
        </Field>
        {settings.filesystemAccess === "full" && (
          <div className="fieldHint success">Full PC Access is enabled — Latex can work with files anywhere your Windows account has permission.</div>
        )}
      </div>
    </div>
  );
}

function TerminalPage({ settings, onSaveSettings }: SettingsScreenProps) {
  return (
    <div className="settingsPage">
      <h2>Terminal</h2>
      <p className="settingsSubtitle">Commands run inside the approved workspace.</p>
      <div className="settingsGroup">
        <Field label="Shell">
          <select
            value={settings.shell ?? "powershell"}
            onChange={(event) => onSaveSettings({ shell: event.target.value as "powershell" | "cmd" })}
          >
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
          </select>
        </Field>
        <Field label="Command Approval">
          <RadioGroup
            name="term-approval"
            value={settings.terminalApprovalMode}
            onChange={(value) => onSaveSettings({ terminalApprovalMode: value as ApprovalMode })}
            options={[
              { value: "always", label: "Always Ask", hint: "Ask before every command." },
              { value: "destructive", label: "Trusted Commands", hint: "Run safe commands; ask before risky ones." },
              { value: "trusted", label: "Allow Workspace Commands", hint: "Run commands freely in approved workspaces." },
              { value: "autonomous", label: "Autonomous", hint: "Run any command without asking." }
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

function PermissionsPage({ settings, onSaveSettings }: SettingsScreenProps) {
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const filesystemAccess: FilesystemAccess = settings.filesystemAccess ?? "workspace";

  const requestFilesystemAccess = (value: FilesystemAccess) => {
    if (value === "full" && filesystemAccess !== "full") {
      setConfirmingFullAccess(true);
      return;
    }
    onSaveSettings({ filesystemAccess: value });
  };

  return (
    <div className="settingsPage">
      <h2>Permissions</h2>
      <p className="settingsSubtitle">Everything defaults to approval-required. You stay in control.</p>
      <div className="settingsGroup">
        <Field label="Filesystem Access">
          <div className="permissionHeader">
            <span className="fieldHint">What can Latex read and modify?</span>
          </div>
          <RadioGroup
            name="fs-scope"
            value={filesystemAccess}
            onChange={(value) => requestFilesystemAccess(value as FilesystemAccess)}
            options={[
              { value: "workspace", label: "Workspace Only", hint: "Latex can read and modify files only inside the folder you open with Open Folder." },
              { value: "full", label: "Full PC Access", hint: "Latex can work with files anywhere your Windows account has permission (Desktop, Documents, Downloads, etc.)." }
            ]}
          />
        </Field>
        <Field label="File Change Approval">
          <RadioGroup
            name="fs-approval"
            value={settings.approvalMode}
            onChange={(value) => onSaveSettings({ approvalMode: value as ApprovalMode })}
            options={[
              { value: "always", label: "Ask Every Time", hint: "Ask before every file change." },
              { value: "destructive", label: "Workspace Only", hint: "Safe edits apply automatically inside the approved boundary." },
              { value: "trusted", label: "Allow Workspace Changes", hint: "Apply file changes without asking." },
              { value: "autonomous", label: "Autonomous", hint: "Apply changes and run commands without asking." }
            ]}
          />
        </Field>
        <Field label="PC Control">
          <div className="permissionHeader">
            <span className="fieldHint">Screenshot, mouse, keyboard, opening apps/folders/URLs.</span>
          </div>
          <RadioGroup
            name="pc-control"
            value={settings.pcControl ?? "ask"}
            onChange={(value) => onSaveSettings({ pcControl: value as PcControlMode })}
            options={[
              { value: "off", label: "Off", hint: "Computer-control tools are disabled." },
              { value: "ask", label: "Ask", hint: "Ask before each computer-control action." },
              { value: "on", label: "On", hint: "Allow computer-control tools according to the other approval settings." }
            ]}
          />
        </Field>
        <Field label="Terminal">
          <RadioGroup
            name="terminal-approval"
            value={settings.terminalApprovalMode}
            onChange={(value) => onSaveSettings({ terminalApprovalMode: value as ApprovalMode })}
            options={[
              { value: "always", label: "Always Ask", hint: "Ask before every command." },
              { value: "destructive", label: "Trusted Commands", hint: "Run safe commands; ask before risky ones." },
              { value: "trusted", label: "Allow Workspace Commands", hint: "Run commands freely in approved workspaces." },
              { value: "autonomous", label: "Autonomous", hint: "Run any command without asking." }
            ]}
          />
        </Field>
      </div>

      {confirmingFullAccess && (
        <div className="modalBackdrop" onClick={() => setConfirmingFullAccess(false)}>
          <div className="modalPanel fullAccessConfirm" onClick={(event) => event.stopPropagation()}>
            <div className="wsModalHead">
              <div className="wsModalTitle"><Shield size={15} /> Enable Full PC Access?</div>
              <button className="iconButton" onClick={() => setConfirmingFullAccess(false)} title="Close">
                <span aria-hidden>×</span>
              </button>
            </div>
            <div className="wsModalBody">
              <p>Latex will be able to work with files and folders across your computer where your Windows account has permission.</p>
              <div className="fullAccessList">
                <div>✓ Read files</div>
                <div>✓ Create files</div>
                <div>✓ Edit files</div>
                <div>✓ Create folders</div>
                <div>✓ Rename files</div>
                <div>✓ Move files</div>
                <div>✓ Copy files</div>
                <div>✓ Delete files</div>
                <div>✓ Search files</div>
              </div>
              <p className="fieldHint">Only enable this if you trust Latex. Windows security (UAC, ACLs, Defender) is never bypassed.</p>
            </div>
            <div className="wsModalFoot">
              <button className="btn" onClick={() => setConfirmingFullAccess(false)}>Cancel</button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirmingFullAccess(false);
                  onSaveSettings({ filesystemAccess: "full" });
                }}
              >
                <Shield size={14} /> Enable Full PC Access
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationsPage({ settings, onSaveSettings }: SettingsScreenProps) {
  return (
    <div className="settingsPage">
      <h2>Notifications</h2>
      <p className="settingsSubtitle">Get pinged when a long task finishes while Latex is in the background.</p>
      <div className="settingsGroup">
        <Field label="Notify when tasks finish">
          <div className="fieldRow">
            <Toggle
              checked={Boolean(settings.notifyOnFinish)}
              onChange={(checked) => onSaveSettings({ notifyOnFinish: checked })}
            />
            <span className="fieldHint"><Bell size={13} /> Native Windows notification</span>
          </div>
        </Field>
      </div>
    </div>
  );
}



function MemoryPage() {
  const [enabled, setEnabled] = useState(true);
  const [useHistory, setUseHistory] = useState(true);
  const [useLongTermMemory, setUseLongTermMemory] = useState(true);
  const [memories, setMemories] = useState<Array<{ id: string; text: string; category: string; createdAt: number; updatedAt: number; importance: number }>>([]);
  const [stats, setStats] = useState<{ indexedConversations: number; indexedMessages: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const settings = await window.latex.memory.getSettings();
      setEnabled(settings.enabled);
      setUseHistory(settings.useHistory);
      setUseLongTermMemory(settings.useLongTermMemory);
      const mems = await window.latex.memory.list();
      setMemories(mems);
      const st = await window.latex.chatHistory.stats();
      setStats(st);
    } catch {
      // Settings not available
    }
    setLoading(false);
  }

  async function saveMemorySettings(partial: Partial<{ enabled: boolean; useHistory: boolean; useLongTermMemory: boolean }>) {
    await window.latex.memory.setSettings(partial);
    if (partial.enabled !== undefined) setEnabled(partial.enabled);
    if (partial.useHistory !== undefined) setUseHistory(partial.useHistory);
    if (partial.useLongTermMemory !== undefined) setUseLongTermMemory(partial.useLongTermMemory);
  }

  async function clearAllMemories() {
    await window.latex.memory.clear();
    setMemories([]);
  }

  async function deleteMemory(id: string) {
    await window.latex.memory.delete(id);
    setMemories((prev) => prev.filter(m => m.id !== id));
  }

  async function rebuildIndex() {
    await window.latex.chatHistory.rebuildIndex();
    const st = await window.latex.chatHistory.stats();
    setStats(st);
  }

  if (loading) return <div className="settingsPage"><Spinner /></div>;

  return (
    <div className="settingsPage">
      <h2>Chat Memory</h2>
      <p className="settingsSubtitle">
        Latex can remember useful information from your previous Chat conversations.
        This only affects <strong>Chat mode</strong> — the Main Agent is never influenced by chat memory.
      </p>

      <div className="settingsGroup">
        <div className="settingsRow">
          <div>
            <div className="settingsLabel">Enable Memory</div>
            <div className="settingsHint">Allow Latex to use context from previous chats.</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => saveMemorySettings({ enabled: e.target.checked })} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className="settingsRow">
          <div>
            <div className="settingsLabel">Use Previous Chat History</div>
            <div className="settingsHint">Search through messages from your previous Chat conversations.</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={useHistory} onChange={(e) => saveMemorySettings({ useHistory: e.target.checked })} disabled={!enabled} />
            <span className="toggleSlider" />
          </label>
        </div>

        <div className="settingsRow">
          <div>
            <div className="settingsLabel">Save Long-Term Memories</div>
            <div className="settingsHint">Extract and store useful facts, preferences, and decisions from conversations.</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={useLongTermMemory} onChange={(e) => saveMemorySettings({ useLongTermMemory: e.target.checked })} disabled={!enabled} />
            <span className="toggleSlider" />
          </label>
        </div>
      </div>

      <div className="settingsGroup">
        <div className="settingsRow">
          <div>
            <div className="settingsLabel">Indexed Conversations</div>
            <div className="settingsHint">{stats?.indexedConversations ?? 0} conversations · {stats?.indexedMessages ?? 0} messages indexed</div>
          </div>
          <button className="settingsBtn" onClick={rebuildIndex}>Rebuild Index</button>
        </div>
      </div>

      <div className="settingsGroup">
        <div className="settingsRow" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="settingsLabel">Long-Term Memories ({memories.length})</div>
            <div className="settingsHint">Saved facts and preferences from your conversations.</div>
          </div>
          <button className="settingsBtn settingsBtnDanger" onClick={clearAllMemories} disabled={memories.length === 0}>Clear All</button>
        </div>

        {memories.length > 0 && (
          <div className="memoryList">
            {memories.slice(0, 20).map((mem) => (
              <div key={mem.id} className="memoryItem">
                <div className="memoryCategory">[{mem.category}]</div>
                <div className="memoryText">{mem.text}</div>
                <button className="memoryDeleteBtn" onClick={() => deleteMemory(mem.id)} title="Delete memory">×</button>
              </div>
            ))}
            {memories.length > 20 && (
              <div className="settingsHint">… and {memories.length - 20} more</div>
            )}
          </div>
        )}
        {memories.length === 0 && (
          <div className="settingsHint">No memories yet. Start a Chat conversation and Latex will learn useful information.</div>
        )}
      </div>
    </div>
  );
}

/** One NEW/FIXED/IMPROVED group of a release entry — omitted when empty. */
function ReleaseList({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="releaseList">
      <span className="releaseListLabel">{label}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ReleaseNotes({ release, latest }: { release: ReleaseEntry; latest?: boolean }) {
  return (
    <div className={`releaseEntry${latest ? " latest" : ""}`}>
      <div className="releaseHead">
        <span className="releaseVersion">Latex {release.version}</span>
        {latest ? <span className="releaseLatestBadge">Latest</span> : null}
        <span className="releaseDate">Released {formatReleaseDate(release.date)}</span>
      </div>
      {release.name ? <div className="releaseName">{release.name}</div> : null}
      <ReleaseList label="New" items={release.added} />
      <ReleaseList label="Fixed" items={release.fixed} />
      <ReleaseList label="Improved" items={release.improved} />
    </div>
  );
}

/**
 * About + Updates.
 *
 * The updater runs entirely in the main process; this page only renders the
 * normalized status it streams over `updates:event`. Two things are always
 * true here: the version shown comes from `app.getVersion()` (never a literal),
 * and a build with no update feed says so plainly instead of claiming a
 * failure — the release history below is permanent either way.
 */
function AboutPage() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "download" | "install" | null>(null);

  useEffect(() => {
    let alive = true;
    const updates = window.latex?.updates;
    if (!updates) return () => { alive = false; };
    void updates.status()
      .then((next: UpdateStatus) => { if (alive) setStatus(next); })
      .catch(() => undefined);
    const off = updates.onEvent((event: { status: UpdateStatus }) => {
      if (alive) setStatus(event.status);
    });
    return () => { alive = false; off(); };
  }, []);

  const run = async (action: "check" | "download" | "install") => {
    const updates = window.latex?.updates;
    if (!updates || busy) return;
    setBusy(action);
    try {
      const next = action === "check"
        ? await updates.check()
        : action === "download"
          ? await updates.download()
          : await updates.install();
      setStatus(next);
    } catch {
      // The main process always answers with a normalized status; a throw here
      // means the bridge is unavailable, which the row below already reports.
    } finally {
      setBusy(null);
    }
  };

  const state = status?.state ?? "idle";
  const percent = Math.max(0, Math.min(100, Math.round(status?.percent ?? 0)));

  return (
    <div className="settingsPage">
      <h2>About</h2>
      <div className="settingsGroup">
        <div className="aboutRow">
          <img src={logo} alt="Latex logo" className="aboutLogoImg" />
          <div>
            <div className="aboutName">Latex</div>
            <div className="aboutVersion">
              Version {status?.currentVersion ?? "—"} · AI Workspace Agent
            </div>
          </div>
        </div>
        <p className="settingsSubtitle">A Codex-style desktop coding agent powered by Google Gemini. Built with Electron, React, and TypeScript.</p>
      </div>

      <h2>Updates</h2>
      <p className="settingsSubtitle">
        Updates are identified by your installed version and platform — no Latex account or sign-in is required.
      </p>
      <div className="settingsGroup">
        <div className="field">
          <span className="fieldLabel">Current version</span>
          <div className="fieldControl">
            <span className="updateVersion">{status?.currentVersion ?? "—"}</span>
          </div>
        </div>

        {/* One line of state, always a sentence a person can act on. Raw
            updater errors never reach this surface. */}
        <div className={`updateStatusRow ${state}`} role="status">
          {state === "checking" && <span>Checking for updates…</span>}
          {state === "up-to-date" && <span><Check size={13} /> You're up to date — Latex {status?.currentVersion}.</span>}
          {state === "available" && (
            <span>Latex {status?.version} is available{status?.releaseDate ? ` · ${formatReleaseDate(status.releaseDate)}` : ""}.</span>
          )}
          {state === "downloading" && (
            <span>Downloading update… Latex {status?.version}{percent > 0 ? ` · ${percent}%` : ""}</span>
          )}
          {state === "downloaded" && <span><Check size={13} /> Update ready — Latex {status?.version} has been downloaded.</span>}
          {state === "installing" && <span>Restarting to install…</span>}
          {state === "error" && <span className="updateError">{status?.message ?? "Couldn't check for updates. Try again."}</span>}
          {state === "unsupported" && <span>{status?.message ?? "Automatic updates are available for installed production builds."}</span>}
          {state === "idle" && (
            <span>Updates are checked automatically when Latex starts, and downloaded in the background.</span>
          )}
        </div>

        {state === "downloading" && (
          <div className="updateProgress">
            <div className="updateProgressBar" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="updateProgressMeta">
              {percent}%
              {status?.total ? ` · ${formatUpdateBytes(status.transferred)} / ${formatUpdateBytes(status.total)}` : ""}
              {status?.bytesPerSecond ? ` · ${formatUpdateBytes(status.bytesPerSecond)}/s` : ""}
            </div>
          </div>
        )}

        {/* Real release notes from the feed when there is one; the maintained
            changelog otherwise. Nothing here is invented. */}
        {status?.releaseNotes && state === "available" && (
          <div className="updateNotes">
            <div className="updateNotesTitle">What's new in Latex {status.version}</div>
            <pre>{status.releaseNotes}</pre>
          </div>
        )}

        <div className="updateActions">
          {state === "available" && (
            <>
              <button className="btn" disabled={busy !== null} onClick={() => void run("download")}>
                {busy === "download" ? <Spinner /> : null} Update
              </button>
              <a className="btn ghost" href="#whats-new">View Changes</a>
            </>
          )}
          {state === "downloading" && (
            <button className="btn" disabled>Downloading…</button>
          )}
          {state === "downloaded" && (
            <>
              <button className="btn" disabled={busy !== null} onClick={() => void run("install")}>
                {busy === "install" ? <Spinner /> : null} Restart &amp; Update
              </button>
            </>
          )}
          {/* A manual check is ALWAYS available — including on a build with no
              feed, where it is the honest way to re-confirm the state. It is
              hidden only while the run in progress already has a primary action
              (download / restart). */}
          {state !== "available" && state !== "downloading" && state !== "downloaded" && state !== "installing" && (
            <button className="btn" disabled={busy !== null || state === "checking"} onClick={() => void run("check")}>
              {busy === "check" || state === "checking" ? <Spinner /> : <RefreshCw size={14} />} Check for Updates
            </button>
          )}
          {state === "unsupported" && LATEX_WEBSITE_URL ? (
            <a className="btn ghost" href={LATEX_WEBSITE_URL} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Download Latest Version
            </a>
          ) : null}
        </div>
        {/* Shown only when the RUNNING BUILD genuinely has no update feed.
            An installed production build carries electron-builder's generated
            update metadata, so this sentence cannot appear there — it is not
            a claim about the project, it is a statement about this binary. */}
        {state === "unsupported" && !LATEX_WEBSITE_URL && status?.feedConfigured === false ? (
          <p className="fieldHint">
            This build was packaged without update metadata, so it cannot update itself. Installed releases of Latex
            include it and update automatically.
          </p>
        ) : null}
        {state === "unsupported" && status?.feedConfigured && !LATEX_WEBSITE_URL ? (
          <p className="fieldHint">
            Updates are checked automatically in installed production builds.
          </p>
        ) : null}
      </div>

      <h2 id="whats-new">What's New</h2>
      <p className="settingsSubtitle">Every release Latex has shipped, newest first. The latest is highlighted.</p>
      <div className="settingsGroup">
        {[...LATEX_RELEASES]
          .sort((a, b) => compareVersions(b.version, a.version))
          .map((release, index) => (
            <ReleaseNotes key={release.version} release={release} latest={index === 0} />
          ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="fieldLabel">{label}</span>
      <div className="fieldControl">{children}</div>
    </label>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggleKnob" />
    </button>
  );
}

function RadioGroup({
  value,
  onChange,
  options,
  name
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; hint: string }>;
  name?: string;
}) {
  const groupName = name ?? options.map((o) => o.value).join("-");
  return (
    <div className="radioGroup">
      {options.map((option) => (
        <label key={option.value} className={`radioRow ${value === option.value ? "selected" : ""}`}>
          <input
            type="radio"
            name={groupName}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="radioText">
            <span className="radioLabel">{option.label}</span>
            <span className="radioHint">{option.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

// ── Usage Page ─────────────────────────────────────────────────────────

import { formatNumber, formatCredits, formatResetTime, usagePercent } from "../../../shared/providerUsage.js";
import type { ProviderUsage } from "../../../shared/providerUsage.js";

function UsagePage() {
  const [usages, setUsages] = useState<ProviderUsage[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  async function refreshUsage() {
    setLoading(true);
    try {
      const hasUsage = typeof window.latex !== "undefined" && typeof (window.latex as Record<string, unknown>).usage !== "undefined";
      if (hasUsage) {
        const usageApi = (window.latex as Record<string, unknown>).usage as {
          fetchAll: () => Promise<Array<{
            provider: string;
            label: string;
            status: string;
            creditsRemaining: number | null;
            creditsUsed: number | null;
            creditsLimit: number | null;
            creditsCurrency: string | null;
            requestsRemaining: number | null;
            requestsLimit: number | null;
            requestsUsed: number | null;
            tokensRemaining: number | null;
            tokensLimit: number | null;
            resetAt: number | null;
            source: string;
            subtitle: string | null;
            fetchedAt: number;
            error: string | null;
          }>>;
        };
        const data = await usageApi.fetchAll();
        setUsages(data.map((d) => ({
          provider: d.provider,
          label: d.label,
          requestsUsed: d.requestsUsed,
          requestsLimit: d.requestsLimit,
          inputTokensUsed: null,
          inputTokensLimit: null,
          outputTokensUsed: null,
          outputTokensLimit: null,
          creditsUsed: d.creditsUsed,
          creditsLimit: d.creditsLimit,
          creditsCurrency: d.creditsCurrency,
          resetAt: d.resetAt,
          subtitle: d.error ?? d.subtitle,
          source: d.source as ProviderUsage["source"],
          fetchedAt: d.fetchedAt
        })));
      } else {
        // Fallback: show basic status without usage API
        setUsages([
          { provider: "gemini", label: "Gemini", requestsUsed: null, requestsLimit: null, inputTokensUsed: null, inputTokensLimit: null, outputTokensUsed: null, outputTokensLimit: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null, resetAt: null, subtitle: "Usage API not available", source: "unavailable", fetchedAt: Date.now() },
          { provider: "openrouter", label: "OpenRouter", requestsUsed: null, requestsLimit: null, inputTokensUsed: null, inputTokensLimit: null, outputTokensUsed: null, outputTokensLimit: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null, resetAt: null, subtitle: "Usage API not available", source: "unavailable", fetchedAt: Date.now() },
          { provider: "groq", label: "Groq", requestsUsed: null, requestsLimit: null, inputTokensUsed: null, inputTokensLimit: null, outputTokensUsed: null, outputTokensLimit: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null, resetAt: null, subtitle: "Usage API not available", source: "unavailable", fetchedAt: Date.now() },
          { provider: "ollama", label: "Ollama", requestsUsed: null, requestsLimit: null, inputTokensUsed: null, inputTokensLimit: null, outputTokensUsed: null, outputTokensLimit: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null, resetAt: null, subtitle: "Local", source: "local", fetchedAt: Date.now() },
          { provider: "omniroute", label: "OmniRoute", requestsUsed: null, requestsLimit: null, inputTokensUsed: null, inputTokensLimit: null, outputTokensUsed: null, outputTokensLimit: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null, resetAt: null, subtitle: "Local gateway", source: "local", fetchedAt: Date.now() },
          { provider: "puter", label: "Puter", requestsUsed: null, requestsLimit: null, inputTokensUsed: null, inputTokensLimit: null, outputTokensUsed: null, outputTokensLimit: null, creditsUsed: null, creditsLimit: null, creditsCurrency: null, resetAt: null, subtitle: "Usage API not available", source: "unavailable", fetchedAt: Date.now() },
        ]);
      }
      setLastUpdated(Date.now());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refreshUsage(); }, []);

  const timeAgo = lastUpdated ? `${Math.round((Date.now() - lastUpdated) / 1000)}s ago` : "Never";

  return (
    <div className="settingsPage">
      <h2>Provider Usage</h2>
      <p className="settingsSubtitle">Usage and quota information for each provider. Only real data is shown — no estimated or fake numbers.</p>

      <div className="usageRefreshRow">
        <span className="usageLastUpdated">Updated {timeAgo}</span>
        <button className="btn sm" onClick={() => void refreshUsage()} disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      <div className="usageCards">
        {usages.map((u) => (
          <div key={u.provider} className="usageCard">
            <div className="usageCardHeader">
              <span className="usageCardLabel">{u.label}</span>
              <span className="usageCardSource">{u.source === "local" ? "Local" : u.source === "headers" ? "Live" : u.source === "api" ? "API" : "Unavailable"}</span>
            </div>

            {u.source === "local" ? (
              <div className="usageCardBody">
                <p className="usageInfo">{u.subtitle ?? "Local — no provider quota"}</p>
              </div>
            ) : u.source === "unavailable" ? (
              <div className="usageCardBody">
                <p className="usageInfo">{u.subtitle ?? "Limit information unavailable"}</p>
                <p className="usageInfo">Usage data appears here when the provider exposes rate-limit headers or a usage API.</p>
              </div>
            ) : (
              <div className="usageCardBody">
                {u.requestsUsed !== null && u.requestsLimit !== null && (
                  <div className="usageMetric">
                    <div className="usageMetricLabel">Requests</div>
                    <div className="usageMetricValue">{formatNumber(u.requestsUsed)} / {formatNumber(u.requestsLimit)}</div>
                    <div className="usageBar"><div className="usageBarFill" style={{ width: `${usagePercent(u.requestsUsed, u.requestsLimit) ?? 0}%` }} /></div>
                  </div>
                )}
                {u.creditsUsed !== null && (
                  <div className="usageMetric">
                    <div className="usageMetricLabel">Credits</div>
                    <div className="usageMetricValue">{formatCredits(u.creditsUsed, u.creditsCurrency)}{u.creditsLimit !== null ? ` / ${formatCredits(u.creditsLimit, u.creditsCurrency)}` : ""}</div>
                    {u.creditsLimit !== null && <div className="usageBar"><div className="usageBarFill" style={{ width: `${usagePercent(u.creditsUsed, u.creditsLimit) ?? 0}%` }} /></div>}
                  </div>
                )}
                {u.resetAt !== null && (
                  <div className="usageReset">Resets {formatResetTime(u.resetAt)}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
