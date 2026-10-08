import type { AgentActivityStep } from "./types.js";

/**
 * STRUCTURED ACTIVITY VIEW (shared, provider-independent).
 *
 * Everything here is DERIVED from activity steps that the main process really
 * emitted — tool calls that really ran, files that were really read/written,
 * commands that really exited. Nothing in this file invents progress, and none
 * of it is model text: it is the user-facing shape of Latex's own execution.
 *
 * Both renderers (the live timeline and the persisted per-message activity)
 * use these helpers, so every provider — Gemini, GPT, Claude, DeepSeek, Qwen,
 * Nemotron, GPT-OSS, Puter, OpenRouter, OmniRoute, local Ollama — produces the
 * same user-visible progression.
 */

/** High-level phase a step belongs to, named the way the user reads it. */
export type ActivityPhaseName =
  | "Thinking"
  | "Planning"
  | "Inspecting"
  | "Searching"
  | "Reading"
  | "Creating"
  | "Editing"
  | "Deleting"
  | "Renaming"
  | "Running command"
  | "Testing"
  | "Verifying"
  | "Responding";

/** Tools that only look at the workspace (never mutate it). */
const INSPECT_TOOLS = new Set([
  "read_file",
  "list_directory",
  "get_file_info",
  "file_exists",
  "get_workspace_info"
]);
const SEARCH_TOOLS = new Set(["search_files", "search_project"]);
const COMMAND_TOOLS = new Set(["run_command", "run_terminal", "execute_command"]);

/**
 * Command classification for the Testing / Running-command phases.
 *
 * A build, test runner, typecheck or lint run IS the verification step of a
 * coding task, so it is named as such instead of the generic "Running command".
 */
export function classifyCommandPhase(command?: string): ActivityPhaseName {
  const cmd = (command ?? "").toLowerCase();
  if (!cmd) return "Running command";
  const looksLikeCheck =
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|build|lint|typecheck|check|verify|tsc)\b/.test(cmd)
    || /\b(jest|vitest|pytest|py\.test|mocha|playwright|cypress|karma|ava|rspec|cargo\s+test|go\s+test|dotnet\s+test)\b/.test(cmd)
    || /\bnode\s+--test\b/.test(cmd)
    || /\b(tsc|eslint|ruff|flake8|mypy|golangci-lint)\b/.test(cmd);
  return looksLikeCheck ? "Testing" : "Running command";
}

/** The phase one activity step belongs to, or null when it has no execution role. */
export function activityPhase(step: AgentActivityStep): ActivityPhaseName | null {
  const tool = step.tool ?? "";
  switch (step.kind) {
    case "thinking":
      return "Thinking";
    case "planning":
      return "Planning";
    case "response":
      return "Responding";
    case "verification":
      return "Verifying";
    case "command":
      return classifyCommandPhase(step.command);
    case "file_read":
      return tool === "read_file" ? ifPath(step, "Reading", "Inspecting") : "Inspecting";
    case "file_edit":
      switch (tool) {
        case "create_file":
          return "Creating";
        case "delete_file":
          return "Deleting";
        case "rename_file":
        case "move_file":
          return "Renaming";
        default:
          return "Editing";
      }
    case "file_op":
      return "Creating";
    case "tool":
      if (SEARCH_TOOLS.has(tool)) return "Searching";
      if (INSPECT_TOOLS.has(tool)) return "Inspecting";
      if (tool === "create_directory") return "Creating";
      if (tool === "delete_directory") return "Deleting";
      if (tool === "copy_file") return "Creating";
      if (COMMAND_TOOLS.has(tool)) return classifyCommandPhase(step.command);
      return null;
    default:
      return null;
  }
}

function ifPath(step: AgentActivityStep, withPath: ActivityPhaseName, without: ActivityPhaseName): ActivityPhaseName {
  return step.path ? withPath : without;
}

/** Live counters, built from REAL successful operations only. */
export interface ActivityCounts {
  /** Unique file paths, per operation kind (a file written 5× counts once). */
  created: string[];
  edited: string[];
  deleted: string[];
  renamed: string[];
  foldersCreated: string[];
  foldersDeleted: string[];
  filesInspected: string[];
  /** Successful command / test executions. */
  commands: number;
  tests: number;
  /** Steps that finished with a failure — shown so a run never looks clean. */
  failed: number;
}

const EMPTY_COUNTS: ActivityCounts = {
  created: [],
  edited: [],
  deleted: [],
  renamed: [],
  foldersCreated: [],
  foldersDeleted: [],
  filesInspected: [],
  commands: 0,
  tests: 0,
  failed: 0
};

function pushUnique(list: string[], value: string | undefined): void {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * Count what actually happened.
 *
 * Only `done` steps are counted — an attempted operation that failed is not a
 * created file — and paths are deduplicated so five edits to one file stay one
 * change, matching the final change summary.
 */
export function activityCounts(steps: AgentActivityStep[]): ActivityCounts {
  if (steps.length === 0) return { ...EMPTY_COUNTS, created: [], edited: [], deleted: [], renamed: [], foldersCreated: [], foldersDeleted: [], filesInspected: [] };
  const counts: ActivityCounts = {
    created: [],
    edited: [],
    deleted: [],
    renamed: [],
    foldersCreated: [],
    foldersDeleted: [],
    filesInspected: [],
    commands: 0,
    tests: 0,
    failed: 0
  };
  for (const step of steps) {
    if (step.status === "failed") counts.failed += 1;
    if (step.status !== "done") continue;
    const tool = step.tool ?? "";
    switch (tool) {
      case "create_file":
        pushUnique(counts.created, step.path);
        break;
      case "copy_file":
        pushUnique(counts.created, step.path);
        break;
      case "write_file":
      case "edit_file":
        pushUnique(counts.edited, step.path);
        break;
      case "delete_file":
        pushUnique(counts.deleted, step.path);
        break;
      case "rename_file":
      case "move_file":
        pushUnique(counts.renamed, step.path ?? step.detail);
        break;
      case "create_directory":
        pushUnique(counts.foldersCreated, step.path);
        break;
      case "delete_directory":
        pushUnique(counts.foldersDeleted, step.path);
        break;
      case "read_file":
      case "get_file_info":
      case "file_exists":
        pushUnique(counts.filesInspected, step.path);
        break;
      default:
        break;
    }
    if (step.kind === "command" && COMMAND_TOOLS.has(tool || "run_command")) {
      counts.commands += 1;
      if (classifyCommandPhase(step.command) === "Testing") counts.tests += 1;
    }
  }
  return counts;
}

/** Compact count line: "2 created • 5 edited • 1 deleted • 1 renamed". */
export function activityCountLabel(counts: ActivityCounts): string {
  const parts: string[] = [];
  const add = (n: number, word: string) => {
    if (n > 0) parts.push(`${n} ${word}`);
  };
  add(counts.created.length, "created");
  add(counts.edited.length, "edited");
  add(counts.deleted.length, "deleted");
  add(counts.renamed.length, "renamed");
  add(counts.foldersCreated.length, counts.foldersCreated.length === 1 ? "folder created" : "folders created");
  add(counts.foldersDeleted.length, counts.foldersDeleted.length === 1 ? "folder deleted" : "folders deleted");
  add(counts.filesInspected.length, "inspected");
  add(counts.commands, counts.commands === 1 ? "command run" : "commands run");
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(" • ");
}

/** True when the counters carry any information worth showing. */
export function hasCounts(counts: ActivityCounts): boolean {
  return activityCountLabel(counts).length > 0;
}

/**
 * A short, honest HIGH-LEVEL plan derived from what the user actually asked.
 *
 * This is intent, not a claim: it is emitted before any tool has run, it never
 * says something was done, and it always ends with verification. It is built
 * from the request text, not from a model call, so it can never be a
 * fabricated plan and never exposes private reasoning.
 */
export function planIntentForRequest(request: string): string {
  const text = (request ?? "").trim();
  const lower = text.toLowerCase();
  const target = extractTarget(text);
  const where = target ? `\`${target}\`` : "the workspace";

  if (/(delete|remove|clean up|uninstall)/.test(lower)) {
    return `I'll locate ${where}, confirm its current state, remove it, then verify the workspace reflects the removal.`;
  }
  if (/(fix|bug|broken|error|crash|regression|not working|doesn't work|fails?)/.test(lower)) {
    return `I'll inspect ${where} to find what causes this, make the smallest change that fixes it, then run the relevant checks to verify the result.`;
  }
  if (/(refactor|restructure|rename|migrate|port|clean up the code)/.test(lower)) {
    return `I'll inspect ${where} first, plan the change so behaviour is preserved, apply it, then verify nothing broke.`;
  }
  if (/(run|install|execute|launch|start)\b/.test(lower)) {
    return `I'll inspect the project setup, run what this needs, then read the real output and confirm the result.`;
  }
  if (/(review|analyse|analyze|explain|audit|summarise|summarize|what does)/.test(lower)) {
    return `I'll read ${where} and report what I find — read-only, no files will be changed.`;
  }
  if (/(create|add|build|implement|make|write|generate|set up|setup|new)/.test(lower)) {
    return `I'll inspect the existing structure around ${where}, plan the change, implement it, then run the available checks to verify it works.`;
  }
  return `I'll inspect ${where} and the rest of the project, identify what this needs, make the smallest required change, then verify the result.`;
}

/** First file-like token in the request ("src/App.tsx", "index.html"). */
function extractTarget(text: string): string | undefined {
  const quoted = text.match(/[`"']([^`"']*\.[a-z0-9]{1,6})[`"']/i);
  if (quoted) return quoted[1];
  const bare = text.match(/\b[\w./-]*[\w-]\.(?:[a-z]{1,6})\b/i);
  return bare ? bare[0] : undefined;
}
