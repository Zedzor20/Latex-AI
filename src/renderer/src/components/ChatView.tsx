import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  FileDiff,
  FileText,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  X
} from "lucide-react";
import { DiffLines } from "./DiffLines";
import type { AgentActivityStep, AgentTaskPhase, AgentTaskTimings, ApprovalRequest, ChatMessage, FileOperationPreview, GeneratedImage, ModelProvider, PendingChange } from "../../../shared/types";
import { phaseLabel } from "../lib/phases";
import { activityCountLabel, activityCounts, activityPhase } from "../../../shared/taskActivity";
import { normalizeThinkingText } from "../../../shared/thinkingText";
import { activeFileOperationPath } from "../../../shared/fileOperations";
import { shouldAutoFollow, resolveFollowTarget } from "../../../shared/scrollFollow";
import { RequestStatus } from "./RequestStatus";

/** Short model name for display. */
function modelDisplayName(modelName?: string, provider?: ModelProvider): string {
  if (!modelName) return "";
  // Strip provider prefixes and models/ prefix for display
  const name = modelName.replace(/^models\//, "").replace(/^(openrouter|minimax|groq|puter)\//, "");
  const providerLabel = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "";
  return name + (providerLabel ? ` · ${providerLabel}` : "");
}

/**
 * Streaming-tail word-by-word reveal.
 *
 * During a live response, the moving tail is split into words and each word
 * fades in over ~0.2s as it crosses the reveal threshold — a burst of words
 * cascades instead of dumping all at once. The threshold is arrival-driven and
 * clears any backlog within ~0.7s, so the reveal can never fall behind a fast
 * stream (which would otherwise end with a visible dump). Words that have
 * already appeared keep their stable keys across tail growth, so they stay
 * visible and never re-animate. Only the in-flight tail uses this; a finished
 * message renders through the normal MarkdownView path.
 */
function StreamingTail({ text }: { text: string }) {
  const { pieces, total } = useMemo(() => {
    const out: Array<{ kind: "word" | "br"; i: number; text?: string }> = [];
    let wordI = 0;
    let idx = 0;
    while (idx < text.length) {
      const ch = text[idx];
      if (ch === "\n") { out.push({ kind: "br", i: idx }); idx++; }
      else if (/\s/.test(ch)) { idx++; }
      else {
        let j = idx;
        while (j < text.length && !/\s/.test(text[j]) && text[j] !== "\n") j++;
        out.push({ kind: "word", i: wordI, text: text.slice(idx, j) });
        wordI++; idx = j;
      }
    }
    return { pieces: out, total: wordI };
  }, [text]);

  const revealedRef = useRef(0);
  const [, bump] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);

  useEffect(() => {
    if (total === 0) { revealedRef.current = 0; return; }
    if (revealedRef.current > total) revealedRef.current = total;
    if (revealedRef.current >= total) return;
    lastRef.current = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - lastRef.current) / 1000);
      lastRef.current = now;
      const backlog = total - revealedRef.current;
      if (backlog > 0) {
        // 0.2s per word (5 words/s) in the normal case; a large backlog is
        // cleared within ~0.7s so the reveal tracks the stream instead of
        // falling behind and jumping at the end.
        const rate = Math.max(5, backlog / 0.7);
        const advance = Math.max(1, Math.round(dt * rate));
        revealedRef.current = Math.min(total, revealedRef.current + advance);
        bump((n) => n + 1);
      }
      rafRef.current = revealedRef.current < total ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [total]);

  const revealed = revealedRef.current;
  return (
    <span className="streamTail">
      {pieces.map((p) =>
        p.kind === "br" ? (
          <br key={`br${p.i}`} />
        ) : (
          <span key={`w${p.i}:${p.text}`} className={`word${p.i < revealed ? " on" : ""}`}>
            {p.text}
          </span>
        )
      )}
    </span>
  );
}

import type { ErrorInfo } from "../lib/errors";
import { diffStats } from "../lib/format";
import { Spinner } from "./ui";

/** Review-row label for the net effect of the turn on a file. */
const KIND_LABELS: Record<"created" | "modified" | "deleted" | "renamed", string> = {
  created: "Created",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed"
};

interface ChatViewProps {
  messages: ChatMessage[];
  stream?: string;
  busy: boolean;
  activity: string[];
  activitySteps: AgentActivityStep[];
  activityComplete: boolean;
  /** When the current response started — drives this response's own timer. */
  turnStartedAt?: number | null;
  /**
   * Latest high-level APPLICATION status from the main process (real events
   * only). Rendered in the Agent Activity timeline header only — never in the
   * Thinking box, which carries provider-exposed reasoning only. The two are
   * separate channels and must not share content.
   */
  activityStatus?: string;
  /** True when the selected model's provider exposes thinking we can show. */
  thinkingAvailable?: boolean;
  /**
   * True only when the model's provider actually exposes reasoning text.
   * When false the Thinking box still shows (it is a real processing state) but
   * never pretends reasoning is coming — no text is invented to fill it.
   */
  thinkingExposesReasoning?: boolean;
  /** Live, aggregated per-file previews of real Main Agent file operations. */
  fileOperations?: FileOperationPreview[];
  /** End state of the current response: none while running. */
  turnOutcome?: "stopped" | "error" | null;
  /** Real request phase + timing milestones reported by the main process. */
  phase?: AgentTaskPhase | null;
  timings?: AgentTaskTimings | null;
  appMode: "main" | "chat";
  approval: ApprovalRequest | null;
  onApproveApproval: () => void;
  onRejectApproval: () => void;
  pendingChanges: PendingChange[];
  error: ErrorInfo | null;
  modelLabel: string;
  onOpenDiff: () => void;
  /**
   * Open the Change Review for ONE message's PERSISTED records.
   *
   * A reopened conversation reviews the turn that message really produced,
   * never whatever turn happens to be live in the renderer — the two are
   * separate things and must not borrow each other's state.
   */
  onOpenPersistedReview?: (changes: PendingChange[]) => void;
  onErrorAction: (action: "settings" | "retry" | "fixModel" | "openFolder") => void;
  onOpenInExplorer: (relativePath: string) => void;
  onRegenerate: (messageId: string) => void;
  onEditMessage: (messageId: string) => void;
  /**
   * The persisted chat currently open, or null when nothing is selected. Used
   * as the "a chat was opened" signal for the one-shot jump to the end.
   */
  selectedChatId?: string | null;
  thinkingText?: string;
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
    turnStartedAt,
    turnOutcome,
    phase,
    timings,
    appMode,
    approval,
    onApproveApproval,
    onRejectApproval,
    pendingChanges,
    error,
    modelLabel,
    onOpenDiff,
    onOpenPersistedReview,
    onErrorAction,
    onOpenInExplorer,
    onRegenerate,
    onEditMessage,
    selectedChatId,
    thinkingText: thinkingRaw,
    activityStatus: activityStatusText,
    thinkingAvailable,
    thinkingExposesReasoning,
    fileOperations
  } = props;

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cushionRef = useRef<HTMLDivElement>(null);
  // Send-anchor state. `anchorIdRef` is the DOM target of the message the user
  // just sent; `anchorModeRef` says the conversation is currently pinned to it.
  const anchorModeRef = useRef(false);
  const anchorIdRef = useRef<string | null>(null);
  const lastUserIdRef = useRef<string | null>(null);
  const lastAnchoredUserIdRef = useRef<string | null>(null);
  // Latest messages, read by effects that must not depend on the array identity
  // (it changes on every streamed delta).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
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

  // Opening a chat is an explicit "show me this conversation" action: jump to
  // the latest message ONCE, after the messages are actually in the DOM. The
  // jump happens in a layout effect (before paint) so a long persisted chat
  // never renders at the top and then visibly slides down. From then on the
  // reader owns the scroll position — the auto-follow guard below resumes only
  // when they come back to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Switching chats is not a Send: drop any send-anchor so a stream that is
    // still running in the chat we LEFT can never reposition the one we just
    // opened. Opening a chat keeps its own one-shot "show me the end" jump.
    anchorModeRef.current = false;
    anchorIdRef.current = null;
    holdAfterTurnRef.current = false;
    cushion(0);
    const toBottom = () => { el.scrollTop = el.scrollHeight; };
    nearBottomRef.current = true;
    toBottom();
    const frame = requestAnimationFrame(toBottom);
    // Long chats with images/markdown can finish laying out a tick later.
    const settle = window.setTimeout(toBottom, 60);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); };
  }, [selectedChatId]);

  // Auto-follow: only chase new activity when the user is already near the
  // bottom. If they scrolled up to read, leave them alone; when they come
  // back down, normal auto-follow resumes.
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onNearScroll = () => {
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < followThreshold();
    };
    el.addEventListener("scroll", onNearScroll, { passive: true });
    onNearScroll();
    return () => el.removeEventListener("scroll", onNearScroll);
  }, []);

  // ── Who owns the scroll position ────────────────────────────────────
  //
  // The reader. Always. Automatic scrolling may only ever REVEAL something new
  // (move down); it may never pull the view back towards older content. Two
  // rules enforce that and nothing else does:
  //
  //   1. a REAL gesture (wheel, drag, touch, key) silences automatic scrolling
  //      for USER_GRACE_MS, so a reader scrolling inside the follow threshold is
  //      never nudged on the next frame;
  //   2. a follow is a clamp DOWNWARD to the newest content, never a re-apply of
  //      an older target.
  //
  // Deliberately bound to gestures rather than to `scroll` events: a
  // programmatic scrollTo also fires `scroll`, so counting those as user intent
  // would silently disable following for the rest of the turn.
  const lastUserScrollAtRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onGesture = () => { lastUserScrollAtRef.current = Date.now(); };
    el.addEventListener("wheel", onGesture, { passive: true });
    el.addEventListener("touchstart", onGesture, { passive: true });
    el.addEventListener("touchmove", onGesture, { passive: true });
    el.addEventListener("pointerdown", onGesture, { passive: true });
    el.addEventListener("keydown", onGesture);
    return () => {
      el.removeEventListener("wheel", onGesture);
      el.removeEventListener("touchstart", onGesture);
      el.removeEventListener("touchmove", onGesture);
      el.removeEventListener("pointerdown", onGesture);
      el.removeEventListener("keydown", onGesture);
    };
  }, []);

  // Frame-aligned follow.
  //
  // Reading `scrollHeight` forces a synchronous layout, so coalescing every
  // request — token, thinking delta, activity step — into at most ONE
  // measurement per frame is what keeps a growing document cheap. While the
  // send-anchor is active it holds the anchored message in place and lets the
  // answer grow beneath it; otherwise it is a plain near-bottom follow.
  const followFrameRef = useRef<number | null>(null);

  // ── Send → anchor ───────────────────────────────────────────────────
  // The conversation is repositioned on exactly ONE event: the rising edge of a
  // turn (the user pressed Send). The target is the REAL DOM element of the
  // just-sent user message, measured only after React laid it out — never raw
  // scrollHeight maths that breaks under a different window size.
  //
  // Contract:
  //   • the just-sent message sits near the top (ANCHOR_FRACTION of the
  //     viewport) with the answer area below it;
  //   • a trailing "cushion" supplies that empty room while the answer is
  //     still shorter than the space, and shrinks to nothing as it grows;
  //   • once the answer outgrows the room the anchor degrades into a normal
  //     bottom-follow — and only while the reader is near the bottom.
  const ANCHOR_FRACTION = 0.24;
  // Bottom zone that counts as "the reader is following the response".
  const FOLLOW_THRESHOLD_PX = 140;
  // How long a real user gesture outranks automatic following.
  const USER_GRACE_MS = 1200;
  const followThreshold = () =>
    Math.min(FOLLOW_THRESHOLD_PX, Math.max(80, (scrollRef.current?.clientHeight ?? 0) * 0.2));
  const cushion = (height: number) => {
    const el = cushionRef.current;
    if (!el) return;
    const next = height > 1 ? `${Math.round(height)}px` : "0px";
    if (el.style.height !== next) el.style.height = next;
  };

  /**
   * Position the just-sent message at ANCHOR_FRACTION of the viewport.
   *
   * Returns whether the anchor still HOLDS — i.e. whether the answer is still
   * shorter than the room beneath the anchored message.
   *
   * That return value is the fix for the scroll fight. The cushioned target is
   * `min(desired, maxScroll)` and, while a cushion exists, `maxScroll` always
   * equals `desired` — so the anchor pinned the sent message at 24% of the
   * viewport for the ENTIRE response, no matter how long it grew. Every follow
   * re-applied that old target, so a reader who scrolled down to watch the
   * newest text arrive was dragged straight back up. Now the anchor releases as
   * soon as the answer outgrows its room (`need <= 0`), clears itself, and the
   * turn continues as an ordinary downward follow that can never be re-pinned.
   */
  const applyAnchor = useCallback((behavior: ScrollBehavior): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const marker = anchorIdRef.current ? markerRefs.current.get(anchorIdRef.current) : undefined;
    const viewport = el.clientHeight;
    if (!marker || viewport <= 0) {
      anchorIdRef.current = null;
      anchorModeRef.current = false;
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
      return false;
    }
    // The anchored message's top inside the scroller's content space, measured
    // against the scroller's own rect so it is independent of the current
    // scroll offset and of the offsetParent.
    const containerTop = el.getBoundingClientRect().top;
    const markerTop = marker.getBoundingClientRect().top - containerTop + el.scrollTop;
    const anchorY = Math.min(300, Math.max(56, Math.round(viewport * ANCHOR_FRACTION)));
    const desired = Math.max(0, markerTop - anchorY);

    // Cushion: the trailing room needed to make `desired` reachable at all.
    // Measured against the layout WITHOUT the current cushion.
    const current = cushionRef.current?.offsetHeight ?? 0;
    const naturalMax = Math.max(0, el.scrollHeight - current - viewport);
    const need = Math.max(0, Math.ceil(desired - naturalMax));
    if (Math.abs(need - current) > 1) cushion(need);

    const maxScroll = Math.max(0, el.scrollHeight - viewport);
    const target = Math.min(desired, maxScroll);
    if (behavior === "smooth") {
      el.scrollTo({ top: target, behavior: "smooth" });
    } else if (Math.abs(el.scrollTop - target) > 0.5) {
      el.scrollTop = target;
    }
    if (need <= 0) {
      // The answer now reaches the bottom of the viewport: the anchor has done
      // its job. Release it so the newest text stays on screen.
      anchorIdRef.current = null;
      anchorModeRef.current = false;
      return false;
    }
    return true;
  }, []);

  // After a turn ends NOTHING may move the conversation. The position the
  // send-anchor established — the just-sent message near the top, the answer
  // below it — is the resting state; a later content change (the live thinking
  // panel collapsing, the answer re-rendering as markdown, a notice row
  // appearing) must not re-measure it and must never fall back to
  // scrollHeight. The flag is dropped by the next Send.
  const holdAfterTurnRef = useRef(false);

  const followIfNearBottom = useCallback(() => {
    if (followFrameRef.current !== null) return;
    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      // WHO owns the position right now is a pure decision (see
      // shared/scrollFollow.ts) so the rule can be tested on its own.
      if (!shouldAutoFollow({
        nearBottom: nearBottomRef.current,
        sinceUserGestureMs: Date.now() - lastUserScrollAtRef.current,
        graceMs: USER_GRACE_MS,
        holdAfterTurn: holdAfterTurnRef.current
      })) return;
      // While the send-anchor still holds it decides the position; the moment it
      // releases, this becomes a plain follow to the newest content.
      if (anchorIdRef.current && applyAnchor("auto")) return;
      // Where to go is the other half of the rule, and it is DOWNWARD ONLY: a
      // follow may reveal newer content, never pull the reader back towards
      // older content. `null` means "leave the reader alone".
      const target = resolveFollowTarget({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      });
      if (target !== null) el.scrollTop = target;
    });
  }, [applyAnchor]);

  // The turn's end is the reader's moment, not the app's: never re-scroll on the
  // busy → idle transition. The position the send-anchor established (or the
  // bottom the reader was already at) is preserved.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy) {
      holdAfterTurnRef.current = true;
      return;
    }
    followIfNearBottom();
  }, [messages.length, stream, activity.length, activitySteps.length, pendingChanges.length, approval, busy, error, activityComplete, turnOutcome, turnStartedAt, thinkingRaw, followIfNearBottom]);

  // Remember the last user message that was on screen while IDLE. A run that
  // turns busy for a turn which was already sent (app reopened mid-response) is
  // therefore never mistaken for a fresh Send and never repositions the chat.
  useEffect(() => {
    if (busy) return;
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === "user");
    lastUserIdRef.current = lastUser?.id ?? null;
  }, [busy]);

  // Rising edge of a turn → the send-anchor. A double rAF waits for the message
  // (and any image/file inside it) to be laid out before measuring; the later
  // settle catches a late image load without re-scrolling when nothing moved.
  useEffect(() => {
    if (!busy) {
      // Turn finished: stop re-applying the anchor but LEAVE the layout exactly
      // as the reader left it. Collapsing the cushion here shrinks the content,
      // the browser clamps scrollTop, and the conversation visibly drags back —
      // pulling older messages into view. Keeping it means "bottom" still equals
      // the anchored position, so nothing moves when the response ends.
      anchorModeRef.current = false;
      anchorIdRef.current = null;
      return;
    }
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (!lastUser || lastUser.id === lastUserIdRef.current) return;
    lastAnchoredUserIdRef.current = lastUser.id;
    anchorIdRef.current = lastUser.id;
    anchorModeRef.current = true;
    nearBottomRef.current = true;
    // A new Send re-arms auto-follow for the turn that is starting.
    holdAfterTurnRef.current = false;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => applyAnchor("smooth"));
    });
    const settle = window.setTimeout(() => {
      if (anchorModeRef.current && nearBottomRef.current) applyAnchor("smooth");
    }, 170);
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
      window.clearTimeout(settle);
    };
  }, [busy, applyAnchor]);

  // Safety follow for content that grows without changing any tracked prop (an
  // error card, tool-result lines between step updates). Frame-aligned and
  // low-rate; every real content change is already covered above.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(followIfNearBottom, 400);
    return () => window.clearInterval(id);
  }, [busy, followIfNearBottom]);
  // Never leave a queued frame behind when this view goes away.
  useEffect(() => () => {
    if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current);
  }, []);

  // ── Layer 1: the live real-time Thinking box ────────────────────────
  // Thinking is PROVIDER REASONING AND NOTHING ELSE.
  //
  // The only content this box may ever render is the model's own reasoning /
  // thought summary, exactly as its provider streamed it (Gemini thought
  // summaries, DeepSeek/Qwen/GLM reasoning_content, Ollama thinking, Puter
  // reasoning chunks, MiniMax reasoning_details). It is updated on EVERY delta,
  // while the model is still working, and never after the fact.
  //
  // Nothing else belongs here. Request lifecycle ("Waiting for model
  // response..."), tool work ("Reading x.ts", "Running npm test") and any other
  // application progress are the AGENT ACTIVITY channel and the request-status
  // row; they share no state with this box. Reasoning is normalized for DISPLAY
  // (escape decoding + markdown noise) on the accumulated buffer, so an escape
  // sequence split across two stream chunks is decoded only once its pair has
  // arrived.
  // Memoized on the RAW reasoning only: ChatView re-renders on every streamed
  // token (~30-60×/s), and re-running the whole-buffer normalization on each of
  // those unrelated renders is what made long reasoning look like it only
  // settled at the end. It now re-normalizes exactly when reasoning arrives.
  const liveThinking = useMemo(
    () => (thinkingRaw && thinkingRaw.trim() ? normalizeThinkingText(thinkingRaw) : ""),
    [thinkingRaw]
  );
  const thinkingDisplay = liveThinking;
  // The box exists whenever the Thinking EXPERIENCE is available for this model
  // (`thinkingAvailable`) or real reasoning has actually arrived. GPT/Claude
  // models qualify through `thinkingAvailable` even though their provider exposes
  // no reasoning — in that case the box shows only the state and timer, and no
  // reasoning text is ever invented to keep it looking busy.
  const thinkingCapable = Boolean(thinkingAvailable) || Boolean(liveThinking);
  // The lone pre-reasoning state: a temporary transport notice, replaced the
  // instant the first real reasoning delta arrives. It never says "Waiting for
  // model response" — that is a REQUEST state, not thinking.
  const thinkingWaiting = "Waiting for thinking…";
  const thinkingStreaming = Boolean(liveThinking);
  // The elapsed timer, the open/closed state and the reasoning scroll-follow all
  // live INSIDE <ThinkingBox> below. That is deliberate: a clock that ticks
  // twice a second, or a reasoning delta landing, must re-render the Thinking
  // panel ONLY — never the conversation around it. This component therefore
  // holds no thinking tick state and no thinking scroll refs.

  // Split so the live thinking block sits ABOVE the streaming answer.
  const regularMessages = useMemo(() => messages.filter((m) => !m.meta?.streaming), [messages]);
  const streamMsg = useMemo(() => messages.find((m) => Boolean(m.meta?.streaming)), [messages]);
  // Live activity panel: visible while this response is running, or while it
  // holds an unfinalized error/stop state. On success the saved message row
  // takes over, so exactly ONE collapsed activity row exists per response.
  // The activity panel is a MAIN-agent concept. Chat is a plain conversation:
  // it never shows an agent activity box, and it never shows the Thinking box.
  const showLiveActivity = appMode !== "chat" && ((busy && !activityComplete) || activitySteps.length > 0 || turnOutcome != null);
  // The live response status row ("● Working · 4s"). Exactly ONE status surface
  // is ever on screen: when the activity timeline is visible (Main mode) the
  // timeline already carries the phase label and the elapsed time, so this row
  // stands down rather than showing a second, competing timer. Chat has no
  // timeline, so the row is the status there. It appears on the very first
  // render after Send because `busy` is set synchronously there.
  // While the model has produced nothing visible yet, the THINKING surface owns
  // the turn (its label + clock). Without this the status row would show a
  // second, competing timer for the very same wait. Once answer text starts
  // arriving the row takes over ("Responding") and Thinking stops being active
  // — this is the WORKING → THINKING → RESPONDING transition, with no invented
  // content anywhere in it.
  const answering = Boolean(streamMsg?.content && streamMsg.content.trim().length > 0);
  const thinkingSurface = Boolean(busy && thinkingCapable && !answering && !showLiveActivity);
  const showRequestStatus = !showLiveActivity && !thinkingSurface && (busy || turnOutcome != null);
  // True only once the model has ACTUALLY streamed reasoning for this turn, so
  // the row can say "Thinking" without inventing a thinking channel.
  const thinkingActiveNow = Boolean(liveThinking);
  // How many files THIS turn touched — drives the live card's visibility only.
  // The rows, their diffs and their stats live inside `ChangeReviewCard`, which
  // is also what rebuilds the card from a message's PERSISTED records, so the
  // live turn and a reopened conversation render the same thing from the same
  // code and can never drift apart.
  const pendingCount = useMemo(
    () => pendingChanges.filter((c) => c.status !== "rejected").length,
    [pendingChanges]
  );

  /**
   * The LIVE card for the turn that is running (or just finished). Once the
   * assistant message carries its own persisted records, the message renders
   * them instead and this one stands down — see `cardAfterMessageId` below.
   */
  const changesCard = pendingCount > 0 ? (
    <ChangeReviewCard
      changes={pendingChanges}
      onReview={onOpenDiff}
      onOpenInExplorer={onOpenInExplorer}
    />
  ) : null;

  /**
   * Open one message's PERSISTED Change Review in the viewer.
   *
   * It falls back to the live review when no dedicated handler is wired, so the
   * button can never become a no-op.
   */
  const openPersistedReview = useCallback(
    (changes: PendingChange[]) => {
      if (onOpenPersistedReview) onOpenPersistedReview(changes);
      else onOpenDiff();
    },
    [onOpenPersistedReview, onOpenDiff]
  );

  /**
   * The change card belongs to the END of Latex's finished response — it is the
   * task result, not part of the user's prompt. While a run is still going it is
   * pinned to the live area (below the activity timeline) so progress stays
   * visible; once the run finishes it moves under the assistant's message.
   */
  const lastRegular = regularMessages[regularMessages.length - 1];
  // Once the last answer carries its OWN persisted Change Review, that record
  // is the one on screen. Without this the finished turn would render twice:
  // once from the live array and once from the message.
  const lastRegularHasReview = Boolean(
    lastRegular?.role === "assistant"
    && (lastRegular.meta?.reviewChanges as PendingChange[] | undefined)?.length
  );
  const cardAfterMessageId = !busy && !lastRegularHasReview && lastRegular?.role === "assistant" ? lastRegular.id : null;

  // Fixed marker spacing: 28px per marker
  const MARKER_GAP = 28;

  return (
    <div className="chat">
      <div className="chatScroll" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="chatEmpty">Ask Latex to inspect a project, build something, review code, or fix an issue.</div>
        )}

        {regularMessages.map((message) => (
          <Fragment key={message.id}>
            <div
              ref={(el) => { if (el && message.role === 'user') markerRefs.current.set(message.id, el); else if (message.role === 'user') markerRefs.current.delete(message.id); }}
            >
              <MessageBubble
                message={message}
                streaming={false}
                busy={busy}
                appMode={appMode}
                onRegenerate={onRegenerate}
                onEditMessage={onEditMessage}
              />
            </div>
            {/* Completed task review: rendered AFTER the assistant's answer, so
                the conversation reads prompt → response → change review. */}
            {message.id === cardAfterMessageId && pendingCount > 0 && changesCard}
            {/* The SAME card, rebuilt from the records persisted on this very
                message. This is what keeps "Agent changed 1 file / MODIFIED
                test.html / +13 -1 / Review" attached to the turn it belongs to
                after another message, a Chat/Main switch, a chat switch, a
                minimize and a full restart. */}
            <MessageChangeReview
              message={message}
              onReview={openPersistedReview}
              onOpenInExplorer={onOpenInExplorer}
            />
          </Fragment>
        ))}

        {/* Live Thinking box for the CURRENT response — appears above the
            streaming answer, in BOTH Main and Chat. It renders PROVIDER-EXPOSED
            reasoning the moment it streams and nothing else; it is strictly
            separate from the Agent Activity timeline below it. It is absent
            entirely for a model with no reasoning channel. */}
        {/* Visible while this response is running AND either real reasoning has
            arrived or the Thinking surface currently owns the turn. A UI-only
            box (GPT/Claude with no exposed reasoning) therefore fades out the
            moment the answer starts, leaving the response to speak for itself. */}
        {busy && thinkingCapable && (Boolean(liveThinking) || thinkingSurface) && (
          <ThinkingBox
            text={thinkingDisplay}
            waiting={thinkingWaiting}
            streaming={thinkingStreaming}
            startedAt={turnStartedAt}
            showElapsed={!showLiveActivity && thinkingSurface}
            expectsReasoning={Boolean(thinkingExposesReasoning)}
          />
        )}

        {/* Live response status — the answer to "is Latex doing something, and
            for how long?", from the moment Send is pressed. Sits directly above
            the streaming answer and never blocks the conversation. */}
        {showRequestStatus && (
          <RequestStatus
            busy={busy}
            phase={phase}
            timings={timings}
            startedAt={turnStartedAt}
            outcome={turnOutcome}
            thinkingActive={thinkingActiveNow}
          />
        )}

        {streamMsg && (
          <div key={streamMsg.id}>
            <MessageBubble
              message={streamMsg}
              streaming
              busy={busy}
              appMode={appMode}
              onRegenerate={onRegenerate}
              onEditMessage={onEditMessage}
            />
          </div>
        )}

        {/* Live file-writing previews: the ACTUAL content the Main Agent is
            producing, streamed from real tool events (never fake typing). The
            currently-active file stays expanded; completed files collapse.
            When the turn finishes the message's own persisted record takes over
            (see MessageBubble), so this never leaves a duplicate behind. */}
        {appMode !== "chat" && fileOperations && fileOperations.length > 0 && (
          <FileOperationPanel operations={fileOperations} />
        )}

        {/* Live AGENT activity — MAIN only. Chat stays a clean conversation. */}
        {showLiveActivity && (
          <ActivityTimeline
            steps={activitySteps}
            complete={activityComplete}
            busy={busy}
            startedAt={turnStartedAt}
            outcome={turnOutcome}
            kind="agent"
            phase={phase}
            timings={timings}
            statusText={activityStatusText}
          />
        )}

        {approval && (
          <ApprovalCard approval={approval} onApprove={onApproveApproval} onReject={onRejectApproval} />
        )}

        {/* While the run is live the card tracks progress under the activity
            timeline; when it completes the card above (after the answer) takes
            over, so it is never duplicated. */}
        {busy && pendingCount > 0 && changesCard}

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

        {/* Trailing room the send-anchor needs while the answer is still
            shorter than the viewport. Its height is written imperatively (never
            through state) so it can never re-render the conversation. */}
        <div ref={cushionRef} className="scrollCushion" aria-hidden="true" />
        <div ref={bottomRef} />
      </div>

      {/* RIGHT-side prompt navigation timeline with always-visible labels */}
      {userPrompts.length > 0 && (
        <>
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
        </>
      )}
    </div>
  );
}

/** Verb shown on a file-operation preview card. */
const FILE_OP_VERB: Record<FileOperationPreview["operation"], string> = {
  create: "Creating",
  write: "Writing",
  edit: "Editing",
  delete: "Deleting",
  rename: "Renaming",
  move: "Moving",
  copy: "Copying"
};

/**
 * Live file-writing preview panel.
 *
 * Renders one aggregated, COLLAPSIBLE card per file the Main Agent is writing.
 * Only the operation that is still in progress stays expanded by default; every
 * completed file collapses automatically, and repeated writes to one path keep
 * updating a single card. The content is the real preview buffer from the tool
 * arguments — there is no fabricated typing animation, and when a provider
 * streams no content the card says so honestly.
 */
const FileOperationPanel = memo(function FileOperationPanel({ operations }: { operations: FileOperationPreview[] }) {
  // Manual expand/collapse overrides; a path absent here uses the auto rule.
  const [manual, setManual] = useState<Record<string, boolean>>({});
  // The single most-recent in-progress operation is the one expanded by default.
  const activePath = useMemo(() => activeFileOperationPath(operations), [operations]);

  return (
    <div className="fileOpPanel">
      {operations.map((op) => {
        const expanded = manual[op.filePath] ?? (op.filePath === activePath);
        const verb = FILE_OP_VERB[op.operation] ?? "Writing";
        return (
          <div key={op.filePath} className={`fileOpCard ${op.status}`}>
            <button
              className="fileOpHead"
              onClick={() => setManual((m) => ({ ...m, [op.filePath]: !expanded }))}
              title={op.filePath}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="fileOpVerb">{verb}</span>
              <span className="fileOpPath">{op.filePath}</span>
              {op.operations > 1 && (
                <span className="fileOpOps" title={`${op.operations} separate writes were folded into this one entry`}>
                  {op.operations} changes
                </span>
              )}
              <span className="fileOpSpacer" />
              <span className={`fileOpBadge ${op.status}`}>
                {op.status === "writing" && (<><Loader2 size={12} className="spin" /> writing</>)}
                {op.status === "committed" && (<><Check size={12} /> {op.verified === false ? "written" : "verified"}</>)}
                {op.status === "failed" && (<><X size={12} /> failed</>)}
                {op.status === "stopped" && (<><X size={12} /> not committed</>)}
              </span>
            </button>
            {expanded && (
              <div className="fileOpBody">
                {op.preview !== undefined && op.preview.length > 0 ? (
                  <pre className="fileOpCode">{op.preview}</pre>
                ) : (
                  <div className="fileOpWaiting">
                    <Loader2 size={13} className="spin" /> Waiting for file content…
                  </div>
                )}
                {op.error && <div className="fileOpError">{op.error}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

/**
 * THE Change Review card — the net effect of ONE turn on the workspace.
 *
 * It renders from whatever record owns the turn: the live array while a task
 * runs, and the records PERSISTED on the assistant message afterwards. Both
 * paths share this component on purpose, so a reopened conversation shows the
 * exact same card and the two can never drift apart.
 *
 * Expansion state is local to the instance: two turns are two cards, and a
 * toggle in one must never move a row in the other.
 */
function ChangeReviewCard({
  changes,
  onReview,
  onOpenInExplorer
}: {
  changes: PendingChange[];
  onReview: () => void;
  onOpenInExplorer: (relativePath: string) => void;
}) {
  const [expandedChange, setExpandedChange] = useState<string | null>(null);
  // Rejected entries are not part of the turn's effect on the workspace.
  const visibleChanges = useMemo(
    () => changes.filter((c) => c.status !== "rejected"),
    [changes]
  );
  // Diff stats are the expensive part (they parse every diff). They depend ONLY
  // on the change-set, so they are computed once per change-set instead of on
  // every streamed token — the conversation re-renders ~30×/s. The `changes`
  // array comes straight off the message for a persisted review, so its
  // identity is stable and this memo genuinely holds.
  const changeStats = useMemo(() => {
    const map = new Map<string, { added: number; removed: number }>();
    for (const change of visibleChanges) map.set(change.id, diffStats(change.diff));
    return map;
  }, [visibleChanges]);
  const totalStats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const stats of changeStats.values()) { added += stats.added; removed += stats.removed; }
    return { added, removed };
  }, [changeStats]);
  if (visibleChanges.length === 0) return null;
  return (
    <div className="changesCard">
      <div className="changesHead">
        <div className="changesTitle"><FileDiff size={15} /> Agent changed {visibleChanges.length} file{visibleChanges.length === 1 ? '' : 's'}</div>
        <div className="changesStats">
          <span className="statAdded">+{totalStats.added}</span>
          <span className="statRemoved">-{totalStats.removed}</span>
        </div>
        <div className="changesActions">
          <button className="btn sm" onClick={onReview}>Review</button>
        </div>
      </div>
      <div className="changesList">
        {visibleChanges.map((change) => {
            const stats = changeStats.get(change.id) ?? { added: 0, removed: 0 };
            const isOpen = expandedChange === change.id;
            // The agent already merged repeated writes to the same file into one
            // entry, so this list is one row per file with the net diff.
            const kind = change.kind ?? (change.existed === false ? "created" : "modified");
            return (
              <div key={change.id} className="changeRowWrap">
                <div className="changeRow" onClick={() => setExpandedChange(isOpen ? null : change.id)}>
                  {isOpen ? <ChevronDown size={13} className="changeChevron" /> : <ChevronRight size={13} className="changeChevron" />}
                  <span className={`changeKind ${kind}`}>{KIND_LABELS[kind]}</span>
                  <span className="changePath">
                    {change.renamedFrom ? `${change.renamedFrom} → ${change.filePath}` : change.filePath}
                  </span>
                  {change.description && <span className="changeDesc">{change.description}</span>}
                  {(change.operations ?? 1) > 1 && <span className="changeOpsCount">×{change.operations}</span>}
                  <span className="changesStats">
                    <span className="statAdded">+{stats.added}</span>
                    <span className="statRemoved">-{stats.removed}</span>
                  </span>
                  {/*
                    A single Change Review action (the header "Review" button)
                    is the one way to inspect changes. The per-row "preview the
                    final file" buttons were removed: they duplicated that
                    review with a whole-file view. Only "Open in Explorer"
                    remains, which is navigation, not a second review.
                  */}
                  <span className="changeActions">
                    <button
                      className="iconButton"
                      title="Reveal in Explorer"
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
  );
}

/**
 * A finished turn's Change Review, rebuilt from the records PERSISTED on its
 * message.
 *
 * The message — not the renderer, not the active task — owns the record. That
 * is what makes the card survive sending another message, switching Chat/Main,
 * switching chats, minimizing and restarting Latex, while the task that
 * produced it is long gone from memory.
 */
function MessageChangeReview({
  message,
  onReview,
  onOpenInExplorer
}: {
  message: ChatMessage;
  onReview: (changes: PendingChange[]) => void;
  onOpenInExplorer: (relativePath: string) => void;
}) {
  const records = message.meta?.reviewChanges as PendingChange[] | undefined;
  if (!records || records.length === 0) return null;
  return (
    <ChangeReviewCard
      changes={records}
      onReview={() => onReview(records)}
      onOpenInExplorer={onOpenInExplorer}
    />
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

/**
 * Memoized so a streamed token (which re-renders ChatView ~30×/s) never
 * re-parses the markdown of every message already in the conversation. A live
 * flush only replaces the STREAMING message object, so finished messages keep
 * their identity and skip rendering entirely. The handler props are ignored on
 * purpose — App resolves the current conversation through a ref, so a cached
 * handler can never act on a stale conversation.
 */
const MessageBubble = memo(MessageBubbleImpl, (prev, next) =>
  prev.message === next.message && prev.streaming === next.streaming && prev.busy === next.busy && prev.appMode === next.appMode
);

function MessageBubbleImpl({
  message,
  streaming,
  busy,
  appMode,
  onRegenerate,
  onEditMessage
}: {
  message: ChatMessage;
  streaming: boolean;
  busy: boolean;
  appMode: "main" | "chat";
  onRegenerate: (id: string) => void;
  onEditMessage: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // Defense-in-depth: ensure content is always a string (never [object Object]).
  const safeContent = typeof message.content === "string"
    ? message.content
    : message.content == null ? ""
    : typeof message.content === "object"
      ? (message.content as Record<string, unknown>).message
        ? String((message.content as Record<string, unknown>).message)
        : JSON.stringify(message.content)
      : String(message.content);
  // The streamed text renders IMMEDIATELY — never deferred, because a deferred
  // render is starved by the continuous stream of urgent updates and the
  // response visibly arrives in bursts instead of live.
  const markdownContent = safeContent;
  // Images the PROVIDER really generated for this message (persisted on meta,
  // or on the live streaming message). Rendered as pictures — never as text.
  const generatedImages = useMemo(() => {
    const imgs = message.meta?.generatedImages as GeneratedImage[] | undefined;
    if (!Array.isArray(imgs)) return [];
    return imgs.filter((img) => img && img.base64 && img.mimeType);
  }, [message.meta?.generatedImages]);
  // Extract persisted image attachments from message meta
  const imageAttachments = useMemo(() => {
    const atts = message.meta?.attachments as Array<{ id: string; name: string; kind: string; base64?: string; mimeType?: string; size?: number }> | undefined;
    if (!atts) return [];
    return atts.filter((a) => a.kind === "image" && a.base64 && a.mimeType);
  }, [message.meta?.attachments]);
  // Extract persisted FILE attachments from message meta — rendered as small
  // attachment cards (name/type/size). The extracted file CONTENT is never
  // shown as message text; the main process replays it to the model from meta,
  // so big files can't blow up the conversation (spec: compact attachment).
  const fileAttachments = useMemo(() => {
    const atts = message.meta?.attachments as
      | Array<{ id: string; name: string; kind: string; content?: string; truncated?: boolean; size?: number; label?: string }>
      | undefined;
    if (!atts) return [];
    return atts.filter(
      (a) =>
        (a.kind === "text" || a.kind === "workspace" || a.kind === "conversation") &&
        (a.content !== undefined || a.size !== undefined)
    );
  }, [message.meta?.attachments]);

  // ── Incremental Markdown for the ACTIVE response ─────────────────────
  // The expensive part of streaming was never the text update: it was running
  // the whole Markdown pipeline over the ENTIRE, ever-growing response on every
  // frame (O(n) per frame, O(n²) over the answer) — which is exactly why long
  // responses visibly degrade as they grow.
  //
  // So split the streamed text at the last COMPLETE top-level block. That prefix
  // can no longer change as more text arrives, which lets its parsed tree be
  // memoized: React reuses the identical element objects and re-parses only the
  // small moving tail. The split point is a blank line OUTSIDE any open code
  // fence, so ``` inside a code block never becomes a boundary and parsing the
  // halves is equivalent to parsing the whole. When the response finishes the
  // full text is parsed once — the same blocks, so nothing jumps.
  const { stablePrefix, liveTail } = useMemo(
    () => (streaming ? splitStableMarkdown(markdownContent) : { stablePrefix: "", liveTail: markdownContent }),
    [markdownContent, streaming]
  );
  // Parsed ONCE per newly-completed block — not once per frame. This is the
  // single biggest win: completed paragraphs/fences stop being re-parsed.
  const stableTree = useMemo(
    () => (stablePrefix ? <MarkdownView content={stablePrefix} /> : null),
    [stablePrefix]
  );
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

  // Extract persisted activity/thinking from message meta — every assistant
  // message owns its OWN collapsed activity row (survives restart).
  const persistedSteps = (message.meta?.activitySteps as AgentActivityStep[] | undefined) ?? [];
  // The durable FILE-ACTIVITY record for this message: same shape the live
  // panel renders, folded by the same reducer, stored WITH the message. It is
  // read straight back off the conversation, so it survives a chat switch, a
  // new message, minimize/restore and a full app restart — none of which used to
  // preserve it, because it only ever lived in renderer state.
  const persistedFiles = (message.meta?.fileOperations as FileOperationPreview[] | undefined) ?? [];
  const persistedComplete = Boolean(message.meta?.activityComplete);
  const persistedThinking = typeof message.meta?.thinking === "string" ? message.meta.thinking : "";
  const persistedStopped = Boolean(message.meta?.stopped);
  const persistedDuration = message.startedAt && message.completedAt
    ? formatDuration(Math.max(0, message.completedAt - message.startedAt))
    : undefined;

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
      {/* Persisted THINKING box — provider-exposed reasoning in its OWN box
          (survives restart). Present in BOTH modes: a Thinking RESPONSE box is
          not a Thinking MODE. It sits as a sibling of the activity row, never
          inside it. (The agent-activity row itself stays Main-only.) */}
      {!isUser && persistedThinking.trim() && (
        <MessageThinking
          thinking={persistedThinking}
          complete={persistedComplete}
          stopped={persistedStopped}
        />
      )}
      {/* Persisted AGENT ACTIVITY box — execution steps only. MAIN ONLY. */}
      {!isUser && appMode !== "chat" && persistedSteps.length > 0 && (
        <MessageActivity
          steps={persistedSteps}
          complete={persistedComplete}
          stopped={persistedStopped}
          durationFallback={persistedDuration}
        />
      )}
      {/* Persisted FILE ACTIVITY — what the task actually did to files, with
          how many real writes each one took. MAIN ONLY, like the live panel:
          Chat is a conversation and never edits the workspace. */}
      {!isUser && appMode !== "chat" && persistedFiles.length > 0 && (
        <FileOperationPanel operations={persistedFiles} />
      )}
      {isUser ? (
        <div className="messageText userText">
          {imageAttachments.length > 0 && (
            <div className="msgImageGrid">
              {imageAttachments.map((att) => (
                <button
                  key={att.id}
                  type="button"
                  className="msgImageThumb"
                  onClick={() => setLightboxSrc(`data:${att.mimeType};base64,${att.base64}`)}
                  title={att.name}
                >
                  <img src={`data:${att.mimeType};base64,${att.base64}`} alt={att.name} loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {fileAttachments.length > 0 && (
            <div className="fileAttachList">
              {fileAttachments.map((att) => {
                const meta = [formatBytes(att.size), att.truncated ? "partial" : ""]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div key={att.id} className="fileAttachCard" title={att.label ?? att.name}>
                    <FileText size={13} />
                    <span className="fileAttachName">{att.name}</span>
                    {meta && <span className="fileAttachMeta">{meta}</span>}
                  </div>
                );
              })}
            </div>
          )}
          {safeContent}
        </div>
      ) : (
        /*
         * ONE renderer for every provider and for both the streaming and the
         * finished message — `remark-gfm` adds the GitHub-flavoured extensions
         * (tables, strikethrough, task lists, autolinks) on top of CommonMark,
         * so GPT/Claude/DeepSeek/Qwen/Nemotron and Gemini build the same DOM.
         */
        <div className="messageText markdown">
          {/* Completed blocks: memoized, never re-parsed while the tail grows. */}
          {stableTree}
          {/* Live tail only: word-by-word reveal while the response streams.
              A finished message goes through MarkdownView so it never
              re-reveals word by word whenever the conversation re-renders.
              A tail containing an unfinished code fence keeps the Markdown
              renderer instead: code must keep its monospace/formatting while
              it arrives, and the word fade is a prose affordance. */}
          {streaming
            ? (liveTail
                ? (liveTail.includes("```")
                    ? <MarkdownView content={liveTail} />
                    : <StreamingTail text={liveTail} />)
                : null)
            : <MarkdownView content={liveTail} />}
        </div>
      )}
      {/* Real generated images (provider image output). Their own block — the
          picture is never mixed into the assistant prose or the activity rows,
          and no base64 ever appears as visible text. */}
      {!isUser && generatedImages.length > 0 && (
        <div className="msgImageGrid generatedImageGrid">
          {generatedImages.map((img) => (
            <button
              key={img.id}
              type="button"
              className="msgImageThumb"
              onClick={() => setLightboxSrc(`data:${img.mimeType};base64,${img.base64}`)}
              title={`${img.name} — click to view`}
            >
              <img src={`data:${img.mimeType};base64,${img.base64}`} alt={img.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {lightboxSrc && (
        <div className="imageLightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="Preview" />
          <button type="button" className="lightboxClose" onClick={() => setLightboxSrc(null)}>
            <X size={20} />
          </button>
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

/**
 * Persisted Thinking box for a saved response.
 *
 * The after-turn twin of the live Thinking box: it carries PROVIDER-EXPOSED
 * reasoning only, in its own collapsible box that sits as a SIBLING of the
 * Agent activity row — never inside it. This keeps the two streams (model
 * reasoning vs. real execution steps) independent before and after the turn,
 * and it is where a finished turn's thinking summary lives and collapses to.
 */
function MessageThinking({
  thinking,
  complete,
  stopped
}: {
  thinking: string;
  complete?: boolean;
  stopped?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = useMemo(() => normalizeThinkingText(thinking), [thinking]);
  if (!text.trim()) return null;
  return (
    <div className="thinkingBlock msgThinkingBlock">
      <button className="thinkingToggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="thinkingLabel">Thinking</span>
        {stopped ? (
          <span className="thinkingElapsed"> · stopped</span>
        ) : complete ? (
          <Check size={12} className="thinkingCheck" />
        ) : null}
        {!expanded && (
          <span className="thinkingPreview">
            {text.slice(0, 80)}{text.length > 80 ? "..." : ""}
          </span>
        )}
      </button>
      {expanded && <div className="thinkingContent">{text}</div>}
    </div>
  );
}

/** Compact persisted AGENT ACTIVITY display inside assistant messages. */
function MessageActivity({
  steps,
  complete,
  stopped,
  durationFallback
}: {
  steps: AgentActivityStep[];
  complete: boolean;
  stopped?: boolean;
  durationFallback?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = steps.filter((s) => s.status === "done").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const totalSteps = steps.length;

  // Compute total duration from first startedAt to last timestamp
  const totalDuration = useMemo(() => {
    if (steps.length === 0) return durationFallback;
    const first = steps[0];
    const start = first.startedAt ?? first.timestamp;
    const last = steps[steps.length - 1];
    const end = last.timestamp || Date.now();
    const ms = end - start;
    return ms > 0 ? formatDuration(ms) : durationFallback;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, durationFallback]);

  // One compact header per response — AGENT ACTIVITY ONLY. Provider thinking
  // is rendered by MessageThinking above this box, so nothing here ever claims
  // or contains model reasoning.
  //   stopped → "Stopped · 5.8s"
  //   done    → "Finished · 5 steps · 8.4s"
  //   running → "Working · 2/5 steps"
  const title = stopped
    ? `Stopped${totalDuration ? ` \u00b7 ${totalDuration}` : ""}`
    : complete
      ? failedCount > 0
        ? `Finished \u00b7 ${totalSteps} step${totalSteps === 1 ? "" : "s"} (${failedCount} failed)${totalDuration ? ` \u00b7 ${totalDuration}` : ""}`
        : `Finished \u00b7 ${totalSteps} step${totalSteps === 1 ? "" : "s"}${totalDuration ? ` \u00b7 ${totalDuration}` : ""}`
      : `Working \u00b7 ${doneCount}/${totalSteps} steps`;

  return (
    <div className="msgActivity">
      <div className="msgActivityHeader" onClick={() => setExpanded((c) => !c)} style={{ cursor: "pointer" }}>
        <span className="msgActivityIcon">
          {stopped ? (
            <X size={11} />
          ) : complete ? (
            failedCount > 0 ? <X size={11} className="msgActivityIconFail" /> : <Check size={11} className="msgActivityIconDone" />
          ) : (
            <span className="msgActivityDot" />
          )}
        </span>
        <span className="msgActivityTitle">{title}</span>
        <span className="msgActivityToggle">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
      </div>
      {expanded && (
        <div className="msgActivitySteps">
          {steps.map((step, index) => {
            const stepDur = step.duration ? formatDuration(step.duration) : undefined;
            return (
              <div key={step.id} className={`msgActivityStep ${step.status}`}>
                <div className="msgActivityStepRow">
                  <span className="msgActivityStepIcon">
                    {step.status === "done" ? <Check size={9} /> : step.status === "active" ? <Spinner size={9} /> : step.status === "failed" ? <X size={9} /> : <span className="msgActivityStepPending" />}
                  </span>
                  <span className="msgActivityStepLabel">{index + 1}. {step.label}</span>
                  <ActivityStepStatus step={step} />
                  {stepDur && <span className="msgActivityStepDuration">{stepDur}</span>}
                </div>
                <ActivityStepDetail step={step} detailClass="msgActivityStepDetail" />
              </div>
            );
          })}
          <ActivityStepCounts steps={steps} />
        </div>
      )}
    </div>
  );
}

/**
 * Live, real-operation count line for the activity panel.
 *
 * Derived only from steps that actually completed (a failed write is not a
 * created file) and deduplicated by path, so editing one file five times reads
 * as "1 edited" — exactly what the final receipt reports. Renders nothing when
 * no countable operation has happened yet. Uses the existing chip styling, so
 * the panel's look is unchanged.
 */
function ActivityStepCounts({ steps }: { steps: AgentActivityStep[] }) {
  const counts = useMemo(() => activityCounts(steps), [steps]);
  const label = activityCountLabel(counts);
  if (!label) return null;
  const chips = label.split(" • ");
  return (
    // Reuses the existing chip styling; `activityCounts` is only a hook so the
    // totals row is distinguishable from a single step's own chips.
    <div className="activityStepChips activityCounts" title="Real operations completed so far">
      {chips.map((chip) => (
        <span key={chip} className="activityStepChip">{chip}</span>
      ))}
    </div>
  );
}

/**
 * Right-aligned outcome chip for an activity row ("Success" / "Failed").
 * Thinking/planning rows keep their existing icon-only treatment.
 */
function ActivityStepStatus({ step }: { step: AgentActivityStep }) {
  if (!step.kind || step.kind === "thinking" || step.kind === "planning" || step.kind === "response") {
    return null;
  }
  const label = step.status === "done" ? "Success" : step.status === "failed" ? "Failed" : step.status === "active" ? "Running" : null;
  if (!label) return null;
  return <span className={`activityStepStatus ${step.status}`}>{label}</span>;
}

/**
 * Structured detail for one activity step: file line counts, process exit codes
 * and the expandable command output.
 *
 * This is the ACTIVITY channel — command output, stdout/stderr and file
 * operation detail live here and are never mixed into the assistant response.
 */
function ActivityStepDetail({ step, detailClass }: { step: AgentActivityStep; detailClass: string }) {
  const [open, setOpen] = useState(false);
  const chips: string[] = [];
  if (step.kind === "file_read" && typeof step.lines === "number") {
    chips.push(`${step.lines} line${step.lines === 1 ? "" : "s"} read`);
  }
  if (step.kind === "file_edit" && typeof step.lines === "number") {
    chips.push(`${step.lines} line${step.lines === 1 ? "" : "s"} written`);
  }
  if (step.kind === "command" && typeof step.exitCode === "number") {
    chips.push(`exit ${step.exitCode}`);
  }
  // A build / test / typecheck / lint run is the verification half of a coding
  // task; naming it "Testing" is what tells the user checks were really run.
  if (step.kind === "command" && activityPhase(step) === "Testing") chips.unshift("Testing");
  const output = step.output && step.output.trim() ? step.output : null;

  return (
    <>
      {step.detail && <span className={detailClass}>{step.detail}</span>}
      {chips.length > 0 && (
        <span className="activityStepChips">
          {chips.map((chip) => (
            <span key={chip} className="activityStepChip">{chip}</span>
          ))}
        </span>
      )}
      {output && (
        <>
          <button
            type="button"
            className="activityStepOutputToggle"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
          >
            {open ? "Hide output" : "Show output"}
          </button>
          {open && (
            <div className="activityStepOutput">
              {step.command && <div className="activityStepOutputCommand">{step.command}</div>}
              <pre className="activityStepOutputBody">{output}</pre>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The ONE Markdown renderer, shared by the streaming halves and the finished
 * message, so a provider's output produces the same DOM throughout — `remark-gfm`
 * adds the GitHub-flavoured extensions (tables, strikethrough, task lists,
 * autolinks) on top of CommonMark.
 */
/**
 * Providers hand back ALL kinds of Markdown, and two shapes of it used to
 * arrive as visible gibberish instead of a picture:
 *
 *  1. A line break between the image alt text and its destination
 *     (`![cat]\n(data:image/svg+xml;base64,…)`) — CommonMark then sees two
 *     paragraphs of plain text, so the `![cat](data:…)` was printed literally.
 *  2. A `data:` URL at all: react-markdown's default transform blanks it (it
 *     exists to stop `javascript:` payloads), so an inline picture silently
 *     became an empty `src`.
 *
 * `joinSplitImageDestinations` repairs shape 1 with a line-based pass — it only
 * ever merges a line that is nothing but a parenthesized payload onto a line
 * that ends with `![alt]`, so no other text can be touched.
 */
function joinSplitImageDestinations(text: string): string {
  if (!text.includes("![")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const splitDestination = next !== undefined && /^\s*\(\S[^\s]*\)\s*$/.test(next);
    const openDestination = /!\[[^\]]*\]\(\s*$/.test(line);
    if (openDestination && next !== undefined) {
      out.push(`${line}${next.trim()}`);
      i++;
      continue;
    }
    if (splitDestination && /!\[[^\]]*\]\s*$/.test(line)) {
      out.push(`${line.replace(/\s+$/, "")}${next.trim()}`);
      i++;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * URL policy for message Markdown: `data:image/…` is allowed on an `src` (that
 * is how a provider inlines a picture) and nowhere else — a `data:` href would
 * be a navigation the model chose for the user, and stays stripped.
 */
function safeUrlTransform(url: string, key: string): string {
  const value = (url ?? "").trim();
  if (key === "src" && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(value)) {
    return value;
  }
  return defaultUrlTransform(value);
}

function MarkdownView({ content }: { content: string }) {
  const repaired = useMemo(() => joinSplitImageDestinations(content), [content]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={safeUrlTransform}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        a: ({ children, ...rest }) => (
          <a {...rest} target="_blank" rel="noreferrer">{children}</a>
        ),
        // Tables need a horizontal scroll container: a wide comparison
        // must never widen the conversation column or overflow the panel.
        table: ({ children }) => (
          <div className="mdTableWrap"><table>{children}</table></div>
        )
      }}
    >
      {repaired}
    </ReactMarkdown>
  );
}

/**
 * Split streamed Markdown into an already-complete prefix and the live tail.
 *
 * The prefix ends at the last blank line that is OUTSIDE an open code fence, so
 * it contains only fully closed top-level blocks (a heading, a paragraph, a
 * list, a fenced block). Parsing that prefix is therefore equivalent to parsing
 * the same span of the whole document, and it never changes again as more text
 * arrives — which is what makes the expensive parse memoizable instead of
 * re-running over the whole, ever-growing response on every frame.
 *
 * Single linear pass, no regex per character: the fence tracking only needs to
 * look at the start of each line.
 */
function splitStableMarkdown(text: string): { stablePrefix: string; liveTail: string } {
  let openFence: string | null = null;
  let lastBoundary = -1;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      const line = text.slice(lineStart, i);
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        if (openFence === null) openFence = marker;
        else if (openFence === marker) openFence = null;
      } else if (openFence === null && line.trim() === "" && i + 1 < text.length) {
        // A blank line outside a fence closes the block before it. Splitting
        // here divides the document only between complete blocks.
        lastBoundary = i + 1;
      }
      lineStart = i + 1;
    }
  }
  if (lastBoundary <= 0) return { stablePrefix: "", liveTail: text };
  return { stablePrefix: text.slice(0, lastBoundary), liveTail: text.slice(lastBoundary) };
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

/** Human-readable byte size for attachment cards ("12.3 KB"). */
function formatBytes(n?: number): string {
  if (!n || n < 1) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Format milliseconds into a short human-readable duration string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/**
 * Two activity rows are "the same event" when every visible field matches.
 * Distinct operations on the same file keep different ids/details, so this is
 * only ever true for a genuinely repeated identical operation.
 */
function sameActivityStep(a: AgentActivityStep, b: AgentActivityStep): boolean {
  return a.status === b.status
    && a.label === b.label
    && (a.kind ?? "") === (b.kind ?? "")
    && (a.tool ?? "") === (b.tool ?? "")
    && (a.path ?? "") === (b.path ?? "")
    && (a.command ?? "") === (b.command ?? "")
    && (a.detail ?? "") === (b.detail ?? "")
    && (a.lines ?? 0) === (b.lines ?? 0);
}

/**
 * Collapse CONSECUTIVE identical activity rows into one with a ×N counter.
 *
 * The persisted timeline keeps every real step (they really happened — a model
 * can legitimately write the same file repeatedly); this only stops the live
 * list from repeating the same line five times.
 */
function aggregateActivitySteps(steps: AgentActivityStep[]): Array<{ step: AgentActivityStep; count: number }> {
  const out: Array<{ step: AgentActivityStep; count: number }> = [];
  for (const step of steps) {
    const previous = out[out.length - 1];
    if (previous && sameActivityStep(previous.step, step)) {
      previous.count += 1;
      continue;
    }
    out.push({ step, count: 1 });
  }
  return out;
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

/**
 * Memoized so streamed tokens (which re-render ChatView ~30×/s) do not
 * re-render the whole execution timeline; it only re-renders when its OWN
 * inputs (steps, phase, timings, status) actually change.
 */
/**
 * The live Thinking panel — provider reasoning, streamed, and nothing else.
 *
 * Self-contained on purpose: the elapsed clock (its own 500 ms interval), the
 * open/closed state and the reasoning scroll-follow all live HERE, so a ticking
 * timer or an incoming reasoning delta re-renders this panel only and never the
 * conversation behind it. It renders `text` — the provider's own reasoning — and
 * while none has arrived yet shows the temporary `waiting` transport line, which
 * is replaced the instant the first real delta lands.
 */
const ThinkingBox = memo(function ThinkingBox({
  text,
  waiting,
  streaming,
  startedAt,
  showElapsed,
  expectsReasoning
}: {
  /** Provider-exposed reasoning, normalized for display. Empty until it arrives. */
  text: string;
  /** Temporary transport line shown before the first reasoning delta. */
  waiting: string;
  /** True once real reasoning is on screen (drives the live accent). */
  streaming: boolean;
  /** Epoch ms this response started — the floor for the elapsed clock. */
  startedAt?: number | null;
  /** False when another surface already shows this response's clock. */
  showElapsed: boolean;
  /**
   * True when this model's provider exposes reasoning. Controls ONLY what the
   * box may display: when false there is no body and no "waiting" claim, so a
   * GPT/Claude turn shows the genuine state and timer and nothing more. It never
   * suppresses the box itself — the box is the experience, not the reasoning.
   */
  expectsReasoning: boolean;
}) {
  // Collapsed by default when there is no reasoning to show: an expanded but
  // permanently empty panel would look broken, and filling it with invented
  // "Analyzing…/Planning…" lines is exactly what must never happen.
  const [expanded, setExpanded] = useState(expectsReasoning);
  const [tick, setTick] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // One tick per half second, and only while this panel is mounted (i.e. only
  // while a response is running) — the conversation never sees it.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  const seconds = useMemo(() => {
    if (!startedAt) return 0;
    return Math.max(0, (Date.now() - startedAt) / 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, tick]);

  // New response → open the panel and resume following.
  useEffect(() => {
    userScrolledUp.current = false;
    setExpanded(true);
  }, [startedAt]);

  // Keep the END of the streamed reasoning visible, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el && !userScrolledUp.current) el.scrollTop = el.scrollHeight;
  }, [text, expanded]);

  const body = text || (expectsReasoning ? waiting : "");

  return (
    <div className={`thinkingBlock${streaming ? " streaming" : ""}`}>
      <button className="thinkingToggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="thinkingLabel">Thinking</span>
        {/* Exactly ONE elapsed clock per response: another surface may already
            count this same response, in which case this panel does not. */}
        {showElapsed && seconds >= 1 && (
          <span className="thinkingElapsed"> · {seconds.toFixed(1)}s</span>
        )}
        {!expanded && body && (
          <span className="thinkingPreview">
            {body.slice(0, 80)}{body.length > 80 ? "..." : ""}
          </span>
        )}
      </button>
      {expanded && body && (
        <div
          className="thinkingContent"
          ref={contentRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
            userScrolledUp.current = !atBottom;
          }}
        >
          {body}
        </div>
      )}
    </div>
  );
});

const ActivityTimeline = memo(function ActivityTimeline({
  steps,
  complete,
  busy,
  startedAt,
  outcome,
  kind,
  phase,
  timings,
  statusText
}: {
  steps: AgentActivityStep[];
  complete: boolean;
  busy: boolean;
  /** Epoch ms when THIS response started — its own timer, never reused. */
  startedAt?: number | null;
  outcome?: "stopped" | "error" | null;
  kind?: "chat" | "agent";
  /** Real request phase from the main process (never inferred here). */
  phase?: AgentTaskPhase | null;
  timings?: AgentTaskTimings | null;
  /**
   * Latest APPLICATION status line (what Latex is doing right now). This is
   * the activity stream's business — it is never shown in the Thinking box.
   */
  statusText?: string;
}) {
  const [collapsed, setCollapsed] = useState(() => true);
  const [tick, setTick] = useState(0);
  // Frozen elapsed captured at the settle render — truthful wall-clock for
  // turns that fail/stop before any activity step was emitted (0-step settle).
  const settledElapsed = useMemo(
    () => (startedAt ? Math.max(0, Date.now() - startedAt) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, outcome, startedAt]
  );
  const doneCount = steps.filter((s) => s.status === "done").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const activeStep = steps.find((s) => s.status === "active");
  const displaySteps = useMemo(() => aggregateActivitySteps(steps), [steps]);

  useEffect(() => {
    if (!busy && complete) {
      const timer = setTimeout(() => setCollapsed(true), 1200);
      return () => clearTimeout(timer);
    } else if (steps.length > 0) {
      setCollapsed(false);
    }
  }, [complete, steps.length, busy]);

  // Live timer: tick every 250ms while THIS response is running.
  useEffect(() => {
    if (busy) {
      const interval = setInterval(() => setTick((t) => t + 1), 250);
      return () => clearInterval(interval);
    }
  }, [busy]);

  // Elapsed for this response: from its start (or first step) to now
  // (while running) or to the last recorded step (when settled).
  const totalElapsed = useMemo(() => {
    const first = steps[0];
    const start = startedAt ?? first?.startedAt ?? first?.timestamp ?? Date.now();
    if (busy) return Math.max(0, Date.now() - start);
    const last = steps[steps.length - 1];
    const end = last?.timestamp ?? Date.now();
    return Math.max(0, end - start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, busy, startedAt, tick]);

  // Compute individual step durations for display
  const getStepDuration = useCallback((step: AgentActivityStep): string | undefined => {
    if (step.duration) return formatDuration(step.duration);
    if (step.status === "active" && step.startedAt) return formatDuration(Date.now() - step.startedAt);
    return undefined;
  }, [tick]);

  // Force re-render for active steps
  void tick;

  if (steps.length === 0) {
    if (busy) {
      // Even before the first activity step lands, name the REAL phase —
      // "Waiting for model response" is honest, "Thinking" is not.
      return (
        <div className="activityThinking">
          <Spinner size={12} />
          <span>{phase ? phaseLabel(phase) : "Starting task"}<span className="dots">...</span></span>
        </div>
      );
    }
    // Settled but no step was ever emitted (instant failure/stop) — still show
    // the honest outcome row instead of vanishing, per the activity spec.
    if (outcome) {
      return (
        <div className="activityThinking">
          <X size={12} className="activityIconFail" />
          <span>
            {outcome === "stopped" ? "Stopped" : "Request failed"}
            {settledElapsed > 0 && <span className="activityElapsed"> · {formatDuration(settledElapsed)}</span>}
          </span>
        </div>
      );
    }
    return null;
  }

  const isExpanded = !collapsed;

  return (
    <div className="activityCodex">
      <div className="activityCodexHeader" onClick={() => setCollapsed((c) => !c)} style={{ cursor: "pointer" }}>
        <span className="activityCodexIcon">
          {outcome === "error" ? (
            <X size={13} className="activityIconFail" />
          ) : outcome === "stopped" ? (
            <X size={13} />
          ) : complete ? (
            failedCount > 0 ? <X size={13} className="activityIconFail" /> : <Check size={13} className="activityIconDone" />
          ) : busy ? (
            <Spinner size={13} />
          ) : (
            <Check size={13} />
          )}
        </span>
        <span className="activityCodexTitle">
          {busy && !outcome
            ? (statusText && statusText.trim() ? statusText.trim() : phaseLabel(phase ?? "starting"))
            : outcome === "stopped"
              ? "Stopped"
              : outcome === "error"
                ? "Request failed"
                : complete
                  ? kind === "chat"
                    ? "Thinking"
                    : failedCount > 0
                      ? `Finished · ${failedCount} failed`
                      : `Finished · ${doneCount} step${doneCount === 1 ? "" : "s"}`
                  : activeStep?.label || "Working..."
          }
          {totalElapsed > 0 && <span className="activityElapsed"> · {formatDuration(totalElapsed)}</span>}
        </span>
        <span className="activityCodexToggle">
          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </div>
      {isExpanded && (
        <div className="activityCodexSteps">
          {displaySteps.map(({ step, count }, index) => {
            const stepDur = getStepDuration(step);
            return (
              <div key={step.id} className={`activityCodexStep ${step.status}`}>
                <div className="activityCodexStepRow">
                  <span className="activityCodexStepIcon">
                    {step.status === "done" ? <Check size={11} /> : step.status === "active" ? <Spinner size={11} /> : step.status === "failed" ? <X size={11} /> : <span className="activityStepPending" />}
                  </span>
                  <span className="activityCodexStepLabel">{index + 1}. {step.label}</span>
                  <ActivityStepStatus step={step} />
                  {count > 1 && <span className="activityStepCount" title={`${count} identical operations`}>×{count}</span>}
                  {stepDur && <span className="activityStepDuration">{stepDur}</span>}
                </div>
                <ActivityStepDetail step={step} detailClass="activityCodexStepDetail" />
              </div>
            );
          })}
          <ActivityStepCounts steps={steps} />
        </div>
      )}
    </div>
  );
});
