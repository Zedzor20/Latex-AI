import { Bell, Check, Cloud, FolderOpen, KeyRound, Link, Mic, Monitor, Moon, Plug, RefreshCw, Shield, Sun, Trash2, Unlink, Volume2 } from "lucide-react";
import { useState } from "react";
import logo from "../assets/latex-logo.svg";
import type { ApprovalMode, FilesystemAccess, GeminiModel, LatexSettings, ModelProvider, PcControlMode, ProviderStatus, ThemePreference, Workspace } from "../../../shared/types";
import { modelShortName } from "../lib/errors";
import { modelCapability } from "../lib/format";
import { providerOfModel } from "../lib/modelRouter";
import { Spinner } from "./ui";
import type { ModelsState } from "./Composer";

export type SettingsPage = "appearance" | "ai" | "voice" | "workspace" | "terminal" | "permissions" | "notifications" | "about";

export interface ConnectionState {
  state: "idle" | "testing" | "ok" | "fail";
  message: string;
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
}

const navItems: Array<{ id: SettingsPage; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
  { id: "workspace", label: "Workspace" },
  { id: "terminal", label: "Terminal" },
  { id: "permissions", label: "Permissions" },
  { id: "notifications", label: "Notifications" },
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

const PROVIDER_ORDER: ModelProvider[] = ["gemini", "openrouter", "minimax", "groq", "puter"];

const PROVIDER_KEYS: Record<ModelProvider, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  groq: "Groq",
  puter: "Puter (Free)"
};

const PROVIDER_HINTS: Record<ModelProvider, string> = {
  gemini: "aistudio.google.com/apikey",
  openrouter: "openrouter.ai/keys",
  minimax: "platform.minimaxi.com",
  groq: "console.groq.com/keys",
  puter: "Sign in with your Puter account (Google)"
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
  puterLoading
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
                  disabled={connections[provider].state === "testing"}
                >
                  {connections[provider].state === "testing" ? <><Spinner size={12} /> Testing...</> : <><Plug size={13} /> Test</>}
                </button>
                {configured && (
                  <button className="btn sm danger" onClick={() => onClearProviderKey(provider)}><Trash2 size={13} /> Clear</button>
                )}
                {provider !== "gemini" && !configured && (
                  <span className="fieldHint">Get a key at {PROVIDER_HINTS[provider]}</span>
                )}
              </div>
              {connections[provider].state === "ok" && (
                <div className="fieldHint success">✓ {connections[provider].message}</div>
              )}
              {connections[provider].state === "fail" && (
                <div className="fieldHint fail">✕ {connections[provider].message}</div>
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

function AboutPage() {
  return (
    <div className="settingsPage">
      <h2>About</h2>
      <div className="settingsGroup">
        <div className="aboutRow">
          <img src={logo} alt="Latex logo" className="aboutLogoImg" />
          <div>
            <div className="aboutName">Latex</div>
            <div className="aboutVersion">Version 0.1.0 · AI Workspace Agent</div>
          </div>
        </div>
        <p className="settingsSubtitle">A Codex-style desktop coding agent powered by Google Gemini. Built with Electron, React, and TypeScript.</p>
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
