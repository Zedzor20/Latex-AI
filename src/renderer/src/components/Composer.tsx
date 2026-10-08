import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
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
import { imageGenerationBadgeLabel, imageGenerationCapabilityOfModel, modelEligibleForThinkingFilter, modelSupportsImageGeneration, thinkingCapabilityOfModel, thinkingBadgeLabel, compareThinkingModels, THINKING_FILTER_ORDER } from "../../../shared/modelCapabilities";

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

export interface ComposerProps {
  workspace?: Workspace;
  composer: string;
  setComposer: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  /** Current app mode. The Thinking control is a MAIN-only concept: Chat is a
   *  plain conversation and never shows or toggles provider reasoning. */
  appMode?: "main" | "chat";
  approvalMode: ApprovalMode;
  onSelectApprovalMode: (mode: ApprovalMode) => void;
  showApprovalMenu: boolean;
  onToggleApprovalMenu: (open: boolean) => void;
  /** True when the selected model's provider genuinely exposes thinking. */
  thinkingSupported?: boolean;
  /** Resolved Thinking state for the selected model (default ON when supported). */
  thinkingOn?: boolean;
  /** Persist an explicit per-model Thinking preference. */
  onToggleThinking?: (enabled: boolean) => void;
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
  onStartOllama?: () => void;
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
  /** When the selected model is image-capable, this sends the turn to the
   *  dedicated image-generation path instead of the normal conversation/agent
   *  path, so Gemini-native image models actually produce a picture. */
  onGenerateImage?: (text: string, attachments?: Attachment[]) => void;
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
    onGenerateImage,
    busy,
    appMode,
    approvalMode,
    onSelectApprovalMode,
    showApprovalMenu,
    onToggleApprovalMenu,
    thinkingSupported,
    thinkingOn,
    onToggleThinking,
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
    onStartOllama,
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

  // Explicit image-generation mode for image-capable models. When on, the
  // send button routes the prompt to `onGenerateImage` (Gemini-native image
  // models produce a picture; other providers surface an honest notice).
  const [generateImageMode, setGenerateImageMode] = useState(false);
  const imageCapable = useMemo(() => {
    if (!selectedModel) return false;
    const found = models.find((m) => m.name === selectedModel);
    return modelSupportsImageGeneration(found ?? { name: selectedModel, provider: activeProvider as ModelProvider, capabilities: [] });
  }, [selectedModel, models, activeProvider]);

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

  // Handle file selection via hidden file input (images + text/code/docs)
  const handleImageFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).slice(0, 8);
    const attachments: Attachment[] = [];
    for (const file of files) {
      const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
      if (imageExts.has(ext)) {
        if (file.size > 4 * 1024 * 1024) continue;
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
      } else {
        // Text/code/doc files: read as text for the model. Large files are
        // accepted (same 4MB gate as images) but the extracted text is capped
        // at 200KB with a `truncated` flag — bounded payload, compact card.
        if (file.size > 4 * 1024 * 1024) continue;
        const text = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve('');
          reader.readAsText(file);
        });
        if (text) {
          attachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            name: file.name,
            kind: 'text',
            content: text.slice(0, 200 * 1024),
            truncated: text.length > 200 * 1024,
            size: file.size
          });
        }
      }
    }
    if (attachments.length > 0) {
      onAddAttachments(attachments);
    }
    e.target.value = '';
  }, [onAddAttachments]);

  // Handle clipboard paste — detect pasted images AND files from Ctrl+V
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    const otherFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    // Also check for file data in clipboard (Windows Explorer copy)
    const files = e.clipboardData?.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.type.startsWith('image/') && f.name) {
          otherFiles.push(f);
        }
      }
    }
    if (imageFiles.length === 0 && otherFiles.length === 0) return;
    e.preventDefault(); // prevent default paste for files/images
    void (async () => {
      const attachments: Attachment[] = [];
      // Handle images
      for (const file of imageFiles.slice(0, 5)) {
        if (file.size > 4 * 1024 * 1024) continue;
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
            name: file.name || `pasted-image-${Date.now()}.png`,
            kind: 'image',
            base64,
            mimeType: file.type || 'image/png',
            size: file.size
          });
        }
      }
      // Handle other files (text/code/docs)
      for (const file of otherFiles.slice(0, 5)) {
        if (file.size > 4 * 1024 * 1024) continue;
        const text = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve('');
          reader.readAsText(file);
        });
        if (text) {
          attachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            name: file.name || `pasted-file-${Date.now()}`,
            kind: 'text',
            content: text.slice(0, 200 * 1024),
            truncated: text.length > 200 * 1024,
            size: file.size
          });
        }
      }
      if (attachments.length > 0) {
        onAddAttachments(attachments);
      }
    })();
  }, [onAddAttachments]);

  // Register paste event listener on the textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.addEventListener('paste', handlePaste);
    return () => el.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  // Handle drag & drop — support both images and text/code files
  const handleDrop = useCallback((e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    void (async () => {
      const attachments: Attachment[] = [];
      for (const file of files.slice(0, 8)) {
        const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
        const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
        const docExts = new Set(['.pdf', '.doc', '.docx', '.rtf', '.odt', '.xlsx', '.xls']);
        if (imageExts.has(ext)) {
          if (file.size > 4 * 1024 * 1024) continue;
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
        } else if (docExts.has(ext) || file.size <= 4 * 1024 * 1024) {
          // Text/code/doc files: read as text
          const text = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => resolve('');
            reader.readAsText(file);
          });
          if (text) {
            attachments.push({
              id: `att-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
              name: file.name,
              kind: 'text',
              content: text.slice(0, 200 * 1024),
              truncated: text.length > 200 * 1024,
              size: file.size
            });
          }
        }
      }
      if (attachments.length > 0) {
        onAddAttachments(attachments);
      }
    })();
  }, [onAddAttachments]);

  // Handle slash command selection — use a ref to avoid stale closure
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onGenerateImageRef = useRef(onGenerateImage);
  onGenerateImageRef.current = onGenerateImage;
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
        if (!canSend) return;
        if (generateImageMode && onGenerateImageRef.current) {
          onGenerateImageRef.current(composer.trim(), attachments);
        } else {
          onSend();
        }
      }}
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); }}
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
            if (!canSend) return;
            if (generateImageMode && onGenerateImageRef.current) {
              onGenerateImageRef.current(composer.trim(), attachments);
            } else if (canSend) {
              onSend();
            }
          }
        }}
        placeholder="Ask Latex anything..."
      />

      <div className="composerBar">
        <div className="composerBarLeft">
          <button type="button" className="iconButton" title="Attach files" onClick={onPickFiles}><Paperclip size={16} /></button>
          <input ref={imageInputRef} type="file" accept="image/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.htm,.xml,.yaml,.yml,.csv,.tsv,.log,.py,.java,.cpp,.c,.h,.cs,.rs,.go,.toml,.env,.sh,.ps1,.bat,.sql,.pdf,.doc,.docx,.rtf,.odt,.xlsx,.xls" multiple style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} onChange={handleImageFileChange} tabIndex={-1} />
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
          {/* Image-generation mode — always available. When on, the prompt is
              routed to a genuinely image-capable model on the same provider
              (resolved in the main process); if the provider cannot return
              generated image data, the activity panel says so honestly and the
              model still answers in text. */}
          <button
            type="button"
            className={`pillButton imagePill ${generateImageMode ? "imageModeOn" : ""}`}
            title={generateImageMode
              ? "Image generation mode on — this prompt will produce a picture"
              : imageCapable
                ? "Generate an image with this model"
                : "Generate an image — Latex will use an image-capable model on this provider"}
            onClick={() => setGenerateImageMode((v) => !v)}
          >
            <Image size={14} />
            <span>{generateImageMode ? "Image generation" : "Generate image"}</span>
          </button>

          {/* Thinking control — only for models whose provider API genuinely
              exposes reasoning. Default ON; an explicit OFF is remembered per
              model and is never carried onto a model that cannot use it. */}
          {appMode !== "chat" && thinkingSupported && (
            <button
              type="button"
              className={`pillButton thinkingPill ${thinkingOn ? "thinkingOn" : ""}`}
              title={thinkingOn
                ? "Provider thinking is on — click to turn it off for this model"
                : "Provider thinking is off for this model — click to turn it on"}
              onClick={() => onToggleThinking?.(!thinkingOn)}
            >
              <Brain size={14} />
              <span>{thinkingOn ? "Thinking" : "Thinking off"}</span>
            </button>
          )}
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
            onStartOllama={onStartOllama}
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
            <button
              type="submit"
              className={`sendButton ${generateImageMode ? "imageMode" : ""}`}
              disabled={!canSend}
              title={generateImageMode ? "Generate image" : "Send"}
            >
              {generateImageMode ? <Image size={16} /> : <Send size={16} />}
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

  // ── Ollama local models — tool-capable models qualify for the agent workflow ──
  if (provider === "ollama" && model.supportsTools) return true;

  // ── NVIDIA Nemotron models ──
  // Nemotron models are ordinary chat/tool-calling models (70B/49B/340B and
  // the newer Nemotron-3 families) and were previously hidden from the picker
  // entirely. Keep them selectable whenever the provider reports tool support.
  if (/nemotron|nvidia/i.test(lower + " " + id) && model.supportsTools) return true;

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

  // ── Ollama models: local tool-capable coding models make the cut ──
  if (model.provider === "ollama") {
    if (model.supportsTools && /coder|code|instruct|chat|qwen|gemma|llama|deepseek/i.test(id)) return true;
    return false;
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
  // NVIDIA/Nemotron models are explicitly supported — never hide them for size
  // or for looking like a "nano"/small variant name.
  if (/nemotron|nvidia/i.test(combined)) return false;
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
  providerHealth,
  onStartOllama
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
  onStartOllama?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // ── Single-select model filter ──────────────────────────────────────
  // ONE active filter value. "Thinking" is a FILTER over the model list (like
  // a provider tab), never a mode and never composable with a provider: the
  // chips are mutually exclusive, so clicking a provider always leaves the
  // Thinking filter. This is the single source of truth for the selection.
  const [scope, setScope] = useState<string>("all");
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  useEffect(() => {
    // Keep the provider tab in sync with the active model's provider — but
    // never hijack a non-provider filter (All / Recommended / Automation /
    // Thinking): those are their own single selection.
    setScope((current) => (current === "all" || current === "thinking" || current === "recommended" || current === "automation" || !activeProvider ? current : `provider:${activeProvider}`));
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
    // THINKING scope: only models whose provider API genuinely exposes reasoning
    // to Latex (see shared/modelCapabilities). Search inside this scope stays
    // inside it, so "Thinking" + a query never reveals non-thinking models.
    // A provider may additionally narrow it ("Thinking + OpenRouter"), and we use
    // allStrong here so provider-specific reasoning models are not hidden by the
    // "All" scope's Claude-on-OpenRouter de-duplication.
    if (scope === "thinking") {
      // ONLY the allowed providers, and only models whose exact provider+model
      // genuinely exposes reasoning. OpenRouter is never shown here even
      // though its models stay available in All Models.
      return allStrong.filter((model) => modelEligibleForThinkingFilter(model));
    }
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

  const handleScopeClick = (key: string) => {
    // SINGLE-SELECT. Every chip (All / Recommended / Automation / Thinking /
    // each provider) is an exclusive choice: clicking one replaces the active
    // filter outright, so two chips can never appear selected together. The
    // Thinking chip selects the reasoning-capable model list — it does NOT
    // enable reasoning for a task (that is Main's per-model Thinking control).
    if (key === scope) return;
    setScope(key);
  };

  const handleRefresh = async () => {
    await onRetryModels();
    const now = new Date();
    setLastRefreshed(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  };

  const scopeLabel = scope === "all" ? "All providers" : scope === "recommended" ? "Recommended" : scope === "automation" ? "Automation"
    : scope === "thinking" ? "Thinking"
    : (PROVIDER_LABELS[scope.replace("provider:", "") as ModelProvider] ?? scope);
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
              { key: "thinking", label: "Thinking", providerName: undefined },
              { key: "provider:gemini", label: "Gemini", providerName: "gemini" },
              { key: "provider:groq", label: "Groq", providerName: "groq" },
              { key: "provider:openrouter", label: "OpenRouter", providerName: "openrouter" },
              { key: "provider:minimax", label: "MiniMax", providerName: "minimax" },
              { key: "provider:puter", label: "Puter", providerName: "puter" },
              { key: "provider:ollama", label: "Ollama", providerName: "ollama" },
              { key: "provider:omniroute", label: "OmniRoute", providerName: "omniroute" }
            ]).map((chip) => {
              const health = chip.providerName ? getProviderHealth(chip.providerName) : undefined;
              const healthIcon = health ? (health.status === "ok" ? "\u2713" : health.status === "error" ? "\u2717" : "\u2014") : "";
              const healthClass = health ? (health.status === "ok" ? "healthOk" : health.status === "error" ? "healthErr" : "healthUnknown") : "";
              // Exactly one chip is active: the active filter itself.
              const chipActive = scope === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  className={`modelScopeChip ${chipActive ? "active" : ""}`}
                  onClick={() => handleScopeClick(chip.key)}
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

          {/* Ollama scope: LOCAL and CLOUD sections */}
          {modelsState === "ready" && scope === "provider:ollama" && (
            <OllamaCategories models={filtered} selectedModel={selectedModel} autoModel={autoModel} onSelect={select} providerHealth={providerHealth} onStartOllama={onStartOllama} />
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

          {/* OmniRoute scope: show models from the local OmniRoute gateway */}
          {modelsState === "ready" && scope === "provider:omniroute" && (
            <div className="modelCategory">
              <div className="modelCategoryLabel">
                <span className="modelCategoryDot other" />
                OmniRoute Models
                <span className="modelCategoryCount">{filtered.length}</span>
              </div>
              <div className="modelGroup">
                {filtered.map((model) => renderModelRow(model, selectedModel, autoModel, select, providerHealth))}
              </div>
            </div>
          )}

          {/* Thinking scope: verified reasoning models only, sections in the
              fixed order PUTER → OLLAMA → OMNIROUTE → MINIMAX → GEMINI. */}
          {modelsState === "ready" && scope === "thinking" && (
            <ThinkingCategories models={filtered} selectedModel={selectedModel} autoModel={autoModel} onSelect={select} providerHealth={providerHealth} />
          )}

          {/* Provider-specific or Recommended scopes (non-OpenRouter) */}
          {modelsState === "ready" && scope !== "all" && scope !== "automation" && scope !== "thinking" && scope !== "provider:puter" && scope !== "provider:ollama" && scope !== "provider:openrouter" && scope !== "provider:omniroute" && otherModels.length > 0 && (
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
/** Ollama scope: local models and (signed-in) Ollama Cloud models, clearly separated. */
function OllamaCategories({ models, selectedModel, autoModel, onSelect, providerHealth, onStartOllama }: {
  models: GeminiModel[];
  selectedModel: string | undefined;
  autoModel: boolean;
  onSelect: (name: string) => void;
  providerHealth?: Array<{ provider: string; status: "ok" | "error" | "no_key"; error?: string; modelCount: number }>;
  onStartOllama?: () => void;
}) {
  const local = models.filter((m) => !isCloudTag(m.name));
  const cloud = models.filter((m) => isCloudTag(m.name));
  const sections = [
    { label: "LOCAL MODELS", icon: "\ud83d\udcbb", models: local },
    { label: "OLLAMA CLOUD", icon: "\u2601\ufe0f", models: cloud }
  ];
  return (
    <>
      {/* Start Ollama Button */}
      <div className="modelCategory ollamaStartCategory">
        <button
          type="button"
          className="ollamaStartBtn"
          onClick={() => onStartOllama?.()}
        >
          <span className="ollamaStartIcon">▶</span>
          <span className="ollamaStartText">Start Ollama</span>
        </button>
      </div>

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
      {models.length === 0 && (
        <div className="modelMenuState">No Ollama models found. Click "Start Ollama" above to start the Ollama server, then pull a model (e.g. <code>ollama pull qwen2.5-coder</code>).</div>
      )}
      {cloud.length === 0 && local.length > 0 && (
        <div className="modelMenuState">Ollama Cloud requires signing in to your Ollama account in the Ollama app — cloud models will appear here after you sign in.</div>
      )}
    </>
  );
}

/** True when the model tag refers to an Ollama Cloud model. */
function isCloudTag(name: string): boolean {
  return /-cloud|:cloud|cloud/i.test(name);
}

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

/** Display labels for the Thinking filter's fixed provider sections. */
const THINKING_PROVIDER_LABELS: Partial<Record<ModelProvider, string>> = {
  puter: "Puter",
  ollama: "Ollama",
  omniroute: "OmniRoute",
  minimax: "MiniMax",
  gemini: "Google Gemini"
};

/**
 * Thinking filter: verified reasoning models only, grouped into fixed provider
 * sections (Puter → Ollama → OmniRoute → MiniMax → Gemini). Never alphabetical,
 * never OpenRouter. A section with no verified models is omitted entirely.
 */
function ThinkingCategories({ models, selectedModel, autoModel, onSelect, providerHealth }: {
  models: GeminiModel[];
  selectedModel: string | undefined;
  autoModel: boolean;
  onSelect: (name: string) => void;
  providerHealth?: Array<{ provider: string; status: "ok" | "error" | "no_key"; error?: string; modelCount: number }>;
}) {
  const groups = useMemo(() => {
    const map = new Map<ModelProvider, GeminiModel[]>();
    for (const model of models) {
      const provider = (model.provider ?? providerOfModel(model.name)) as ModelProvider;
      if (!THINKING_FILTER_ORDER.includes(provider)) continue;
      const list = map.get(provider) ?? [];
      list.push(model);
      map.set(provider, list);
    }
    // Strongest / most capable verified thinking model first.
    for (const list of map.values()) list.sort(compareThinkingModels);
    return map;
  }, [models]);

  const sections = THINKING_FILTER_ORDER
    .map((provider) => ({ provider, list: groups.get(provider) ?? [] }))
    .filter((section) => section.list.length > 0);

  if (sections.length === 0) {
    return (
      <div className="modelMenuState">
        No verified thinking models right now. Thinking lists only models whose
        provider actually exposes reasoning (Puter, Ollama, OmniRoute, MiniMax, Gemini).
      </div>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <div key={section.provider} className="modelCategory">
          <div className="modelCategoryLabel">
            <span className="modelCategoryDot other" />
            {THINKING_PROVIDER_LABELS[section.provider] ?? section.provider}
            <span className="modelCategoryCount">{section.list.length} models</span>
          </div>
          <div className="modelGroup">
            {section.list.map((model) => renderModelRow(model, selectedModel, autoModel, onSelect, providerHealth))}
          </div>
        </div>
      ))}
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
          <span className="modelProviderBadge" title={`Served by ${PROVIDER_LABELS[provider] ?? provider}`}>{provider === "puter" ? "Puter" : provider === "openrouter" ? "OR" : provider === "gemini" ? "Gem" : provider === "groq" ? "Groq" : provider === "minimax" ? "MM" : provider === "ollama" ? "Ollama" : provider}</span>
          {provider === "ollama" && (
            <span className={`modelLocalTag ${isCloudTag(model.name) ? "cloud" : ""}`}>{isCloudTag(model.name) ? "CLOUD" : "LOCAL"}</span>
          )}
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
      {/* "reason" was a name-based guess; this tag states whether the provider
          actually EXPOSES thinking to Latex, with the reason in its tooltip. */}
      {(() => {
        const thinking = thinkingCapabilityOfModel(model);
        if (thinking.supportsThinking) {
          return <span className="modelTag thinkingTag" title={thinking.reason}>{thinkingBadgeLabel(thinking)?.toLowerCase() ?? "thinking"}</span>;
        }
        return model.supportsReasoning
          ? <span className="modelTag" title="Reasoning-capable model, but this provider does not expose its thinking to Latex">reason</span>
          : null;
      })()}
      {/* Image generation is a CAPABILITY, not a name guess: this badge says
          whether the provider API really returns generated image data. */}
      {(() => {
        const image = imageGenerationCapabilityOfModel(model);
        return image.supportsImageGeneration
          ? <span className="modelTag imageTag" title={image.reason}>{imageGenerationBadgeLabel(image)?.toLowerCase() ?? "image"}</span>
          : null;
      })()}
    </button>
  );
}
