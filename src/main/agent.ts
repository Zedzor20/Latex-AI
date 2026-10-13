import { BrowserWindow } from "electron";
import path from "node:path";
import type { AgentActivityStep, AgentEvent, AgentTaskPhase, AgentTaskStatus, AgentTaskTimings, Attachment, ChatMessage, Conversation, FileOperationEvent, FileOperationPreview, FilesystemAccess, GeneratedResult, GeminiModel, ModelProvider, PendingChange, ProviderError, TaskChangeSummary, TaskResultState, Workspace } from "../shared/types.js";
import { generatedResultCounts, generatedResultFromImage, generatedResultFromToolResult, generatedResultSentence, mergeGeneratedResults, resolveTaskResultState } from "../shared/generatedResults.js";
import { shouldFallback, classifyHttpStatus } from "../shared/types.js";
import { LATEX_SYSTEM_PROMPT, LATEX_CHAT_PROMPT, LATEX_TOOL_PROTOCOL } from "../shared/systemPrompt.js";
import { applyResponseContract } from "../shared/responseContract.js";
import { LATEX_SYSTEM_PROMPT_LOCAL, LATEX_TOOL_PROTOCOL_LOCAL } from "../shared/systemPromptLocal.js";
import { toolCatalogTextLocal } from "./toolCatalogLocal.js";
import { FileTools } from "./fileTools.js";
import type { AIProvider } from "./geminiProvider.js";
import { AppStore } from "./store.js";
import { isQuotaError, ProviderFactory, providerOfModel, recordModelFailure, recordModelSuccess, isModelAvailable, toProviderError, providerLabel } from "./providerService.js";
import { applyFileOperationEvent, compactReviewChanges, MAX_PERSISTED_FILE_OPERATIONS } from "../shared/fileOperations.js";
import { getPuterAuthToken } from "./main.js";
import { id, redactActivityText } from "./security.js";
import { buildApprovalRequest, getTool, toolCatalogText, type ToolContext } from "./tools.js";
import { toolDeclarationsFor } from "./toolDeclarationsWrap.js";
import { containsToolCall, parseTextToolCalls, stripToolCallBlocks } from "./toolProtocol.js";
import { AssistantStreamFilter } from "./assistantStreamFilter.js";
import { isOllamaModel, requestGate, releaseRequest } from "./ollamaGate.js";
import { AgentRuntimeGuard, AGENT_IDLE_TIMEOUT_MS, AGENT_MAX_RUNTIME_MS } from "./requestPolicy.js";
import { getTaskManager } from "./taskManager.js";
import { composeTaskReport, composeTaskReportParts, emptyTaskSummary, htmlLocalReferences, mergePendingChange, summarizeForActivity, TaskChangeRecorder, type CodeSource } from "./taskSummary.js";
import { chatBoundaryNotice, detectWorkspaceClaims, normalizeChatResponse } from "./chatResponse.js";
import { planIntentForRequest } from "../shared/taskActivity.js";
import { imageGenerationCapability, preferredImageModelPattern, resolveThinkingEnabled } from "../shared/modelCapabilities.js";
import { imageGenerationIntent } from "../shared/imageRouting.js";
import {
  CompletionGuard,
  finalAnswerDiagnostic,
  finalizationKey,
  normalizeAnswerText,
  pendingStreamText,
  reconcileFinalAnswer,
  type FinalAnswerReconciliation
} from "../shared/finalAnswer.js";
import { currentTurnHasImage, imagesOf, toProviderMessage, type ProviderMessage } from "../shared/vision.js";

/** Text files whose final contents are analysed for features/controls. */
const ANALYZABLE_EXTENSIONS = /\.(?:html?|css|js|mjs|cjs|jsx|tsx?|json|md|txt|py|sh|ps1|yml|yaml)$/i;
/** Cap on how much changed source is read back for the summary (characters). */
const MAX_ANALYSIS_CHARS = 400_000;

/**
 * Does this user prompt ask for an IMAGE to be generated or edited?
 *
 * Used ONLY to (a) route the turn to a genuinely image-capable model when the
 * selected one cannot return image data and the SAME provider offers one, and
 * (b) tell the user honestly when no image output is possible. A false positive
 * is harmless (the model just answers in text); a false negative leaves normal
 * text behaviour completely untouched.
 *
 * The predicate itself lives in `shared/imageRouting.ts`, next to the endpoint
 * rule it feeds, so intent detection and routing can never disagree — and so
 * the same predicates are what the routing tests exercise. Understanding a
 * picture ("what is this image?") is deliberately NOT an image request.
 */
export function looksLikeImageRequest(text: string): boolean {
  return imageGenerationIntent(text);
}

/** File extension for a generated image MIME type. */
function imageExtension(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "png";
}

/** Tools that change the filesystem durably when they succeed (Part L). */
const FILE_WRITE_TOOLS = new Set([
  "edit_file", "write_file", "create_file", "rename_file", "move_file",
  "delete_file", "create_directory", "delete_directory", "copy_file"
]);

/**
 * Tools whose content can be shown as a live file preview.
 *
 * Only operations that PRODUCE file content get a preview card; delete/rename/
 * move only have an activity row because there is no content to display (and
 * showing one would be a fabricated file view).
 */
const FILE_PREVIEW_TOOLS = new Set(["create_file", "write_file", "edit_file"]);

/**
 * Canonical JSON for tool arguments: object keys sorted, `undefined` dropped.
 * Two dispatches of the same call produced by different code paths (native
 * function-call deltas vs. the text protocol vs. a re-sent turn) must hash to
 * the same string, so key order in the provider payload can never decide
 * whether a call is a duplicate.
 */
function canonicalArgs(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalArgs).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalArgs(entryValue)}`).join(",")}}`;
}

/** The stable identity of ONE logical tool invocation inside a task. */
function toolCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}|${canonicalArgs(args)}`;
}

/** Map a tool name onto the file-operation kind shown in the preview card. */
function fileOperationKind(name: string): FileOperationPreview["operation"] {
  switch (name) {
    case "create_file": return "create";
    case "copy_file": return "copy";
    case "edit_file": return "edit";
    case "rename_file": return "rename";
    case "move_file": return "move";
    case "delete_file": return "delete";
    default: return "write";
  }
}

/**
 * Did a tool invocation really succeed?
 *
 * File tools report their own success flags, but a COMMAND's truth is its exit
 * code: `node broken.js` exiting 1 (or a build exiting 1) must never be shown as
 * "Success" in the activity panel, counted as a completed operation, or
 * described as a passing check in the final report.
 */
function toolResultFailed(name: string, result: unknown): boolean {
  if (name !== "run_command") return false;
  const exitCode = result && typeof result === "object" ? (result as Record<string, unknown>).exitCode : undefined;
  return typeof exitCode === "number" && exitCode !== 0;
}

/**
 * Shared success test for a finished tool call (result flags + real exit code).
 *
 * `verified: false` is a FAILURE: a tool that reports it could not confirm the
 * operation on disk must never be counted as a completed change — that is what
 * let an unverified folder creation appear as a success.
 */
function toolCallSucceeded(name: string, result: unknown): boolean {
  const json = typeof result === "string" ? result : JSON.stringify(result ?? null);
  if (json.includes('"error"') || json.includes('"success": false')) return false;
  const obj = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
  if (obj && obj.verified === false) return false;
  if (obj && obj.cancelled === true) return false;
  return !toolResultFailed(name, result);
}

/** Compact, store-safe subset of tool args for the task checkpoint. */
function pickToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const key of ["relativePath", "path", "from", "to", "command", "query", "oldText", "newText"]) {
    const value = args[key];
    if (typeof value === "string") keep[key] = value.length > 500 ? value.slice(0, 500) : value;
  }
  if (typeof args.content === "string") keep.content = `<${args.content.length} chars>`;
  return keep;
}

// ── Deterministic Action Detection ───────────────────────────────────────
// When small models claim an action in prose but don't produce a tool call,
// this function detects the implied action and returns the tool + args.

interface ImpliedAction {
  tool: string;
  args: Record<string, unknown>;
  path: string;
  toolLabel: string;
}

function detectImpliedAction(userMessage: string, modelResponse: string): ImpliedAction | null {
  const response = (modelResponse || "").toLowerCase();
  const user = (userMessage || "").toLowerCase();

  // Extract filename patterns from user message: "Delete X", "Create X", "make a folder called X", etc.
  const filePatterns = user.match(/(?:delete|remove|create|write|rename|edit)\s+(?:the\s+)?(?:file\s+)?[`"']?([\w.\-\/\\]+(?:\.[a-zA-Z0-9]+))[`"']?/i);
  const explicitPath = filePatterns?.[1];

  // Also try quoted filenames: `file.html`, "file.html"
  const quotedPath = user.match(/[`"']([\w.\-\/\\]+(?:\.[a-zA-Z0-9]+))[`"']/)?.[1];

  // Try folder patterns: "create a folder called X", "make directory X", "create folder X"
  const folderCreateMatch = user.match(/(?:create|make|add)\s+(?:a\s+)?(?:folder|directory|dir)\s+(?:called|named|titled)?\s*[`"']?([\w.\-\/\\]+)[`"']?/i);
  const folderDeleteMatch = user.match(/(?:delete|remove)\s+(?:the\s+)?(?:folder|directory|dir)\s+[`"']?([\w.\-\/\\]+)[`"']?/i);

  const targetPath = explicitPath || quotedPath;
  const targetFolder = folderCreateMatch?.[1] || folderDeleteMatch?.[1];
  const finalPath = targetPath || targetFolder;
  if (!finalPath) return null;

  // If user asked to create/delete a folder, use directory tools
  if (folderCreateMatch && !targetPath) {
    const folderCreated = /(?:created|made|added|exists|ready|done)/i.test(response);
    if (folderCreated) {
      return {
        tool: "create_directory",
        args: { relativePath: folderCreateMatch[1] },
        path: folderCreateMatch[1],
        toolLabel: `Creating folder ${folderCreateMatch[1]}`
      };
    }
  }
  if (folderDeleteMatch && !targetPath) {
    const folderDeleted = /(?:deleted|removed|done|cleared)/i.test(response);
    if (folderDeleted) {
      return {
        tool: "delete_directory",
        args: { relativePath: folderDeleteMatch[1] },
        path: folderDeleteMatch[1],
        toolLabel: `Deleting folder ${folderDeleteMatch[1]}`
      };
    }
  }

  // Detect what action the model claims to have done
  const deletePatterns = ["i deleted", "i have deleted", "removed", "i removed", "has been deleted", "has been removed", "deleted successfully", "done. i deleted", "done, i deleted", "deleted the", "removal of", "file has been removed", "file deleted", "i've deleted", "i've removed", "was deleted", "was removed", "successfully deleted", "successfully removed"];
  const createPatterns = ["i created", "i have created", "created successfully", "file has been created", "i wrote", "i have written", "done. i created", "done, i created", "here is the file", "here's the file", "created the", "wrote the", "the file has been created", "file created", "i've created", "i've written", "was created", "successfully created", "successfully wrote"];
  const renamePatterns = ["i renamed", "i have renamed", "renamed successfully", "has been renamed", "renamed the", "file has been renamed", "i've renamed", "was renamed", "successfully renamed"];
  const editPatterns = ["i edited", "i have edited", "i updated", "i modified", "edited successfully", "has been updated", "has been modified", "done. i updated", "done, i updated", "edited the", "updated the", "modified the", "the file has been updated", "file updated", "i've edited", "i've updated", "i've modified", "was updated", "was edited", "successfully updated", "successfully edited"];

  // Only trigger if the USER asked for this specific action AND the model claims it happened
  const userAskedDelete = /delete|remove/i.test(user);
  const userAskedCreate = /create|write|make|new file/i.test(user);
  const userAskedRename = /rename/i.test(user);
  const userAskedEdit = /edit|update|modify|change|replace/i.test(user);

  const modelClaimsDelete = deletePatterns.some(p => response.includes(p));
  const modelClaimsCreate = createPatterns.some(p => response.includes(p));
  const modelClaimsRename = renamePatterns.some(p => response.includes(p));
  const modelClaimsEdit = editPatterns.some(p => response.includes(p));

  if (userAskedDelete && modelClaimsDelete) {
    return {
      tool: "delete_file",
      args: { relativePath: finalPath },
      path: finalPath,
      toolLabel: `Deleting ${finalPath}`
    };
  }

  if (userAskedCreate && modelClaimsCreate) {
    // For create, we need the content the model generated
    // Extract from the response: look for code blocks first
    const codeBlockMatch = modelResponse.match(/```(?:html|css|js|javascript|typescript|python|txt|json|xml|yaml|yml|md|sh|bat|ps1|c|cpp|java|rs|go)?\s*\n([\s\S]*?)```/);
    const content = codeBlockMatch?.[1]?.trim();
    if (content && content.length > 5) {
      return {
        tool: "create_file",
        args: { relativePath: finalPath, content },
        path: finalPath,
        toolLabel: `Creating ${finalPath}`
      };
    }
    // If no code block, check if the response contains meaningful non-prose content
    // Look for content after the claim (e.g., model wrote content below its claim)
    const lines = modelResponse.split("\n");
    let contentStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (modelClaimsCreate && /created|wrote|written/i.test(lines[i])) {
        contentStart = i + 1;
        break;
      }
    }
    if (contentStart >= 0 && contentStart < lines.length) {
      const trailingContent = lines.slice(contentStart).join("\n").trim();
      if (trailingContent.length > 10) {
        return {
          tool: "create_file",
          args: { relativePath: finalPath, content: trailingContent },
          path: finalPath,
          toolLabel: `Creating ${finalPath}`
        };
      }
    }
    return null; // Can't create without content
  }

  if (userAskedRename && modelClaimsRename) {
    // Extract the new name from user message
    const renameMatch = user.match(/rename\s+(?:the\s+)?(?:file\s+)?[`"']?([\w.\-\/\\]+)[`"']?\s+(?:to|as)\s+[`"']?([\w.\-\/\\]+(?:\.[a-zA-Z0-9]+))[`"']?/i);
    if (renameMatch) {
      return {
        tool: "rename_file",
        args: { from: renameMatch[1], to: renameMatch[2] },
        path: renameMatch[1],
        toolLabel: `Renaming ${renameMatch[1]} to ${renameMatch[2]}`
      };
    }
    return null;
  }

  if (userAskedEdit && modelClaimsEdit && !userAskedDelete && !userAskedCreate) {
    // For edit, look for old/new content in the response
    // Try to find a diff or replacement pair
    const oldNewMatch = modelResponse.match(/(?:replacing?|changing?|updating?)\s+[`"'](.+?)[`"']\s+(?:with|to)\s+[`"'](.+?)[`"']/i);
    if (oldNewMatch) {
      return {
        tool: "edit_file",
        args: { relativePath: finalPath, oldText: oldNewMatch[1], newText: oldNewMatch[2] },
        path: finalPath,
        toolLabel: `Editing ${finalPath}`
      };
    }
    return null;
  }

  return null;
}

const activeAgents = new Set<Agent>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

/**
 * Build a timeout error that names the ACTUAL provider/model that stalled and
 * how long we waited — so the error card never blames an unrelated model
 * (e.g. "Ollama qwen…" shown for a Gemini/OpenRouter request).
 *
 * kind:
 *   "max_runtime" — task hit Latex's 30-minute maximum runtime
 *   "idle"        — stream went completely silent (no bytes)
 */
function timeoutError(provider: ModelProvider, model: string, ms: number, kind?: "max_runtime" | "idle"): Error {
  const secs = Math.round(ms / 1000);
  const detail = kind === "max_runtime"
    ? "timed out: reached Latex's 30-minute maximum runtime for a single task"
    : kind === "idle"
      ? `timed out: stopped responding — no data arrived for ${secs} seconds`
      : `did not respond within ${secs} seconds`;
  const err = new Error(
    `${providerLabel(provider)} model ${model} ${detail}.`
  ) as Error & Partial<ProviderError>;
  Object.assign(err, {
    provider,
    model,
    errorType: "timeout",
    retryable: true,
    fallbackAllowed: false,
    status: null,
    timestamp: Date.now()
  });
  return err;
}

export function stopActiveAgents(): void {
  for (const agent of activeAgents) agent.requestStop();
}

export function resolvePendingApproval(requestId: string, approved: boolean): boolean {
  const waiter = pendingApprovals.get(requestId);
  if (!waiter) return false;
  pendingApprovals.delete(requestId);
  waiter(approved);
  return true;
}

/**
 * Register an approval wait in the SAME pending-approval map the agent uses,
 * so MCP tool calls resolve through the identical `agent:resolveApproval` IPC
 * the Main Agent permission UI already drives. Permissions are never bypassed.
 */
export function registerPendingApproval(requestId: string): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(requestId, resolve);
  });
}

export class Agent {
  private fileTools = new FileTools();
  private stopped = false;
  private abortController: AbortController | null = null;
  private _activityStepsForMessage: AgentActivityStep[] = [];
  /**
   * Every REAL file operation of the current turn, folded by path exactly the
   * way the live panel folds them. This is the durable record: it is written
   * into the assistant message's metadata so "Editing x.ts" is still there
   * after a chat switch, a new message or an app restart — where it used to be
   * renderer state that vanished with the component.
   */
  private _fileOperationsForMessage: FileOperationPreview[] = [];
  /**
   * Durable GENERATED RESULTS for this message: images the provider really
   * produced and visuals a real tool really returned. Persisted WITH the
   * message so a generated graph/image survives Thinking collapsing, the final
   * response, a new message, a tab/chat switch and a restart.
   */
  private _generatedResultsForMessage: GeneratedResult[] = [];
  /** The real outcome state of the current turn (set during finalization). */
  private _taskResultForMessage: TaskResultState | null = null;
  /**
   * The turn's Change Review records (one entry per file, net diff).
   *
   * `collectChange` folds every real file mutation in here, and the finished
   * list is written onto the assistant message's metadata. That is what makes
   * "Agent changed 1 file / MODIFIED test.html / +13 -1 / Review" part of the
   * conversation rather than of the running task: it used to live only in the
   * renderer, so sending another message, switching chats or remounting the
   * chat view silently destroyed the record. Reset per turn, never per render.
   */
  private _reviewChangesForMessage: PendingChange[] = [];
  /** Task-level runtime guard — 30-min max + idle watchdog, no 90s cap. */
  private runtimeGuard: AgentRuntimeGuard | null = null;
  /** Persistent task id for checkpointing (null when no task is active). */
  private currentTaskId: string | null = null;
  /** Assistant message this run is producing — stamped on every stream event. */
  private currentMessageId: string | null = null;
  /** Current request phase — the honesty source for the activity header. */
  private phase: AgentTaskPhase | null = null;
  /**
   * Stable id of THIS run's task-plan row.
   *
   * The plan is the first thing the user sees and must stay visible while the
   * real steps scroll underneath it, so it gets its own id and is completed
   * in place (never merged into a later "Thinking" row by label).
   */
  private planStepId: string | null = null;
  /**
   * Last high-level Thinking-box status line, so an identical consecutive line
   * is never repeated (a 12-turn loop must not spam the same sentence).
   */
  private lastActivityStatus = "";
  /**
   * Task-scoped tool-execution registry — the idempotency guard.
   *
   * Keyed by `toolCallKey(name, args)` and holding the result of the one real
   * execution plus the workspace stamp it was recorded against. A duplicate
   * dispatch (fragmented tool deltas, a re-sent turn, a model re-emitting an
   * identical call) replays that result instead of running the tool again.
   */
  private toolExecutions = new Map<string, { result: unknown; stamp: number; failures?: number }>();
  /**
   * Bumped every time a file-mutating tool really changes the workspace.
   *
   * This is what separates a duplicate from a legitimate repeat: `build → edit
   * → build` has a new stamp, so the second build runs; `Get-Date → Get-Date`
   * has no state change between them, so the second one is a replay.
   */
  private toolStateStamp = 0;
  /** Real timing milestones (never derived from a single generic timer). */
  private timings: AgentTaskTimings = {};
  /** chatId of the active run — events stay routable per chat (Part AB). */
  private currentConvId = "";
  /** Accumulated assistant text for crash-safe stream checkpoints (Part F). */
  private taskStreamContent = "";
  /**
   * Provider-exposed reasoning summaries received during this task.
   * Checkpointed with the task so a cancelled/failed/interrupted run keeps the
   * thinking the provider really sent — never reconstructed, never invented.
   */
  private thinkingForTask: string[] = [];
  /** Checkpoint brief for a resumed task (empty on a normal turn). */
  private resumeNote = "";
  /**
   * Compact, human-readable reason this task did not complete (provider error
   * text or "stopped by user"). Checkpointed so a recovered task knows WHY it
   * stopped instead of guessing.
   */
  private taskError = "";
  /** Text already delivered on the assistant channel during the ACTIVE run. */
  private streamedAnswerText = "";
  /**
   * Which pipeline this Agent instance is running. The Main pipeline owns the
   * workspace tools; the Chat pipeline is conversation-only. Enforced at the
   * tool-execution layer — not by hiding buttons in React.
   */
  private runMode: "main" | "chat" = "main";
  /**
   * Real, operation-derived record of what this task changed. Created for Main
   * runs only; `null` in Chat means no workspace mutation can ever be recorded.
   */
  private changes: TaskChangeRecorder | null = null;
  /**
   * ONCE-PER-MESSAGE COMPLETION GUARD.
   *
   * A run must finalize (and emit `done`) exactly ONE time. A duplicate
   * completion, a late provider event or a second finalization pass would
   * otherwise append/replace the assistant message the user is reading.
   */
  private readonly completionGuard = new CompletionGuard();
  /** Development diagnostics for final-text decisions (opt-in, content-free). */
  private readonly debugFinalAnswer = process.env.LATEX_DEBUG_FINAL_ANSWER === "1";

  constructor(
    private readonly store: AppStore,
    private readonly window: BrowserWindow,
    private readonly chatHistory?: import("./chatHistoryService.js").ChatHistoryService
  ) {
    activeAgents.add(this);
  }

  /** Start the persistent task + the task-level 30-minute runtime guard. */
  private startRuntime(conversation: Conversation, mode: "main" | "chat", workspace: Workspace | undefined, model: string | undefined): void {
    this.currentConvId = conversation.id;
    this.taskStreamContent = "";
    this.streamedAnswerText = "";
    this.completionGuard.clear();
    this.thinkingForTask = [];
    this.taskError = "";
    // Every delta/activity event of this run is tagged with its message id, so
    // the renderer can never append it to the wrong chat or message.
    this.currentMessageId = id("msg");
    // Fresh phase + timing trail for THIS task. The activity UI starts moving
    // immediately ("Starting task") instead of waiting for the first token.
    this.phase = null;
    this.timings = {};
    this.runtimeGuard?.dispose();
    this.runtimeGuard = new AgentRuntimeGuard();
    if (!model) return; // no model → run() throws immediately, no task to track
    try {
      const messages = conversation.messages;
      let lastUser: ChatMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { lastUser = messages[i]; break; }
      }
      const task = getTaskManager(this.store).beginTask({
        chatId: conversation.id,
        mode,
        provider: providerOfModel(model),
        model,
        userPrompt: lastUser ? lastUser.content.slice(0, 4000) : undefined,
        workspaceId: workspace?.id
      });
      this.currentTaskId = task.taskId;
      this.setPhase("starting", "Starting task");
    } catch (err) {
      console.error("[Agent] Failed to begin task record:", err);
      this.currentTaskId = null;
    }
  }

  /** Terminal checkpoint: completed | cancelled | timed_out | failed. */
  private finishRuntime(status: AgentTaskStatus): void {
    const taskId = this.currentTaskId;
    if (!taskId) return;
    this.currentTaskId = null;
    this.currentMessageId = null;
    this.logTimings(status);
    try {
      getTaskManager(this.store).finishTask(taskId, status, {
        phase: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
        timings: { ...this.timings, completedAt: this.timings.completedAt ?? Date.now() },
        assistantContent: this.taskStreamContent,
        activity: this._activityStepsForMessage,
        thinkingSummaries: this.thinkingForTask.length > 0 ? [...this.thinkingForTask] : undefined,
        // Why it stopped — real text only, never a reconstructed explanation.
        error: this.stopped ? "Stopped by the user." : (this.taskError || undefined)
      });
    } catch (err) {
      console.error("[Agent] Failed to finalize task record:", err);
    }
  }

  /** Classify why a run ended abnormally. Timeouts are NEVER "completed". */
  private taskStatusForError(): AgentTaskStatus {
    if (this.stopped) return "cancelled";
    if (this.runtimeGuard?.abortReason) return "timed_out";
    return "failed";
  }

  /**
   * Record a real lifecycle phase transition.
   *
   * This is what stops the activity UI from showing a generic "thinking" label
   * while nothing is actually arriving: the phase becomes
   * `waiting_for_provider` the moment the request is dispatched, and only moves
   * to `streaming` when the first real provider event lands.
   */
  private setPhase(phase: AgentTaskPhase, stepLabel?: string): void {
    const at = Date.now();
    this.phase = phase;
    const t = this.timings;
    if (!t.taskStartedAt) t.taskStartedAt = at;
    // Milestones are FIRST-occurrence only: overwriting them per model call
    // made the timing trail self-contradictory (negative first-byte latency).
    if (phase === "requesting_model" && !t.requestStartedAt) t.requestStartedAt = at;
    if (phase === "streaming" && !t.firstProviderEventAt) t.firstProviderEventAt = at;
    if (phase === "tool_execution" && !t.firstToolCallAt) t.firstToolCallAt = at;
    if (phase === "completed") t.completedAt = at;
    t.lastEventAt = at;

    if (this.currentTaskId) {
      try {
        getTaskManager(this.store).checkpoint(this.currentTaskId, { phase, timings: { ...t } }, { immediate: true });
      } catch { /* bookkeeping must never break generation */ }
    }
    this.emit({
      type: "phase",
      conversationId: this.currentConvId || "active",
      payload: { phase, at, timings: { ...t } }
    });
    // Debug timing trail (development aid only — never shown in the product UI).
    console.log(`[Task ${this.currentTaskId ?? "-"}] phase=${phase} at=${at} since=${t.taskStartedAt ? at - t.taskStartedAt : 0}ms`);
    if (stepLabel) this.emitActivityStep(stepLabel, "active");
    // The AGENT ACTIVITY status line mirrors the REAL lifecycle in Main mode
    // only: Chat stays a plain conversation and never shows agent status lines.
    // This is the ACTIVITY channel — it is never mixed with `thinking`, which
    // carries the provider's own reasoning.
    if (stepLabel && this.runMode === "main") this.emitActivityStatus(stepLabel);
  }

  /** Mark the first streamed assistant delta (used for first-token timing). */
  private noteFirstDelta(): void {
    if (!this.timings.firstAssistantDeltaAt) this.timings.firstAssistantDeltaAt = Date.now();
  }

  /** Log the timing trail for this task (Part 36: diagnosis, not UI). */
  private logTimings(status: AgentTaskStatus): void {
    const t = this.timings;
    const rel = (value?: number) => (value && t.taskStartedAt ? `${value - t.taskStartedAt}ms` : "-");
    console.log(
      `[Task ${this.currentTaskId ?? "-"}] ${status} timings: request=${rel(t.requestStartedAt)} ` +
      `firstProviderEvent=${rel(t.firstProviderEventAt)} firstDelta=${rel(t.firstAssistantDeltaAt)} ` +
      `firstTool=${rel(t.firstToolCallAt)} lastEvent=${rel(t.lastEventAt)}`
    );
  }

  /** Task-level timeout (30-min max runtime or silent idle stream). */
  private runtimeTimeoutError(provider: ModelProvider, model: string, reason: "max_runtime" | "idle"): Error {
    return timeoutError(provider, model, reason === "max_runtime" ? AGENT_MAX_RUNTIME_MS : AGENT_IDLE_TIMEOUT_MS, reason);
  }

  /**
   * Emit turn-end prose to the renderer ONLY when it was not already streamed
   * live. The streamed text is a prefix of the cleaned turn text, so anything
   * the filter already sent is skipped — this is the duplicate-response guard.
   */
  private emitUnstreamedProse(raw: string, streamedThisTurn: string, conversationId: string): void {
    const clean = stripToolCallBlocks(raw).trim();
    if (!clean) return;
    const normalize = (value: string) => value.replace(/[\s\n\r]+/g, " ").trim();
    const target = normalize(clean);
    const already = normalize(streamedThisTurn);
    if (already && target.startsWith(already)) {
      // Everything (or nearly everything) is on screen; the final message is
      // built separately and delivered with the `done` event.
      return;
    }
    if (!already) {
      this.taskStreamContent += clean;
      this.checkpointAssistantStream();
      this.streamedAnswerText += clean;
      this.emit({ type: "message", conversationId, payload: clean });
      return;
    }
    // Partially streamed: append only the unseen remainder.
    const remainder = target.slice(already.length).trim();
    if (!remainder) return;
    this.taskStreamContent += remainder;
    this.checkpointAssistantStream();
    this.streamedAnswerText += remainder;
    this.emit({ type: "message", conversationId, payload: remainder });
  }

  /**
   * Stream the composed final answer through the normal assistant channel.
   *
   * The finalization phase must not dump one giant block: the answer arrives as
   * paragraph-sized chunks on the same `message` events every other delta uses,
   * and the persisted `done` message is exactly the text that was streamed.
   */
  private streamFinalContent(text: string, conversationId: string): void {
    const clean = (text ?? "").trim();
    if (!clean) return;
    let rest = clean;
    while (rest.length > 0) {
      let cut = rest.length;
      if (rest.length > 600) {
        const window = rest.slice(0, 600);
        const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
        cut = breakAt > 200 ? breakAt + 1 : 600;
      }
      const piece = rest.slice(0, cut);
      rest = rest.slice(cut);
      this.taskStreamContent += piece;
      this.checkpointAssistantStream();
      this.emit({ type: "message", conversationId, payload: piece });
    }
  }

  /**
   * Emit the terminal `done` event at most ONCE per run/message.
   *
   * A duplicate `done` is what makes a finished answer change on screen: the
   * renderer swaps in the payload's conversation again and a late event can win
   * the race against the one the user is reading. The guard is keyed by the
   * run's task+message identity, so a genuine second message is unaffected.
   */
  private emitDoneOnce(conversationId: string, conversation: Conversation): void {
    const key = finalizationKey(this.currentTaskId, this.currentMessageId);
    if (!this.completionGuard.claim(key)) {
      console.log(`[Agent] Duplicate completion suppressed for ${key || "(unkeyed run)"} — the message was already finalized.`);
      if (this.debugFinalAnswer) {
        console.log(finalAnswerDiagnostic({
          taskId: this.currentTaskId ?? undefined,
          messageId: this.currentMessageId ?? undefined,
          stage: "done-dedupe",
          streamedLength: this.streamedAnswerText.length,
          finalLength: 0,
          source: "skipped",
          preservedStreamed: true,
          ignoredEmptyFinal: false,
          rejectedReplacement: false
        }));
      }
      return;
    }
    this.emit({ type: "done", conversationId, payload: conversation });
  }

  /**
   * Record what happened to the final text (development diagnostics only).
   *
   * Content-free by construction: lengths and the DECISION are logged, never the
   * answer itself, so no message body and no credential can reach the log.
   */
  private noteFinalAnswer(stage: string, reconciled: FinalAnswerReconciliation, candidate: string): void {
    if (!this.debugFinalAnswer) return;
    console.log(finalAnswerDiagnostic({
      taskId: this.currentTaskId ?? undefined,
      messageId: this.currentMessageId ?? undefined,
      stage,
      streamedLength: this.streamedAnswerText.length,
      finalLength: (candidate ?? "").length,
      source: reconciled.source,
      preservedStreamed: reconciled.preservedStreamed,
      ignoredEmptyFinal: reconciled.ignoredEmptyFinal,
      rejectedReplacement: reconciled.rejectedReplacement
    }));
    if (reconciled.rejectedReplacement) {
      console.warn("[Agent] A finalization payload tried to replace a longer streamed answer; the streamed answer was kept.");
    }
  }

  /** Checkpoint the accumulated assistant text (debounced by the manager). */
  private checkpointAssistantStream(): void {
    const taskId = this.currentTaskId;
    if (!taskId) return;
    try {
      getTaskManager(this.store).checkpointStream(taskId, this.taskStreamContent);
    } catch {
      // Checkpointing must never break generation.
    }
  }

  /** Record a tool invocation start (+ durable file-op start for write tools). */
  private recordToolStart(callId: string, name: string, args: Record<string, unknown>, pathArg: string | undefined): void {
    const taskId = this.currentTaskId;
    if (!taskId) return;
    try {
      const tm = getTaskManager(this.store);
      tm.checkpointToolCall(taskId, { id: callId, tool: name, args: pickToolArgs(args), status: "started", path: pathArg, at: Date.now() });
      if (FILE_WRITE_TOOLS.has(name) && pathArg) {
        tm.checkpointFileOp(taskId, { path: pathArg, operation: name, status: "started", at: Date.now() });
      }
    } catch {
      // Never break tool execution over checkpointing.
    }
  }

  /**
   * Record a finished tool invocation. For write tools this is the durable
   * "file is on disk + verified" checkpoint (Parts L/AA): immediate persist.
   */
  private recordToolEnd(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    pathArg: string | undefined,
    status: "completed" | "failed" | "rejected",
    result?: unknown
  ): void {
    const resultJson = result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result ?? null);
    const success = status === "completed"
      && !resultJson.includes('"error"')
      && !resultJson.includes('"success": false')
      && !toolResultFailed(name, result);

    // ── Operation-derived change record ────────────────────────────────
    // The ONLY place a file change becomes real: the tool actually ran and
    // reported success. Model text is never consulted. Chat runs have no
    // recorder at all, so a fabricated tool call in Chat records nothing.
    try {
      this.changes?.record(name, args, success, result, status === "completed" ? (success ? "success" : "failed") : status);
    } catch { /* summary building must never break the run */ }

    const taskId = this.currentTaskId;
    if (!taskId) return;
    try {
      const tm = getTaskManager(this.store);
      const callStatus = status === "completed" ? (success ? "completed" : "failed") : status;
      tm.checkpointToolCall(taskId, {
        id: callId,
        tool: name,
        args: pickToolArgs(args),
        status: callStatus,
        path: pathArg,
        result: resultJson ? resultJson.slice(0, 2000) : undefined,
        at: Date.now()
      });
      if (FILE_WRITE_TOOLS.has(name) && pathArg) {
        const verified = result && typeof result === "object"
          ? Boolean((result as { verified?: boolean }).verified)
          : undefined;
        tm.checkpointFileOp(taskId, { path: pathArg, operation: name, status: success ? "completed" : "failed", verified, at: Date.now() });
      }
      const task = tm.get(taskId);
      if (task) {
        const results = task.toolResults ?? [];
        results.push({ name, success, path: pathArg, detail: resultJson ? resultJson.slice(0, 200) : undefined });
        tm.checkpoint(taskId, { toolResults: results.slice(-100) });
      }
    } catch {
      // Never break tool execution over checkpointing.
    }
  }

  requestStop(): void {
    this.stopped = true;
    this.abortController?.abort();
    for (const [requestId, resolve] of pendingApprovals) {
      pendingApprovals.delete(requestId);
      resolve(false);
    }
  }

  async run(conversation: Conversation, workspace?: Workspace, attachments?: Attachment[], resumeNote?: string): Promise<Conversation> {
    this.resumeNote = resumeNote ?? "";
    const settings = this.store.getSettings();
    // Main pipeline: workspace tools are allowed and every real operation is
    // recorded into an operation-derived change summary.
    this.runMode = "main";
    this.changes = new TaskChangeRecorder("main");
    // Persistent task + task-level runtime guard (30-min shared policy).
    this.startRuntime(conversation, "main", workspace, settings.selectedModel);
    try {
      const result = await this.runInner(conversation, workspace, attachments);
      this.finishRuntime(this.stopped ? "cancelled" : "completed");
      return result;
    } catch (err) {
      // A failed run that already changed files must still end with a real
      // assistant message explaining what WAS completed (never a bare error card).
      this.taskError = err instanceof Error ? err.message : String(err ?? "Provider request failed.");
      await this.persistIncompleteResult(conversation, err);
      this.finishRuntime(this.taskStatusForError());
      throw err;
    } finally {
      this.runtimeGuard?.dispose();
      this.runtimeGuard = null;
      activeAgents.delete(this);
      releaseRequest(settings.selectedModel ?? "");
    }
  }

  /**
   * Finalize a Main run that ended in an error after doing real work.
   *
   * The task result is built from the recorded operations, so the user sees what
   * was completed, what remains, and why the run stopped — persisted as a normal
   * assistant message and emitted with the usual `done` event. A run that failed
   * before touching anything is left to the normal error path.
   */
  private async persistIncompleteResult(conversation: Conversation, err: unknown): Promise<void> {
    if (this.stopped || !this.changes) return;
    try {
      const taskSummary = this.changes.summary();
      if (taskSummary.counts.operations === 0) return;
      // The thrown value is not always an Error instance (provider errors are
      // plain objects), so pull a real message out of whatever shape arrives.
      const rawReason = err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : (err as { message?: unknown } | null | undefined)?.message;
      const reason = typeof rawReason === "string" && rawReason.trim() && rawReason !== "[object Object]"
        ? rawReason
        : "the provider request failed";
      const now = Date.now();
      const settings = this.store.getSettings();
      const usedProvider = providerOfModel(settings.selectedModel ?? "");
      this._taskResultForMessage = resolveTaskResultState({
        stopped: this.stopped,
        failed: true,
        filesChanged: taskSummary.counts.filesChanged,
        successfulOperations: taskSummary.counts.succeeded,
        failedOperations: taskSummary.counts.failed,
        generatedResults: generatedResultCounts(this._generatedResultsForMessage).total,
        hasAnswer: true
      });
      const content = composeTaskReport({
        summary: taskSummary,
        generatedResults: this._generatedResultsForMessage,
        taskResult: this._taskResultForMessage,
        statusLabel: "The task stopped before completion",
        incompleteReason: `${reason.replace(/\s+/g, " ").trim().slice(0, 300)} — the remaining steps were not executed.`
      });
      // The streamed answer is authoritative here too: a run that failed after
      // producing real prose must not have that prose replaced by the report.
      const reconciled = reconcileFinalAnswer(this.streamedAnswerText, content);
      const finalContent = reconciled.content || content;
      this.noteFinalAnswer("incomplete", reconciled, content);
      const message: ChatMessage = {
        id: this.currentMessageId ?? id("msg"),
        role: "assistant",
        content: finalContent,
        createdAt: now,
        startedAt: this.timings.taskStartedAt ?? now,
        completedAt: now,
        model: settings.selectedModel,
        provider: usedProvider,
        meta: { ...this.messageActivityMeta("agent"), incomplete: true }
      };
      const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
      this.store.saveConversation(next);
      if (finalContent.length >= this.taskStreamContent.length) this.taskStreamContent = finalContent;
      this.checkpointAssistantStream();
      this.emitActivityStep("Finalizing response...", "done", "Summarized the completed work after the run stopped");
      this.emitActivityComplete();
      this.emitDoneOnce(conversation.id, next);
      console.log(`[Agent] Persisted an incomplete-task summary (${taskSummary.counts.operations} operations, ${taskSummary.counts.filesChanged} files).`);
    } catch (finalizeErr) {
      console.error("[Agent] Failed to summarize the incomplete task:", finalizeErr);
    }
  }

  async chat(conversation: Conversation, workspace?: Workspace, attachments?: Attachment[], resumeNote?: string): Promise<Conversation> {
    this.resumeNote = resumeNote ?? "";
    const settings = this.store.getSettings();
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    // Chat pipeline: conversation only. No tools are exposed AND no workspace
    // mutation can be recorded, so model prose that claims "I changed X" can
    // never turn into a file-change event.
    this.runMode = "chat";
    this.changes = null;
    // Fresh activity lifecycle for this response (Chat path).
    this._activityStepsForMessage = [];
    this._fileOperationsForMessage = [];
    this._reviewChangesForMessage = [];
    this._generatedResultsForMessage = [];
    this._taskResultForMessage = null;
    // Same resource gate for the Chat path (local Ollama models only).
    if (isOllamaModel(settings.selectedModel)) {
      const gate = requestGate(settings.selectedModel);
      if (!gate.ok) throw new Error(gate.error ?? "Another Ollama generation is already running. Wait for it to finish or press Stop.");
    }

    // Persistent task + task-level runtime guard start here (chat path).
    this.startRuntime(conversation, "chat", workspace, settings.selectedModel);

    // ── Cross-chat context retrieval (Chat-only, never Main) ───────────
    // Retrieve relevant context from previous Chat conversations and long-term memories.
    // This happens BEFORE the model request so context can be injected into the system prompt.
    let contextBlock = "";
    if (this.chatHistory && conversation.messages.length > 0) {
      try {
        const lastUserMsg = conversation.messages.filter(m => m.role === "user").pop();
        if (lastUserMsg) {
          const memories: import("../shared/types.js").ChatMemory[] = (this.store as any).store?.get?.("chatMemories", []) ?? [];
          const context = this.chatHistory.retrieveContext(
            lastUserMsg.content,
            memories,
            conversation.id
          );
          if (context.conversations.length > 0 || context.memories.length > 0) {
            contextBlock = this.chatHistory.formatContextForPrompt(context);
            // Emit a subtle activity step so the user knows context was used
            this.emitActivityStep("Context", "active",
              context.conversationCount > 0
                ? `Using context from ${context.conversationCount} previous chat${context.conversationCount > 1 ? 's' : ''}`
                : "Checking previous conversations"
            );
            console.log(`[ChatHistory] Injected context: ${context.conversations.length} conversations, ${context.memories.length} memories`);
          }
        }
      } catch (err) {
        console.error("[ChatHistory] Context retrieval failed:", err);
        // Continue without context — the chat should still work
      }
    }

    // Build enhanced system prompt with cross-chat context
    // Chat mode gets the exact same response standard as Main mode, so a
    // conversation reply and a coding-agent reply read as one product.
    const chatBase = contextBlock ? `${LATEX_CHAT_PROMPT}\n\n${contextBlock}` : LATEX_CHAT_PROMPT;
    const enhancedPrompt = applyResponseContract(chatBase);

    // Chat path also runs a per-response activity lifecycle so every prompt
    // (not just the first) shows a live activity panel in the renderer.
    this.emitActivityStep("Understanding your request", "active");

    try {
      const result = await this.generateTurn(conversation, enhancedPrompt + this.resumeBlock(), undefined, attachments);

      // ── Post-response memory extraction (Chat-only) ──────────────────
      // After a successful response, analyze both the user message and assistant
      // response for useful memory-worthy information.
      if (this.chatHistory) {
        try {
          const lastUserMsg = conversation.messages.filter(m => m.role === "user").pop();
          const lastAssistantMsg = result.messages.filter(m => m.role === "assistant").pop();
          const memories: import("../shared/types.js").ChatMemory[] = (this.store as any).store?.get?.("chatMemories", []) ?? [];

          // Analyze user message
          if (lastUserMsg) {
            const { analyzeForMemory, findMemoryToUpdate, mergeMemory } = await import("./memoryService.js");
            const userMemory = analyzeForMemory(lastUserMsg.content, result.id, memories);
            if (userMemory) {
              const existing = findMemoryToUpdate(userMemory, memories);
              if (existing) {
                const merged = mergeMemory(existing, userMemory);
                const updated = memories.map(m => m.id === existing.id ? merged : m);
                (this.store as any).store?.set?.("chatMemories", updated);
              } else {
                const updated = [userMemory, ...memories].slice(0, 200);
                (this.store as any).store?.set?.("chatMemories", updated);
              }
            }
          }

          // Analyze assistant response (for recommendations, decisions, etc.)
          if (lastAssistantMsg && lastAssistantMsg.content.length > 30) {
            const { analyzeForMemory, findMemoryToUpdate, mergeMemory } = await import("./memoryService.js");
            const freshMemories: import("../shared/types.js").ChatMemory[] = (this.store as any).store?.get?.("chatMemories", []) ?? [];
            const assistantMemory = analyzeForMemory(lastAssistantMsg.content, result.id, freshMemories);
            if (assistantMemory) {
              const existing = findMemoryToUpdate(assistantMemory, freshMemories);
              if (existing) {
                const merged = mergeMemory(existing, assistantMemory);
                const updated = freshMemories.map(m => m.id === existing.id ? merged : m);
                (this.store as any).store?.set?.("chatMemories", updated);
              } else {
                const updated = [assistantMemory, ...freshMemories].slice(0, 200);
                (this.store as any).store?.set?.("chatMemories", updated);
              }
            }
          }
        } catch (err) {
          console.error("[ChatHistory] Memory extraction failed:", err);
          // Memory extraction failure should never break the chat
        }
      }

      this.finishRuntime(this.stopped ? "cancelled" : "completed");
      return result;
    } catch (err) {
      this.taskError = err instanceof Error ? err.message : String(err ?? "Provider request failed.");
      this.finishRuntime(this.taskStatusForError());
      throw err;
    } finally {
      this.runtimeGuard?.dispose();
      this.runtimeGuard = null;
      activeAgents.delete(this);
      releaseRequest(settings.selectedModel ?? "");
    }
  }
  private async runInner(conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]): Promise<Conversation> {
    const settings = this.store.getSettings();
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    const factory = new ProviderFactory((provider) => this.store.getApiKey(provider), () => getPuterAuthToken());
    const mode: FilesystemAccess = settings.filesystemAccess === "full" ? "full" : "workspace";
    this.fileTools.setMode(mode);
    // The review records belong to THIS turn — and to the message it produces.
    // The field and the local name the SAME array, and `collectChange` folds
    // into it in place, so the record the user watched build up live is exactly
    // the record persisted with the answer. The reset happens HERE, at the top
    // of the turn, not in `runInnerWithModel`: that method re-runs for every
    // automatic fallback model, and a retry must ADD to this turn's review, not
    // throw away the files the first attempt already changed.
    const pendingChanges: PendingChange[] = [];
    this._reviewChangesForMessage = pendingChanges;

    // ── Resource gate for local Ollama models ───────────────────────
    // Prevents duplicate inference requests (double-send, retry + health
    // check racing) which double model memory and make the whole PC lag.
    if (isOllamaModel(settings.selectedModel)) {
      const gate = requestGate(settings.selectedModel);
      if (!gate.ok) throw new Error(gate.error ?? "Another Ollama generation is already running. Wait for it to finish or press Stop.");
    }

    // ── The workspace must be a REAL folder we can name ────────────────
    // `.`, an empty string or a relative path is not a workspace: it is the
    // exact input that made a tool "inspect `.`" and try to "create folder `.`".
    // It is dropped here, before any filesystem call, so every tool gets an
    // honest "open a folder first" instead of acting on an unintended location.
    const workspacePathRaw = (workspace?.path ?? "").trim();
    const workspaceUsable = Boolean(workspace && workspacePathRaw && path.isAbsolute(workspacePathRaw));
    const activeWorkspace = workspaceUsable ? workspace : undefined;
    if (workspace && !workspaceUsable) {
      const detail = `No usable workspace folder ("${workspacePathRaw || "."}") — filesystem operations are disabled until a folder is opened.`;
      this.emitActivityStep("Workspace", "failed", detail, { kind: "verification" });
      this.emitActivityStatus(detail);
      console.warn(`[Agent] Ignoring unusable workspace path "${workspacePathRaw}" — no filesystem operation will run against it.`);
    }

    const ctx: ToolContext = {
      workspace: activeWorkspace,
      settings,
      fileTools: this.fileTools,
      mode: workspaceUsable ? mode : "workspace",
      collectChange: (change) => {
        // One entry per FILE for the whole turn: a model that writes the same
        // file five times produces one review row whose diff goes from the
        // original content to the final content. Chat mode never reaches here
        // (`this.changes` is null there), so a fabricated tool call can never
        // create a change record.
        const idx = change.kind === "renamed"
          ? -1
          : pendingChanges.findIndex((item) => item.filePath === change.filePath && item.kind !== "renamed");
        if (idx >= 0) pendingChanges[idx] = mergePendingChange(pendingChanges[idx], change);
        else pendingChanges.push(change);
        this.emit({ type: "changes", conversationId: conversation.id, payload: [...pendingChanges] });
      }
    };

    const MAX_AUTO_ATTEMPTS = 5;
    const attempted = new Set<string>();
    const currentKey = this.modelKey(settings.selectedModel);
    attempted.add(currentKey);
    let lastError: Error | undefined;
    let lastProviderError: ProviderError | undefined;
    let currentModel = settings.selectedModel;
    let attempts = 0;

    // ── Image generation routing (Main) ─────────────────────────────────
    // A request that asks for an image, served by a model that cannot return
    // image data, is routed to a real image-capable model on the SAME provider
    // when one exists. That model serves ONE direct turn with no tool
    // declarations, so the normal agent/tool loop is never handed an
    // image-only model in a workspace task.
    const lastUserTextMain = [...conversation.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const imageRouting = await this.resolveImageModel(settings.selectedModel, lastUserTextMain, factory);
    if (imageRouting.notice) {
      this.emitActivityStep("Image generation", "done", imageRouting.notice);
      this.emitActivityStatus(imageRouting.notice);
    }
    const imageTurn = imageRouting.model !== settings.selectedModel;
    if (imageTurn) currentModel = imageRouting.model;

    while (attempts < MAX_AUTO_ATTEMPTS && !this.stopped) {
      attempts++;
      try {
        return await this.runInnerWithModel(currentModel, conversation, activeWorkspace, attachments, ctx, factory, imageTurn);
      } catch (err) {
        releaseRequest(currentModel);
        const currentProvider = providerOfModel(currentModel);
        const provErr = toProviderError(currentProvider, currentModel, err);
        console.error(`[Agent] Provider error:`, { provider: provErr.provider, model: provErr.model, message: provErr.message, errorType: provErr.errorType, status: provErr.status, originalError: err instanceof Error ? err.message : typeof err });
        lastError = new Error(provErr.message);
        lastProviderError = provErr;
        recordModelFailure(currentProvider, currentModel, provErr);
        if (this.stopped) break;
        const isAuto = settings.autoSelectModel;
        if (!isAuto || !shouldFallback(provErr)) {
          throw provErr;
        }
        // Manual Ollama selection never falls back to another model —
        // the user picked this exact model, surface the error instead.
        const fallback = await this.findFallbackModel(attempted, factory);
        if (!fallback) {
          const names = Array.from(attempted).join(", ");
          throw new Error(`All available Automation models failed for this request. Attempted: ${names}. Last error: ${provErr.message}`);
        }
        const fallbackKey = this.modelKey(fallback.name);
        attempted.add(fallbackKey);
        currentModel = fallback.name;
        const label = fallback.displayName ?? fallback.name;
        const newProvider = providerOfModel(fallback.name);
        const errorLabel = `${provErr.provider} ${provErr.errorType} (HTTP ${provErr.status ?? "N/A"})`;
        this.emit({ type: "status", conversationId: conversation.id, payload: `Switching to ${label} (${errorLabel})` });
        this.store.setSettings({ selectedModel: fallback.name, provider: newProvider });
        // Record the fallback in the task checkpoint (restored on recovery).
        if (this.currentTaskId) {
          try {
            getTaskManager(this.store).checkpoint(this.currentTaskId, {
              model: fallback.name,
              provider: newProvider,
              currentStep: `Switched to ${label} after ${provErr.provider} ${provErr.errorType}`
            }, { immediate: true });
          } catch { /* non-fatal */ }
        }
      }
    }
    throw lastProviderError ?? lastError ?? new Error("The model run failed.");
  }

  private modelKey(modelName: string): string {
    const provider = providerOfModel(modelName);
    return `${provider}:${modelName}`;
  }

  private async findFallbackModel(attempted: Set<string>, factory: ProviderFactory): Promise<GeminiModel | undefined> {
    const models = await factory.listAllModels().catch(() => []);
    const eligible = models.filter((m) => {
      const key = this.modelKey(m.name);
      if (attempted.has(key)) return false;
      const provider = m.provider ?? providerOfModel(m.name);
      return isModelAvailable(provider, m.name);
    });
    const toolCapable = eligible.filter((m) => (m.supportsTools ?? false) || (providerOfModel(m.name) === "gemini" && !m.name.includes("/")));
    if (toolCapable.length > 0) return toolCapable[0];
    return eligible[0];
  }

  private async runInnerWithModel(
    modelName: string,
    conversation: Conversation,
    workspace: Workspace | undefined,
    attachments: Attachment[] | undefined,
    ctx: ToolContext,
    factory: ProviderFactory,
    /** Routed image turn: one direct call, no tool declarations. */
    imageTurn = false
  ): Promise<Conversation> {
    const startedAt = Date.now();
    const settings = ctx.settings;
    const usedProvider = providerOfModel(modelName);
    console.log(`[Agent] Using model: ${usedProvider}/${modelName}`);
    const provider = factory.getProvider(usedProvider);
    if (!provider) throw new Error(`No API key is configured for ${providerLabel(usedProvider)}.`);
    // ── Lightweight agent context for LOCAL Ollama models ──────────
    // The full 9k prompt + 33-tool catalog is measured to add tens of
    // seconds of prompt eval (and crashes low-VRAM runners). Locals get a
    // reduced tool set + compact protocol; the provider further compacts
    // the prose prompt. Cloud providers keep the full prompt.
    const isLocalOllama = isOllamaModel(modelName) && !modelName.includes("-cloud");
    const fullSystem = LATEX_SYSTEM_PROMPT + "\n\n" + LATEX_TOOL_PROTOCOL.replace("{{TOOL_CATALOG}}", toolCatalogText());
    // THE shared response standard is appended once, centrally, for every
    // provider and mode — cloud and local alike. Providers must never add
    // their own formatting rules; the answer's SHAPE stays consistent while the
    // model keeps full control of its content.
    let system = isLocalOllama
      ? applyResponseContract(LATEX_SYSTEM_PROMPT_LOCAL + "\n\n" + LATEX_TOOL_PROTOCOL_LOCAL.replace("{{TOOL_CATALOG}}", toolCatalogTextLocal()), { local: true })
      : applyResponseContract(fullSystem);
    // Resuming an interrupted task: give the model the CHECKPOINT (what really
    // completed, what is still pending) so it continues instead of restarting.
    system += this.resumeBlock();
    /** Factual workspace scope for the plan row (set below, used after the reset). */
    let workspaceNote = "";
    // ── Embed workspace context so every model knows what it can access ──
    // Without this, the model has no idea what folder is selected or what
    // files exist. This is critical for non-Ollama providers (OpenRouter,
    // Groq, Gemini, Puter) where the model may not generate tool calls
    // if it doesn't understand the workspace context.
    if (workspace?.path) {
      const wsName = workspace.name || path.basename(workspace.path);      let wsContext = `\n\n# Active Workspace\nPath: ${workspace.path}\nName: ${wsName}\n\nAll file operations (read_file, write_file, edit_file, create_file, delete_file, etc.) use paths RELATIVE to this workspace. Example: if the workspace is "C:\\Projects\\MyGame" and you want to edit "src/App.jsx", the relativePath is "src/App.jsx".`;
      // Add a brief file listing so the model knows what exists
      let fileCount = 0;
      try {
        const files = await this.fileTools.tree(workspace.path, 2);
        fileCount = files.length;
        if (files.length > 0) {
          const listing = files.map((f) => {
            const isDir = f.type === "directory";
            return `${isDir ? "[DIR]" : "[FILE]"} ${f.name}${f.children && f.children.length > 0 ? ` (${f.children.length} items)` : ""}`;
          }).join("\n");
          wsContext += `\n\nWorkspace files (top 2 levels):\n${listing}`;
        } else {
          wsContext += "\n\nWorkspace is empty.";
        }
      } catch {
        wsContext += "\n\n(Unable to list workspace files)";
      }
      system += wsContext;
      console.log(`[Agent] Workspace context added: ${workspace.path}`);
      workspaceNote = `${wsName} · ${fileCount} project file${fileCount === 1 ? "" : "s"} in scope`;
    }
    // Modality decided by the CURRENT message only. `request.attachments` is the
    // same set the provider may append, filtered consistently.
    const request = buildRequestMessages(conversation.messages, attachments);
    let transcript = request.messages;
    logRequestMode("main", modelName, request.messages);
    let finalText = "";
    // True once the model produced its OWN concluding prose after doing tool
    // work. That text — not the operation checklist — is the user-facing
    // answer, with the checklist kept underneath as a receipt.
    let modelConcluded = false;
    let turnThinking = "";
    // Real generated images received from the provider during this task. Its own
    // channel — never merged with assistant text or the activity timeline.
    const taskImages: Array<{ mimeType: string; data: string }> = [];
    let emittedImageStep = false;
    let toolsExecuted = 0;
    const toolResults: Array<{ name: string; success: boolean; path?: string; detail?: string }> = [];
    let lastToolNames: string[] = [];
    let consecutiveNoProgressTurns = 0;

    this._activityStepsForMessage = [];
    this._fileOperationsForMessage = [];
    this._generatedResultsForMessage = [];
    this._taskResultForMessage = null;
    this.planStepId = null;
    this.lastActivityStatus = "";
    // New task → new execution registry: a command from a previous task must
    // never suppress a real call in this one.
    this.toolExecutions.clear();
    this.toolStateStamp = 0;
    // ── Real-time plan (section: show the intent before any tool runs) ──
    // Derived from the user's actual request text, so it is honest the instant
    // it appears: it states what Latex is about to inspect/change, never that
    // something already succeeded.
    const requestText = [...conversation.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    this.emitPlanStep(planIntentForRequest(requestText), workspaceNote || undefined);
    this.setPhase("planning");
    let thinkingDone = false;
    // Track whether the agent has successfully completed the user's request
    // so that Stop after completion doesn't overwrite it.
    let agentCompleted = false;
    // ── Shared long-running request policy (30 minutes) ──────────────
    // The old 90s/180s per-call AbortSignal.timeout killed long streaming
    // generations at ~1m30s. The task-level guard measures from TASK START,
    // survives across turns/fallback calls, and never fires while chunks
    // keep arriving (idle watchdog resets on every chunk) — for EVERY
    // provider through this common layer.
    const guard = this.runtimeGuard ?? new AgentRuntimeGuard();
    this.runtimeGuard = guard;
    try {
    for (let turn = 0; turn < 12; turn++) {
      if (this.stopped) break;
      this.emit({ type: "status", conversationId: conversation.id, payload: `Thinking through step ${turn + 1}` });

      this.abortController = new AbortController();
      let functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let turnText = "";
      // Tool keys dispatched during THIS model turn. Streamed tool deltas that
      // arrive split (or twice) collapse into one execution.
      const seenToolCalls = new Set<string>();
      // Channel separation: this turn's visible answer is emitted through a
      // stateful filter, so a tool call split across chunks can never leak
      // raw protocol JSON into the chat. <thought> content goes to Thinking.
      const textFilter = new AssistantStreamFilter((thought) =>
        this.emitThinking(conversation.id, thought)
      );
      let liveStreamedText = "";

      // Combine the user's Stop signal with the task runtime guard. While
      // chunks arrive the guard stays reset — generation may run for the
      // full 30-minute task budget.
      const combinedSignal = AbortSignal.any([this.abortController.signal, guard.signal]);
      // The request is dispatched here. From this moment until the first real
      // provider event the UI must say "Waiting for model response…" — it must
      // never look like local reasoning is still being produced.
      this.setPhase("requesting_model", `Request sent to ${modelName}`);
      this.setPhase("waiting_for_provider", "Waiting for model response...");
      try {
        for await (const chunk of provider.generate({
          model: modelName,
          system,
          messages: transcript,
          tools: imageTurn ? undefined : toolDeclarationsFor(Boolean(workspace), settings.filesystemAccess === "full" ? "full" : "workspace", isLocalOllama),
          attachments: turn === 0 ? request.attachments : undefined,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxOutputTokens,
          // Provider-side thinking is ON by default for a model whose provider
          // API genuinely exposes reasoning, unless the user turned it off for
          // THIS model. Models without a reasoning channel never receive the
          // control parameter — unsupported reasoning is never requested.
          thinking: resolveThinkingEnabled(settings.thinkingPreferences, providerOfModel(modelName), modelName),
          // Intent of THIS turn. Routing to an image model is not enough: a
          // gateway that serves chat and images on separate endpoints must be
          // told which one this is, or it rejects the request outright.
          intent: imageTurn ? "image_generation" : "chat",
          signal: combinedSignal
        })) {
          guard.noteActivity(); // streaming data → keep the request alive
          // First real provider event: only NOW is the model actually connected.
          if (this.phase !== "streaming") this.setPhase("streaming", "Receiving response...");
          if (this.stopped) break;
          if (chunk.type === "reasoning") {
            // ── Thinking / reasoning content ──
            const thinkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
            if (thinkText) {
              turnThinking += thinkText;
              this.noteThinking(thinkText);
              this.emitThinking(conversation.id, thinkText);
            }
          } else if (chunk.type === "image") {
            // Real image data — its own channel (never text, never a tool call).
            taskImages.push({ mimeType: chunk.mimeType, data: chunk.data });
            if (!emittedImageStep) {
              emittedImageStep = true;
              this.emitActivityStep("Generating image", "active", modelName);
            }
            this.emitGeneratedResult(
              generatedResultFromImage(
                { mimeType: chunk.mimeType, data: chunk.data },
                { taskId: this.currentTaskId ?? undefined, messageId: this.currentMessageId ?? undefined },
                taskImages.length - 1
              ),
              conversation.id
            );
            this.emit({
              type: "image",
              conversationId: conversation.id,
              payload: { mimeType: chunk.mimeType, base64: chunk.data }
            });
          } else if (chunk.type === "text") {
            const chunkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
            turnText += chunkText;
            this.noteFirstDelta();
            // ── Real-time streaming: emit each chunk to the renderer ──
            // Strip tool-call artifacts so the user never sees raw protocol text.
            const cleanChunk = textFilter.push(chunkText);
            if (cleanChunk) {
              liveStreamedText += cleanChunk;
              this.streamedAnswerText += cleanChunk;
              this.taskStreamContent += cleanChunk;
              this.checkpointAssistantStream();
              this.emit({ type: "message", conversationId: conversation.id, payload: cleanChunk });
            }
          } else {
            functionCalls.push(chunk);
          }
        }
        // End of this model call: release whatever prose the filter was still
        // holding (it only ever withholds an in-progress protocol region).
        const streamTail = textFilter.flush();
        if (streamTail) {
          liveStreamedText += streamTail;
          this.streamedAnswerText += streamTail;
          this.taskStreamContent += streamTail;
          this.checkpointAssistantStream();
          this.emit({ type: "message", conversationId: conversation.id, payload: streamTail });
        }
      } catch (err) {
        if (this.stopped) break;
        // Task-level guard aborts (30-min max runtime / silent idle stream):
        // report a TIMEOUT — never silently "finish with results".
        if (guard.abortReason) {
          throw this.runtimeTimeoutError(providerOfModel(modelName), modelName, guard.abortReason);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const isHang = /timeout|abort/i.test(errMsg);
        // Provider-side hang after real tool work → finish with what we have
        if (isHang && toolsExecuted > 0) {
          console.log(`[Agent] Model call timed out after tool execution — finishing with results.`);
          break;
        }
        // Surface an ATTRIBUTED timeout (real provider + model + duration)
        // instead of a bare "operation was aborted" that gets mislabeled.
        if (isHang) {
          throw timeoutError(providerOfModel(modelName), modelName, AGENT_IDLE_TIMEOUT_MS, "idle");
        }
        throw err;
      }

      if (this.stopped) break;

      // === CASE 1: Native function calls from the provider ===
      // Check native function calls FIRST — they are more reliable than text-based tool calls.
      if (functionCalls.length > 0) {
        if (!thinkingDone) {
          thinkingDone = true;
          const toolNames = functionCalls.map(c => c.name.replace(/_/g, ' ')).join(', ');
          this.completePlanStep();
          this.emitPlanningStep(`Identified ${functionCalls.length} native operation${functionCalls.length > 1 ? 's' : ''}: ${toolNames}`);
        }
        for (const call of functionCalls) {
          if (this.stopped) break;
          const nativeArgs = (call.args ?? {}) as Record<string, unknown>;
          const result = await this.runToolCall(call.name, nativeArgs, conversation.id, ctx, seenToolCalls);
          toolsExecuted++;
          const resultStr = JSON.stringify(result, null, 2).slice(0, 12000);
          // Real exit codes count: a command that exited non-zero is a failure here too.
          const success = toolCallSucceeded(call.name, result);
          const nativePath = typeof nativeArgs.relativePath === 'string' ? nativeArgs.relativePath : typeof nativeArgs.from === 'string' ? nativeArgs.from : typeof nativeArgs.to === 'string' ? nativeArgs.to : undefined;
          // Record the command/query text so the final summary names what ran
          // instead of printing a placeholder.
          const nativeDetail = typeof nativeArgs.command === 'string' ? nativeArgs.command : typeof nativeArgs.query === 'string' ? nativeArgs.query : undefined;
          toolResults.push({ name: call.name, success, path: nativePath, detail: nativeDetail });
          if (this.stopped) break;

          transcript = [
            ...transcript,
            { role: "model", parts: [{ text: finalText || `Calling ${call.name}` }] },
            { role: "user", parts: [{ text: `Tool result for ${call.name}:\n${resultStr}` }] }
          ];
        }
        // Always let the model produce its conclusion. Previously a successful
        // set of file operations skipped the final model call, so the user got
        // an operation checklist instead of an explanation of what changed.
      }
      // === CASE 2: Text contains tool calls (text-based protocol) ===
      else if (containsToolCall(turnText)) {
        const textCalls = parseTextToolCalls(turnText);
        if (textCalls.length > 0) {
          console.log(`[Agent] ${providerOfModel(modelName)} used the structured tool protocol: ${textCalls.map((c) => c.name).join(", ")}`);

          // Only emit SHORT prose from this turn to avoid dumping long planning text
          const prose = stripToolCallBlocks(turnText).trim();
          if (prose) {
            const shortProse = prose.split(/\n\n/).filter(p => p.trim().length > 0 && p.trim().length < 120).join(' ');
            if (shortProse && shortProse.trim().length > 0) {
              if (!thinkingDone) {
                thinkingDone = true;
                const toolNames = textCalls.map(c => c.name.replace(/_/g, ' ')).join(', ');
                this.completePlanStep();
                this.emitPlanningStep(`Identified ${textCalls.length} operation${textCalls.length > 1 ? 's' : ''}: ${toolNames}`);
              }
              finalText += (finalText ? '\n' : '') + shortProse;
            }
            if (!thinkingDone) {
              thinkingDone = true;
              this.completePlanStep();
              this.emitPlanningStep(`Planned ${textCalls.length} operation${textCalls.length > 1 ? 's' : ''}`);
            }
          }

          const currentTurnToolNames = textCalls.map(c => c.name);

          for (const call of textCalls) {
            if (this.stopped) break;
            const callArgs = (call.args ?? {}) as Record<string, unknown>;
            const result = await this.runToolCall(call.name, callArgs, conversation.id, ctx, seenToolCalls);
            toolsExecuted++;
            const resultStr = JSON.stringify(result, null, 2).slice(0, 12000);
            const success = toolCallSucceeded(call.name, result);
            const filePath = typeof callArgs.relativePath === 'string' ? callArgs.relativePath : typeof callArgs.from === 'string' ? callArgs.from : typeof callArgs.to === 'string' ? callArgs.to : undefined;
            const cmdOrQuery = typeof callArgs.command === 'string' ? callArgs.command : typeof callArgs.query === 'string' ? callArgs.query : undefined;
            toolResults.push({ name: call.name, success, path: filePath, detail: cmdOrQuery });
            if (this.stopped) break;

            transcript = [
              ...transcript,
              { role: "model", parts: [{ text: turnText || `Calling ${call.name}` }] },
              { role: "user", parts: [{ text: `Tool result for ${call.name}:\n${resultStr}` }] }
            ];
          }

          // Stuck-loop detection
          if (currentTurnToolNames.length > 0 && lastToolNames.length > 0) {
            const sameTools = currentTurnToolNames.length === lastToolNames.length &&
              currentTurnToolNames.every((t, i) => t === lastToolNames[i]);
            if (sameTools) {
              consecutiveNoProgressTurns++;
            } else {
              consecutiveNoProgressTurns = 0;
            }
          }
          lastToolNames = currentTurnToolNames;

          if (consecutiveNoProgressTurns >= 2) {
            console.log(`[Agent] Model stuck repeating tools: ${currentTurnToolNames.join(", ")}. Breaking loop.`);
            this.emitActivityStep("Finishing", "done");
            break;
          }

          // The final answer must explain the work in prose, so the loop always
          // continues to a conclusion turn after tools ran successfully.
        } else {
          // Tool-like text but not parseable - strip tool artifacts and show as prose
          const cleanText = stripToolCallBlocks(turnText).trim();
          if (cleanText) {
            if (!thinkingDone) {
              thinkingDone = true;
              this.completePlanStep();
            }
            finalText += cleanText;
            this.taskStreamContent += cleanText;
            this.checkpointAssistantStream();
            // Only emit if the live filter did not already stream it.
            this.emitUnstreamedProse(cleanText, liveStreamedText, conversation.id);
          }
          consecutiveNoProgressTurns++;
          if (consecutiveNoProgressTurns >= 2) break;
        }
      }
      // === CASE 3: Plain text response (no tools) ===
      else {
        if (turnText) {
          // Strip any tool call artifacts and clean up
          const cleanText = stripToolCallBlocks(turnText).trim();
          if (cleanText) {
            if (!thinkingDone) {
              thinkingDone = true;
              this.completePlanStep();
            }
            // The final text is the model's own conclusion. It is NEVER
            // reduced to "the last paragraph": silently dropping the rest of a
            // complete answer is exactly the "answer changed at the end" bug.
            // When tools ran, the longer of the two forms is kept so no real
            // prose is lost; when none ran, the text is accumulated as before.
            if (toolsExecuted > 0) {
              modelConcluded = true;
              const candidate = cleanText.trim();
              if (candidate.length > finalText.length) finalText = candidate;
            } else {
              finalText += cleanText;
            }
            // Never replace a longer accumulated stream with a shorter form:
            // the checkpoint is what a reopened/restored conversation shows.
            const turnFinal = finalText || cleanText;
            if (turnFinal.length >= this.taskStreamContent.length) this.taskStreamContent = turnFinal;
            this.checkpointAssistantStream();
            // Re-emitting already-streamed text here is what made the answer
            // render twice while streaming — emit only genuine remainder.
            this.emitUnstreamedProse(finalText || cleanText, liveStreamedText, conversation.id);
          }
        }
        break;
      }
    }

    } finally {
      // CRITICAL: Ensure the plan row is always completed when the loop exits
      // (even on error), so the UI never shows a spinner on finished work.
      if (!thinkingDone) {
        thinkingDone = true;
        this.completePlanStep();
      }
    }

    // ── Deterministic action fallback for small models ──────────────────
    // Small local models (1.5B–3B) often output text claiming an action was
    // performed ("I deleted the file") without producing an actual tool call.
    // When this happens on the FIRST turn and the user's request clearly
    // maps to a simple filesystem operation, execute it deterministically
    // so the user gets a real result instead of a hallucinated one.
    if (toolsExecuted === 0 && conversation.messages.length > 0) {
      const userMsg = conversation.messages[conversation.messages.length - 1];
      const implied = detectImpliedAction(userMsg.content, finalText);
      if (implied && workspace) {
        console.log(`[Agent] Small model claimed action without tool call. Executing deterministically: ${implied.tool}(${implied.path})`);
        const result = await this.runToolCall(implied.tool, implied.args, conversation.id, ctx);
        const resultStr = JSON.stringify(result, null, 2).slice(0, 12000);
        const success = toolCallSucceeded(implied.tool, result);
        toolsExecuted++;
        toolResults.push({ name: implied.tool, success, path: implied.path });
        if (success) {
          agentCompleted = true;
          // Update finalText to reflect the actual operation
          finalText = `✅ **${implied.toolLabel}**\n\n- \`${implied.path}\`\n\n✅ Verified successfully.`;
        } else {
          finalText = `❌ **${implied.toolLabel} failed**\n\n${resultStr.slice(0, 500)}`;
        }        } else if (!implied) {
        // Model claimed a file operation but detectImpliedAction couldn't match it.
        // Re-prompt once with explicit tool-use instructions so the model can
        // produce a proper tool call instead of just prose.
        const looksLikeClaim = /(?:create|delete|edit|write|rename|remove|modify|update|make|put|add)\s+(?:a\s+)?(?:file|folder|directory|document)/i.test(finalText)
          || /(?:done|finished|completed|created|deleted|edited|updated|wrote|made)/i.test(finalText);
        const looksLikeUserAskedFileOp = /(?:create|delete|edit|write|rename|remove|modify|update|make|put|add|open)/i.test(userMsg.content)
          && /(?:file|folder|directory|document|test|txt|html|css|js|json|py|md)/i.test(userMsg.content);
        if (looksLikeClaim && looksLikeUserAskedFileOp) {
          console.log(`[Agent] Model claimed file operation but no tool call detected. Re-prompting with explicit instructions.`);
          this.emitActivityStep("Retrying with tool instructions", "active");
          // Build a re-prompt that forces tool use
          const retryTools = toolDeclarationsFor(Boolean(workspace), settings.filesystemAccess === "full" ? "full" : "workspace", isLocalOllama);
          const retrySystem = system + "\n\nIMPORTANT: You MUST use the provided tools to perform file operations. Do NOT just describe what you would do — actually call the tool. If you want to create a file, call the create_file tool. If you want to delete a file, call the delete_file tool. If you want to edit a file, call the edit_file tool."
            + (workspace ? `\nThe current workspace is: ${workspace}` : "");
          const retryMessages: ChatMessage[] = [
            ...conversation.messages,
            { id: `retry_${Date.now()}`, role: "user" as const, content: `Please use the actual tool to ${String(userMsg.content ?? '')}. Do not just describe it — call the tool.`, createdAt: Date.now() }
          ];
          try {
            const retryTranscript = buildRequestMessages(retryMessages).messages;
            let retryText = "";
            const retryAbort = new AbortController();
            this.abortController = retryAbort;
            for await (const chunk of provider.generate({
              model: modelName,
              system: retrySystem,
              messages: retryTranscript,
              tools: retryTools,
              temperature: 0.3,
              maxOutputTokens: settings.maxOutputTokens,
              thinking: resolveThinkingEnabled(settings.thinkingPreferences, providerOfModel(modelName), modelName),
              // Same intent as the turn it retries: a retry must never silently
              // move an image turn onto the chat endpoint.
              intent: imageTurn ? "image_generation" : "chat",
              signal: AbortSignal.any([retryAbort.signal, guard.signal])
            })) {
              if (this.stopped || retryAbort.signal.aborted) break;
              if (chunk.type === "text") {
                retryText += (typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? ""));
              }
            }
            // Check if the retry produced a valid tool call
            const retryCalls = parseTextToolCalls(retryText);
            if (retryCalls.length > 0) {
              const retryCall = retryCalls[0];
              console.log(`[Agent] Retry produced tool call: ${retryCall.name}`);
              const result = await this.runToolCall(retryCall.name, retryCall.args, conversation.id, ctx);
              const resultStr = JSON.stringify(result, null, 2).slice(0, 12000);
              const success = toolCallSucceeded(retryCall.name, result);
              toolsExecuted++;
              const retryPath = String((retryCall.args as Record<string, unknown>)?.relativePath ?? (retryCall.args as Record<string, unknown>)?.path ?? "");
              toolResults.push({ name: retryCall.name, success, path: retryPath });
              if (success) {
                agentCompleted = true;
                finalText = `✅ **Tool execution completed**\n\n- \`${(retryCall.args as Record<string, unknown>)?.relativePath ?? (retryCall.args as Record<string, unknown>)?.path ?? "file"}\`\n\n✅ Verified successfully.`;
              } else {
                finalText = `❌ **Tool execution failed**\n\n${resultStr.slice(0, 500)}`;
              }
            }
            // If retry didn't produce a tool call either, keep original text but add disclaimer
            // Do NOT claim the operation succeeded
          } catch (retryErr) {
            console.log(`[Agent] Retry failed:`, retryErr);
          }
        }
      }
    }

    const now = Date.now();
    recordModelSuccess(providerOfModel(modelName), modelName);
    // Only show "stopped by user" if the task was NOT already completed.
    // If all tools succeeded and we finished naturally, Stop arriving after
    // that should not overwrite the completed state.
    const stoppedText = (this.stopped && !agentCompleted && toolsExecuted === 0) ? "\n\n_(Generation stopped by user)_" : "";
    let safeFinalText = typeof finalText === "string" ? finalText : String(finalText ?? "");
    if (safeFinalText.includes("[object Object]") || safeFinalText.includes("[object Array]")) {
      safeFinalText = safeFinalText.replace(/\[object Object\]/g, "").replace(/\[object Array\]/g, "").trim();
    }
    // Final cleanup: strip any remaining tool call artifacts
    safeFinalText = stripToolCallBlocks(safeFinalText).trim();

    // ── Explicit FINALIZATION phase ────────────────────────────────────
    // Reached for EVERY completed run, whether the model wrote a conclusion or
    // stopped dead after its last tool call. The user always gets a final
    // assistant message; the model is never the thing that guarantees it.
    if (toolsExecuted > 0) {
      const successCount = toolResults.filter(r => r.success).length;
      // Real verification status for the Thinking box, then the timeline row.
      this.emitActivityStatus("Verifying the changes on disk…");
      this.emitActivityStep("Verifying results", "done", `${successCount}/${toolsExecuted} operations successful`, { kind: "verification" });
      this.emitActivityStatus(successCount === toolsExecuted
        ? `All ${toolsExecuted} operation${toolsExecuted === 1 ? "" : "s"} succeeded.`
        : `${toolsExecuted - successCount} of ${toolsExecuted} operations failed.`);
    }
    // The activity label states the REAL phase. It uses the same wording as the
    // interrupted-run path ("Finalizing response...") so the timeline never
    // describes one phase with two different names.
    this.setPhase("finalizing", "Finalizing response...");
    // Operation-derived summary: built from REAL tool executions only. Reads the
    // changed source back (bounded), verifies local HTML references on disk, and
    // derives files/features/controls from that text — nothing is invented.
    const taskSummary = await this.buildChangeSummary(ctx);
    this.emitActivityStep(summarizeForActivity(taskSummary), "done");
    this.emitActivityComplete();
    if (this.currentTaskId) {
      try {
        getTaskManager(this.store).checkpoint(this.currentTaskId, { changeSummary: taskSummary }, { immediate: true });
      } catch { /* summary persistence is best-effort */ }
    }
    // ── The REAL task result ──────────────────────────────────────────
    // Success is decided from the WHOLE verified result — file changes, real
    // commands, generated images/graphs/charts — never from the filesystem
    // alone. "No files changed" must never be read as "nothing happened".
    // Only a MUTATION or a real command makes a run "successful": a read or an
    // inspect that worked must never be able to turn "4 operations could not be
    // completed" into "Done".
    const successfulMutations = taskSummary.operations.filter((op) => op.mutating && op.status === "success").length;
    const successfulCommands = taskSummary.operations.filter((op) => op.type === "command" && op.status === "success").length;
    this._taskResultForMessage = resolveTaskResultState({
      stopped: this.stopped,
      failed: false,
      filesChanged: taskSummary.counts.filesChanged,
      successfulOperations: successfulMutations + successfulCommands,
      failedOperations: taskSummary.counts.failed,
      generatedResults: generatedResultCounts(this._generatedResultsForMessage).total,
      hasAnswer: Boolean(this.streamedAnswerText.trim() || (safeFinalText ?? "").trim())
    });
    let finalContent: string;
    if (toolsExecuted > 0) {
      // Lead with the model's own explanation when it produced one (that prose
      // makes the answer readable), then the operation-derived sections.
      const explanation = (safeFinalText ?? "").trim();
      const report = composeTaskReportParts({
        summary: taskSummary,
        explanation: modelConcluded && explanation.length > 40 ? explanation : undefined,
        stopped: this.stopped,
        generatedResults: this._generatedResultsForMessage,
        taskResult: this._taskResultForMessage
      });
      // ── The streamed answer is AUTHORITATIVE ─────────────────────────
      // If the model already streamed its own closing prose, only the report's
      // BODY (the operation-derived sections) is new; if it never wrote an
      // answer (the "finished after the last tool call" case) the whole report
      // is new. Either way the composed text may only APPEND to what the user
      // already read — it can never shrink, rewrite or replace it.
      const streamedNorm = normalizeAnswerText(this.streamedAnswerText);
      const explanationNorm = normalizeAnswerText(explanation).slice(0, 200);
      const proseAlreadyOnScreen = Boolean(streamedNorm && explanationNorm && streamedNorm.includes(explanationNorm));
      const candidate = proseAlreadyOnScreen ? report.body : report.full;
      const reconciled = reconcileFinalAnswer(this.streamedAnswerText, candidate);
      finalContent = reconciled.content || (proseAlreadyOnScreen ? "" : report.full);
      this.noteFinalAnswer("finalize", reconciled, candidate);
      this.streamFinalContent(reconciled.pendingStream, conversation.id);
    } else if (safeFinalText && safeFinalText.trim().length > 0) {
      // No tools used. The ENTIRE answer is kept: long answers were previously
      // cut at 25 lines, which is the same "answer changed at the end" symptom
      // for anyone whose streamed reply was longer than that.
      const body = safeFinalText.trim();
      // Main mode honesty guard: a model that claims it changed files without
      // executing a single tool must not be believed.
      const claims = detectWorkspaceClaims(body);
      const candidate = claims.fileChange || claims.commandRun
        ? `${body}\n\n_(No workspace operation was executed for this request — no files were changed.)_`
        : body;
      const reconciled = reconcileFinalAnswer(this.streamedAnswerText, candidate);
      finalContent = reconciled.content || candidate;
      this.noteFinalAnswer("finalize-text", reconciled, candidate);
      this.streamFinalContent(reconciled.pendingStream, conversation.id);
    } else {
      // No model prose at all: still answer from the verified task result —
      // including a generated graph/image, which is a result in its own right.
      const generatedSentence = generatedResultSentence(this._generatedResultsForMessage);
      const candidate = taskSummary.counts.operations > 0
        ? composeTaskReport({
            summary: taskSummary,
            generatedResults: this._generatedResultsForMessage,
            taskResult: this._taskResultForMessage
          })
        : generatedSentence
          ? generatedSentence
          : taskImages.length > 0
            ? "Here's the generated image."
            // Nothing at all came back: say so instead of claiming a task was
            // completed. "Task completed." over an empty response is the same
            // class of false success this finalization pass exists to remove.
            : "The model returned an empty response, so nothing was changed.";
      const reconciled = reconcileFinalAnswer(this.streamedAnswerText, candidate);
      finalContent = reconciled.content || candidate;
      this.noteFinalAnswer("finalize-empty", reconciled, candidate);
      this.streamFinalContent(reconciled.pendingStream, conversation.id);
    }
    const message: ChatMessage = {
      // STABLE IDENTITY: the message id is the one every event of this run was
      // tagged with, so the streamed answer, its activity, its file operations
      // and the persisted message all name the same message.
      id: this.currentMessageId ?? id("msg"),
      role: "assistant",
      content: finalContent + stoppedText,
      createdAt: now,
      startedAt,
      completedAt: now,
      model: modelName,
      provider: usedProvider,
      meta: {
        ...this.messageActivityMeta("agent", turnThinking),
        ...this.generatedImageMeta(taskImages)
      }
    };
    const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
    this.store.saveConversation(next);
    this.emitDoneOnce(conversation.id, next);
    return next;
  }

  /**
   * Compute the PREVIEW buffer for a file-writing tool from its real arguments.
   *
   * `create_file`/`write_file`/`copy_file` carry the full content directly. An
   * `edit_file` only carries the replaced fragments, so the post-edit content is
   * reconstructed by applying the edit to the CURRENT file (read-only; the real
   * write happens later through the normal tool path). Nothing here touches the
   * filesystem, and a failure simply yields no preview — never fake content.
   */
  private async buildFilePreview(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ content?: string; previous?: string }> {
    const rel = typeof args.relativePath === "string" ? args.relativePath : undefined;
    if (name === "edit_file" && rel) {
      try {
        const { change } = await ctx.fileTools.prepareEdit(
          ctx.workspace?.path,
          rel,
          typeof args.oldText === "string" ? args.oldText : "",
          typeof args.newText === "string" ? args.newText : ""
        );
        return { content: change.nextContent, previous: change.previousContent };
      } catch {
        // The edit cannot be reconstructed (text not found, unreadable file):
        // fall back to the raw replacement text so the preview is still real.
        return { content: typeof args.newText === "string" ? args.newText : undefined };
      }
    }
    const content = typeof args.content === "string" ? args.content : undefined;
    return { content };
  }

  /**
   * Emit one file-operation event (ACTIVITY channel; preview buffer only).
   *
   * The same event is ALSO folded into the turn's durable record, using the
   * same pure reducer the renderer uses — so the live panel and the recorded
   * history can never disagree about what happened to a file.
   */
  private emitFileOperation(payload: FileOperationEvent): void {
    const identity = {
      taskId: this.currentTaskId ?? undefined,
      chatId: this.currentConvId || undefined,
      messageId: this.currentMessageId ?? undefined
    };
    this._fileOperationsForMessage = applyFileOperationEvent(
      this._fileOperationsForMessage,
      { ...payload, ...identity },
      identity,
      MAX_PERSISTED_FILE_OPERATIONS
    );
    this.emit({
      type: "file_operation",
      conversationId: this.currentConvId || "active",
      taskId: this.currentTaskId ?? undefined,
      messageId: this.currentMessageId ?? undefined,
      payload: { ...payload, ...identity }
    });
  }

  /**
   * Remember one finished tool execution so an identical dispatch replays it.
   *
   * The stamp is read AFTER the call: a successful file mutation has already
   * bumped `toolStateStamp`, so the entry is recorded as "current" and the
   * same call will not run again — while an unrelated read recorded before a
   * later edit goes stale and really re-runs.
   *
   * Failures are handled separately: an identical FAILED command gets exactly
   * one retry (a transient error should not brick the task) and is replayed
   * after that, so a broken command cannot loop for the rest of the turn.
   */
  private rememberToolExecution(key: string, result: unknown, failed: boolean, name: string): void {
    if (failed) {
      const failures = (this.toolExecutions.get(key)?.failures ?? 0) + 1;
      this.toolExecutions.set(key, {
        result,
        failures,
        // -1 never equals the workspace stamp → one retry stays possible.
        stamp: failures >= 2 ? this.toolStateStamp : -1
      });
      return;
    }
    if (FILE_WRITE_TOOLS.has(name)) this.toolStateStamp += 1;
    this.toolExecutions.set(key, { result, stamp: this.toolStateStamp, failures: 0 });
  }

  private async runToolCall(
    name: string,
    args: Record<string, unknown>,
    conversationId: string,
    ctx: ToolContext,
    /** Tool keys already dispatched during the CURRENT model turn. */
    seenInTurn?: Set<string>
  ): Promise<unknown> {
    // ── Main/Chat tool boundary (enforced here, not in React) ──────────
    // Even if a model emits a perfect `{"tool":"write_file",...}` payload in
    // Chat, no workspace tool can execute: the Chat pipeline simply has no
    // path to the filesystem. This mirrors "Chat session → conversation
    // provider → NO workspace write tools".
    if (this.runMode !== "main") {
      return {
        error: "Workspace tools are not available in Chat mode. Chat is conversation-only — switch to Main to change files.",
        mode: "chat",
        executed: false
      };
    }
    // ── Idempotency: a duplicate dispatch must never re-run a tool ──────
    // The same call can legitimately reach this method more than once —
    // streamed tool deltas re-merged, a re-sent turn, or a small model
    // re-emitting `Get-Date` because it wants to "verify". Only ONE of those
    // is a real operation:
    //   • inside the same turn → always a duplicate → replay.
    //   • across turns         → a duplicate only while the workspace has not
    //     changed underneath (any successful file mutation bumps the stamp),
    //     so `edit → rebuild` still really runs the build again.
    // Replaying happens BEFORE the approval prompt, so a duplicate can never
    // ask the user to confirm the same operation twice either.
    const callKey = toolCallKey(name, args);
    const prior = this.toolExecutions.get(callKey);
    const duplicateInTurn = Boolean(seenInTurn?.has(callKey));
    const duplicateAcrossTurns = Boolean(prior && prior.stamp === this.toolStateStamp);
    if (prior && (duplicateInTurn || duplicateAcrossTurns)) {
      console.log(
        `[Agent] Duplicate tool call suppressed: ${name} (${duplicateInTurn ? "already run this turn" : "no state change since last run"})`
      );
      seenInTurn?.add(callKey);
      return prior.result;
    }
    seenInTurn?.add(callKey);
    const tool = getTool(name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    if (tool.requiresWorkspace && !ctx.workspace && ctx.mode !== "full") {
      return { error: "This operation requires an approved workspace. Open a folder first (or enable Full PC Access in Settings)." };
    }
    const label = this.toolLabel(name, args);
    const detail = typeof args.relativePath === "string" ? args.relativePath : typeof args.command === "string" ? args.command : undefined;
    // One stable step id per invocation: the completion call updates THIS row,
    // so consecutive commands/edits stay separate rows in the timeline.
    const stepId = `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.setPhase("tool_execution");
    this.emitActivityStep(label, "active", detail, { id: stepId, ...this.toolActivityData(name, args, undefined) });
    this.emitActivityStatus(this.toolStatusLine(name, args, "start"));
    // Crash-safe tool record: started → fs change → completed (Part AA).
    const toolCallId = `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const toolPath = typeof args.relativePath === "string" && args.relativePath
      ? args.relativePath
      : typeof args.to === "string" && args.to
        ? args.to
        : typeof args.from === "string" && args.from
          ? args.from
          : undefined;
    this.recordToolStart(toolCallId, name, args, toolPath);

    // ── Live file preview (PREVIEW BUFFER, never the committed content) ──
    // Emitted the MOMENT the file operation is identified — before approval and
    // before the real write — so the user watches the file being produced
    // instead of receiving it only after the whole task finished. For a provider
    // that streams no file content we still show the operation immediately and
    // the UI shows an honest "Waiting for file content…" state.
    let fileOp: { operation: FileOperationPreview["operation"]; filePath: string; preview?: string; previous?: string } | null = null;
    if (this.runMode === "main" && FILE_PREVIEW_TOOLS.has(name) && toolPath) {
      const built = await this.buildFilePreview(name, args, ctx);
      fileOp = { operation: fileOperationKind(name), filePath: toolPath, preview: built.content, previous: built.previous };
      this.emitFileOperation({
        phase: "start",
        operation: fileOp.operation,
        filePath: fileOp.filePath,
        preview: fileOp.preview,
        previousPreview: fileOp.previous,
        at: Date.now()
      });
    }
    // Only the real filesystem outcome moves the preview out of "writing":
    // `complete` (verified on disk) or `failed`/`stopped`. A committed preview
    // therefore never claims a write that did not happen.
    const finishFileOp = (phase: "commit" | "complete" | "failed", opts?: { verified?: boolean; error?: string }) => {
      if (!fileOp) return;
      this.emitFileOperation({
        phase,
        operation: fileOp.operation,
        filePath: fileOp.filePath,
        preview: fileOp.preview,
        previousPreview: fileOp.previous,
        verified: opts?.verified,
        error: opts?.error,
        at: Date.now()
      });
    };
    const policy = tool.approvalPolicy(args, ctx.settings);
    try {
      if (policy.needed) {
        const preview = await tool.preview(ctx, args);
        const request = buildApprovalRequest(tool, args, policy, preview);
        console.log(`[PERMISSION REQUEST] id=${request.requestId} op=${name} path=${typeof args.relativePath === 'string' ? args.relativePath : ''}`);
        this.emit({ type: "approval", conversationId, payload: request });
        console.log(`[PERMISSION IPC SEND] id=${request.requestId}`);
        const approved = await this.waitForApproval(request.requestId);
        console.log(`[PERMISSION RESOLVED] id=${request.requestId} approved=${approved}`);
        if (this.stopped) {
          finishFileOp("failed", { error: "Stopped by the user." });
          this.recordToolEnd(toolCallId, name, args, toolPath, "rejected", "Stopped by the user.");
          return { cancelled: true, operation: name, reason: "Stopped by the user." };
        }
        if (!approved) {
          finishFileOp("failed", { error: "The user rejected this operation." });
          this.emitToolEvent(name, "rejected", args, undefined, undefined, stepId);
          this.emitActivityStatus(this.toolStatusLine(name, args, "rejected"));
          this.recordToolEnd(toolCallId, name, args, toolPath, "rejected", "The user rejected this operation.");
          return { cancelled: true, operation: name, reason: "The user rejected this operation." };
        }
        console.log(`[PERMISSION TOOL START] id=${request.requestId} op=${name}`);
        const executed = await tool.execute(ctx, args);
        // A command that exited non-zero is a FAILED step, whatever shape its
        // result object has (a real terminal failure is never "Success").
        const failed = toolResultFailed(name, executed) || (FILE_WRITE_TOOLS.has(name) && !toolCallSucceeded(name, executed));
        finishFileOp(failed ? "failed" : "complete", failed ? { error: "The operation did not complete." } : { verified: true });
        this.emitToolEvent(name, failed ? "error" : "ok", args, undefined, executed, stepId);
        this.noteToolOutcome(name, args, executed);
        this.captureGeneratedResult(name, executed, failed, toolCallId, conversationId);
        this.recordToolEnd(toolCallId, name, args, toolPath, "completed", executed);
        this.rememberToolExecution(callKey, executed, failed, name);
        return executed;
      }
      const executed = await tool.execute(ctx, args);
      const failed = toolResultFailed(name, executed) || (FILE_WRITE_TOOLS.has(name) && !toolCallSucceeded(name, executed));
      finishFileOp(failed ? "failed" : "complete", failed ? { error: "The operation did not complete." } : { verified: true });
      this.emitToolEvent(name, failed ? "error" : "ok", args, undefined, executed, stepId);
      this.noteToolOutcome(name, args, executed);
      this.captureGeneratedResult(name, executed, failed, toolCallId, conversationId);
      this.recordToolEnd(toolCallId, name, args, toolPath, "completed", executed);
      this.rememberToolExecution(callKey, executed, failed, name);
      return executed;
    } catch (err) {
      let message = "Tool execution failed";
      if (err instanceof Error) message = err.message || "Tool execution failed";
      else if (typeof err === "string") message = err;
      else if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
        message = (err as { message: string }).message;
      }
      finishFileOp("failed", { error: message });
      this.emitToolEvent(name, "error", args, message, undefined, stepId);
      this.emitActivityStatus(this.toolStatusLine(name, args, "failed"));
      this.recordToolEnd(toolCallId, name, args, toolPath, "failed", message);
      const failure = { error: message };
      // Recorded as a failure, not a success: the model gets ONE genuine
      // retry of an identical command (transient errors must not brick the
      // task), and every attempt after that replays this result — the blind
      // retry loop this guard exists to stop. Any real file change bumps the
      // stamp, which makes a deliberate re-run possible again.
      this.rememberToolExecution(callKey, failure, true, name);
      return failure;
    }
  }

  /**
   * Build the operation-derived summary for this task.
   *
   * Reads back the source of the files the task really changed (bounded by
   * MAX_ANALYSIS_CHARS), checks the local references of any changed HTML page
   * on disk, and analyses the CHANGED text (not the whole file) so the features
   * and controls describe this change rather than code that already existed.
   *
   * Chat runs have no recorder and yield an empty summary — no file can ever be
   * reported as changed from a conversation.
   */
  private async buildChangeSummary(ctx: ToolContext): Promise<TaskChangeSummary> {
    if (!this.changes || this.runMode !== "main") return emptyTaskSummary("chat");
    const sources: CodeSource[] = [];
    let budget = MAX_ANALYSIS_CHARS;
    for (const changedPath of this.changes.changedPathList()) {
      if (budget <= 0) break;
      if (!ANALYZABLE_EXTENSIONS.test(changedPath)) continue;
      try {
        const text = await ctx.fileTools.readFile(ctx.workspace?.path, changedPath);
        if (typeof text !== "string" || text.length === 0) continue;
        budget -= text.length;
        const evidence = this.changes.evidenceFor(changedPath);
        sources.push({ path: changedPath, code: evidence ? evidence.chunks.join("\n") : text });
        // A page only really "loads" when its local references exist on disk.
        if (/\.html?$/i.test(changedPath)) {
          const refs = htmlLocalReferences(text);
          const missing: string[] = [];
          for (const ref of refs) {
            const exists = await ctx.fileTools.fileExists(ctx.workspace?.path, ref).catch(() => false);
            if (!exists) missing.push(ref);
          }
          if (refs.length > 0 && missing.length === 0) {
            this.changes.addVerification(`\`${changedPath}\` references resolve on disk (${refs.join(", ")}).`);
          } else if (missing.length > 0) {
            this.changes.addVerification(`\`${changedPath}\` still references ${missing.map((ref) => `\`${ref}\``).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in the workspace.`);
          }
        }
      } catch {
        // Unreadable file — skip analysis; the summary must never fail the task.
      }
    }
    return this.changes.summary(sources);
  }

  private toolLabel(name: string, args: Record<string, unknown>): string {
    const path = typeof args.relativePath === "string" && args.relativePath
      ? args.relativePath
      : typeof args.to === "string" && args.to
        ? args.to
        : typeof args.from === "string" && args.from
          ? args.from
          : undefined;
    const cmd = typeof args.command === "string" ? args.command : undefined;
    switch (name) {
      case "read_file": return path ? `Reading ${path}` : "Reading file";
      case "write_file": return path ? `Writing ${path}` : "Writing file";
      case "create_file": return path ? `Creating ${path}` : "Creating file";
      case "edit_file": return path ? `Editing ${path}` : "Editing file";
      case "delete_file": return path ? `Deleting ${path}` : "Deleting file";
      case "rename_file": return path ? `Renaming ${path}` : "Renaming file";
      case "move_file": return path ? `Moving ${path}` : "Moving file";
      case "list_directory": return "Listing directory";
      case "search_files": return `Searching for ${typeof args.query === 'string' ? args.query : 'files'}`;
      case "search_project": return `Searching project for ${typeof args.query === 'string' ? args.query : 'text'}`;
      case "create_directory": return path ? `Creating directory ${path}` : "Creating directory";
      case "get_workspace_info": return "Inspecting workspace";
      // Command steps are named after what they actually run, so consecutive
      // commands stay distinct rows ("Run tasklist ...", "Run npm build ...").
      // The command is shown to the user, so any credential inside it is
      // masked before it ever reaches the activity row.
      case "run_command": {
        const shown = redactActivityText(cmd) ?? cmd;
        return shown ? `Run ${shown.length > 48 ? `${shown.slice(0, 48)}…` : shown}` : "Running command";
      }
      case "file_exists": return path ? `Checking ${path}` : "Checking file";
      case "get_file_info": return path ? `Getting info for ${path}` : "Getting file info";
      case "copy_file": return `Copying ${typeof args.from === 'string' ? args.from : 'file'}`;
      case "delete_directory": return path ? `Deleting directory ${path}` : "Deleting directory";
      default: return name.replace(/_/g, " ");
    }
  }

  private toolDetail(name: string, args: Record<string, unknown>): string | undefined {
    const cmd = typeof args.command === 'string' ? args.command : undefined;
    const query = typeof args.query === 'string' ? args.query : undefined;
    const path = typeof args.relativePath === 'string' ? args.relativePath : undefined;
    const ext = path ? path.split('.').pop()?.toLowerCase() : undefined;
    // NOTE: Detail text must NEVER include the filename — it is already in the label.
    // Use file extension to generate context-aware descriptions.

    switch (name) {
      case "read_file": return path ? `Inspecting ${ext ? ext.toUpperCase() : 'file'} contents and structure` : `Inspecting file contents and structure`;
      case "write_file": return path ? `Writing ${ext ? ext.toUpperCase() : 'file'} content to disk` : `Writing file content to disk`;
      case "create_file": return path ? `Creating new ${ext ? ext.toUpperCase() : 'file'} in workspace` : `Creating new file in workspace`;
      case "edit_file": return path ? `Applying targeted changes to ${ext ? ext.toUpperCase() : 'file'}` : `Applying targeted text replacement`;
      case "delete_file": return `Permanently removing file from workspace`;
      case "rename_file": return `Renaming file to new name`;
      case "move_file": return `Moving file to a different location`;
      case "search_files": return query ? `Scanning workspace for files matching "${query}"` : `Scanning workspace for matching files`;
      case "search_project": return query ? `Searching file contents for "${query}"` : `Searching file contents for matching text`;
      case "list_directory": return `Listing all files and folders in directory`;
      case "get_workspace_info": return `Analyzing project structure, frameworks and dependencies`;
      case "run_command": return cmd ? `Executing shell command` : undefined;
      case "create_directory": return `Creating folder and any missing parent directories`;
      case "delete_directory": return `Removing directory and all its contents`;
      case "file_exists": return path ? `Checking whether file exists on disk` : `Checking file existence`;
      case "get_file_info": return path ? `Reading file metadata and properties` : `Getting file information`;
      case "copy_file": return `Copying file to a new location`;
      default: return undefined;
    }
  }

  /**
   * Derive the structured ACTIVITY payload for a finished tool call.
   *
   * This is the only place raw execution output is carried: stdout/stderr and
   * exit codes for commands, line counts for file reads, the target path for
   * file edits. It is rendered inside the expandable activity item and is
   * never appended to the assistant response.
   */
  private toolActivityData(name: string, args: Record<string, unknown>, result: unknown): Partial<AgentActivityStep> {
    const path = typeof args.relativePath === "string" && args.relativePath
      ? args.relativePath
      : typeof args.to === "string" && args.to
        ? args.to
        : undefined;
    const command = typeof args.command === "string" ? args.command : undefined;

    // run_command → TerminalResult { command, cwd, exitCode, stdout, stderr }
    if (name === "run_command") {
      const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
      const stdout = typeof r.stdout === "string" ? r.stdout.trim() : "";
      const stderr = typeof r.stderr === "string" ? r.stderr.trim() : "";
      const exitCode = typeof r.exitCode === "number" ? r.exitCode : null;
      const output = [stdout, stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n");
      // ACTIVITY channel is user-visible: mask credentials in the command and
      // in captured stdout/stderr (a command can echo a key back out).
      return {
        kind: "command",
        tool: name,
        command: redactActivityText(command ?? (typeof r.command === "string" ? r.command : undefined)),
        output: output ? redactActivityText(output.slice(-8000)) : undefined,
        exitCode
      };
    }

    // read_file returns the file text — report its size, never its contents.
    if (name === "read_file") {
      if (typeof result === "string") {
        return { kind: "file_read", tool: name, path, lines: result.length === 0 ? 0 : result.split("\n").length };
      }
      return { kind: "file_read", tool: name, path };
    }

    if (FILE_WRITE_TOOLS.has(name) || name === "delete_file" || name === "rename_file" || name === "move_file") {
      const content = typeof args.content === "string" ? args.content : undefined;
      return {
        kind: "file_edit",
        tool: name,
        path,
        lines: content ? content.split("\n").length : undefined
      };
    }

    return { kind: "tool", tool: name, path };
  }

  private emitToolEvent(
    name: string,
    status: "ok" | "error" | "rejected",
    args: Record<string, unknown>,
    error?: string,
    result?: unknown,
    stepId?: string
  ): void {
    const path = typeof args.relativePath === "string" && args.relativePath
      ? args.relativePath
      : typeof args.to === "string" && args.to
        ? args.to
        : typeof args.from === "string" && args.from
          ? args.from
          : typeof args.command === "string"
            ? args.command
            : undefined;
    // The tool event carries the execution detail too, so the activity list can
    // expand a command's output without waiting for the persisted timeline.
    // The activity KIND always comes from the tool, even when it failed: a
    // failed edit is still a file edit, not an anonymous tool step.
    // The result is always passed through: a command that ran and exited
    // non-zero is still a real execution, and its exit code and captured
    // output belong in the activity row (status "error" here means "the step
    // failed", not "there is no result"). A thrown tool error has no result at
    // all, so `base` stays a plain kind/tool/path row.
    const base = this.toolActivityData(name, args, result);
    const data: Partial<AgentActivityStep> = status === "ok" || !error
      ? base
      : { ...base, output: `Error: ${error}` };
    this.emit({ type: "tool", conversationId: this.currentConvId || "active", payload: { name, status, path, error, ...data } });
    const label = this.toolLabel(name, args);
    const detail = this.toolDetail(name, args);
    const stepStatus = status === "ok" ? "done" : "failed";
    // Only fall back to path for detail if the label doesn't already contain it
    const hasPathInLabel = path && label.includes(path);
    this.emitActivityStep(label, stepStatus, detail ?? (hasPathInLabel ? undefined : path), { ...data, id: stepId });
  }

  /**
   * Emit the task's high-level plan as its own durable row.
   *
   * Intent only: it is generated from the user's request BEFORE any tool runs,
   * it never claims an action happened, and it stays pinned at the top of the
   * activity list while the real steps appear underneath it.
   */
  private emitPlanStep(intent: string, contextNote?: string): void {
    const detail = contextNote ? `${intent} Workspace: ${contextNote}.` : intent;
    this.planStepId = `plan_${Date.now().toString(36)}`;
    this.emitActivityStep("Thinking", "active", detail, { id: this.planStepId, kind: "thinking" });
    // The plan is delivered as its OWN activity row above. It is deliberately
    // NOT also pushed onto the execution-STATUS channel: that channel names
    // real operations ("Reading …", "Request sent …") in the activity panel,
    // and model/plan text must never leak into it. Thinking stays its own box.
  }

  /** Finish the plan row in place (keeps its text, records how long planning took). */
  private completePlanStep(): void {
    if (!this.planStepId) return;
    this.emitActivityStep("Thinking", "done", undefined, { id: this.planStepId, kind: "thinking" });
  }

  /**
   * Emit one EXECUTION-STATUS line for the agent-activity panel.
   *
   * This names real operations in the user's language (a phase transition, a
   * tool starting or finishing, verification). It is deliberately NOT provider
   * reasoning: provider reasoning travels on the `thinking` channel and renders
   * in its own dedicated Thinking box. Nothing here can ever be hidden
   * chain-of-thought, and consecutive duplicates are dropped so the activity
   * header never flickers with the same sentence.
   */
  /**
   * Record provider-exposed reasoning for the task checkpoint.
   * Feeds `thinkingSummaries` so a cancelled/failed task keeps exactly the
   * thinking the provider sent. Bounded so an endless stream cannot grow the
   * persisted record without limit.
   */
  private noteThinking(text: string): void {
    if (!text) return;
    if (this.thinkingForTask.length >= 4000) return;
    this.thinkingForTask.push(text);
  }

  /**
   * Emit ONE provider reasoning delta on the THINKING channel.
   *
   * Every provider goes through this single method, so the renderer receives
   * reasoning with the SAME run identity as the answer it belongs to: the task,
   * the chat and the message. That identity is what lets the Thinking panel keep
   * following the right message across a Main/Chat switch, a conversation change
   * and a restore. It never touches the assistant text channel — reasoning can
   * never be appended to the visible answer, and it never blocks streaming.
   */
  private emitThinking(conversationId: string, text: string | undefined | null): void {
    const clean = typeof text === "string" ? text : text == null ? "" : String(text);
    // An empty delta carries no reasoning: emitting it would only churn state.
    if (!clean) return;
    this.emit({
      type: "thinking",
      conversationId,
      taskId: this.currentTaskId ?? undefined,
      messageId: this.currentMessageId ?? undefined,
      payload: clean
    });
  }

  private emitActivityStatus(text: string | undefined | null): void {
    if (!text || this.stopped) return;
    const line = text.trim();
    if (!line || line === this.lastActivityStatus) return;
    this.lastActivityStatus = line;
    this.emit({
      type: "activity_status",
      conversationId: this.currentConvId || "active",
      payload: { text: line, at: Date.now() }
    });
  }

  /**
   * One-line status for a tool invocation, in the user's language.
   *
   * Built from the tool name and its real arguments only — never from model
   * text — so the Activity timeline can never claim work that did not happen.
   */
  private toolStatusLine(
    name: string,
    args: Record<string, unknown>,
    stage: "start" | "ok" | "failed" | "rejected"
  ): string {
    const path = typeof args.relativePath === "string" && args.relativePath
      ? args.relativePath
      : typeof args.to === "string" && args.to
        ? args.to
        : typeof args.from === "string" && args.from
          ? args.from
          : undefined;
    const rawCommand = typeof args.command === "string" ? args.command : undefined;
    const command = redactActivityText(rawCommand);
    const query = typeof args.query === "string" ? args.query : undefined;
    const shorten = (value: string) => (value.length > 60 ? `${value.slice(0, 60)}…` : value);

    // Commands read best as their actual command line.
    if (name === "run_command") {
      const cmd = command ? `\`${shorten(command)}\`` : "the command";
      if (stage === "start") return `Running ${cmd}…`;
      if (stage === "ok") return `Finished running ${cmd}.`;
      if (stage === "failed") return `${cmd} reported a failure.`;
      return `${cmd} was not run — the operation was not approved.`;
    }

    const target = path ?? query ?? "";
    const label = target ? shorten(target) : "";
    const startVerb: Record<string, string> = {
      read_file: "Reading",
      write_file: "Writing",
      create_file: "Creating",
      edit_file: "Editing",
      copy_file: "Copying",
      rename_file: "Renaming",
      move_file: "Moving",
      delete_file: "Deleting",
      create_directory: "Creating the folder",
      delete_directory: "Deleting the folder",
      list_directory: "Listing the workspace contents",
      search_files: "Searching the workspace for files",
      search_project: "Searching the workspace for",
      get_workspace_info: "Inspecting the project structure",
      file_exists: "Checking whether a file exists",
      get_file_info: "Checking the file details for"
    };
    const okLine: Record<string, string> = {
      read_file: `${label} read.`,
      write_file: `${label} updated.`,
      create_file: `${label} created.`,
      edit_file: `${label} updated.`,
      copy_file: `${label} copied.`,
      rename_file: `${label} renamed.`,
      move_file: `${label} moved.`,
      delete_file: `${label} deleted.`,
      create_directory: `${label} created.`,
      delete_directory: `${label} deleted.`,
      list_directory: "Workspace contents listed.",
      search_files: "Search complete.",
      search_project: "Search complete.",
      get_workspace_info: "Workspace inspected.",
      file_exists: `${label} checked.`,
      get_file_info: `${label} checked.`
    };
    const failedLine: Record<string, string> = {
      read_file: `${label} could not be read.`,
      write_file: `${label} could not be updated.`,
      create_file: `${label} could not be created.`,
      edit_file: `${label} could not be updated.`,
      copy_file: `${label} could not be copied.`,
      rename_file: `${label} could not be renamed.`,
      move_file: `${label} could not be moved.`,
      delete_file: `${label} could not be deleted.`,
      create_directory: `${label} could not be created.`,
      delete_directory: `${label} could not be deleted.`
    };

    if (stage === "start") {
      const verb = startVerb[name] ?? "Working on";
      return label ? `${verb} ${label}…` : `${verb}…`;
    }
    if (stage === "ok") return okLine[name] ?? (label ? `${label} done.` : "Operation complete.");
    if (stage === "failed") return failedLine[name] ?? (label ? `${label} failed.` : "The operation failed.");
    return label ? `${label} was left unchanged — the operation was not approved.` : "The operation was not approved.";
  }

  /** Record the real outcome of a tool call on the Thinking status channel. */
  private noteToolOutcome(name: string, args: Record<string, unknown>, result: unknown): void {
    this.emitActivityStatus(this.toolStatusLine(name, args, toolResultFailed(name, result) ? "failed" : "ok"));
  }

  /** A real planning outcome: what the model actually decided to do. */
  private emitPlanningStep(detail: string): void {
    if (!detail) return;
    this.emitActivityStep("Planning", "done", detail, { kind: "planning", id: `planning_${Date.now().toString(36)}` });
  }

  /**
   * Record one ACTIVITY step.
   *
   * `extra` carries the structured execution detail (kind, tool, command,
   * stdout, exitCode, path, lines) plus an optional stable `id`. Passing the
   * same id on the completion call updates that exact row, so several commands
   * or edits never collapse into one another.
   */
  private emitActivityStep(
    label: string,
    status: "pending" | "active" | "done" | "failed",
    detail?: string,
    extra?: Partial<AgentActivityStep>
  ): void {
    const now = Date.now();
    const step: AgentActivityStep = {
      id: extra?.id ?? `step_${now}_${Math.random().toString(36).slice(2, 6)}`,
      label,
      status,
      detail,
      timestamp: now,
      startedAt: status === "active" ? now : undefined,
      kind: extra?.kind,
      tool: extra?.tool,
      command: extra?.command,
      output: extra?.output,
      exitCode: extra?.exitCode,
      path: extra?.path,
      lines: extra?.lines
    };
    const steps = this._activityStepsForMessage;
    const idx = extra?.id
      ? steps.findIndex((s) => s.id === extra.id)
      : status === "active"
        ? steps.findIndex((s) => s.label === label)
        : steps.findIndex((s) => s.label === label && s.status === "active");

    if (idx >= 0) {
      const existing = steps[idx];
      const duration = existing.startedAt ? now - existing.startedAt : undefined;
      steps[idx] = {
        ...existing,
        ...step,
        id: existing.id,
        startedAt: existing.startedAt,
        detail: detail ?? existing.detail,
        // Only overwrite structured detail when this call actually carried it.
        kind: extra?.kind ?? existing.kind,
        command: extra?.command ?? existing.command,
        output: extra?.output ?? existing.output,
        exitCode: extra?.exitCode ?? existing.exitCode,
        path: extra?.path ?? existing.path,
        lines: extra?.lines ?? existing.lines,
        duration,
        timestamp: now
      };
    } else {
      steps.push(step);
    }

    if (this.currentTaskId) {
      try {
        getTaskManager(this.store).checkpoint(this.currentTaskId, { activity: steps, currentStep: label });
      } catch { /* non-fatal */ }
    }
    this.emit({ type: "activity_step", conversationId: this.currentConvId || "active", payload: steps[idx >= 0 ? idx : steps.length - 1] });
  }

  private emitActivityComplete(summary?: string): void {
    this.emit({ type: "activity_complete", conversationId: this.currentConvId || "active", payload: { summary } });
  }

  private async waitForApproval(requestId: string): Promise<boolean> {
    const PERM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(requestId, resolve);
      // Safety timeout: resolve as denied if the user doesn't respond
      const timer = setTimeout(() => {
        if (pendingApprovals.has(requestId)) {
          pendingApprovals.delete(requestId);
          console.log(`[PERMISSION] Request ${requestId} timed out after ${PERM_TIMEOUT_MS / 1000}s`);
          resolve(false);
        }
      }, PERM_TIMEOUT_MS);
      // Clean up timer if the promise resolves before timeout
      const origResolve = pendingApprovals.get(requestId);
      if (origResolve) {
        pendingApprovals.set(requestId, (approved: boolean) => {
          clearTimeout(timer);
          resolve(approved);
        });
      }
    });
  }

  private async generateTurn(
    conversation: Conversation,
    system: string,
    tools: unknown[] | undefined,
    attachments?: Attachment[]
  ): Promise<Conversation> {
    // Local copy: an image request may ROUTE this turn to a genuinely
    // image-capable model on the same provider. Every existing
    // `settings.selectedModel` read below therefore follows the routed model.
    const settings = { ...this.store.getSettings() };
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    const factory = new ProviderFactory((provider) => this.store.getApiKey(provider), () => getPuterAuthToken());
    const lastUserText = [...conversation.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const routed = await this.resolveImageModel(settings.selectedModel, lastUserText, factory);
    settings.selectedModel = routed.model;
    if (routed.notice) {
      this.emitActivityStep("Image generation", "done", routed.notice);
      this.emitActivityStatus(routed.notice);
    }
    const provider = factory.getProvider(providerOfModel(settings.selectedModel));
    if (!provider) throw new Error("No API key is configured for the selected model's provider.");
    const request = buildRequestMessages(conversation.messages, attachments);
    const transcript = request.messages;
    logRequestMode("chat", settings.selectedModel, request.messages);
    let finalText = "";
    let turnThinking = "";
    let emittedResponseStep = false;
    let emittedImageStep = false;
    const turnImages: Array<{ mimeType: string; data: string }> = [];
    const startedAt = Date.now();
    this.abortController = new AbortController();
    // ── Shared long-running request policy (30 minutes) ──────────────
    // The old 90s/180s per-call cap terminated long streaming generations.
    // The task-level guard runs from TASK START and stays reset while
    // chunks arrive — same policy for every provider (OmniRoute,
    // OpenRouter, Puter, Gemini, Ollama, ...).
    const guard = this.runtimeGuard ?? new AgentRuntimeGuard();
    this.runtimeGuard = guard;
    const chatCallSignal = AbortSignal.any([this.abortController.signal, guard.signal]);
    // Channel separation for the simple-chat path too: raw tool JSON, file
    // contents and shell payloads stay out of the assistant message.
    const chatTextFilter = new AssistantStreamFilter((thought) =>
      this.emitThinking(conversation.id, thought)
    );
    try {
      this.emitActivityStep("Planning response", "active");
      this.setPhase("planning");
      this.setPhase("requesting_model", `Request sent to ${settings.selectedModel}`);
      this.setPhase("waiting_for_provider", "Waiting for model response...");
      for await (const chunk of provider.generate({
        model: settings.selectedModel,
        system,
        messages: transcript,
        tools,
        attachments: request.attachments,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        thinking: resolveThinkingEnabled(settings.thinkingPreferences, providerOfModel(settings.selectedModel), settings.selectedModel),
        intent: looksLikeImageRequest(lastUserText) ? "image_generation" : "chat",
        signal: chatCallSignal
      })) {
        guard.noteActivity(); // streaming data → keep the request alive
        if (this.phase !== "streaming") this.setPhase("streaming", "Receiving response...");
        if (this.stopped) break;
        if (chunk.type === "reasoning") {
          // Native thinking/reasoning stream — drive the muted activity UI.
          const thinkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
          if (thinkText) {
            turnThinking += thinkText;
            this.noteThinking(thinkText);
            this.emitThinking(conversation.id, thinkText);
          }
        } else if (chunk.type === "image") {
          // Real image data from the provider — its OWN channel, never mixed
          // into the assistant text or the activity timeline.
          turnImages.push({ mimeType: chunk.mimeType, data: chunk.data });
          this.emitGeneratedResult(
            generatedResultFromImage(
              { mimeType: chunk.mimeType, data: chunk.data },
              { taskId: this.currentTaskId ?? undefined, messageId: this.currentMessageId ?? undefined },
              turnImages.length - 1
            ),
            conversation.id
          );
          if (!emittedImageStep) {
            emittedImageStep = true;
            this.emitActivityStep("Generating image", "active", settings.selectedModel);
          }
          this.emit({
            type: "image",
            conversationId: conversation.id,
            payload: { mimeType: chunk.mimeType, base64: chunk.data }
          });
        } else if (chunk.type === "text") {
          const chunkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
          finalText += chunkText;
          this.noteFirstDelta();
          if (!emittedResponseStep) {
            emittedResponseStep = true;
            this.emitActivityStep("Generating response", "active");
          }
          // Stream clean prose only — the filter holds back anything that
          // could still become a protocol region across chunk boundaries.
          const cleanChunk = chatTextFilter.push(chunkText);
          if (cleanChunk) {
            this.taskStreamContent += cleanChunk;
            this.checkpointAssistantStream();
            this.emit({ type: "message", conversationId: conversation.id, payload: cleanChunk });
          }
        }
      }
      // Release any prose the filter was still holding for this call.
      const chatTail = chatTextFilter.flush();
      if (chatTail) {
        this.taskStreamContent += chatTail;
        this.checkpointAssistantStream();
        this.emit({ type: "message", conversationId: conversation.id, payload: chatTail });
      }
    } catch (err) {
      if (this.stopped) {
        // Preserve whatever text we have so far when user stops
        if (finalText) {
          // Partial answers are normalized too: an abrupt stop must not dump
          // half-finished tool JSON into the conversation.
          const cleanPartial = normalizeChatResponse(stripToolCallBlocks(finalText).trim()).text;
          if (cleanPartial) {
            const now = Date.now();
            const usedProvider = providerOfModel(settings.selectedModel);
            this.emitActivityStep("Stopped", "failed", "Generation stopped by user");
            this.emitActivityComplete();
            const message: ChatMessage = {
              id: id("msg"),
              role: "assistant",
              content: cleanPartial + "\n\n_(Generation stopped by user)_",
              createdAt: now,
              startedAt,
              completedAt: now,
              model: settings.selectedModel,
              provider: usedProvider,
              meta: {
                ...this.messageActivityMeta("chat", turnThinking),
                ...this.generatedImageMeta(turnImages)
              }
            };
            const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
            this.store.saveConversation(next);
            this.emit({ type: "done", conversationId: conversation.id, payload: next });
            return next;
          }
        }
        // No partial text — still finalize the activity so the UI never hangs.
        this.emitActivityStep("Stopped", "failed", "Generation stopped by user");
        this.emitActivityComplete();
      }
      // An unattended abort/timeout (NOT a user Stop) → attributed timeout
      // error so the card names the model that actually stalled. A guard
      // abort is a task-level timeout (30-min max / silent idle stream).
      if (!this.stopped && err instanceof Error && /timeout|abort/i.test(err.message)) {
        if (guard.abortReason) {
          throw this.runtimeTimeoutError(providerOfModel(settings.selectedModel), settings.selectedModel, guard.abortReason);
        }
        throw timeoutError(providerOfModel(settings.selectedModel), settings.selectedModel, AGENT_IDLE_TIMEOUT_MS, "idle");
      }
      throw err;
    }
    this.setPhase("finalizing");
    const now = Date.now();
    recordModelSuccess(providerOfModel(settings.selectedModel), settings.selectedModel);
    const stoppedText = this.stopped ? "\n\n_(Generation stopped by user)_" : "";
    let safeFinalText2 = typeof finalText === "string" ? finalText : String(finalText ?? "");
    safeFinalText2 = stripToolCallBlocks(safeFinalText2).trim();
    if (safeFinalText2.includes("[object Object]") || safeFinalText2.includes("[object Array]")) {
      safeFinalText2 = safeFinalText2.replace(/\[object Object\]/g, "").replace(/\[object Array\]/g, "").trim();
    }
    // ── Chat response normalization (provider-independent) ────────────
    // Local models leak `/thought>` markers, raw write_file/edit_file JSON and
    // fake shell transcripts into conversation. Those are internal protocol and
    // are removed here; legitimate code examples survive untouched. A claim
    // that files were changed is REPORTED, never converted into an operation —
    // Chat has no workspace tools at all.
    const normalized = normalizeChatResponse(safeFinalText2);
    safeFinalText2 = normalized.text;
    const claims = normalized.claims;
    const boundaryNotice = chatBoundaryNotice(claims);
    console.log(
      `[Chat] normalized reply: protocolStripped=${normalized.strippedProtocol} ` +
      `fileChangeClaim=${claims.fileChange} commandClaim=${claims.commandRun}`
    );
    const usedProvider = providerOfModel(settings.selectedModel);
    if (claims.fileChange || claims.commandRun) {
      // Distinguish "model explanation" from "actual Latex tool operation".
      this.emitActivityStep("Chat mode — no workspace access", "done",
        claims.fileChange ? "The reply describes file changes; nothing was changed on disk" : "The reply describes commands; none were run");
    }
    if (this.stopped) {
      this.emitActivityStep("Stopped", "failed", "Generation stopped by user");
    } else {
      this.emitActivityStep("Finished", "done");
    }
    this.emitActivityComplete();
    const message: ChatMessage = {
      id: id("msg"),
      role: "assistant",
      // An image-only answer (the image model returned no prose) must never be
      // reported as a failed response — the picture IS the response.
      content: (safeFinalText2 || (turnImages.length > 0 ? "Here's the generated image." : "I couldn't generate a response. Please try again."))
        + (boundaryNotice ? `\n\n${boundaryNotice}` : "")
        + stoppedText,
      createdAt: now,
      startedAt,
      completedAt: now,
      model: settings.selectedModel,
      provider: usedProvider,
      meta: {
        ...this.messageActivityMeta("chat", turnThinking),
        ...this.generatedImageMeta(turnImages),
        // Marks the message as MODEL TEXT. Only a real Main Agent tool
        // execution can produce a file-change record.
        chatOrigin: "model",
        ...(claims.fileChange || claims.commandRun ? { chatClaimedChange: true, chatClaimMatches: claims.matches } : {})
      }
    };
    const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
    this.store.saveConversation(next);
    this.emit({ type: "done", conversationId: conversation.id, payload: next });
    return next;
  }

  /**
   * Commit a REAL tool-produced visual to the turn's durable records.
   *
   * Called only after the tool actually succeeded: a failed, rejected or
   * cancelled call can never create a result, and an ordinary text/JSON result
   * creates nothing at all (so a read/list/search never becomes a "result").
   * The record is keyed by the tool call's stable id, so a duplicate dispatch, a
   * rerender or a restored task cannot stack the same graph twice.
   */
  private captureGeneratedResult(
    name: string,
    result: unknown,
    failed: boolean,
    toolCallId: string,
    conversationId: string
  ): void {
    if (failed) return;
    const generated = generatedResultFromToolResult(name, result, {
      taskId: this.currentTaskId ?? undefined,
      messageId: this.currentMessageId ?? undefined,
      toolCallId
    });
    if (!generated) return;
    this.emitGeneratedResult(generated, conversationId);
  }

  /**
   * Fold one generated result into the durable list AND emit it live, so the
   * result appears while the task runs and is still there when it finishes.
   * Deduplicated by `resultId` on both sides.
   */
  private emitGeneratedResult(generated: GeneratedResult, conversationId: string): void {
    const existing = this._generatedResultsForMessage.find((item) => item.resultId === generated.resultId);
    // An identical result arriving twice (a repeated stream event, an IPC
    // reconnect, a rerender) is already recorded — emit nothing.
    if (existing && existing.status === generated.status) return;
    this._generatedResultsForMessage = mergeGeneratedResults(this._generatedResultsForMessage, generated);
    this.emit({ type: "generated_result", conversationId, payload: generated });
  }

  /**
   * The durable generated-result metadata for this message, when there is any.
   * Kept separate from the activity metadata so an image-only turn can persist
   * its result without also adopting an activity timeline.
   */
  private generatedResultMeta(): Record<string, unknown> {
    return this._generatedResultsForMessage.length > 0
      ? { generatedResults: this._generatedResultsForMessage }
      : {};
  }

  /**
   * Build persisted per-message activity metadata: force-closes any active
   * steps (so restored conversations never show stuck spinners) and includes
   * thinking + stop state for the collapsed activity row.
   */
  private messageActivityMeta(kind: "chat" | "agent", thinking?: string): Record<string, unknown> {
    const closed = this._activityStepsForMessage.map((s) =>
      s.status === "active" ? { ...s, status: "done" as const, timestamp: Date.now() } : s
    );
    return {
      ...(closed.length > 0 ? { activitySteps: closed, activityComplete: true, activityKind: kind } : {}),
      // The durable file-operation record for this message. Stored next to the
      // activity steps so a reopened chat shows the same "Edited x.ts" history
      // the user watched happen — including how many REAL writes it took.
      ...(this._fileOperationsForMessage.length > 0 ? { fileOperations: this._fileOperationsForMessage } : {}),
      // The durable CHANGE REVIEW for this message: the same per-file records
      // (kind, path, net diff, how many real writes it took) the card rendered
      // live, minus the before/after buffers. Reopening the chat rebuilds the
      // card from here, so it can never depend on the active task or on React
      // state surviving a switch.
      ...(this._reviewChangesForMessage.length > 0
        ? { reviewChanges: compactReviewChanges(this._reviewChangesForMessage) }
        : {}),
      // The durable GENERATED RESULTS (images, graphs, charts, artifacts). They
      // are stored with the message, independently of the Change Review, so a
      // reopened chat rebuilds the graph from persisted data instead of
      // depending on the live task UI or on React state.
      ...(this._generatedResultsForMessage.length > 0
        ? { generatedResults: this._generatedResultsForMessage }
        : {}),
      // The REAL outcome state, derived from the whole verified result. Kept on
      // the message so a reopened chat can still tell "succeeded" from "nothing
      // happened" without re-deriving it from filesystem counters.
      ...(this._taskResultForMessage ? { taskResult: this._taskResultForMessage } : {}),
      ...(thinking ? { thinking } : {}),
      // The durable task this message belongs to — kept on the message so a
      // reopened chat can still trace the answer back to its recorded work.
      ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
      ...(this.stopped ? { stopped: true } : {})
    };
  }

  /**
   * Persist GENERATED images on the assistant message.
   *
   * They are stored under a distinct `generatedImages` key (not `attachments`)
   * so the vision-replay path never re-uploads a Latex-generated picture to the
   * model on the next turn — a text-only model must never receive image input it
   * cannot handle. They still render and survive reopening the chat.
   */
  private generatedImageMeta(images: Array<{ mimeType: string; data: string }>): Record<string, unknown> {
    if (images.length === 0) return {};
    // When the SAME images are already stored as durable generated results, the
    // legacy `generatedImages` copy would double the base64 written to disk for
    // every generated picture — the normalized result is the source of truth
    // and the renderer reads it first.
    if (this._generatedResultsForMessage.some((item) => item.kind === "image" && item.base64)) return {};
    return {
      generatedImages: images.map((img, index) => ({
        id: id("img"),
        name: `generated-${index + 1}.${imageExtension(img.mimeType)}`,
        kind: "image" as const,
        base64: img.data,
        mimeType: img.mimeType
      }))
    };
  }

  /**
   * Explicit image-generation turn: the user chose the "Generate image" mode,
   * so route to a genuinely image-capable model on the same provider and request
   * IMAGE output. Text-only models are never handed an image request.
   *
   * Gemini-native image models produce the picture as inline data; other providers'
   * image output is not wired yet, so they surface an honest notice and the chosen
   * model still answers in text (which may be a description or an apology).
   */
  async generateImage(
    conversation: Conversation,
    workspace?: Workspace,
    attachments?: Attachment[]
  ): Promise<Conversation> {
    const settings = { ...this.store.getSettings() };
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    // Chat-style runtime: image generation exposes no workspace tools, so a
    // model's prose can never be recorded as a file operation. The persistent
    // task + 30-minute guard live here so Stop still aborts the in-flight request.
    this.runMode = "chat";
    this.changes = null;
    this._activityStepsForMessage = [];
    this._fileOperationsForMessage = [];
    this._reviewChangesForMessage = [];
    this._generatedResultsForMessage = [];
    this.startRuntime(conversation, "chat", workspace, settings.selectedModel);
    try {
      const result = await this.performImageTurn(conversation, attachments);
      this.finishRuntime(this.stopped ? "cancelled" : "completed");
      return result;
    } catch (err) {
      this.taskError = err instanceof Error ? err.message : String(err ?? "Image generation failed.");
      this.finishRuntime(this.taskStatusForError());
      throw err;
    } finally {
      this.runtimeGuard?.dispose();
      this.runtimeGuard = null;
      activeAgents.delete(this);
      releaseRequest(this.store.getSettings().selectedModel ?? "");
    }
  }

  /** One direct provider turn requesting IMAGE output for an image-capable model. */
  private async performImageTurn(
    conversation: Conversation,
    attachments?: Attachment[]
  ): Promise<Conversation> {
    const settings = { ...this.store.getSettings() };
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    const factory = new ProviderFactory((provider) => this.store.getApiKey(provider), () => getPuterAuthToken());
    const forced = await this.resolveImageModelForced(settings.selectedModel, factory);
    settings.selectedModel = forced.model;
    if (forced.notice) {
      this.emitActivityStep("Image generation", "done", forced.notice);
      this.emitActivityStatus(forced.notice);
    }
    const provider = factory.getProvider(providerOfModel(settings.selectedModel));
    if (!provider) throw new Error("No API key is configured for the selected model's provider.");
    const request = buildRequestMessages(conversation.messages, attachments);
    const transcript = request.messages;
    logRequestMode("generateImage", settings.selectedModel, request.messages);
    const startedAt = Date.now();
    this.abortController = new AbortController();
    const guard = this.runtimeGuard ?? new AgentRuntimeGuard();
    this.runtimeGuard = guard;
    const signal = AbortSignal.any([this.abortController.signal, guard.signal]);
    const imageTextFilter = new AssistantStreamFilter((thought) =>
      this.emitThinking(conversation.id, thought)
    );
    this.setPhase("requesting_model", `Request sent to ${settings.selectedModel}`);
    this.setPhase("waiting_for_provider", "Waiting for model response...");
    let finalText = "";
    let turnThinking = "";
    let emittedResponseStep = false;
    let emittedImageStep = false;
    const turnImages: Array<{ mimeType: string; data: string }> = [];
    try {
      this.emitActivityStep("Generating image", "active", settings.selectedModel);
      for await (const chunk of provider.generate({
        model: settings.selectedModel,
        system: "You are a Latex image-generation model. Generate the image the user described and return it. If you also describe the image in words, keep that description short.",
        messages: transcript,
        tools: undefined,
        attachments: request.attachments,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        thinking: resolveThinkingEnabled(settings.thinkingPreferences, providerOfModel(settings.selectedModel), settings.selectedModel),
        // An explicit image-generation turn — never the chat endpoint.
        intent: "image_generation",
        signal
      })) {
        guard.noteActivity();
        if (this.phase !== "streaming") this.setPhase("streaming", "Receiving response...");
        if (this.stopped) break;
        if (chunk.type === "reasoning") {
          const thinkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
          if (thinkText) {
            turnThinking += thinkText;
            this.noteThinking(thinkText);
            this.emitThinking(conversation.id, thinkText);
          }
        } else if (chunk.type === "image") {
          turnImages.push({ mimeType: chunk.mimeType, data: chunk.data });
          if (!emittedImageStep) {
            emittedImageStep = true;
            this.emitActivityStep("Generating image", "active", settings.selectedModel);
          }
          this.emitGeneratedResult(
            generatedResultFromImage(
              { mimeType: chunk.mimeType, data: chunk.data },
              { taskId: this.currentTaskId ?? undefined, messageId: this.currentMessageId ?? undefined },
              turnImages.length - 1
            ),
            conversation.id
          );
          this.emit({
            type: "image",
            conversationId: conversation.id,
            payload: { mimeType: chunk.mimeType, base64: chunk.data }
          });
        } else if (chunk.type === "text") {
          const chunkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
          finalText += chunkText;
          this.noteFirstDelta();
          if (!emittedResponseStep) {
            emittedResponseStep = true;
            this.emitActivityStep("Generating response", "active");
          }
          const cleanChunk = imageTextFilter.push(chunkText);
          if (cleanChunk) {
            this.taskStreamContent += cleanChunk;
            this.checkpointAssistantStream();
            this.emit({ type: "message", conversationId: conversation.id, payload: cleanChunk });
          }
        }
      }
      const tail = imageTextFilter.flush();
      if (tail) {
        this.taskStreamContent += tail;
        this.checkpointAssistantStream();
        this.emit({ type: "message", conversationId: conversation.id, payload: tail });
      }
    } catch (err) {
      if (this.stopped) {
        if (finalText) {
          const cleanPartial = normalizeChatResponse(stripToolCallBlocks(finalText).trim()).text;
          if (cleanPartial) {
            const now = Date.now();
            this.emitActivityStep("Stopped", "failed", "Generation stopped by user");
            this.emitActivityComplete();
            const message: ChatMessage = {
              id: id("msg"),
              role: "assistant",
              content: cleanPartial + "\n\n_(Generation stopped by user)_",
              createdAt: now,
              startedAt,
              completedAt: now,
              model: settings.selectedModel,
              provider: providerOfModel(settings.selectedModel),
              meta: { ...this.generatedImageMeta(turnImages), ...this.generatedResultMeta() }
            };
            const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
            this.store.saveConversation(next);
            this.emit({ type: "done", conversationId: conversation.id, payload: next });
            return next;
          }
        }
        this.emitActivityStep("Stopped", "failed", "Generation stopped by user");
        this.emitActivityComplete();
      }
      if (!this.stopped && err instanceof Error && /timeout|abort/i.test(err.message)) {
        if (guard.abortReason) {
          throw this.runtimeTimeoutError(providerOfModel(settings.selectedModel), settings.selectedModel, guard.abortReason);
        }
        throw timeoutError(providerOfModel(settings.selectedModel), settings.selectedModel, AGENT_IDLE_TIMEOUT_MS, "idle");
      }
      throw err;
    }
    this.setPhase("finalizing");
    const now = Date.now();
    recordModelSuccess(providerOfModel(settings.selectedModel), settings.selectedModel);
    const stoppedText = this.stopped ? "\n\n_(Generation stopped by user)_" : "";
    let safeFinalText = typeof finalText === "string" ? finalText : String(finalText ?? "");
    safeFinalText = stripToolCallBlocks(safeFinalText).trim();
    if (safeFinalText.includes("[object Object]") || safeFinalText.includes("[object Array]")) {
      safeFinalText = safeFinalText.replace(/\[object Object\]/g, "").replace(/\[object Array\]/g, "").trim();
    }
    const normalized = normalizeChatResponse(safeFinalText);
    safeFinalText = normalized.text;
    const usedProvider = providerOfModel(settings.selectedModel);
    const message: ChatMessage = {
      id: id("msg"),
      role: "assistant",
      content: (safeFinalText || (turnImages.length > 0 ? "Here's the generated image." : "I couldn't generate a response. Please try again.")) + stoppedText,
      // The generated images also live as durable generated results, so the
      // explicit image-mode message carries the same normalized data as every
      // other generated result (and one copy of the base64).
      createdAt: now,
      startedAt,
      completedAt: now,
      model: settings.selectedModel,
      provider: usedProvider,
      meta: {
        ...this.generatedImageMeta(turnImages),
        ...this.generatedResultMeta(),
        ...(turnThinking ? { thinking: turnThinking } : {})
      }
    };
    const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
    this.store.saveConversation(next);
    this.emitActivityStep(emittedImageStep ? "Image generated" : "Finished", "done");
    this.emitActivityComplete();
    this.emit({ type: "done", conversationId: conversation.id, payload: next });
    return next;
  }

  /**
   * Force-resolve an image model for an EXPLICIT image-generation request.
   * Skips the `looksLikeImageRequest` heuristic — the user already asked for an
   * image — and routes to a genuinely image-capable model on the same provider
   * when the selected one cannot return image data.
   */
  private async resolveImageModelForced(
    selectedModel: string,
    factory: ProviderFactory
  ): Promise<{ model: string; notice?: string }> {
    const providerName = providerOfModel(selectedModel);
    if (imageGenerationCapability(providerName, selectedModel).supportsImageGeneration) {
      return { model: selectedModel };
    }
    const pattern = preferredImageModelPattern(providerName);
    if (pattern) {
      try {
        const impl = factory.getProvider(providerName);
        const list = impl ? await impl.listModels() : [];
        const hit = list.find((m) => pattern.test(m.name.replace(/^models\//, "")));
        if (hit) {
          return { model: hit.name, notice: `Generating the image with ${hit.name.replace(/^models\//, "")}.` };
        }
      } catch {
        // Listing must never break the request — fall through to the search.
      }
    }
    // The selected model cannot return image data and its own provider has
    // nothing either, so look across EVERY configured provider. With Claude or
    // GPT selected the real image model is almost always Gemini's, and refusing
    // there would leave a working image model unused.
    const elsewhere = await this.findImageModelAnywhere(factory);
    if (elsewhere) return elsewhere;
    // Nothing anywhere can really return an image. Say so plainly instead of
    // sending the request to a text model that would answer in prose or code.
    return {
      model: selectedModel,
      notice: "No image-generation model is configured. Add an image-capable model in Settings → AI."
    };
  }

  /**
   * Find a genuinely image-capable model on ANY provider the user has configured.
   *
   * A text model can never become an image generator, and the image model does
   * not have to live on the provider the user happens to have selected. Routing
   * may therefore cross providers — which is safe here because the request is
   * built AFTER routing and the provider is re-derived from whichever model wins.
   *
   * Only models whose provider API really returns image data qualify (the
   * capability check is the same one the adapters use); a failure from one
   * provider never ends the search. Returns undefined when nothing configured
   * can produce an image.
   */
  private async findImageModelAnywhere(
    factory: ProviderFactory
  ): Promise<{ model: string; notice: string } | undefined> {
    const providers: ModelProvider[] = ["gemini", "openrouter", "omniroute", "minimax", "groq", "puter", "ollama"];
    for (const provider of providers) {
      const pattern = preferredImageModelPattern(provider);
      if (!pattern) continue;
      try {
        const impl = factory.getProvider(provider);
        if (!impl) continue;
        const list = await impl.listModels();
        const hit = list.find(
          (m) => pattern.test(m.name.replace(/^models\//, "")) && imageGenerationCapability(provider, m.name).supportsImageGeneration
        );
        if (hit) {
          const label = hit.name.replace(/^models\//, "");
          return {
            model: hit.name,
            // Named explicitly: the user selected something else, and silently
            // producing the picture from a different model would be a lie.
            notice: `The selected model cannot generate images. Using ${label} for this image.`
          };
        }
      } catch {
        // Keep looking — one provider failing must not end the search.
      }
    }
    return undefined;
  }

  /**
   * Decide which model should serve an image request.
   * Capability comes from the adapter that would really read image data, never
   * from the model name alone. Returns the selected model unchanged when the
   * model can already produce images (or when no image model is available).
   */
  private async resolveImageModel(
    selectedModel: string,
    lastUserText: string,
    factory: ProviderFactory
  ): Promise<{ model: string; notice?: string }> {
    if (!looksLikeImageRequest(lastUserText)) return { model: selectedModel };
    const providerName = providerOfModel(selectedModel);
    if (imageGenerationCapability(providerName, selectedModel).supportsImageGeneration) {
      return { model: selectedModel };
    }
    const pattern = preferredImageModelPattern(providerName);
    if (pattern) {
      try {
        const impl = factory.getProvider(providerName);
        const list = impl ? await impl.listModels() : [];
        const hit = list.find((m) => pattern.test(m.name.replace(/^models\//, "")));
        if (hit) {
          return { model: hit.name, notice: `Generating the image with ${hit.name.replace(/^models\//, "")}.` };
        }
      } catch {
        // Listing must never break the request — fall through to the search.
      }
    }
    // Same rule as the forced path: the image model does not have to live on the
    // provider the user selected, so search all of them before giving up.
    const elsewhere = await this.findImageModelAnywhere(factory);
    if (elsewhere) return elsewhere;
    return {
      model: selectedModel,
      notice: "No image-generation model is configured. Add an image-capable model in Settings → AI."
    };
  }

  /**
   * System-prompt block for a RESUMED task (empty for a normal turn).
   * Carries only facts taken from the checkpoint — never a fabricated history.
   */
  private resumeBlock(): string {
    if (!this.resumeNote) return "";
    return `\n\n## RESUMING AN INTERRUPTED TASK\nThe user asked you to continue a task that was interrupted.\n${this.resumeNote}\n\nContinue from the last completed step. Do NOT restart from the beginning and do NOT repeat operations already listed as completed. Finish the remaining work, then verify it.`;
  }

  private emit(event: AgentEvent): void {
    // Events carry taskId + chatId + messageId so the renderer can route them
    // to the right conversation/message even while another chat is visible
    // (Part AB). Explicit event types are what decide the channel — no text
    // sniffing on the renderer side.
    const enriched: AgentEvent = {
      ...event,
      ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
      ...(this.currentMessageId ? { messageId: this.currentMessageId } : {})
    };
    this.window.webContents.send("agent:event", enriched);
  }
}

/**
 * Safe, one-line proof of the outgoing request's modality. Logs ONLY metadata
 * (never image data, keys or prompts) so a false image-input error is easy to
 * diagnose: `requestMode=text` means no image field was sent.
 */
function logRequestMode(scope: string, model: string, messages: readonly ProviderMessage[]): void {
  const imageCount = messages.reduce((n, m) => n + imagesOf(m.attachments).length, 0);
  console.log(
    `[RequestMode] scope=${scope} provider=${providerOfModel(model)} model=${model} hasImage=${imageCount > 0} imageCount=${imageCount} requestMode=${imageCount > 0 ? "multimodal" : "text"}`
  );
}

/**
 * Build the provider transcript for ONE request.
 *
 * The request's modality is decided by the CURRENT user message only
 * (`currentTurnHasImage`): a normal text-only turn must never carry an image
 * from an earlier message in the same chat, or a text-only model (e.g. a
 * non-vision Ollama model) would fail with "does not support image input" on
 * plain conversation. FILE content is always carried — it is text and can
 * never be mistaken for an image.
 *
 * `fresh` is the set of attachments for the message being sent right now
 * (turn 0). It is filtered the same way so the provider never receives an
 * image field the transcript deliberately omitted.
 */
function buildRequestMessages(
  messages: readonly ChatMessage[],
  fresh?: Attachment[]
): { includeImages: boolean; messages: ProviderMessage[]; attachments: Attachment[] | undefined } {
  const includeImages = currentTurnHasImage(messages, fresh);
  return {
    includeImages,
    messages: messages.map((message) => toProviderMessage(message, includeImages)),
    attachments: includeImages ? fresh : fresh?.filter((a) => a.kind !== "image")
  };
}
