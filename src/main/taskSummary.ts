/**
 * TaskChangeSummary — the honest, operation-derived record of what a Main Agent
 * task actually changed, plus the report builder the final answer is rendered
 * from.
 *
 * Why this exists: the old final answer was assembled from a couple of generic
 * counters. The user saw "Agent changed 7 files / +490 -7" and nothing that
 * explained the work. This module keeps a real record of every workspace
 * operation and turns it into a readable summary.
 *
 * Design rules (non-negotiable):
 *  - A file only enters `filesChanged` after a REAL tool call reported success.
 *    Model prose is never evidence — a model saying "I changed script.js" while
 *    in Chat mode records nothing at all.
 *  - Descriptions, features and controls are derived from the code that was
 *    actually written (or from the operation's own arguments). Nothing is
 *    invented, and a section with no real content is omitted entirely.
 *  - The report is built in the MAIN PROCESS from real events, so every
 *    provider and model gets the same structure. A model that writes its own
 *    conclusion still leads with that prose; a model that writes nothing still
 *    gets a factual summary.
 *  - Chat mode cannot record anything: `new TaskChangeRecorder("chat")` refuses
 *    every mutation, so a fabricated tool call in Chat can never become a
 *    file-change record.
 */

import { createTwoFilesPatch } from "diff";
import type {
  PendingChange,
  TaskChangeSummary,
  TaskControl,
  TaskOperation,
  TaskOperationType
} from "../shared/types.js";

export type { TaskChangeSummary, TaskControl, TaskOperation, TaskOperationType };

export interface CodeSource {
  path: string;
  code: string;
}

// ── Tool classification ────────────────────────────────────────────────────

const MUTATING_TOOLS = new Set([
  "create_file", "write_file", "edit_file", "delete_file", "rename_file",
  "move_file", "copy_file", "create_directory", "delete_directory"
]);

const TYPE_BY_TOOL: Record<string, TaskOperationType> = {
  create_file: "file_create",
  write_file: "file_write",
  edit_file: "file_edit",
  delete_file: "file_delete",
  rename_file: "file_rename",
  move_file: "file_move",
  copy_file: "file_copy",
  create_directory: "folder_create",
  delete_directory: "folder_delete",
  run_command: "command",
  read_file: "read",
  get_file_info: "inspect",
  file_exists: "inspect",
  list_directory: "inspect",
  get_workspace_info: "inspect",
  search_files: "read",
  search_project: "read"
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function opPath(args: Record<string, unknown>): string | undefined {
  return str(args.relativePath) ?? str(args.path) ?? str(args.to) ?? str(args.from);
}

// ── Code-construct detection (what the changed text actually contains) ─────

const CONSTRUCT_RULES: Array<{ re: RegExp; tag: string }> = [
  { re: /getContext\(\s*["']2d["']/, tag: "2D canvas rendering" },
  { re: /requestAnimationFrame\s*\(/, tag: "frame render loop" },
  { re: /clearRect|fillRect|fillStyle/, tag: "per-frame drawing and clearing" },
  { re: /createRadialGradient|createLinearGradient/, tag: "gradient shading" },
  { re: /devicePixelRatio/, tag: "high-DPI canvas sizing" },
  { re: /ResizeObserver|addEventListener\(\s*["']resize/, tag: "responsive resize handling" },
  { re: /ctx\.arc|\.arc\(/, tag: "circular entity drawing" },
  { re: /drawImage|new Image\(/, tag: "sprite drawing" },
  { re: /ctx\.(save|restore)\(\)/, tag: "canvas transform state" },
  { re: /ctx\.(translate|scale|rotate)\(/, tag: "world-to-screen transforms" },
  { re: /addEventListener\(\s*["']keydown/, tag: "keyboard input" },
  { re: /addEventListener\(\s*["']wheel/, tag: "mouse-wheel input" },
  { re: /addEventListener\(\s*["'](pointerdown|mousedown)/, tag: "pointer input" },
  { re: /addEventListener\(\s*["'](pointermove|mousemove)/, tag: "pointer movement" },
  { re: /setInterval|requestAnimationFrame\s*\(\s*(?:loop|tick|render)/, tag: "timed update loop" },
  { re: /localStorage/, tag: "local persistence" },
  { re: /Math\.random/, tag: "randomised behaviour" },
  { re: /class\s+[A-Z]/, tag: "class definitions" },
  { re: /document\.(getElementById|querySelector)/, tag: "DOM wiring" },
  { re: /<canvas/i, tag: "canvas element" },
  { re: /<button/i, tag: "buttons" },
  { re: /<select/i, tag: "select control" },
  { re: /script\s+src=/i, tag: "script inclusion" },
  { re: /@keyframes/, tag: "CSS animation" },
  { re: /display\s*:\s*grid/, tag: "CSS grid layout" },
  { re: /display\s*:\s*flex/, tag: "flex layout" },
  { re: /grid-template-columns/, tag: "responsive grid" },
  { re: /linear-gradient|radial-gradient/, tag: "gradient styling" },
  { re: /@media/, tag: "responsive media queries" },
  { re: /box-shadow|border-radius/, tag: "panel styling" },
  { re: /fetch\(|await\s+fetch/, tag: "network requests" },
  { re: /JSON\.(parse|stringify)/, tag: "JSON serialization" }
];

/** Construct tag → user-facing feature name. Only real constructs are listed. */
const TAG_FEATURES: Record<string, string> = {
  "2D canvas rendering": "Canvas-based world rendering",
  "frame render loop": "Continuous render loop",
  "per-frame drawing and clearing": "Per-frame world drawing",
  "gradient shading": "Shaded terrain/environment",
  "high-DPI canvas sizing": "Crisp high-DPI canvas",
  "responsive resize handling": "Responsive canvas resizing",
  "circular entity drawing": "Visible entity markers",
  "sprite drawing": "Sprite/entity drawing",
  "canvas transform state": "Layered canvas drawing",
  "world-to-screen transforms": "Camera / viewport transforms",
  "keyboard input": "Keyboard controls",
  "mouse-wheel input": "Mouse-wheel zoom",
  "pointer input": "Mouse/pointer interaction",
  "pointer movement": "Dragging / panning interaction",
  "timed update loop": "Timed simulation updates",
  "local persistence": "State persisted between runs",
  "class definitions": "Structured simulation classes",
  "script inclusion": "Wired page script",
  "gradient styling": "Environment visual styling",
  "responsive grid": "Responsive layout",
  "CSS animation": "Animated UI elements"
};

/** Detect the constructs actually present in a chunk of changed code. */
export function detectConstructs(code: string): string[] {
  if (!code) return [];
  const found: string[] = [];
  for (const rule of CONSTRUCT_RULES) {
    if (rule.re.test(code) && !found.includes(rule.tag)) found.push(rule.tag);
  }
  return found;
}

/** Turn construct tags into feature names (order preserved, deduped). */
export function constructsToFeatures(tags: string[]): string[] {
  const features: string[] = [];
  for (const tag of tags) {
    const feature = TAG_FEATURES[tag];
    if (feature && !features.includes(feature)) features.push(feature);
  }
  return features;
}

// ── Control detection (keybinds that really exist in the changed code) ─────

const KEY_ALIASES: Record<string, string> = {
  esc: "Esc",
  escape: "Esc",
  spacebar: "Space",
  " ": "Space",
  up: "Arrow Up",
  down: "Arrow Down",
  left: "Arrow Left",
  right: "Arrow Right",
  shiftleft: "Shift",
  shiftright: "Shift"
};

/** Normalize a raw key literal (KeyW, Digit1, " ", ArrowUp) into a label. */
export function normalizeKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^key[a-z]$/i.test(trimmed)) return trimmed.slice(3).toUpperCase();
  if (/^digit\d$/i.test(trimmed)) return trimmed.slice(5);
  if (/^arrow(up|down|left|right)$/i.test(trimmed)) {
    return `Arrow ${trimmed.slice(5, 6).toUpperCase()}${trimmed.slice(6)}`;
  }
  if (/^numpad/i.test(trimmed)) return trimmed;
  if (trimmed.length === 1) return trimmed.toUpperCase();
  if (lower === "control" || lower === "ctrl") return "Ctrl";
  if (lower === "alt") return "Alt";
  if (lower === "tab") return "Tab";
  if (lower === "enter" || lower === "return") return "Enter";
  if (lower === "backspace") return "Backspace";
  if (lower.startsWith("f") && /^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Human explanation inferred from the statement a binding actually performs. */
function inferActionFromCode(code: string): string | undefined {
  if (/zoom|scrollScale|scaleFactor/i.test(code)) return "Zoom the view";
  if (/camera|viewport|offsetX|panX|scrollX/i.test(code) && /[+\-]=/.test(code)) return "Move the camera";
  if (/pause|paused|isPaused|gameRunning|running\s*=\s*!/.test(code)) return "Pause/resume the simulation";
  if (/reset|restart|initGame|init\s*\(/i.test(code)) return "Reset the simulation";
  if (/speed/i.test(code)) return "Change simulation speed";
  if (/meteor|disaster/i.test(code)) return "Trigger a disaster event";
  if (/tick|step|update\s*\(/i.test(code)) return "Advance the simulation";
  return undefined;
}

const MOUSE_ACTIONS: Array<{ re: RegExp; label: string }> = [
  { re: /addEventListener\(\s*["']wheel/, label: "Mouse Wheel" },
  { re: /addEventListener\(\s*["'](pointerdown|mousedown)/, label: "Mouse Drag" },
  { re: /addEventListener\(\s*["'](pointermove|mousemove)/, label: "Mouse Move" }
];

/** Extract a trailing `// comment` or `/* comment *​/` for a code line. */
function trailingComment(line: string): string | undefined {
  const match = line.match(/(?:\/\/|\/\*)\s*([^*/]{3,60}?)\s*(?:\*\/)?\s*$/);
  return match?.[1]?.trim() || undefined;
}

function lineOf(code: string, index: number): string {
  const start = code.lastIndexOf("\n", index) + 1;
  const end = code.indexOf("\n", index);
  return code.slice(start, end < 0 ? code.length : end);
}

interface RawControl {
  keys: string[];
  mouse?: string;
  button?: string;
  action: string;
  source: string;
}

/**
 * Extract the controls that really exist in the changed code.
 *
 * Two shapes are recognised, both read straight from the written source:
 *  1. a declarative table — `{ keys: ["KeyW","ArrowUp"], action: "Pan up" }`
 *  2. imperative handlers — `addEventListener("keydown", e => … e.code === "Space" …)`
 * Descriptions come from an inline comment when one exists, otherwise from
 * what the handler actually does. Nothing is guessed into existence: a key that
 * is not in the code produces no control entry.
 */
export function detectControls(sources: CodeSource[]): TaskControl[] {
  const raw: RawControl[] = [];

  for (const { path: source, code } of sources) {
    if (!code) continue;

    // 1. Declarative tables: keys: [...] near action: "..."
    const tableRe = /keys?\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g;
    let match: RegExpExecArray | null;
    while ((match = tableRe.exec(code)) !== null) {
      const window = code.slice(match.index, match.index + 320);
      const actionMatch = window.match(/action\s*:\s*["'`]([^"'`]+)["'`]/);
      const labelMatch = window.match(/(?:label|description)\s*:\s*["'`]([^"'`]+)["'`]/);
      const action = actionMatch?.[1] ?? labelMatch?.[1];
      if (!action) continue;
      const keyLiterals = [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
      const keys = keyLiterals.map(normalizeKey).filter((k): k is string => Boolean(k));
      if (keys.length === 0) continue;
      const mouse = keys.find((k) => k.startsWith("Mouse"));
      raw.push({
        keys: keys.filter((k) => !k.startsWith("Mouse")),
        ...(mouse ? { mouse } : {}),
        action,
        source
      });
    }

    // 2. Imperative key handlers
    const handlerRe = /addEventListener\(\s*["']key(?:down|up)["']/g;
    while ((match = handlerRe.exec(code)) !== null) {
      const body = code.slice(match.index, match.index + 2000);
      const keys = new Set<string>();
      for (const keyMatch of body.matchAll(/["'`](Key[A-Z]|Digit\d|Arrow(?:Up|Down|Left|Right)|Space|Escape|Enter|Tab|Backspace)["'`]/g)) {
        const key = normalizeKey(keyMatch[1]);
        if (key) keys.add(key);
      }
      for (const keyMatch of body.matchAll(/\b(?:e|ev|evt|event)\.(?:code|key)\s*={2,3}\s*["'`]([^"'`]{1,20})["'`]/g)) {
        const key = normalizeKey(keyMatch[1]);
        if (key) keys.add(key);
      }
      for (const keyMatch of body.matchAll(/case\s+["'`]([^"'`]{1,20})["'`]\s*:/g)) {
        const key = normalizeKey(keyMatch[1]);
        if (key) keys.add(key);
      }
      if (keys.size === 0) continue;
      // Prefer a human-written comment: on the handler's own line, otherwise on
      // the key-check line inside it. Falls back to what the handler does, and
      // finally to a plain factual label.
      let comment = trailingComment(lineOf(code, match.index));
      if (!comment) {
        for (const line of body.split("\n").slice(0, 24)) {
          if (!/(?:key|code|case)/i.test(line)) continue;
          const found = trailingComment(line);
          if (found) { comment = found; break; }
        }
      }
      const action = comment ?? inferActionFromCode(body) ?? `Handled in ${source}`;
      raw.push({ keys: [...keys], action, source });
    }

    // 3. Mouse interaction
    for (const rule of MOUSE_ACTIONS) {
      const mouseMatch = code.match(rule.re);
      if (!mouseMatch) continue;
      const at = code.indexOf(mouseMatch[0]);
      const body = code.slice(at, at + 600);
      const comment = trailingComment(lineOf(code, at));
      const action = comment ?? inferActionFromCode(body)
        ?? (rule.label === "Mouse Wheel" ? "Zoom the view" : "Interact with the world");
      raw.push({ keys: [], mouse: rule.label, action, source });
    }

    // 4. Markup controls (buttons) that the changed page really exposes
    if (/<button/i.test(code)) {
      for (const buttonMatch of code.matchAll(/<button[^>]*>([^<]{1,40})<\/button>/gi)) {
        const label = buttonMatch[1].trim();
        if (!label) continue;
        const idMatch = buttonMatch[0].match(/id=["']([^"']+)["']/);
        const hay = `${label} ${idMatch?.[1] ?? ""}`.toLowerCase();
        const action = /start|play|begin|go\b/.test(hay) ? "Start the simulation"
          : /stop|pause|halt/.test(hay) ? "Stop/pause the simulation"
            : /reset|restart|clear/.test(hay) ? "Reset the simulation"
              : /speed/.test(hay) ? "Change the simulation speed"
                : /meteor|disaster|event/.test(hay) ? "Trigger an event"
                  : `Trigger \u201c${label}\u201d`;
        raw.push({ keys: [], button: label, action, source });
      }
    }
  }

  return groupControls(raw);
}

/** Merge bindings that share an action and label them (WASD, Space, …). */
function groupControls(raw: RawControl[]): TaskControl[] {
  const grouped = new Map<string, { keys: Set<string>; mouse?: string; buttons: Set<string>; source: string }>();
  for (const item of raw) {
    const key = item.action;
    const entry = grouped.get(key) ?? { keys: new Set<string>(), buttons: new Set<string>(), source: item.source };
    for (const k of item.keys) entry.keys.add(k);
    if (item.mouse) entry.mouse = item.mouse;
    if (item.button) entry.buttons.add(item.button);
    grouped.set(key, entry);
  }

  const controls: TaskControl[] = [];
  for (const [action, entry] of grouped) {
    const letters = [...entry.keys];
    const alpha = /^[A-Z0-9]$/;
    let keys = letters;
    if (letters.length === 4 && letters.every((k) => alpha.test(k)) && new Set(letters).size === 4) {
      const ordered = ["W", "A", "S", "D"].every((k) => letters.includes(k))
        ? ["W", "A", "S", "D"]
        : [...letters].sort();
      keys = [ordered.join("")];
    } else if (letters.length === 4 && letters.every((k) => k.startsWith("Arrow"))) {
      keys = ["Arrow Keys"];
    }
    controls.push({
      keys,
      ...(entry.mouse ? { mouse: entry.mouse } : {}),
      ...(entry.buttons.size > 0 ? { button: [...entry.buttons][0] } : {}),
      action,
      source: entry.source
    });
    if (entry.buttons.size > 1) {
      for (const extra of [...entry.buttons].slice(1)) {
        controls.push({ keys: [], button: extra, action, source: entry.source });
      }
    }
  }
  return controls;
}

// ── Per-file change records (the review card) ──────────────────────────────

/**
 * Net effect of a whole task on ONE file. The review shows exactly one row per
 * file, so five writes to `testing.html` read as a single entry whose diff is
 * the ORIGINAL file state against the FINAL file state — not the sum of every
 * intermediate write.
 */
export type FileChangeKind = "created" | "modified" | "deleted" | "renamed";

/** Classify a file's net state for the turn. */
export function changeKindOf(existed: boolean, nextContent: string): FileChangeKind {
  if (nextContent === "") return "deleted";
  return existed ? "modified" : "created";
}

/**
 * Honest, operation-derived one-liner for a file row. Nothing is invented:
 * `note` is a short snippet of the text that was really replaced, when the
 * operation involved one.
 */
export function describeFileChange(kind: FileChangeKind, lines: number, operations: number, note?: string): string {
  const lineText = lines > 0 ? `${lines} line${lines === 1 ? "" : "s"}` : "no content";
  const opText = operations > 1 ? `${operations} operations` : "1 operation";
  switch (kind) {
    case "created": return `Created with the requested content (${lineText})`;
    case "modified":
      return note
        ? `Updated — replaced ${note}${operations > 1 ? ` (${operations} operations)` : ""}`
        : `Updated the file content (${opText} · ${lineText})`;
    case "deleted": return "Deleted during this task";
    case "renamed": return "Renamed during this task";
  }
}

/** Short quoted snippet of replaced text for an edit description. */
export function editNote(oldText: string): string | undefined {
  const flat = oldText.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return `\`${flat.slice(0, 48)}${flat.length > 48 ? "…" : ""}\``;
}

/**
 * Merge a new change for an already-changed file into the existing entry.
 *
 * The original entry keeps its id (stable React key / review identity) and its
 * PRE-turn previous content, while the newest next content and a diff computed
 * from the two real file states replace the previous diff. An edit that changes
 * nothing is folded in as a duplicate operation rather than a second row.
 */
export function mergePendingChange(existing: PendingChange, incoming: PendingChange): PendingChange {
  // A rename/move is its own entry: merging a later write into it would hide
  // which file moved where.
  if (existing.kind === "renamed" || incoming.kind === "renamed") return incoming;
  const existed = existing.existed === false ? false : existing.existed ?? true;
  const previousContent = existed ? existing.previousContent : "";
  const nextContent = incoming.nextContent;
  const kind = changeKindOf(existed, nextContent);
  const operations = (existing.operations ?? 1) + (incoming.operations ?? 1);
  return {
    ...existing,
    previousContent,
    nextContent,
    existed,
    kind,
    operations,
    diff: createTwoFilesPatch(existing.filePath, existing.filePath, previousContent, nextContent, "", ""),
    description: describeFileChange(kind, nextContent === "" ? 0 : nextContent.split("\n").length, operations)
  };
}

// ── Recorder ───────────────────────────────────────────────────────────────

/** Evidence of what was actually written, per path. */
interface FileEvidence {
  path: string;
  chunks: string[];
  type: TaskOperationType;
  linesAdded: number;
}

export class TaskChangeRecorder {
  private operations: TaskOperation[] = [];
  private evidence = new Map<string, FileEvidence>();
  private createdFiles: string[] = [];
  private modifiedFiles: string[] = [];
  private deletedFiles: string[] = [];
  private renamedFiles: Array<{ from: string; to: string }> = [];
  private createdFolders: string[] = [];
  private deletedFolders: string[] = [];
  private filesChanged: string[] = [];
  private tests: Array<{ command: string; exitCode: number | null; ok: boolean }> = [];
  private verification: string[] = [];

  constructor(private readonly mode: "main" | "chat" = "main") {}

  /** Chat mode must never be able to record a workspace mutation. */
  get canMutateWorkspace(): boolean {
    return this.mode === "main";
  }

  /**
   * Record one finished tool call. `success` must reflect the real tool result
   * (Latex's own success/verified flags) — never the model's claim.
   */
  record(
    tool: string,
    args: Record<string, unknown>,
    success: boolean,
    result: unknown,
    status: "success" | "failed" | "rejected" = success ? "success" : "failed"
  ): TaskOperation | null {
    if (this.mode !== "main") return null;
    const type = TYPE_BY_TOOL[tool] ?? "other";
    const mutating = MUTATING_TOOLS.has(tool);
    const path = opPath(args);
    const from = str(args.from);
    const to = str(args.to);
    const command = str(args.command);
    const content = str(args.content) ?? str(args.newText) ?? "";
    const constructs = detectConstructs(content || command || "");
    const resultObj = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
    const exitCode = typeof resultObj.exitCode === "number" ? resultObj.exitCode : null;
    const verified = typeof resultObj.verified === "boolean" ? resultObj.verified : undefined;

    const operation: TaskOperation = {
      type,
      tool,
      ...(path ? { path } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      status,
      ...(verified !== undefined ? { verified } : {}),
      ...(command ? { command } : {}),
      ...(type === "command" ? { exitCode } : {}),
      at: Date.now(),
      description: describeOperation(type, tool, { path, from, to, command, exitCode }, constructs, success),
      constructs,
      mutating
    };
    this.operations.push(operation);

    if (mutating && success) this.recordChange(operation, args, content);
    if (type === "command") this.recordCommand(operation, success, exitCode);
    else if (!success) { /* handled by callers through the failed list */ }

    return operation;
  }

  private recordChange(operation: TaskOperation, args: Record<string, unknown>, content: string): void {
    const path = operation.path ?? "";
    switch (operation.type) {
      case "file_create":
        if (path && !this.createdFiles.includes(path)) this.createdFiles.push(path);
        this.pushChanged(path);
        this.addEvidence(path, content, "file_create");
        break;
      case "file_write":
        if (path && !this.modifiedFiles.includes(path) && !this.createdFiles.includes(path)) this.modifiedFiles.push(path);
        this.pushChanged(path);
        this.addEvidence(path, content, "file_write");
        break;
      case "file_edit":
        if (path && !this.modifiedFiles.includes(path)) this.modifiedFiles.push(path);
        this.pushChanged(path);
        this.addEvidence(path, content, "file_edit");
        break;
      case "file_delete":
        if (path) {
          this.deletedFiles.push(path);
          this.modifiedFiles = this.modifiedFiles.filter((p) => p !== path);
          this.createdFiles = this.createdFiles.filter((p) => p !== path);
          this.filesChanged = this.filesChanged.filter((p) => p !== path);
          this.evidence.delete(path);
        }
        break;
      case "file_rename":
      case "file_move": {
        const from = str(args.from) ?? operation.from;
        const to = str(args.to) ?? operation.to;
        if (from && to) {
          this.renamedFiles.push({ from, to });
          this.filesChanged = this.filesChanged.filter((p) => p !== from);
          this.modifiedFiles = this.modifiedFiles.filter((p) => p !== from);
          this.pushChanged(to);
          const carried = this.evidence.get(from);
          if (carried) {
            this.evidence.delete(from);
            this.addEvidence(to, carried.chunks.join("\n"), "file_edit");
          }
        }
        break;
      }
      case "folder_create":
        if (path && !this.createdFolders.includes(path)) this.createdFolders.push(path);
        break;
      case "folder_delete":
        if (path && !this.deletedFolders.includes(path)) this.deletedFolders.push(path);
        break;
      default:
        break;
    }
  }

  private recordCommand(operation: TaskOperation, success: boolean, exitCode: number | null): void {
    const command = operation.command ?? "";
    if (!command) return;
    this.tests.push({ command, exitCode, ok: success });
    if (success) {
      const label = exitCode === null ? `Ran \`${trimCommand(command)}\` — completed` : `Ran \`${trimCommand(command)}\` — exit ${exitCode}`;
      this.addVerification(label);
    } else {
      this.addVerification(`Command failed: \`${trimCommand(command)}\`${exitCode === null ? "" : ` (exit ${exitCode})`}`);
    }
  }

  /** Factual verification line for the final report (only call with real evidence). */
  addVerification(text: string): void {
    if (!text) return;
    if (!this.verification.includes(text)) this.verification.push(text);
  }

  private pushChanged(path: string): void {
    if (path && !this.filesChanged.includes(path)) this.filesChanged.push(path);
  }

  private addEvidence(path: string, content: string, type: TaskOperationType): void {
    if (!path) return;
    const existing = this.evidence.get(path) ?? { path, chunks: [], type, linesAdded: 0 };
    if (content) {
      existing.chunks.push(content);
      existing.linesAdded += content.split("\n").length;
    }
    existing.type = type;
    this.evidence.set(path, existing);
  }

  /** Evidence for one path (the code that was actually written/changed). */
  evidenceFor(path: string): FileEvidence | undefined {
    return this.evidence.get(path);
  }

  /** Paths that were written, in order — used for reporting and analysis. */
  changedPathList(): string[] {
    return [...this.filesChanged];
  }

  addFeatures(features: string[]): void {
    for (const feature of features) {
      const trimmed = feature.trim();
      if (trimmed && !this._features.includes(trimmed)) this._features.push(trimmed);
    }
  }

  private _features: string[] = [];

  /**
   * Build the summary. `sources` is optional extra code to analyse for controls
   * (typically the final on-disk contents of the changed files).
   */
  summary(sources: CodeSource[] = []): TaskChangeSummary {
    const succeeded = this.operations.filter((op) => op.status === "success").length;
    const failed = this.operations.length - succeeded;
    const constructs = this.allConstructs();
    const features = [...this._features, ...constructsToFeatures(constructs)];
    const controls = this.mode === "main" ? detectControls(this.mergeSources(sources)) : [];
    const linesAdded = [...this.evidence.values()].reduce((total, item) => total + item.linesAdded, 0);

    return {
      mode: this.mode,
      createdFiles: [...this.createdFiles],
      modifiedFiles: [...this.modifiedFiles],
      deletedFiles: [...this.deletedFiles],
      renamedFiles: [...this.renamedFiles],
      createdFolders: [...this.createdFolders],
      deletedFolders: [...this.deletedFolders],
      filesChanged: [...this.filesChanged],
      operations: [...this.operations],
      tests: [...this.tests],
      verification: [...this.verification],
      features: features.slice(0, 12),
      controls,
      failedOperations: this.operations.filter((op) => op.status !== "success"),
      counts: {
        operations: this.operations.length,
        succeeded,
        failed,
        filesChanged: this.filesChanged.length,
        linesAdded
      }
    };
  }

  /** Written evidence first, then the on-disk text for files with no evidence. */
  private mergeSources(sources: CodeSource[]): CodeSource[] {
    const merged = new Map<string, string>();
    for (const source of sources) {
      if (source.code) merged.set(source.path, source.code);
    }
    for (const evidence of this.evidence.values()) {
      const code = evidence.chunks.join("\n");
      if (code) merged.set(evidence.path, code);
    }
    return [...merged].map(([path, code]) => ({ path, code }));
  }

  private allConstructs(): string[] {
    const tags: string[] = [];
    for (const operation of this.operations) {
      if (operation.status !== "success" || !operation.mutating) continue;
      for (const tag of operation.constructs) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    }
    return tags;
  }
}

/** A summary with nothing in it — used when no recorder exists (Chat runs). */
export function emptyTaskSummary(mode: "main" | "chat" = "chat"): TaskChangeSummary {
  return {
    mode,
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    createdFolders: [],
    deletedFolders: [],
    filesChanged: [],
    operations: [],
    tests: [],
    verification: [],
    features: [],
    controls: [],
    failedOperations: [],
    counts: { operations: 0, succeeded: 0, failed: 0, filesChanged: 0, linesAdded: 0 }
  };
}

function trimCommand(command: string): string {
  return command.length > 60 ? `${command.slice(0, 60)}…` : command;
}

function describeOperation(
  type: TaskOperationType,
  tool: string,
  parts: { path?: string; from?: string; to?: string; command?: string; exitCode?: number | null },
  constructs: string[],
  success: boolean
): string {
  const suffix = constructs.length > 0 ? ` (${constructs.slice(0, 3).join(", ")})` : "";
  const prefix = success ? "" : "Failed: ";
  switch (type) {
    case "file_create": return `${prefix}Created \`${parts.path ?? "file"}\`${suffix}`;
    case "file_write": return `${prefix}Wrote \`${parts.path ?? "file"}\`${suffix}`;
    case "file_edit": return `${prefix}Edited \`${parts.path ?? "file"}\`${suffix}`;
    case "file_delete": return `${prefix}Deleted \`${parts.path ?? "file"}\``;
    case "file_rename": return `${prefix}Renamed \`${parts.from ?? "?"}\` → \`${parts.to ?? "?"}\``;
    case "file_move": return `${prefix}Moved \`${parts.from ?? "?"}\` → \`${parts.to ?? "?"}\``;
    case "file_copy": return `${prefix}Copied \`${parts.from ?? "?"}\` → \`${parts.to ?? "?"}\``;
    case "folder_create": return `${prefix}Created folder \`${parts.path ?? "folder"}\``;
    case "folder_delete": return `${prefix}Deleted folder \`${parts.path ?? "folder"}\``;
    case "command": return `${prefix}Ran \`${trimCommand(parts.command ?? "command")}\`${parts.exitCode !== null && parts.exitCode !== undefined ? ` (exit ${parts.exitCode})` : ""}`;
    case "read": return `Read \`${parts.path ?? "file"}\``;
    case "inspect": return `Inspected \`${parts.path ?? "workspace"}\``;
    default: return `${prefix}${tool.replace(/_/g, " ")}${suffix}`;
  }
}

// ── HTML sanity checks (real file references, verified on disk) ────────────

/** Local (non-URL, non-anchor) references a page depends on. */
export function htmlLocalReferences(html: string): string[] {
  const refs: string[] = [];
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"'>]+)["']/gi)) {
    const value = match[1].trim();
    if (!value) continue;
    if (/^(?:[a-z]+:|\/\/|#|\/)/i.test(value)) continue; // absolute/remote/anchor
    if (!/\.(?:js|mjs|cjs|css|png|jpe?g|gif|svg|webp|json)$/i.test(value)) continue;
    const clean = value.replace(/^\.\//, "").split(/[?#]/)[0];
    if (clean && !refs.includes(clean)) refs.push(clean);
  }
  return refs;
}

// ── Final report ───────────────────────────────────────────────────────────

/**
 * Keep the model's closing prose readable: short snippets may stay, but a dump
 * of whole files / patches belongs in the activity panel, not the answer.
 */
export function sanitizeExplanation(text: string, maxChars = 1500): string {
  let out = (text ?? "").trim();
  if (!out) return "";
  out = out.replace(/```[\s\S]*?```/g, (full) => (full.split("\n").length > 14 ? "" : full));
  if (out.length > maxChars) {
    const clipped = out.slice(0, maxChars);
    const boundary = Math.max(clipped.lastIndexOf("\n\n"), clipped.lastIndexOf(". "));
    out = `${(boundary > 200 ? clipped.slice(0, boundary) : clipped).trim()}\u2026`;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export interface TaskReportInput {
  summary: TaskChangeSummary;
  /** The model's own closing prose, when it produced one. */
  explanation?: string;
  /** True when the user stopped the task before it finished. */
  stopped?: boolean;
  /** Headline override (used for failures/stops). */
  headline?: string;
  /**
   * Replaces the whole "Done — …" line. Used for a run that ended early
   * ("The task stopped before completion") so an incomplete task never claims
   * the word Done.
   */
  statusLabel?: string;
  /**
   * Why the task could not finish (provider failure, tool outage). Rendered as
   * "What remains" so a failed run is never dressed up as a completed one.
   */
  incompleteReason?: string;
}

/** The report split so the finalization step can stream what is still unseen. */
export interface TaskReportParts {
  /** Headline plus the model's own prose (usually already on screen). */
  header: string;
  /** The structured sections — the part the user has not seen yet. */
  body: string;
  full: string;
}

function orderFiles(summary: TaskChangeSummary): string[] {
  const ordered = [
    ...summary.createdFiles,
    ...summary.modifiedFiles,
    ...summary.renamedFiles.map((r) => r.to),
    ...summary.filesChanged
  ];
  const seen: string[] = [];
  for (const path of ordered) {
    if (path && !seen.includes(path) && !summary.deletedFiles.includes(path)) seen.push(path);
  }
  return seen;
}

/**
 * One-line description of what happened to a file, derived only from the real
 * operations recorded for it (tool names + constructs found in the code that
 * was actually written). Never invents a reason or a purpose.
 */
function fileDescription(summary: TaskChangeSummary, path: string): string {
  const ops = summary.operations.filter((op) => op.path === path && op.status === "success" && op.mutating);
  const constructs = [...new Set(ops.flatMap((op) => op.constructs))].slice(0, 4);
  const verbs = [...new Set(ops.map((op) => op.tool))];
  const rename = summary.renamedFiles.find((item) => item.to === path);
  const verb = summary.createdFiles.includes(path)
    ? "created"
    : rename ? `renamed from \`${rename.from}\``
      : verbs.includes("edit_file") ? "updated"
        : "rewrote";
  const parts = [verb];
  if (constructs.length > 0) parts.push(constructs.join(", "));
  if (ops.length > 1) parts.push(`${ops.length} operations`);
  return parts.join(" · ");
}

// ── Natural-language reporting ─────────────────────────────────────────────
//
// The final answer is prose written from the verified task result — not a table
// of metadata. Every fact comes from a real recorded operation, and each fact is
// stated ONCE: the headline names the files, the prose says what happened and
// what was verified, and the structured change review below the response carries
// the file-by-file inventory.

function cleanPath(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Never invent a location: only add "in/from the project root" when the real path has no folder. */
function pathWithLocation(path: string, preposition: "in" | "from" = "in"): string {
  const cleaned = cleanPath(path);
  if (!cleaned) return "the file";
  if (!cleaned.includes("/")) return `\`${cleaned}\` ${preposition} the project root`;
  return `\`${cleaned}\``;
}

/** "a", "a and b", "a, b and c" */
function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Name up to three paths, then "and N more files" — never a wall of names.
 * When every named path sits at the workspace root the location is stated once
 * ("`a.html` and `b.css` in the project root"); nested paths already locate
 * themselves, and nothing is ever invented.
 */
function namePaths(paths: string[]): string {
  const named = paths.slice(0, 3).map((path) => `\`${cleanPath(path)}\``);
  const rest = paths.length - named.length;
  if (rest > 0) named.push(`${rest} more file${rest === 1 ? "" : "s"}`);
  return joinList(named);
}

interface ChangeGroups {
  created: string[];
  createdFolders: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
  deletedFolders: string[];
}

function groupChanges(summary: TaskChangeSummary): ChangeGroups {
  return {
    created: summary.createdFiles,
    createdFolders: summary.createdFolders,
    modified: summary.modifiedFiles.filter((path) => !summary.createdFiles.includes(path)),
    renamed: summary.renamedFiles,
    deleted: summary.deletedFiles,
    deletedFolders: summary.deletedFolders
  };
}

function totalChanges(g: ChangeGroups): number {
  return g.created.length + g.createdFolders.length + g.modified.length
    + g.renamed.length + g.deleted.length + g.deletedFolders.length;
}

/**
 * "I created `testing.html` in the project root" / "I updated `a` and `b`, and
 * deleted `c`" — the one-line statement of what actually happened.
 */
function naturalHeadline(g: ChangeGroups): string {
  const clauses: string[] = [];
  const allPaths: string[] = [];
  if (g.created.length > 0) { clauses.push(`created ${namePaths(g.created)}`); allPaths.push(...g.created); }
  if (g.createdFolders.length > 0) {
    clauses.push(`created the ${joinList(g.createdFolders.slice(0, 3).map((folder) => `\`${folder}/\``))} folder${g.createdFolders.length === 1 ? "" : "s"}`);
  }
  if (g.modified.length > 0) { clauses.push(`updated ${namePaths(g.modified)}`); allPaths.push(...g.modified); }
  for (const item of g.renamed.slice(0, 2)) {
    clauses.push(`renamed ${pathWithLocation(item.from)} to ${pathWithLocation(item.to)}`);
  }
  if (g.deleted.length > 0) { clauses.push(`deleted ${namePaths(g.deleted)}`); allPaths.push(...g.deleted); }
  if (g.deletedFolders.length > 0) {
    clauses.push(`deleted the ${joinList(g.deletedFolders.slice(0, 3).map((folder) => `\`${folder}/\``))} folder${g.deletedFolders.length === 1 ? "" : "s"}`);
  }
  if (clauses.length === 0) return "";
  // One file: state its place inline ("`testing.html` in the project root").
  // Several files that all sit at the root: say it once, at the end.
  if (allPaths.length === 1 && g.renamed.length === 0 && g.createdFolders.length === 0 && g.deletedFolders.length === 0) {
    const only = allPaths[0];
    const preposition = g.deleted.length > 0 ? "from" : "in";
    const verb = g.created.length > 0 ? "created" : g.modified.length > 0 ? "updated" : "deleted";
    return `I ${verb} ${pathWithLocation(only, preposition)}`;
  }
  const allAtRoot = allPaths.length > 0 && allPaths.every((path) => !cleanPath(path).includes("/"));
  const sentence = `I ${joinList(clauses)}`;
  return allAtRoot ? `${sentence}, all in the project root` : sentence;
}

/** What the change means for the workspace, in one plain sentence. */
function outcomeSentence(g: ChangeGroups): string {
  const kinds = [g.created.length > 0, g.modified.length > 0, g.renamed.length > 0, g.deleted.length > 0, g.createdFolders.length > 0, g.deletedFolders.length > 0]
    .filter(Boolean).length;
  const deleted = g.deleted.length + g.deletedFolders.length;
  if (kinds > 1) return "The workspace now reflects those changes.";
  if (g.created.length > 0) return g.created.length === 1
    ? "The file now contains the content this task produced."
    : "The new files contain the content this task produced.";
  if (g.createdFolders.length > 0) return "The folder is in place and ready to hold new files.";
  if (deleted > 0) return g.deleted.length > 1
    ? "The files were removed from the workspace and are no longer on disk."
    : "The file was removed from the workspace and is no longer on disk.";
  if (g.renamed.length > 0) return "The file now lives at its new path.";
  return "The updates are in place in the workspace.";
}

/** Long tasks: count what happened, and let the file list below carry the names. */
function countedHeadline(g: ChangeGroups): string {
  const files = (count: number, verb: string) => `${verb} ${count} file${count === 1 ? "" : "s"}`;
  const folders = (count: number, verb: string) => `${verb} ${count} folder${count === 1 ? "" : "s"}`;
  const clauses: string[] = [];
  if (g.created.length > 0) clauses.push(files(g.created.length, "created"));
  if (g.createdFolders.length > 0) clauses.push(folders(g.createdFolders.length, "created"));
  if (g.modified.length > 0) clauses.push(files(g.modified.length, "updated"));
  if (g.renamed.length > 0) clauses.push(files(g.renamed.length, "renamed"));
  if (g.deleted.length > 0) clauses.push(files(g.deleted.length, "deleted"));
  if (g.deletedFolders.length > 0) clauses.push(folders(g.deletedFolders.length, "deleted"));
  if (clauses.length === 0) return "";
  return `I ${joinList(clauses)}`;
}

/** Short, factual closing line — only when it is genuinely useful. */
function nextStepSentence(g: ChangeGroups): string {
  const html = g.created.find((path) => /\.html?$/i.test(path));
  if (html) return `You can open ${pathWithLocation(html)} to see the result.`;
  if (g.deleted.length > 0) return `If you want, I can also check the project for any remaining references to ${namePaths(g.deleted)}.`;
  return "";
}

function controlLine(control: TaskControl): string {
  if (control.mouse) return `- \`${control.mouse}\` — ${control.action}`;
  if (control.keys.length > 0) return `- \`${control.keys.join(" / ")}\` — ${control.action}`;
  if (control.button) return `- \`${control.button}\` (button) — ${control.action}`;
  return `- ${control.action}`;
}

/**
 * Build the final user-facing answer.
 *
 * Reads as a normal assistant message: a natural "Done — I …" line, a short
 * explanation of what happened and what was verified, and only the extra
 * sections that genuinely add information (features, controls, anything that
 * failed). The structured file inventory lives in the change review, so it is
 * not repeated here.
 */
export function composeTaskReport(input: TaskReportInput): string {
  return composeTaskReportParts(input).full;
}

/**
 * Build the final user-facing answer in two parts.
 *
 * The header (headline + model prose) is normally streamed by the model itself,
 * so the finalization phase only has to stream `body`. Keeping them separate is
 * what lets Latex stream the summary without printing the model's closing prose
 * a second time.
 */
export function composeTaskReportParts(input: TaskReportInput): TaskReportParts {
  const { summary } = input;
  const groups = groupChanges(summary);
  const paragraphs: string[] = [];
  const sections: string[] = [];

  // ── Headline: what the agent actually did, in one natural sentence ──
  // Up to three changes are named inline; a longer task is summarised and the
  // "What I changed" list below carries the full inventory (nothing repeated).
  const actions = (totalChanges(groups) > 3 ? countedHeadline(groups) : naturalHeadline(groups)) || undefined;
  const ranCommands = summary.operations.filter((op) => op.type === "command" && op.status === "success");
  const commandHeadline = ranCommands.length === 0
    ? undefined
    : ranCommands.length === 1
      ? `I ran \`${trimCommand(ranCommands[0].command ?? "")}\``
      : `I ran ${ranCommands.length} commands`;
  const headline = input.headline ?? actions ?? commandHeadline ?? "nothing needed to change";
  const status = input.stopped ? "Stopped" : "Done";

  const explanation = sanitizeExplanation(input.explanation ?? "");

  // ── Prose ──
  // A stopped run says so first and then owns exactly what really happened.
  if (input.incompleteReason) {
    paragraphs.push("The run stopped before the task was finished — here is what was completed first.");
    if (actions) paragraphs.push(`${actions}.`);
  }

  // The model's own closing prose (when it wrote any) IS the explanation, so the
  // generated sentences would only repeat it; they are skipped in that case.
  if (!explanation && !input.incompleteReason && totalChanges(groups) > 0) {
    paragraphs.push(outcomeSentence(groups));
  }

  // Count FILES, not operations: writing one file five times is still one change.
  const verifiedChanges = new Set(
    summary.operations
      .filter((op) => op.mutating && op.status === "success" && op.verified !== false)
      .map((op) => op.path ?? op.to ?? op.from ?? "")
      .filter(Boolean)
  ).size;
  if (input.incompleteReason) {
    if (verifiedChanges === 1) paragraphs.push("The change that completed was verified on disk.");
    else if (verifiedChanges > 1) paragraphs.push(`The ${verifiedChanges} changes that completed were verified on disk.`);
  } else if (verifiedChanges === 1) {
    paragraphs.push("I confirmed the change on disk before finishing.");
  } else if (verifiedChanges > 1) {
    paragraphs.push(`I confirmed all ${verifiedChanges} file changes on disk before finishing.`);
  }

  // Real command evidence, described instead of dumped.
  if (ranCommands.length > 0) {
    const names = joinList(ranCommands.slice(0, 3).map((op) => `\`${trimCommand(op.command ?? "")}\``));
    const exitCodes = ranCommands.map((op) => op.exitCode).filter((code): code is number => code !== null && code !== undefined);
    const exitNote = exitCodes.length === 0
      ? ""
      : exitCodes.length === 1 ? ` (exit ${exitCodes[0]})` : ` (exits ${exitCodes.join(", ")})`;
    paragraphs.push(`I also ran ${names} to check the result${exitNote}.`);
  }

  // Extra checks the agent really performed (broken local references, resolved
  // references, …) — stated as sentences, never as a metadata list.
  const checkNotes = summary.verification.filter((line) => /\bstill references\b|references resolve/i.test(line));
  if (checkNotes.length === 1) {
    paragraphs.push(checkNotes[0]);
  } else if (checkNotes.length > 1) {
    sections.push(`### Checks\n\n${checkNotes.map((note) => `- ${note}`).join("\n")}`);
  }

  if (summary.failedOperations.length > 0) {
    paragraphs.push(summary.failedOperations.length === 1
      ? "One operation could not be completed."
      : `${summary.failedOperations.length} operations could not be completed.`);
  }

  // ── Sections that add information the prose does not already carry ──
  // Only a long or mixed task needs the full inventory; short tasks are fully
  // described by the headline, and the change review lists every file anyway.
  if (totalChanges(groups) > 3) {
    const files = orderFiles(summary);
    const lines = files.map((path) => `- \`${path}\` — ${fileDescription(summary, path)}`);
    for (const folder of groups.createdFolders) lines.push(`- \`${folder}/\` — created folder`);
    for (const item of groups.renamed) lines.push(`- \`${item.from}\` → \`${item.to}\``);
    for (const path of groups.deleted) lines.push(`- \`${path}\` — deleted`);
    for (const folder of groups.deletedFolders) lines.push(`- \`${folder}/\` — deleted folder`);
    if (lines.length > 0) sections.push(`### What I changed\n\n${lines.join("\n")}`);
  }

  if (summary.features.length > 0) {
    sections.push(`### New features\n\n${summary.features.map((feature) => `- ${feature}`).join("\n")}`);
  }

  if (summary.controls.length > 0) {
    sections.push(`### Controls\n\n${summary.controls.map(controlLine).join("\n")}`);
  }

  if (summary.failedOperations.length > 0) {
    const lines = summary.failedOperations.slice(0, 6).map((op) => `- ${op.description}`);
    sections.push(`### Not completed\n\n${lines.join("\n")}`);
  }

  if (input.incompleteReason) {
    sections.push(`### What remains\n\n- ${input.incompleteReason}`);
  }

  // ── Closing line: only when there is a real, useful next step ──
  if (!input.incompleteReason && summary.failedOperations.length === 0) {
    const next = nextStepSentence(groups);
    if (next) paragraphs.push(next);
  }

  const head = input.statusLabel
    ? `**${input.statusLabel}**`
    : `**${status} — ${headline}.**`;
  const header = explanation ? `${head}\n\n${explanation}` : head;
  const body = [paragraphs.join("\n\n"), sections.join("\n\n")].filter(Boolean).join("\n\n");
  if (body) return { header, body, full: `${header}\n\n${body}` };
  if (explanation) return { header, body: "", full: header };
  return { header, body: "Nothing in the workspace needed to change.", full: `${header}\n\nNothing in the workspace needed to change.` };
}

/**
 * Compact one-line receipt used by the activity timeline.
 *
 * Counts FILES, not operations: five edits to one file are reported once, and
 * the numbers come from the same verified recorder the final report uses — so
 * the receipt and the answer can never disagree.
 */
export function summarizeForActivity(summary: TaskChangeSummary): string {
  const parts: string[] = [];
  const add = (count: number, singular: string, plural: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
  };
  add(summary.createdFiles.length, "created", "created");
  add(summary.modifiedFiles.length, "edited", "edited");
  add(summary.deletedFiles.length, "deleted", "deleted");
  add(summary.renamedFiles.length, "renamed", "renamed");
  add(summary.createdFolders.length, "folder created", "folders created");
  add(summary.deletedFolders.length, "folder deleted", "folders deleted");
  const commands = summary.operations.filter((op) => op.type === "command" && op.status === "success").length;
  add(commands, "command run", "commands run");
  const failed = summary.failedOperations.length;
  add(failed, "failed", "failed");
  if (parts.length === 0) {
    return summary.counts.succeeded > 0
      ? `${summary.counts.succeeded} operation${summary.counts.succeeded === 1 ? "" : "s"} completed`
      : "Completed";
  }
  return parts.join(" • ");
}
