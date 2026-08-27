import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  Image,
  Mic,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  Square,
  Volume2,
  X
} from "lucide-react";
import type { ApprovalMode, Attachment, GeminiModel, ModelProvider, Workspace } from "../../../shared/types";
import { modelShortName } from "../lib/errors";
import { modelCapability } from "../lib/format";

/** Categorize Puter models into curated sections based on name/capabilities. */
function categorizePuterModels(models: GeminiModel[]) {
  const powerful: GeminiModel[] = [];
  const fast: GeminiModel[] = [];
  const automation: GeminiModel[] = [];
  const recommended: GeminiModel[] = [];
  for (const m of models) {
    const n = ((m.displayName ?? "") + " " + m.name + " " + (m.description ?? "") + " " + (m.capabilities ?? []).join(" ")).toLowerCase();
    if (/embedding|rerank|moderation|whisper|tts|audio|speech|dall.e|flux|stable|transcri|image.?gen|txt2img/.test(n)) continue;
    const isPowerful = /max|ultra|large|72b|70b|405b|400b|o1|o3|claude|gpt-4|gemini-2|deepseek.r1|qwen.?3|command.r|mistral.large/i.test(n) || (m.contextLength ?? 0) >= 100000;
    const isFast = /flash|mini|small|fast|light|nano|turbo|haiku|instant/i.test(n);
    const isAutomation = /code|coder|coding|agent|assistant|instruct|chat/i.test(n) && !/embedding|image|speech|audio/.test(n);
    if (isPowerful) powerful.push(m);
    if (isFast) fast.push(m);
    if (isAutomation) automation.push(m);
    const score = ((m.contextLength ?? 0) / 10000) + (m.supportsTools ? 3 : 0) + (m.supportsReasoning ? 2 : 0) + (m.supportsVision ? 1 : 0) + (isPowerful ? 2 : 0) + (isAutomation ? 1 : 0);
    if (score >= 3) recommended.push(m);
  }
  const cap = (arr: GeminiModel[], n: number) => { arr.sort((a, b) => ((b.contextLength ?? 0) - (a.contextLength ?? 0)) || (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)); return arr.slice(0, n); };
  return { powerful: cap(powerful, 15), fast: cap(fast, 12), automation: cap(automation, 12), recommended: cap(recommended, 10) };
}
import { providerOfModel, PROVIDER_LABELS } from "../lib/modelRouter";
import { Spinner } from "./ui";

export type ModelsState = "idle" | "loading" | "ready" | "error";

interface ComposerProps {
  workspace?: Workspace;
  composer: string;
  setComposer: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  approvalMode: ApprovalMode;
  onSelectApprovalMode: (mode: ApprovalMode) => void;
  showApprovalMenu: boolean;
  onToggleApprovalMenu: (open: boolean) => void;
  modelLabel: string;
  models: GeminiModel[];
  modelsState: ModelsState;
  modelsError: string;
  onRetryModels: () => void;
  selectedModel?: string;
  autoModel: boolean;
  modelReason: string | null;
  onSelectModel: (name: string) => void;
  onSelectAutoModel: () => void;
  activeProvider?: ModelProvider;
  providerHealth?: Array<{
    provider: string; label: string; configured: boolean;
    status: "ok" | "error" | "no_key"; modelCount: number; error?: string; httpStatus?: number;
  }>;
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  onAddAttachments: (attachments: Attachment[]) => void;
  onPickFiles: () => void;
  contextMenuOpen: boolean;
  onToggleContextMenu: (open: boolean) => void;
  onAddContext: (kind: "file" | "workspace" | "conversation") => void;
  listening: boolean;
  transcribing?: boolean;
  onStartListening: () => void;
  onStopListening: () => void;
  speechError: string | null;
  speaking: boolean;
  onStopSpeaking: () => void;
}

const approvalOptions: Array<{ value: ApprovalMode; label: string }> = [
  { value: "always", label: "Always ask" },
  { value: "destructive", label: "Ask for destructive actions" },
  { value: "trusted", label: "Trusted workspace" },
  { value: "autonomous", label: "Autonomous" }
];

export function Composer(props: ComposerProps) {
  const {
    workspace,
    composer,
    setComposer,
    onSend,
    onStop,
    busy,
    approvalMode,
    onSelectApprovalMode,
    showApprovalMenu,
    onToggleApprovalMenu,
    modelLabel,
    models,
    modelsState,
    modelsError,
    onRetryModels,
    selectedModel,
    autoModel,
    modelReason,
    onSelectModel,
    onSelectAutoModel,
    activeProvider,
    providerHealth,
    attachments,
    onRemoveAttachment,
    onAddAttachments,
    onPickFiles,
    contextMenuOpen,
    onToggleContextMenu,
    onAddContext,
    listening,
    transcribing,
    onStartListening,
    onStopListening,
    speechError,
    speaking,
    onStopSpeaking
  } = props;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [composer]);

  const canSend = composer.trim().length > 0 && !busy;

  // Slash commands definition
  const slashCommands = [
    { name: "/clear", desc: "Clear this conversation" },
    { name: "/help", desc: "Show available commands" },
  ];

  // Filter slash commands based on current input
  const filteredSlashCommands = useMemo(() => {
    if (!slashMenuOpen) return [];
    const query = composer.trim().toLowerCase();
    if (!query.startsWith("/")) return [];
    return slashCommands.filter((cmd) => cmd.name.startsWith(query));
  }, [slashMenuOpen, composer]);

  const imageInputRef = useRef<HTMLInputElement>(null);

  // Handle image file selection via hidden file input
  const handleImageFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).slice(0, 5); // max 5 images
    const attachments: Attachment[] = [];
    for (const file of files) {
      if (file.size > 4 * 1024 * 1024) continue; // skip >4MB
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          resolve(dataUrl.split(',')[1] || '');
        };
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (base64) {
        attachments.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
          name: file.name,
          kind: 'image',
          base64,
          mimeType: file.type || 'image/png',
          size: file.size
        });
      }
    }
    if (attachments.length > 0) {
      onAddAttachments(attachments);
    }
    e.target.value = '';
  }, [onAddAttachments]);

  // Handle slash command selection — use a ref to avoid stale closure
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const selectSlashCommand = useCallback((cmd: string) => {
    setSlashMenuOpen(false);
    setSlashMenuIndex(0);
    setComposer(cmd);
    // Use requestAnimationFrame to ensure state is updated before sending
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        onSendRef.current();
      });
    });
  }, []);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {(attachments.length > 0 || listening || speaking) && (
        <div className="composerChips">
          {attachments.map((att) => (
            <span key={att.id} className="chip">
              {att.kind === "image" && att.base64 && att.mimeType ? (
                <span className="chipThumb"><img src={`data:${att.mimeType};base64,${att.base64}`} alt={att.name} /></span>
              ) : (
                <FileText size={12} />
              )}
              <span className="chipName" title={att.name}>{att.name}</span>
              <button type="button" className="chipRemove" onClick={() => onRemoveAttachment(att.id)} title="Remove">
                <X size={11} />
              </button>
            </span>
          ))}
          {listening && (
            <span className="chip listening">
              <span className="micPulse" />
              {transcribing ? "Transcribing…" : "Listening…"}{" "}
              {!transcribing && <button type="button" className="chipRemove" onClick={onStopListening} title="Stop listening"><X size={11} /></button>}
            </span>
          )}
          {speaking && (
            <span className="chip speaking">
              <Volume2 size={12} /> Speaking <button type="button" className="chipRemove" onClick={onStopSpeaking} title="Stop"><Square size={10} fill="currentColor" /></button>
            </span>
          )}
        </div>
      )}
      {speechError && !listening && <div className="speechError">{speechError}</div>}

      <div className="composerTop">
        <button type="button" className="composerWorkspace" title="Current workspace">
          <FolderOpen size={13} />
          <span>{workspace?.name ?? "No workspace"}</span>
        </button>
        {attachments.length > 0 && <span className="attachCount">📎 {attachments.length}</span>}
      </div>

      {slashMenuOpen && filteredSlashCommands.length > 0 && (
        <div className="slashCommandMenu">
          {filteredSlashCommands.map((cmd, idx) => (
            <button
              key={cmd.name}
              type="button"
              className={`slashCommandItem ${idx === slashMenuIndex ? "active" : ""}`}
              onClick={() => selectSlashCommand(cmd.name)}
              onMouseEnter={() => setSlashMenuIndex(idx)}
            >
              <span className="slashCommandName">{cmd.name}</span>
              <span className="slashCommandDesc">{cmd.desc}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        value={composer}
        onChange={(event) => {
          const val = event.target.value;
          setComposer(val);
          // Detect slash command
          if (val === "/" || (val.startsWith("/") && !val.includes(" "))) {
            setSlashMenuOpen(true);
            setSlashMenuIndex(0);
          } else {
            setSlashMenuOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (slashMenuOpen && filteredSlashCommands.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSlashMenuIndex((i) => (i + 1) % filteredSlashCommands.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSlashMenuIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              selectSlashCommand(filteredSlashCommands[slashMenuIndex].name);
              return;
            }
            if (event.key === "Escape") {
              setSlashMenuOpen(false);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (canSend) onSend();
          }
        }}
        placeholder="Ask Latex anything..."
      />

      <div className="composerBar">
        <div className="composerBarLeft">
          <button type="button" className="iconButton" title="Attach files" onClick={onPickFiles}><Paperclip size={16} /></button>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" multiple style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} onChange={handleImageFileChange} tabIndex={-1} />
          <button type="button" className="iconButton" title="Upload image" onClick={() => imageInputRef.current?.click()}><Image size={16} /></button>
          <div className="dropdownWrap">
            <button type="button" className="iconButton" title="Add context" onClick={() => onToggleContextMenu(!contextMenuOpen)}>
              <Plus size={16} />
            </button>
            {contextMenuOpen && (
              <div className="dropdownMenu">
                <div className="modelMenuHeader"><span>Add Context</span></div>
                <button type="button" onClick={() => onAddContext("file")}><FileText size={14} /> File</button>
                <button type="button" onClick={() => onAddContext("workspace")} disabled={!workspace}><FolderOpen size={14} /> Workspace</button>
                <button type="button" onClick={() => onAddContext("conversation")}><Volume2 size={14} /> Conversation</button>
              </div>
            )}
          </div>
          <div className="dropdownWrap">
            <button
              type="button"
              className="pillButton"
              onClick={() => onToggleApprovalMenu(!showApprovalMenu)}
            >
              <Shield size={14} />
              <span>{approvalOptions.find((o) => o.value === approvalMode)?.label ?? "Approval"}</span>
              <ChevronDown size={13} />
            </button>
            {showApprovalMenu && (
              <div className="dropdownMenu">
                {approvalOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={option.value === approvalMode ? "selected" : ""}
                    onClick={() => {
                      onSelectApprovalMode(option.value);
                      onToggleApprovalMenu(false);
                    }}
                  >
                    {option.value === approvalMode ? <Check size={14} /> : <span className="menuCheckSpacer" />}
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="composerBarRight">
          <ModelSelector
            modelLabel={modelLabel}
            models={models}
            modelsState={modelsState}
            modelsError={modelsError}
            onRetryModels={onRetryModels}
            selectedModel={selectedModel}
            autoModel={autoModel}
            modelReason={modelReason}
            onSelectModel={onSelectModel}
            onSelectAutoModel={onSelectAutoModel}
            activeProvider={activeProvider}
            providerHealth={providerHealth}
          />
          <button
            type="button"
            className={`iconButton ${listening ? "active micActive" : ""}`}
            title={listening ? (transcribing ? "Transcribing…" : "Stop listening") : "Voice input"}
            onClick={listening && !transcribing ? onStopListening : () => onStartListening()}
            disabled={transcribing}
          >
            <Mic size={16} />
          </button>
          {busy ? (
            <button type="button" className="stopButton" title="Stop generating" onClick={onStop}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="sendButton" disabled={!canSend} title="Send">
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Whether a model qualifies for the Automation category (verified agent-capable models only). */
/** Whether a model qualifies for the Automation category (verified agent-capable models only).
 *  Models must have tool-calling support and be suitable for multi-step agent workflows. */
function isAutomationModel(model: GeminiModel): boolean {
  const name = model.displayName ?? model.name;
  const id = model.name.toLowerCase();
  const lower = name.toLowerCase();
  const provider = model.provider ?? providerOfModel(model.name);

  // Exclude non-chat models (embedding, TTS, image gen, etc.)
  const excluded = /embedding|rerank|moderation|whisper|tts|audio|speech|dall.e|flux|stable|transcri|translate|image.?gen|txt2img/.test(lower + " " + id);
  if (excluded) return false;

  // ── Claude models (only if the provider actually exposes them) ──
  // Claude Sonnet 4.6 — strong coding/agent model
  if (/claude.*sonnet.*(4\.6|4-6|latest)/i.test(lower) || /claude-sonnet-4(?!\.|\d)/i.test(id)) return true;
  // Claude Haiku 4.5 — fast, supports coding/bash/computer-use
  if (/claude.*haiku.*(4\.5|4-5|latest)/i.test(lower) || /claude.*haiku.*(4\.5|4-5)/i.test(id)) return true;

  // ── Other automation-suitable models ──
  // Qwen 3.7 Max / Qwen 3 Coder
  if (/qwen.*3\.7.*max|qwen.*37.*max|qwen.*3.*coder/i.test(lower)) return true;
  if (/qwen.*3\.7.*max|qwen.*3.*coder/i.test(id)) return true;
  // DeepSeek V3.2
  if (/deepseek.*v3\.?2|deepseek.*3\.?2/i.test(lower)) return true;
  if (/deepseek.*v3\.?2/i.test(id)) return true;
  // GPT OSS 120B
  if (/gpt.?oss.*120b|gpt.?120b/i.test(lower)) return true;
  if (/gpt.*oss.*120/i.test(id)) return true;
  // Gemma 4 models
  if (/gemma.?4.*31b|gemma.?4.*26ba/i.test(lower)) return true;
  if (/gemma.*4.*31b|gemma.*4.*26ba/i.test(id)) return true;
  // Nemotron 3.5 Lightning Free
  if (/nemotron.*3\.5.*lightning/i.test(lower)) return true;
  if (/nemotron.*3\.5.*lightning/i.test(id)) return true;

  return false;
}

/** Whether a model qualifies for the Recommended category.
 *  Only includes models that are actually available from the connected provider. */
function isRecommendedModel(model: GeminiModel): boolean {
  const name = model.displayName ?? model.name;
  const id = model.name.toLowerCase();
  const lower = name.toLowerCase();

  // ── Priority Recommended Models (ordered by preference) ──

  // 1. Claude Opus 4
  if (/claude-opus-4(?!\.|\d)/i.test(id) && !/opus-4\.\d/i.test(id)) return true;
  // 2. Claude Sonnet 4.6 / Claude Sonnet latest
  if (/claude-sonnet-4(?!\.|\d)/i.test(id) && !/sonnet-4\.\d/i.test(id)) return true;
  // 3. DeepSeek V4 Flash
  if (/deepseek.*v4.*flash/i.test(lower) || /deepseek\/deepseek-v4-flash/i.test(id)) return true;
  // 4. GLM latest
  if (/glm.*latest/i.test(lower) || /glm.*latest/i.test(id)) return true;
  // 5. GPT-4o Mini
  if (/gpt-4o-mini(?!-|\d)/i.test(lower) || /gpt-4o-mini(?!-|\d)/i.test(id)) return true;
  // 6. Claude Haiku 4.5 / Claude Haiku latest
  if (/claude.*haiku.*(latest|4\.5|4-5)/i.test(lower) || /claude.*haiku.*(latest|4\.5|4-5)/i.test(id)) return true;
  // 7. Strong GPT via Puter (gpt-4o, gpt-5, gpt-4.1)
  if (model.provider === "puter") {
    if (/gpt-4o(?!-mini)|gpt-5|gpt-4\.1/i.test(id)) return true;
    if (/qwen.*3\.8.*max|qwen.*3\.7.*max|qwen.*3\.6.*27b|qwen.*3.*coder|qwen.*3\.7.*flash/i.test(id)) return true;
    return false;
  }

  // ── Gemini models (only if Gemini provider is the actual provider) ──
  if (model.provider === "gemini") {
    if (/gemini.*2\.5.*flash|gemini.*2\.5.*pro/i.test(lower)) return true;
    if (/gemini.*2\.5.*flash|gemini.*2\.5.*pro/i.test(id)) return true;
  }

  // ── Other strong models from any connected provider ──
  // Gemma 4 models
  if (/gemma.*4/i.test(lower) || /gemma.*4/i.test(id)) return true;
  // DeepSeek V3.2
  if (/deepseek.*v3\.?2|deepseek.*3\.?2/i.test(lower) || /deepseek.*v3\.?2/i.test(id)) return true;
  // GPT-OSS 120B
  if (/gpt.?oss.*120b|gpt.?120b/i.test(lower) || /gpt.*oss.*120/i.test(id)) return true;

  return false;
}

/** Detect weak/small models to hide from the picker (under ~20B parameters). */
function isWeakModel(model: GeminiModel): boolean {
  const provider = model.provider ?? providerOfModel(model.name);
  // Only filter OpenRouter models — other providers have curated lists
  if (provider !== "openrouter") return false;
  const name = model.name.toLowerCase();
  const desc = `${model.description ?? ""} ${model.displayName ?? ""}`.toLowerCase();
  const combined = `${name} ${desc}`;
  // Extract parameter count from name (e.g. "7b", "14b", "32b", "70b")
  const paramMatch = combined.match(/(\d+\.?\d*)b(?:\s|$|[^a-z])/);
  if (paramMatch) {
    const params = parseFloat(paramMatch[1]);
    if (params < 20) return true; // Under 20B = weak
  }
  // Hidden/small model indicators
  if (/tiny|micro|small|0\.5b|1b|1\.5b|3b|4b|6b|7b|8b|9b|10b|12b|14b|15b|16b|18b/.test(combined)) return true;
  // Embedding/moderation/whisper/tts models are not chat models
  if (/embedding|rerank|moderation|whisper|tts|audio|speech|dall.e|flux|stable|transcri|translate/.test(combined)) return true;
  // Filter out unwanted OpenAI O-series models (o1, o3, o4 and similar reasoning variants)
  if (/\bo[134]\b|\bo1-|\bo3-|\bo4-|openai.*o[134]|o[134].*mini|o[134].*pro|o[134].*preview/.test(combined)) return true;
  return false;
}

function matchesSearch(model: GeminiModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    model.name,
    model.displayName ?? "",
    model.description ?? "",
    model.provider ?? "",
    "automation",
    "chat",
    ...(model.capabilities ?? [])
  ].join(" ").toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}



function ModelSelector({
  modelLabel,
  models,
  modelsState,
  modelsError,
  onRetryModels,
  selectedModel,
  autoModel,
  modelReason,
  onSelectModel,
  onSelectAutoModel,
  activeProvider,
  providerHealth
}: {
  modelLabel: string;
  models: GeminiModel[];
  modelsState: ModelsState;
  modelsError: string;
  onRetryModels: () => void;
  selectedModel?: string;
  autoModel: boolean;
  modelReason: string | null;
  onSelectModel: (name: string) => void;
  onSelectAutoModel: () => void;
  activeProvider?: ModelProvider;
  providerHealth?: Array<{
    provider: string; label: string; configured: boolean;
    status: "ok" | "error" | "no_key"; modelCount: number; error?: string; httpStatus?: number;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>("all");
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  useEffect(() => {
    setScope((current) => (current === "all" || !activeProvider ? current : `provider:${activeProvider}`));
  }, [activeProvider]);

  // Provider health lookup helper
  const getProviderHealth = (providerName: string) => {
    if (!providerHealth || providerHealth.length === 0) return undefined;
    return providerHealth.find((h) => h.provider === providerName);
  };

  // Determine which providers are actually connected
  const connectedProviders = useMemo(() => {
    const connected = new Set<string>();
    if (providerHealth && providerHealth.length > 0) {
      for (const h of providerHealth) {
        if (h.configured && h.status === "ok") connected.add(h.provider);
      }
    }
    // If no health data yet, fall back to models list (providers that returned models are connected)
    if (connected.size === 0 && models.length > 0) {
      for (const m of models) {
        const p = m.provider ?? providerOfModel(m.name);
        connected.add(p);
      }
    }
    return connected;
  }, [providerHealth, models]);

  const scopedModels = useMemo(() => {
    // CRITICAL: Only show models from connected providers
    const connectedModels = models.filter((m) => {
      const provider = m.provider ?? providerOfModel(m.name);
      return connectedProviders.has(provider);
    });
    // Filter out weak/small models
    const allStrong = connectedModels.filter((m) => !isWeakModel(m));
    // Hide Claude/Anthropic models from OpenRouter in "All" scope only (keep them in OpenRouter filter)
    const strong = scope === "recommended" || scope === "provider:openrouter" ? allStrong : allStrong.filter((m) => {
      const provider = m.provider ?? providerOfModel(m.name);
      if (provider === "openrouter" && /claude|anthropic/i.test((m.displayName ?? "") + " " + m.name)) return false;
      return true;
    });
    if (scope === "all") return strong;
    if (scope === "automation") return strong.filter((model) => isAutomationModel(model));
    if (scope === "recommended") {
      const rec = strong.filter((model) => isRecommendedModel(model));
      // Custom sort order for Recommended models
      const priority = (m: GeminiModel): number => {
        const id = m.name.toLowerCase();
        const lower = (m.displayName ?? m.name).toLowerCase();
        // 1. Claude Opus 4
        if (/claude-opus-4(?!\.|\d)/i.test(id) && !/opus-4\.\d/i.test(id)) return 10;
        // 2. Claude Sonnet latest
        if (/claude-sonnet-4(?!\.|\d)/i.test(id) && !/sonnet-4\.\d/i.test(id)) return 20;        // 3. DeepSeek V4 Flash (exact match only)
        if (/deepseek.*v4.*flash/i.test(lower) || /deepseek\/deepseek-v4-flash/i.test(id)) return 30;
        // 4. GLM latest
        if (/glm.*latest/i.test(lower) || /glm.*latest/i.test(id)) return 40;
        // 5. GPT-4o Mini
        if (/gpt-4o-mini(?!-|\d)/i.test(lower) || /gpt-4o-mini(?!-|\d)/i.test(id)) return 50;
        // 6. Claude Haiku latest
        if (/claude.*haiku.*(latest|4\.5|4-5)/i.test(lower) || /claude.*haiku.*(latest|4\.5|4-5)/i.test(id)) return 60;
        // 7. Strong GPT via Puter
        if (m.provider === "puter" && /gpt-4o(?!-mini)|gpt-5|gpt-4\.1/i.test(id)) return 70;
        // 8. Puter Qwen models
        if (m.provider === "puter") return 80;
        // 9. Existing recommended models
        return 90;
      };
      rec.sort((a, b) => priority(a) - priority(b));
      return rec;
    }
    if (scope === "provider:puter") {
      // Puter: curated categories from live model list
      return strong.filter((model) => (model.provider ?? providerOfModel(model.name)) === "puter");
    }
    if (scope.startsWith("provider:")) {
      const provider = scope.replace("provider:", "") as ModelProvider;
      return strong.filter((model) => (model.provider ?? providerOfModel(model.name)) === provider);
    }
    return strong;
  }, [models, scope, connectedProviders]);

  const filtered = useMemo(() => {
    if (!scopedModels.length) return [];
    return scopedModels.filter((model) => matchesSearch(model, query));
  }, [scopedModels, query]);

  // Split models into family groups for "all" scope and OpenRouter scope
  const { claudeModels, gptModels, otherModels } = useMemo(() => {
    if (scope !== "all" && scope !== "provider:openrouter") return { claudeModels: [], gptModels: [], otherModels: filtered };
    const claude: GeminiModel[] = [];
    const gpt: GeminiModel[] = [];
    const other: GeminiModel[] = [];
    for (const model of filtered) {
      const name = (model.displayName ?? "") + " " + model.name;
      const id = model.name.toLowerCase();
      if (/claude|anthropic/i.test(name)) claude.push(model);
      else if (/\bgpt\b|openai/i.test(name) && !/deepseek/i.test(name)) gpt.push(model);
      else other.push(model);
    }
    return { claudeModels: claude, gptModels: gpt, otherModels: other };
  }, [filtered, scope]);

  // For OpenRouter scope: sub-group the "other" models into Qwen / DeepSeek / Other
  const { qwenModels, deepseekModels, openRouterOtherModels } = useMemo(() => {
    if (scope !== "provider:openrouter") return { qwenModels: [], deepseekModels: [], openRouterOtherModels: otherModels };
    const qwen: GeminiModel[] = [];
    const deepseek: GeminiModel[] = [];
    const rest: GeminiModel[] = [];
    for (const model of otherModels) {
      const name = (model.displayName ?? "") + " " + model.name;
      if (/qwen/i.test(name)) qwen.push(model);
      else if (/deepseek/i.test(name)) deepseek.push(model);
      else rest.push(model);
    }
    return { qwenModels: qwen, deepseekModels: deepseek, openRouterOtherModels: rest };
  }, [otherModels, scope]);

  // Group by provider within each category
  const otherGroups = useMemo(() => groupByProvider(otherModels), [otherModels]);

  const select = (name: string) => {
    onSelectModel(name);
    setOpen(false);
    setQuery("");
  };

  const handleRefresh = async () => {
    await onRetryModels();
    const now = new Date();
    setLastRefreshed(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  };

  const scopeLabel = scope === "all" ? "All providers" : scope === "recommended" ? "Recommended" : scope === "automation" ? "Automation" : (PROVIDER_LABELS[scope.replace("provider:", "") as ModelProvider] ?? scope);
  const totalCount = filtered.length;

  return (
    <div className="dropdownWrap">
      <button
        type="button"
        className={`pillButton modelButton ${autoModel ? "autoModel" : ""}`}
        title={`${modelLabel} — click to change model`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="modelDot" />
        <span className="modelButtonLabel">{modelLabel}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="dropdownMenu modelMenu">
          <div className="modelMenuHeader">
            <span>MODELS — {scopeLabel}</span>
            <div className="modelMenuHeaderRight">
              {lastRefreshed && <span className="modelLastRefreshed">Updated {lastRefreshed}</span>}
              {modelsState === "loading" && <Spinner size={12} />}
            </div>
          </div>

          <div className="modelScopeRow">
            {([
              { key: "all", label: "All", providerName: undefined },
              { key: "recommended", label: "Recommended", providerName: undefined },
              { key: "automation", label: "Automation", providerName: undefined },
              { key: "provider:gemini", label: "Gemini", providerName: "gemini" },
              { key: "provider:groq", label: "Groq", providerName: "groq" },
              { key: "provider:openrouter", label: "OpenRouter", providerName: "openrouter" },
              { key: "provider:minimax", label: "MiniMax", providerName: "minimax" },
              { key: "provider:puter", label: "Puter", providerName: "puter" }
            ]).map((chip) => {
              const health = chip.providerName ? getProviderHealth(chip.providerName) : undefined;
              const healthIcon = health ? (health.status === "ok" ? "\u2713" : health.status === "error" ? "\u2717" : "\u2014") : "";
              const healthClass = health ? (health.status === "ok" ? "healthOk" : health.status === "error" ? "healthErr" : "healthUnknown") : "";
              return (
                <button
                  key={chip.key}
                  type="button"
                  className={`modelScopeChip ${scope === chip.key ? "active" : ""}`}
                  onClick={() => setScope(chip.key)}
                  title={health ? `${chip.label}: ${health.status === "ok" ? `${health.modelCount} models` : health.error ?? "Not configured"}` : chip.label}
                >
                  {chip.label}
                  {healthIcon && <span className={`modelHealthIcon ${healthClass}`}>{healthIcon}</span>}
                </button>
              );
            })}
          </div>

          <div className="modelSearchWrap">
            <Search size={13} />
            <input
              type="text"
              className="modelSearch"
              placeholder="Search models… e.g. gemini, qwen, deepseek"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </div>



          {modelsState === "loading" && <div className="modelMenuState">Loading models…</div>}

          {modelsState === "error" && (
            <div className="modelMenuState error">
              <span>Unable to load models. Check your API keys or network.</span>
              <button type="button" className="textButton" onClick={() => void handleRefresh()}>
                <RefreshCw size={13} /> Retry
              </button>
            </div>
          )}

          {modelsState === "ready" && models.length === 0 && (
            <div className="modelMenuState">No models found. Add a provider API key in Settings.</div>
          )}

          {modelsState === "ready" && models.length > 0 && totalCount === 0 && (
            <div className="modelMenuState">No models match "{query}" in {scopeLabel}.</div>
          )}

          {/* All Models scope: Claude → GPT → Other */}
          {modelsState === "ready" && scope === "all" && (
            <>
              {/* Claude Models */}
              {claudeModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    Claude Models
                    <span className="modelCategoryCount">{claudeModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {claudeModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}

              {/* GPT Models */}
              {gptModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    GPT Models
                    <span className="modelCategoryCount">{gptModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {gptModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}

              {/* Other Models */}
              {otherModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    Other Models
                    <span className="modelCategoryCount">{otherModels.length} models</span>
                  </div>
                  {otherGroups.map(([providerName, list]) => (
                    <div key={providerName} className="modelGroup">
                      <div className="modelGroupLabel">{providerName}</div>
                      {list.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Automation scope */}
          {modelsState === "ready" && scope === "automation" && otherModels.length > 0 && (
            <div className="modelCategory">
              {otherModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
            </div>
          )}

          {/* Puter scope: curated categories */}
          {modelsState === "ready" && scope === "provider:puter" && (
            <PuterCategories models={filtered} selectedModel={selectedModel} autoModel={autoModel} onSelect={select} providerHealth={providerHealth} />
          )}

          {/* OpenRouter scope: GPT → Qwen → DeepSeek → Claude → Other */}
          {modelsState === "ready" && scope === "provider:openrouter" && (
            <>
              {/* GPT / OpenAI */}
              {gptModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    GPT / OpenAI
                    <span className="modelCategoryCount">{gptModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {gptModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}

              {/* Qwen */}
              {qwenModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    Qwen
                    <span className="modelCategoryCount">{qwenModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {qwenModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}

              {/* DeepSeek */}
              {deepseekModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    DeepSeek
                    <span className="modelCategoryCount">{deepseekModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {deepseekModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}

              {/* Claude */}
              {claudeModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    Claude
                    <span className="modelCategoryCount">{claudeModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {claudeModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}

              {/* Other */}
              {openRouterOtherModels.length > 0 && (
                <div className="modelCategory">
                  <div className="modelCategoryLabel">
                    <span className="modelCategoryDot other" />
                    Other
                    <span className="modelCategoryCount">{openRouterOtherModels.length}</span>
                  </div>
                  <div className="modelGroup">
                    {openRouterOtherModels.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Provider-specific or Recommended scopes (non-OpenRouter) */}
          {modelsState === "ready" && scope !== "all" && scope !== "automation" && scope !== "provider:puter" && scope !== "provider:openrouter" && otherModels.length > 0 && (
            <div className="modelCategory">
              <div className="modelCategoryLabel">
                <span className="modelCategoryDot other" />
                Models
                <span className="modelCategoryCount">{otherModels.length} models</span>
              </div>
              {otherGroups.map(([providerName, list]) => (
                <div key={providerName} className="modelGroup">
                  <div className="modelGroupLabel">{providerName}</div>
                  {list.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Curated Puter model categories */
function PuterCategories({ models, selectedModel, autoModel, onSelect, providerHealth }: {
  models: GeminiModel[];
  selectedModel: string | undefined;
  autoModel: boolean;
  onSelect: (name: string) => void;
  providerHealth?: Array<{ provider: string; status: "ok" | "error" | "no_key"; error?: string; modelCount: number }>;
}) {
  const cats = useMemo(() => categorizePuterModels(models), [models]);
  const sections = [
    { label: "POWERFUL / LARGE", icon: "\ud83e\udde0", models: cats.powerful },
    { label: "FAST", icon: "\u26a1", models: cats.fast },
    { label: "AUTOMATION / CODING", icon: "\ud83e\udee1", models: cats.automation },
    { label: "RECOMMENDED", icon: "\u2b50", models: cats.recommended }
  ];
  return (
    <>
      {sections.map((section) => section.models.length > 0 && (
        <div key={section.label} className="modelCategory">
          <div className="modelCategoryLabel">
            <span className="modelCategoryDot other" />
            {section.icon} {section.label}
            <span className="modelCategoryCount">{section.models.length}</span>
          </div>
          <div className="modelGroup">
            {section.models.map((model) => renderModelRow(model, selectedModel, autoModel, onSelect, providerHealth))}
          </div>
        </div>
      ))}
      {models.length > 0 && cats.powerful.length === 0 && cats.fast.length === 0 && cats.automation.length === 0 && cats.recommended.length === 0 && (
        <div className="modelCategory">
          <div className="modelCategoryLabel"><span className="modelCategoryDot other" /> All Puter Models</div>
          <div className="modelGroup">
            {models.slice(0, 50).map((model) => renderModelRow(model, selectedModel, autoModel, onSelect, providerHealth))}
          </div>
        </div>
      )}
    </>
  );
}

function groupByProvider(models: GeminiModel[]): Array<[string, GeminiModel[]]> {
  const byProvider = new Map<string, GeminiModel[]>();
  for (const model of models) {
    const provider = model.provider ?? providerOfModel(model.name);
    const key = PROVIDER_LABELS[provider] ?? provider;
    const list = byProvider.get(key) ?? [];
    list.push(model);
    byProvider.set(key, list);
  }
  return Array.from(byProvider.entries());
}

function renderModelRow(model: GeminiModel, selectedModel: string | undefined, autoModel: boolean, select: (name: string) => void, providerHealth?: Array<{ provider: string; status: "ok" | "error" | "no_key"; error?: string; modelCount: number }>) {
  const selected = !autoModel && model.name === selectedModel;
  const provider = model.provider ?? providerOfModel(model.name);
  const isAutomation = isAutomationModel(model);
  // Provider health indicator
  const health = providerHealth?.find((h) => h.provider === provider);
  const healthDot = health ? (health.status === "ok" ? "\u25cf" : health.status === "error" ? "\u25cb" : "\u2014") : "";
  const healthColor = health ? (health.status === "ok" ? "#22c55e" : health.status === "error" ? "#ef4444" : "#a1a1aa") : "transparent";
  const healthTitle = health ? `${health.status === "ok" ? "Provider connected" : health.error ?? "Provider not configured"}` : "";
  return (
    <button
      key={model.name}
      type="button"
      className={`modelRow ${selected ? "selected" : ""}`}
      onClick={() => select(model.name)}
      title={`${provider} · ${model.contextLength ? `${(model.contextLength / 1000).toFixed(0)}k context` : ""} ${model.supportsTools ? "· tools" : ""} ${model.supportsVision ? "· vision" : ""} ${model.isFree ? "· free" : ""}${healthTitle ? ` · ${healthTitle}` : ""}`}
    >
      <span className="modelRowCheck">{selected ? <Check size={14} /> : <span className="menuCheckSpacer" />}</span>
      <span className="modelRowText">
        <span className="modelRowName">
          {model.displayName ?? modelShortName(model.name)}
          {model.isFree && <span className="modelFreeTag">free</span>}
          <span className="modelProviderBadge" title={`Served by ${PROVIDER_LABELS[provider] ?? provider}`}>{provider === "puter" ? "Puter" : provider === "openrouter" ? "OR" : provider === "gemini" ? "Gem" : provider === "groq" ? "Groq" : provider === "minimax" ? "MM" : provider}</span>
        </span>
        <span className="modelRowId">
          {healthDot && <span className="modelRowHealth" style={{ color: healthColor }} title={healthTitle}>{healthDot}</span>}
          {modelShortName(model.name)}
          {model.contextLength ? ` · ${(model.contextLength / 1000).toFixed(0)}k ctx` : ""}
          {isAutomation && <span className="modelAutoTag">automation</span>}
        </span>
      </span>
      {model.supportsTools && <span className="modelTag toolTag" title="Supports tool calling">tools</span>}
      {model.supportsVision && <span className="modelTag" title="Supports vision">vision</span>}
      {model.supportsReasoning && <span className="modelTag" title="Reasoning model">reason</span>}
    </button>
  );
}
