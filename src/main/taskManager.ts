/**
 * AgentTaskManager — the persistent task registry owned by the Electron main
 * process.
 *
 * Long-running agent work (model streaming, tool execution, file edits) is
 * owned HERE, not by any React component. Every important event checkpoints
 * the task record so that navigating away, reloading the renderer, closing or
 * crashing Latex never loses:
 *   - the partial assistant response (streamed text)
 *   - the activity timeline
 *   - tool calls/results and durable file operations
 *   - provider/model/prompt needed to resume from the latest checkpoint
 *
 * Persistence extends the existing electron-store layer (AppStore) — no new
 * storage system. Writes are debounced for high-frequency stream chunks and
 * immediate for durable events (tool/file/status transitions).
 */

import type { AgentFileChangeRecord, AgentTaskRecord, AgentTaskStatus, AgentToolCallRecord, ModelProvider } from "../shared/types.js";
import type { AppStore } from "./store.js";

/** Statuses that mean "was still in flight when the process died". */
const ACTIVE_STATUSES: readonly AgentTaskStatus[] = ["running", "waiting_for_model", "waiting_for_tool"];

/** Debounce for high-frequency checkpoints (stream chunks, activity steps). */
const CHECKPOINT_DEBOUNCE_MS = 500;

export interface BeginTaskInit {
  chatId: string;
  mode: "main" | "chat";
  provider?: ModelProvider;
  model?: string;
  userPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
}

export class AgentTaskManager {
  /** Task registry keyed by taskId — never a single "currentTask". */
  private tasksById = new Map<string, AgentTaskRecord>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(private readonly store: AppStore) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const task of this.store.getAgentTasks()) {
      this.tasksById.set(task.taskId, task);
    }
  }

  /**
   * On launch: any task still marked running/waiting* was cut off mid-flight.
   * Its last checkpoint is intact — mark it interrupted so the UI can offer
   * Continue (Part H). Returns the recovered records.
   */
  recoverInterrupted(): AgentTaskRecord[] {
    this.ensureLoaded();
    const recovered: AgentTaskRecord[] = [];
    for (const task of this.tasksById.values()) {
      if (ACTIVE_STATUSES.includes(task.status)) {
        task.status = "interrupted";
        task.updatedAt = Date.now();
        this.store.saveAgentTask(task);
        recovered.push(task);
      }
    }
    if (recovered.length > 0) {
      console.log(`[TaskManager] Recovered ${recovered.length} interrupted task(s) on launch.`);
    }
    return recovered;
  }

  /** Create the persistent task record when the user prompt is accepted. */
  beginTask(init: BeginTaskInit): AgentTaskRecord {
    this.ensureLoaded();
    const now = Date.now();
    const task: AgentTaskRecord = {
      taskId: `task_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      chatId: init.chatId,
      sessionId: init.sessionId,
      mode: init.mode,
      status: "running",
      provider: init.provider,
      model: init.model,
      userPrompt: init.userPrompt,
      assistantContent: "",
      activity: [],
      toolCalls: [],
      toolResults: [],
      filesChanged: [],
      workspaceId: init.workspaceId,
      startedAt: now,
      updatedAt: now
    };
    this.tasksById.set(task.taskId, task);
    // Prompt accepted → immediate checkpoint.
    this.store.saveAgentTask(task);
    return task;
  }

  get(taskId: string): AgentTaskRecord | undefined {
    this.ensureLoaded();
    return this.tasksById.get(taskId);
  }

  list(): AgentTaskRecord[] {
    this.ensureLoaded();
    return [...this.tasksById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Tasks that can be offered as "Continue" after a restart. */
  listRecoverable(): AgentTaskRecord[] {
    return this.list().filter((t) => t.status === "interrupted");
  }

  tasksForChat(chatId: string): AgentTaskRecord[] {
    return this.list().filter((t) => t.chatId === chatId);
  }

  /**
   * Merge a patch into the task record.
   * Debounced by default (stream chunks / activity steps); pass
   * { immediate: true } for durable transitions (tool completed, file written,
   * status changes) so a crash right after can never lose them.
   */
  checkpoint(taskId: string, patch: Partial<AgentTaskRecord>, options?: { immediate?: boolean }): void {
    this.ensureLoaded();
    const task = this.tasksById.get(taskId);
    if (!task) return;
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.dirty.add(taskId);
    if (options?.immediate) {
      this.flushTask(taskId);
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushDirty();
      }, CHECKPOINT_DEBOUNCE_MS);
    }
  }

  /** Append one streamed chunk of the assistant response (Part F). */
  checkpointStream(taskId: string, fullContent: string): void {
    this.checkpoint(taskId, { assistantContent: fullContent, status: "running" });
  }

  /** Record a tool invocation (started → completed/failed/rejected). */
  checkpointToolCall(taskId: string, call: AgentToolCallRecord): void {
    const task = this.tasksById.get(taskId);
    if (!task) return;
    const calls = task.toolCalls ?? [];
    const idx = calls.findIndex((c) => c.id === call.id);
    if (idx >= 0) calls[idx] = call;
    else calls.push(call);
    this.checkpoint(taskId, { toolCalls: calls }, { immediate: true });
  }

  /** Record a durable filesystem operation (Part AA/L). */
  checkpointFileOp(taskId: string, change: AgentFileChangeRecord): void {
    const task = this.tasksById.get(taskId);
    if (!task) return;
    const changes = task.filesChanged ?? [];
    // One durable record per file+operation — the latest state wins
    // (started → completed/failed on the same record).
    const idx = changes.findIndex((c) => c.path === change.path && c.operation === change.operation);
    if (idx >= 0) changes[idx] = change;
    else changes.push(change);
    this.checkpoint(taskId, { filesChanged: changes }, { immediate: true });
  }

  /** Terminal transition: completed | failed | cancelled | timed_out. */
  finishTask(taskId: string, status: AgentTaskStatus, extra?: Partial<AgentTaskRecord>): void {
    this.checkpoint(taskId, { ...extra, status }, { immediate: true });
  }

  /** Synchronous write of one task (used by flush paths). */
  private flushTask(taskId: string): void {
    const task = this.tasksById.get(taskId);
    if (!task) return;
    this.store.saveAgentTask(task);
    this.dirty.delete(taskId);
  }

  private flushDirty(): void {
    for (const taskId of [...this.dirty]) this.flushTask(taskId);
  }

  /** Synchronous flush of every pending checkpoint (before-quit, Part G). */
  flushAll(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.ensureLoaded();
    // Persist active tasks too — their status stays "running" and will be
    // marked interrupted by recoverInterrupted() on next launch.
    for (const task of this.tasksById.values()) {
      if (task.status === "running" || this.dirty.has(task.taskId)) {
        this.store.saveAgentTask(task);
      }
    }
    this.dirty.clear();
  }

  dismiss(taskId: string): void {
    this.ensureLoaded();
    this.tasksById.delete(taskId);
    this.dirty.delete(taskId);
    this.store.deleteAgentTask(taskId);
  }

  /** Chat deleted or cleared — drop its checkpoints too. */
  dropChat(chatId: string): void {
    this.ensureLoaded();
    for (const [taskId, task] of [...this.tasksById]) {
      if (task.chatId === chatId) {
        this.tasksById.delete(taskId);
        this.dirty.delete(taskId);
      }
    }
    this.store.deleteAgentTasksForChat(chatId);
  }
}

// One shared registry per AppStore (main process singleton).
let instance: AgentTaskManager | null = null;
export function getTaskManager(store: AppStore): AgentTaskManager {
  if (!instance) instance = new AgentTaskManager(store);
  return instance;
}
