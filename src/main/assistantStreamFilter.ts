/**
 * AssistantStreamFilter — strict separation between the ASSISTANT RESPONSE
 * channel and the INTERNAL PROTOCOL channel during streaming.
 *
 * Why this exists: `stripToolCallBlocks` needs a complete string. Applied to a
 * single streamed chunk it cannot recognise a tool call split across chunk
 * boundaries, so
 *
 *     {"name": "write_file", "arguments": {"content": "<5 KB of HTML>"}}
 *
 * arriving in 40 pieces leaked 40 fragments of raw JSON straight into the
 * visible answer. This filter keeps the minimum state needed to decide, chunk
 * by chunk, whether text belongs to:
 *
 *   - the ANSWER channel   → returned from push(), rendered as prose/markdown
 *   - the PROTOCOL channel → dropped (tool calls already surface as activity)
 *   - the THINKING channel → forwarded to the onThinking callback
 *
 * It never leaks: if a protocol region never closes, the remainder is dropped
 * rather than shown. It also never stalls the stream — an undecided region is
 * held for at most `maxHold` characters, and ordinary prose is emitted as soon
 * as it cannot possibly be the start of a protocol marker.
 */

import { isKnownToolName, isToolNamePrefix, stripProtocolArtifacts } from "./toolProtocol.js";

/** A backslash, built without escapes so the source stays readable. */
const BACKSLASH = String.fromCharCode(92);
/** Marker of the escaped (Puter NDJSON) tool-call form: {\"name\" */
const ESCAPED_NAME_MARKER = `{${BACKSLASH}"name${BACKSLASH}"`;

interface TagOpener {
  /** Lowercase opening tag fragment. */
  open: string;
  /** Lowercase closing tag that ends the protocol region. */
  close: string;
  /** True when the region's content is reasoning, not tool protocol. */
  thinking: boolean;
}

/** Tags that open a region owned by the internal channel, never the answer. */
const TAG_OPENERS: TagOpener[] = [
  { open: "<function_calls", close: "</function_calls>", thinking: false },
  { open: "<function_call", close: "</function_call>", thinking: false },
  { open: "<tool_call", close: "</tool_call>", thinking: false },
  { open: "<tool_code", close: "</tool_code>", thinking: false },
  { open: "<thought", close: "</thought>", thinking: true }
];

/** JSON starts that *may* be a tool call; confirmed against the tool catalogue. */
const JSON_MARKERS = ['[{"name"', '{"name"', '{"tool"', ESCAPED_NAME_MARKER];

/**
 * Strings we must not emit while they could still grow into a marker. A held
 * suffix is at most a few characters, so prose latency stays imperceptible.
 */
const HOLD_MARKERS: string[] = [
  ...TAG_OPENERS.map((t) => t.open),
  "```json",
  "```",
  ...JSON_MARKERS.map((m) => m.toLowerCase())
];

const MAX_HOLD_CHARS = HOLD_MARKERS.reduce((longest, m) => Math.max(longest, m.length), 0);

/** Whitespace test without a regex (keeps the protocol scanner allocation-free). */
function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

type OpenerKind = "tag" | "json" | "unconfirmed" | "notool";

interface Opener {
  index: number;
  kind: OpenerKind;
  tag?: TagOpener;
}

export class AssistantStreamFilter {
  /** Buffered text that has not been classified yet. */
  private pending = "";
  /** Active suppression channel, or null when the answer channel is live. */
  private mode: "tag" | "fence" | "json" | null = null;
  /** Which tag opened the current region (for the matching closer). */
  private tag: TagOpener | null = null;
  /** Bounded buffer used to find tag/fence closers split across chunks. */
  private scan = "";
  /** Brace/array balancing state for a JSON tool call. */
  private depth = 0;
  private started = false;
  private inString = false;
  private escaped = false;
  /** Characters withheld from the answer channel (diagnostics/tests). */
  private dropped = 0;
  /** Reasoning text collected from a <thought> region. */
  private thought = "";
  private readonly maxHold: number;

  constructor(
    private readonly onThinking?: (text: string) => void,
    options?: { maxHold?: number }
  ) {
    this.maxHold = options?.maxHold ?? 200;
  }

  /** Total characters routed away from the answer channel. */
  get droppedChars(): number {
    return this.dropped;
  }

  /** Feed one streamed chunk; returns the prose that is safe to display. */
  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    return this.drain(false);
  }

  /**
   * End of a model call: release the last safe prose and discard anything that
   * never resolved into either prose or a closed protocol region.
   */
  flush(): string {
    return this.drain(true);
  }

  // ─── Core loop ──────────────────────────────────────────────────────────

  private drain(final: boolean): string {
    let out = "";

    for (;;) {
      if (this.mode !== null) {
        if (!this.consumeSuppressed(final)) return out;
        continue;
      }

      const found = this.findOpener(this.pending);
      if (!found) {
        // Plain prose: emit everything except (a) a suffix that could still
        // grow into a protocol marker and (b) an unclosed fence, which a
        // confirmed tool call must be able to take down with it.
        let boundary = this.pending.length;
        if (!final) {
          boundary = this.pending.length - this.prefixHoldLength(this.pending);
          const fenceStart = this.openFenceIndex(this.pending);
          if (fenceStart >= 0) boundary = Math.min(boundary, fenceStart);
        }
        if (boundary > 0) {
          out += stripProtocolArtifacts(this.pending.slice(0, boundary), false);
          this.pending = this.pending.slice(boundary);
        }
        if (final && this.pending) {
          out += stripProtocolArtifacts(this.pending, false);
          this.pending = "";
        }
        return out;
      }

      if (found.kind === "notool") {
        // A JSON object quoting a name that is not a tool is ordinary prose:
        // release it (fence and all) and keep scanning for real protocol.
        const releaseLen = Math.min(this.pending.length, found.index + 8);
        out += stripProtocolArtifacts(this.pending.slice(0, releaseLen), false);
        this.pending = this.pending.slice(releaseLen);
        continue;
      }

      if (found.kind === "unconfirmed") {
        // Undecided: hold the whole region (fence included) so nothing leaks
        // if it resolves into a tool call.
        if (!final && this.pending.length <= this.maxHold) return out;
        // The header never resolved into a tool name — treat it as prose.
        const releaseLen = Math.max(1, this.pending.length - this.prefixHoldLength(this.pending));
        out += stripProtocolArtifacts(this.pending.slice(0, releaseLen), false);
        this.pending = this.pending.slice(releaseLen);
        continue;
      }

      // Confirmed protocol region: it swallows the fence that introduced it,
      // so the answer never shows a stray ``` left behind by a tool call.
      const atText = this.pending.slice(0, found.index);
      const fenceLen = found.kind === "tag" ? 0 : this.openFenceTail(atText.toLowerCase());
      if (atText.length > 0) {
        out += stripProtocolArtifacts(
          fenceLen > 0 ? atText.slice(0, atText.length - fenceLen) : atText,
          false
        );
        if (fenceLen > 0) this.dropped += fenceLen;
      }
      this.pending = this.pending.slice(found.index);
      this.enterSuppression(found, fenceLen > 0);
    }
  }

  /** Locate the earliest protocol opener in `text`, if any. */
  private findOpener(text: string): Opener | null {
    const lower = text.toLowerCase();
    let best: Opener | null = null;

    for (const tag of TAG_OPENERS) {
      const idx = lower.indexOf(tag.open);
      if (idx >= 0 && (best === null || idx < best.index)) {
        best = { index: idx, kind: "tag", tag };
      }
    }

    for (const marker of JSON_MARKERS) {
      const idx = text.indexOf(marker);
      if (idx < 0) continue;
      const verdict = this.classifyJson(text.slice(idx));
      if (verdict === "notool") continue;
      if (best === null || idx < best.index) {
        best = { index: idx, kind: verdict === "json" ? "json" : "unconfirmed" };
      }
    }

    return best;
  }

  /**
   * Decide what a `{"name": ...}` / `{"tool": ...}` start really is:
   *   "json"        — a confirmed tool call (internal channel)
   *   "notool"      — a real name that is not a tool → ordinary prose
   *   "unconfirmed" — the name has not arrived yet, keep holding
   */
  private classifyJson(snippet: string): "json" | "notool" | "unconfirmed" {
    const escapedQuote = BACKSLASH + '"';
    const text = snippet.indexOf(escapedQuote) >= 0
      ? snippet.split(escapedQuote).join('"')
      : snippet;

    const nameKey = text.indexOf('"name"');
    const toolKey = text.indexOf('"tool"');
    const keyAt = nameKey >= 0 && (toolKey < 0 || nameKey < toolKey) ? nameKey : toolKey;
    if (keyAt < 0) return "unconfirmed";

    let i = keyAt + 6; // past the closing quote of "name"/"tool"
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) return "unconfirmed";
    if (text[i] !== ":") return "notool";
    i++;
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) return "unconfirmed";
    if (text[i] !== '"') return "notool";
    i++;

    const quoteEnd = text.indexOf('"', i);
    if (quoteEnd < 0) {
      // Name still streaming — hold while it could still become a tool name.
      // A chunk boundary can split an escaped quote, leaving a trailing
      // backslash behind; strip it or every tool name looks like prose.
      let partial = text.slice(i).trim().toLowerCase();
      while (partial.endsWith(BACKSLASH)) partial = partial.slice(0, -1).trim();
      return isToolNamePrefix(partial) ? "unconfirmed" : "notool";
    }
    const name = text.slice(i, quoteEnd).trim();
    if (!name) return "notool";
    return isKnownToolName(name) ? "json" : "notool";
  }

  /** Enter the protocol channel for the region starting at `found.index`. */
  private enterSuppression(found: Opener, fenced: boolean): void {
    this.pending = this.pending.slice(found.index);

    if (found.kind === "tag" && found.tag) {
      this.mode = "tag";
      this.tag = found.tag;
      this.thought = "";
      this.scan = "";
      this.dropped += this.pending.length; // the opening tag itself is dropped
      this.pending = "";
      return;
    }

    // A fenced tool call hides its closing fence too; otherwise the fence
    // would be rendered as a stray ``` in the answer.
    this.mode = fenced ? "fence" : "json";
    this.depth = 0;
    this.started = false;
    this.inString = false;
    this.escaped = false;
    this.scan = "";
  }

  /**
   * Consume as much of the active protocol region as possible.
   * Returns true when the region closed and the answer channel is live again.
   */
  private consumeSuppressed(final: boolean): boolean {
    if (this.mode === "tag") {
      this.scan += this.pending;
      this.pending = "";
      const closer = this.tag?.close ?? "</thought>";
      const idx = this.scan.toLowerCase().indexOf(closer);
      if (idx >= 0) {
        const content = this.scan.slice(0, idx);
        const rest = this.scan.slice(idx + closer.length);
        this.dropped += idx + closer.length;
        this.scan = "";
        this.mode = null;
        const tag = this.tag;
        this.tag = null;
        if (tag?.thinking) this.forwardThinking(content);
        this.pending = rest;
        return true;
      }
      // Keep only enough tail to catch a closer split across chunks.
      this.dropped += Math.max(0, this.scan.length - 64);
      this.scan = this.scan.slice(-64);
      if (final) {
        // Never leak an unterminated protocol region.
        if (this.tag?.thinking) this.forwardThinking(this.scan);
        this.dropped += this.scan.length;
        this.scan = "";
        this.tag = null;
        this.mode = null;
        return true;
      }
      return false;
    }

    if (this.mode === "fence") {
      this.scan += this.pending;
      this.pending = "";
      const idx = this.scan.indexOf("```");
      if (idx >= 0) {
        const rest = this.scan.slice(idx + 3);
        this.dropped += idx + 3;
        this.scan = "";
        this.mode = null;
        this.pending = rest;
        return true;
      }
      this.dropped += Math.max(0, this.scan.length - 8);
      this.scan = this.scan.slice(-8);
      if (final) {
        this.dropped += this.scan.length;
        this.scan = "";
        this.mode = null;
        return true;
      }
      return false;
    }

    // JSON tool call: consume incrementally and drop as we go. Depth tracking
    // is string/escape aware so braces inside file contents cannot fool it.
    const text = this.pending;
    let i = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (this.escaped) {
        this.escaped = false;
        continue;
      }
      if (ch === BACKSLASH) {
        this.escaped = true;
        continue;
      }
      if (this.inString) {
        if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        this.started = true;
        this.depth++;
        continue;
      }
      if (ch === "}" || ch === "]") {
        this.depth--;
        const next = text[i + 1];
        const atRegionEnd = this.started && this.depth <= 0 && (next === undefined || isSpace(next));
        if (atRegionEnd) {
          this.dropped += i + 1;
          this.pending = text.slice(i + 1);
          this.mode = null;
          return true;
        }
      }
    }
    this.dropped += i;
    this.pending = text.slice(i);
    if (final) {
      this.dropped += this.pending.length;
      this.pending = "";
      this.mode = null;
      return true;
    }
    return false;
  }

  private forwardThinking(content: string): void {
    const text = content.trim();
    if (!text || !this.onThinking) return;
    this.onThinking(text);
  }

  /** Longest suffix of `text` that is a proper prefix of a protocol marker. */
  private prefixHoldLength(text: string): number {
    const lower = text.toLowerCase();
    const max = Math.min(MAX_HOLD_CHARS - 1, lower.length);
    for (let len = max; len > 0; len--) {
      const suffix = lower.slice(lower.length - len);
      for (const marker of HOLD_MARKERS) {
        if (marker.length > len && marker.startsWith(suffix)) return len;
      }
    }
    return 0;
  }

  /**
   * Index of a still-unclosed fence opener that could be introducing a tool
   * call, or -1. Holding it back means a tool call that turns out to be fenced
   * can take the fence down with it instead of leaving a stray ``` behind.
   *
   * Only fences whose body looks like JSON are withheld: an ```html or
   * ```bash block keeps streaming as ordinary prose, while ``` followed by an
   * object is held until it resolves. Fences must also be balanced — an odd
   * count means the last one is still open.
   */
  private openFenceIndex(lower: string): number {
    let idx = lower.indexOf("```");
    let last = -1;
    let count = 0;
    while (idx >= 0) {
      count++;
      last = idx;
      idx = lower.indexOf("```", idx + 3);
    }
    if (count === 0 || count % 2 === 0) return -1;
    const rest = lower.slice(last + 3).replace(/^[\s]*json[\s]*/i, "");
    if (!rest) return last; // still inside the fence header
    const first = rest[0];
    return first === "{" || first === "[" ? last : -1;
  }

  /** Length of an unclosed fence tail, or 0 when there is none. */
  private openFenceTail(lower: string): number {
    const idx = this.openFenceIndex(lower);
    if (idx < 0) return 0;
    return lower.length - idx;
  }
}

