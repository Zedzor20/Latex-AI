import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Eye,
  FileDiff,
  FolderOpen,
  Globe,
  Pencil,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  X
} from "lucide-react";
import { DiffLines } from "./DiffLines";
import type { AgentActivityStep, ApprovalRequest, ChatMessage, ModelProvider, PendingChange } from "../../../shared/types";

/** Short model name for display. */
function modelDisplayName(modelName?: string, provider?: ModelProvider): string {
  if (!modelName) return "";
  const name = modelName.replace(/^models\//, "").replace(/^(openrouter|minimax|groq)\//, "");
  const providerLabel = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "";
  return name + (providerLabel ? ` · ${providerLabel}` : "");
}
import type { ErrorInfo } from "../lib/errors";
import { diffStats } from "../lib/format";
import { Spinner } from "./ui";

interface ChatViewProps {
  messages: ChatMessage[];
  stream?: string;
  busy: boolean;
  activity: string[];
  activitySteps: AgentActivityStep[];
  activityComplete: boolean;
  appMode: "main" | "chat";
  approval: ApprovalRequest | null;
  onApproveApproval: () => void;
  onRejectApproval: () => void;
  pendingChanges: PendingChange[];
  error: ErrorInfo | null;
  modelLabel: string;
  onOpenDiff: () => void;
  onErrorAction: (action: "settings" | "retry" | "fixModel" | "openFolder") => void;
  onOpenInExplorer: (relativePath: string) => void;
  onPreviewFile: (relativePath: string) => void;
  onRegenerate: (messageId: string) => void;
  onEditMessage: (messageId: string) => void;
}

/** Copy via the Electron bridge when available, else the browser clipboard API. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window.latex?.clipboard?.writeText === "function") {
    try {
      await window.latex.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the browser clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Extract first 4 words from a prompt for the timeline tooltip. */
function firstFourWords(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")     // remove code blocks
    .replace(/[#*`>_~\[\](){}|\\]/g, "") // remove markdown
    .replace(/\s+/g, " ")               // collapse spaces
    .trim();
  const words = cleaned.split(" ").filter(Boolean);
  return words.slice(0, 4).join(" ") + (words.length > 4 ? '...' : '') || cleaned.slice(0, 24);
}

export function ChatView(props: ChatViewProps) {
  const {
    messages,
    stream,
    busy,
    activity,
    activitySteps,
    activityComplete,
    appMode,
    approval,
    onApproveApproval,
    onRejectApproval,
    pendingChanges,
    error,
    modelLabel,
    onOpenDiff,
    onErrorAction,
    onOpenInExplorer,
    onPreviewFile,
    onRegenerate,
    onEditMessage
  } = props;
  const isMainMode = appMode === "main";

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedChange, setExpandedChange] = useState<string | null>(null);
  const [activeMsgId, setActiveMsgId] = useState<string | null>(null);
  const markerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const timelineRef = useRef<HTMLDivElement>(null);
  const markerWrapRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);

  // User prompts for navigation markers
  const userPrompts = useMemo(() => messages.filter((m) => m.role === "user"), [messages]);

  // Scroll tracking: find which user prompt is currently in view
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf: number;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const scrollTop = el.scrollTop;
        const viewMid = scrollTop + el.clientHeight / 2;
        let closest: string | null = null;
        let closestDist = Infinity;
        for (const prompt of userPrompts) {
          const marker = markerRefs.current.get(prompt.id);
          if (!marker) continue;
          const markerTop = marker.offsetTop;
          const dist = Math.abs(markerTop - viewMid);
          if (dist < closestDist) {
            closestDist = dist;
            closest = prompt.id;
          }
        }
        setActiveMsgId(closest);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { cancelAnimationFrame(raf); el.removeEventListener("scroll", onScroll); };
  }, [userPrompts]);

  // Timeline mouse-wheel → scroll the timeline itself (not the chat)
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    const onWheel = (e: WheelEvent) => {
      if (tl.scrollHeight > tl.clientHeight) {
        e.preventDefault();
        tl.scrollTop += e.deltaY;
      }
    };
    tl.addEventListener("wheel", onWheel, { passive: false });
    return () => tl.removeEventListener("wheel", onWheel);
  }, [userPrompts.length]);





  const scrollToMessage = useCallback((msgId: string) => {
    const marker = markerRefs.current.get(msgId);
    if (marker) {
      marker.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setActiveMsgId(msgId);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, stream, activity.length, activitySteps.length, pendingChanges.length, approval]);

  const showThinking = busy && !stream && messages[messages.length - 1]?.role === "user";
  const pendingCount = pendingChanges.filter((c) => c.status === "accepted").length;
  const totalStats = pendingChanges.reduce(
    (acc, change) => {
      const stats = diffStats(change.diff);
      acc.added += stats.added;
      acc.removed += stats.removed;
      return acc;
    },
    { added: 0, removed: 0 }
  );

  // Fixed marker spacing: 28px per marker
  const MARKER_GAP = 28;

  return (
    <div className="chat">
      <div className="chatScroll" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="chatEmpty">Ask Latex to inspect a project, build something, review code, or fix an issue.</div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            ref={(el) => { if (el && message.role === 'user') markerRefs.current.set(message.id, el); else if (message.role === 'user') markerRefs.current.delete(message.id); }}
          >
            <MessageBubble
              message={message}
              streaming={Boolean(message.meta?.streaming)}
              busy={busy}
              onRegenerate={onRegenerate}
              onEditMessage={onEditMessage}
            />
          </div>
        ))}

        {showThinking && (
          <div className="thinking">
            <Spinner size={13} />
            <span>Latex is thinking<span className="dots">...</span></span>
          </div>
        )}

        {isMainMode && (busy || activitySteps.length > 0) && (
          <ActivityTimeline steps={activitySteps} complete={activityComplete} busy={busy} />
        )}

        {approval && (
          <ApprovalCard approval={approval} onApprove={onApproveApproval} onReject={onRejectApproval} />
        )}

        {pendingCount > 0 && (
          <div className="changesCard">
            <div className="changesHead">
              <div className="changesTitle"><FileDiff size={15} /> Edited {pendingCount} file{pendingCount === 1 ? '' : 's'}</div>
              <div className="changesStats">
                <span className="statAdded">+{totalStats.added}</span>
                <span className="statRemoved">-{totalStats.removed}</span>
              </div>
              <div className="changesActions">
                <button className="btn sm" onClick={onOpenDiff}>Review</button>
              </div>
            </div>
            <div className="changesList">
              {pendingChanges
                .filter((c) => c.status === 'accepted')
                .map((change) => {
                  const stats = diffStats(change.diff);
                  const isOpen = expandedChange === change.id;
                  return (
                    <div key={change.id} className="changeRowWrap">
                      <div className="changeRow" onClick={() => setExpandedChange(isOpen ? null : change.id)}>
                        {isOpen ? <ChevronDown size={13} className="changeChevron" /> : <ChevronRight size={13} className="changeChevron" />}
                        <span className="changePath">{change.filePath}</span>
                        <span className="changesStats">
                          <span className="statAdded">+{stats.added}</span>
                          <span className="statRemoved">-{stats.removed}</span>
                        </span>
                        <span className="changeActions">
                          {/\.html?$/i.test(change.filePath) && (
                            <button
                              className="btn sm htmlPreviewBtn"
                              title="Preview HTML"
                              onClick={(event) => { event.stopPropagation(); onPreviewFile(change.filePath); }}
                            >
                              <Globe size={13} /> Preview
                            </button>
                          )}
                          <button
                            className="iconButton"
                            title="Preview file"
                            onClick={(event) => { event.stopPropagation(); onPreviewFile(change.filePath); }}
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            className="iconButton"
                            title="Open in Explorer"
                            onClick={(event) => { event.stopPropagation(); onOpenInExplorer(change.filePath); }}
                          >
                            <FolderOpen size={14} />
                          </button>
                        </span>
                      </div>
                      {isOpen && (
                        <div className="changeDiff">
                          <DiffLines diff={change.diff} />
                          <div className="changeDiffActions">
                            <ChangeCopyButton text={change.diff} label="Copy diff" />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {error && (
          <div className="errorCard">
            <div className="errorMessage">{error.message}</div>
            {error.action && (
              <button
                className="btn sm primary"
                onClick={() => onErrorAction(error.action!)}
              >
                {error.actionLabel ?? 'Open Settings'}
              </button>
            )}
            {error.detail && error.detail !== error.message && (
              <details className="errorDetails">
                <summary>Technical details</summary>
                <pre>{error.detail}</pre>
              </details>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* RIGHT-side prompt navigation timeline with always-visible labels */}
      {userPrompts.length > 0 && (
        <div className="chatTimelineRight" ref={timelineRef}>
          <div className="chatTimelineTrackRight" style={{ height: Math.max(userPrompts.length * MARKER_GAP, 200) }}>
            {userPrompts.map((prompt) => {
              const idx = userPrompts.indexOf(prompt);
              const isActive = activeMsgId === prompt.id;
              const isHovered = hoveredMsgId === prompt.id;
              const preview = typeof prompt.content === 'string' ? firstFourWords(prompt.content) : '';
              return (
                <div
                  key={prompt.id}
                  className={`chatTimelineMarkerRight ${isActive ? 'active' : ''} ${isHovered ? 'hovered' : ''}`}
                  style={{ top: idx * MARKER_GAP }}
                  ref={(el) => {
                    if (el) markerWrapRefs.current.set(prompt.id, el);
                    else markerWrapRefs.current.delete(prompt.id);
                  }}
                  onClick={() => scrollToMessage(prompt.id)}
                  onMouseEnter={() => setHoveredMsgId(prompt.id)}
                  onMouseLeave={() => setHoveredMsgId(null)}
                >
                  <div className={`chatTimelineDot ${isActive ? 'active' : ''}`} />
                  {preview && (
                    <span className="chatTimelineLabel">{preview}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ approval, onApprove, onReject }: { approval: ApprovalRequest; onApprove: () => void; onReject: () => void }) {
  const isCommand = approval.operation === "run_command";
  const isDelete = approval.operation.startsWith("delete");
  return (
    <div className={`approvalCard ${isDelete ? "danger" : ""}`}>
      <div className="approvalTitle">
        {isDelete ? <ShieldAlert size={15} /> : isCommand ? <TerminalSquare size={15} /> : <ShieldCheck size={15} />}
        {approval.title}
      </div>
      <p className="approvalDesc">{approval.description}</p>
      <PreviewBlock preview={approval.preview ?? ""} isCommand={isCommand} />
      <div className="approvalActions">
        <button className={`btn ${isDelete ? "danger" : "primary"}`} onClick={onApprove}>
          {isCommand ? <TerminalSquare size={14} /> : isDelete ? <X size={14} /> : <Check size={14} />}
          {isCommand ? "Run" : isDelete ? "Delete" : "Approve"}
        </button>
        <button className="btn" onClick={onReject}>{isCommand ? "Cancel" : "Reject"}</button>
      </div>
    </div>
  );
}

function PreviewBlock({ preview, isCommand }: { preview: string; isCommand: boolean }) {
  if (isCommand) {
    return <pre className="approvalCommand">{preview}</pre>;
  }
  const lines = preview.split("\n");
  return (
    <div className="approvalPreview">
      {lines.map((line, index) => {
        let cls = "";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) cls = "hunk";
        else if (line.startsWith("+")) cls = "add";
        else if (line.startsWith("-")) cls = "remove";
        return (
          <div key={index} className={`approvalLine ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function MessageBubble({
  message,
  streaming,
  busy,
  onRegenerate,
  onEditMessage
}: {
  message: ChatMessage;
  streaming: boolean;
  busy: boolean;
  onRegenerate: (id: string) => void;
  onEditMessage: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  // Defense-in-depth: ensure content is always a string (never [object Object]).
  const safeContent = typeof message.content === "string"
    ? message.content
    : message.content == null ? ""
    : typeof message.content === "object"
      ? (message.content as Record<string, unknown>).message
        ? String((message.content as Record<string, unknown>).message)
        : JSON.stringify(message.content)
      : String(message.content);
  if (message.meta?.toolResult) {
    return (
      <div className="toolResultLine">
        <Check size={13} />
        <span>{safeContent}</span>
      </div>
    );
  }
  const isUser = message.role === "user";

  const copyText = async () => {
    const ok = await copyToClipboard(safeContent);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  // Extract persisted activity steps from message meta
  const persistedSteps = (message.meta?.activitySteps as AgentActivityStep[] | undefined) ?? [];
  const persistedComplete = Boolean(message.meta?.activityComplete);

  return (
    <article className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="messageLabelRow">
        <span className="messageLabel">{isUser ? "You" : "Latex"}</span>
        {!isUser && (message.model || message.provider) && (
          <span className="messageModelLabel">{modelDisplayName(message.model, message.provider)}</span>
        )}
        <span className="messageTimestamp">{formatTime(message.createdAt)}</span>
        {!isUser && message.completedAt && message.startedAt && (
          <span className="messageDuration">{((message.completedAt - message.startedAt) / 1000).toFixed(1)}s</span>
        )}
        <div className="messageActions">
          <button className="msgAction" title="Copy" onClick={() => void copyText()}>
            {copied ? <Check size={12} /> : <Clipboard size={12} />}
          </button>
          {isUser ? (
            <button className="msgAction" title="Edit" onClick={() => onEditMessage(message.id)}>
              <Pencil size={12} />
            </button>
          ) : (
            !streaming && !busy && (
              <button className="msgAction" title="Regenerate" onClick={() => onRegenerate(message.id)}>
                <RefreshCw size={12} />
              </button>
            )
          )}
        </div>
      </div>
      {/* Show persisted activity steps if available (survives restart) */}
      {!isUser && persistedSteps.length > 0 && (
        <MessageActivity steps={persistedSteps} complete={persistedComplete} />
      )}
      {isUser ? (
        <div className="messageText userText">{safeContent}</div>
      ) : (
        <div className="messageText markdown">
          <ReactMarkdown
            components={{
              pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              a: ({ children, ...rest }) => (
                <a {...rest} target="_blank" rel="noreferrer">{children}</a>
              )
            }}
          >
            {safeContent}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
}

/** Extract plain text from react-markdown's code children (string | array). */
function extractText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object") {
    const candidate = node as { props?: { children?: unknown } };
    if (candidate.props?.children !== undefined) return extractText(candidate.props.children);
  }
  return "";
}

/** Compact persisted activity display inside assistant messages. */
function MessageActivity({ steps, complete }: { steps: AgentActivityStep[]; complete: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = steps.filter((s) => s.status === "done").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const totalSteps = steps.length;

  return (
    <div className="msgActivity">
      <div className="msgActivityHeader" onClick={() => setExpanded((c) => !c)} style={{ cursor: "pointer" }}>
        <span className="msgActivityIcon">
          {complete ? (
            failedCount > 0 ? <X size={11} className="msgActivityIconFail" /> : <Check size={11} className="msgActivityIconDone" />
          ) : (
            <span className="msgActivityDot" />
          )}
        </span>
        <span className="msgActivityTitle">
          {complete
            ? failedCount > 0
              ? `Worked \u00b7 ${totalSteps} step${totalSteps === 1 ? "" : "s"} (${failedCount} failed)`
              : `Worked \u00b7 ${totalSteps} step${totalSteps === 1 ? "" : "s"}`
            : `Working \u00b7 ${doneCount}/${totalSteps} steps`
          }
        </span>
        <span className="msgActivityToggle">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
      </div>
      {expanded && (
        <div className="msgActivitySteps">
          {steps.map((step) => (
            <div key={step.id} className={`msgActivityStep ${step.status}`}>
              <span className="msgActivityStepIcon">
                {step.status === "done" ? <Check size={9} /> : step.status === "active" ? <Spinner size={9} /> : step.status === "failed" ? <X size={9} /> : <span className="msgActivityStepPending" />}
              </span>
              <span className="msgActivityStepLabel">{step.label}</span>
              {step.detail && <span className="msgActivityStepDetail">{step.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeElement = children as React.ReactElement<{ className?: string; children?: React.ReactNode }> | null;
  const text = extractText(codeElement?.props?.children);
  const lang = (codeElement?.props?.className ?? "").replace(/^language-/, "");

  const copy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <div className="codeBlock">
      <div className="codeBlockHead">
        <span className="codeBlockLang">{lang || "code"}</span>
        <button className="codeCopy" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Clipboard size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ChangeCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <button className="btn sm" onClick={() => void copy()}>
      {copied ? <Check size={12} /> : <Clipboard size={12} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function ActivityTimeline({ steps, complete, busy }: { steps: AgentActivityStep[]; complete: boolean; busy: boolean }) {
  const [collapsed, setCollapsed] = useState(() => true);
  const doneCount = steps.filter((s) => s.status === "done").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const activeStep = steps.find((s) => s.status === "active");

  // CRITICAL: ALL hooks must be called BEFORE any early returns.
  // Moving this useEffect above the early return fixes React error #310.
  useEffect(() => {
    if (complete) {
      const timer = setTimeout(() => setCollapsed(true), 1200);
      return () => clearTimeout(timer);
    } else if (steps.length > 0) {
      setCollapsed(false);
    }
  }, [complete, steps.length]);

  // If no structured steps yet, show a clean thinking indicator
  if (steps.length === 0) {
    if (!busy) return null;
    return (
      <div className="activityThinking">
        <Spinner size={12} />
        <span>Thinking<span className="dots">...</span></span>
      </div>
    );
  }

  const isExpanded = !collapsed;

  return (
    <div className="activityCodex">
      <div className="activityCodexHeader" onClick={() => setCollapsed((c) => !c)} style={{ cursor: "pointer" }}>
        <span className="activityCodexIcon">
          {complete ? (
            failedCount > 0 ? <X size={13} className="activityIconFail" /> : <Check size={13} className="activityIconDone" />
          ) : busy ? (
            <Spinner size={13} />
          ) : (
            <Check size={13} />
          )}
        </span>
        <span className="activityCodexTitle">
          {complete
            ? failedCount > 0
              ? `Completed with ${failedCount} issue${failedCount === 1 ? "" : "s"}`
              : `${doneCount} step${doneCount === 1 ? "" : "s"}`
            : activeStep?.label || "Working..."
          }
        </span>
        <span className="activityCodexToggle">
          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </div>
      {isExpanded && (
        <div className="activityCodexSteps">
          {steps.map((step) => (
            <div key={step.id} className={`activityCodexStep ${step.status}`}>
              <span className="activityCodexStepIcon">
                {step.status === "done" ? <Check size={11} /> : step.status === "active" ? <Spinner size={11} /> : step.status === "failed" ? <X size={11} /> : <span className="activityStepPending" />}
              </span>
              <span className="activityCodexStepLabel">{step.label}</span>
              {step.detail && <span className="activityCodexStepDetail">{step.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
