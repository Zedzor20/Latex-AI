import { BrowserWindow } from "electron";
import type { AgentActivityStep, AgentEvent, Attachment, ChatMessage, Conversation, FilesystemAccess, GeminiModel, ModelProvider, PendingChange, ProviderError, Workspace } from "../shared/types.js";
import { shouldFallback, classifyHttpStatus } from "../shared/types.js";
import { LATEX_SYSTEM_PROMPT, LATEX_CHAT_PROMPT, LATEX_TOOL_PROTOCOL } from "../shared/systemPrompt.js";
import { FileTools } from "./fileTools.js";
import type { AIProvider } from "./geminiProvider.js";
import { AppStore } from "./store.js";
import { isQuotaError, ProviderFactory, providerOfModel, recordModelFailure, recordModelSuccess, isModelAvailable, toProviderError } from "./providerService.js";
import { getPuterAuthToken } from "./main.js";
import { id } from "./security.js";
import { buildApprovalRequest, getTool, toolCatalogText, toolDeclarations, type ToolContext } from "./tools.js";
import { containsToolCall, parseTextToolCalls, stripToolCallBlocks } from "./toolProtocol.js";

const activeAgents = new Set<Agent>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

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

export class Agent {
  private fileTools = new FileTools();
  private stopped = false;
  private abortController: AbortController | null = null;
  private _activityStepsForMessage: AgentActivityStep[] = [];

  constructor(private readonly store: AppStore, private readonly window: BrowserWindow) {
    activeAgents.add(this);
  }

  requestStop(): void {
    this.stopped = true;
    this.abortController?.abort();
    for (const [requestId, resolve] of pendingApprovals) {
      pendingApprovals.delete(requestId);
      resolve(false);
    }
  }

  async run(conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]): Promise<Conversation> {
    try {
      return await this.runInner(conversation, workspace, attachments);
    } finally {
      activeAgents.delete(this);
    }
  }

  async chat(conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]): Promise<Conversation> {
    try {
      return await this.generateTurn(conversation, LATEX_CHAT_PROMPT, undefined, attachments);
    } finally {
      activeAgents.delete(this);
    }
  }

  private async runInner(conversation: Conversation, workspace?: Workspace, attachments?: Attachment[]): Promise<Conversation> {
    const settings = this.store.getSettings();
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    const factory = new ProviderFactory((provider) => this.store.getApiKey(provider), () => getPuterAuthToken());
    const mode: FilesystemAccess = settings.filesystemAccess === "full" ? "full" : "workspace";
    this.fileTools.setMode(mode);
    const pendingChanges: PendingChange[] = [];

    const ctx: ToolContext = {
      workspace,
      settings,
      fileTools: this.fileTools,
      mode,
      collectChange: (change) => {
        pendingChanges.push(change);
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

    while (attempts < MAX_AUTO_ATTEMPTS && !this.stopped) {
      attempts++;
      try {
        return await this.runInnerWithModel(currentModel, conversation, workspace, attachments, ctx, factory);
      } catch (err) {
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
    factory: ProviderFactory
  ): Promise<Conversation> {
    const startedAt = Date.now();
    const settings = ctx.settings;
    const provider = factory.getProvider(providerOfModel(modelName));
    if (!provider) throw new Error("No API key is configured for the selected model's provider.");
    const system = LATEX_SYSTEM_PROMPT + "\n\n" + LATEX_TOOL_PROTOCOL.replace("{{TOOL_CATALOG}}", toolCatalogText());
    let transcript = conversation.messages.map(toGeminiMessage);
    let finalText = "";
    let toolsExecuted = 0;
    const toolResults: Array<{ name: string; success: boolean; path?: string; detail?: string }> = [];
    let lastToolNames: string[] = [];
    let consecutiveNoProgressTurns = 0;

    this._activityStepsForMessage = [];
    this.emitActivityStep("Thinking", "active", "Understanding the request...");
    let thinkingDone = false;

    for (let turn = 0; turn < 12; turn++) {
      if (this.stopped) break;
      this.emit({ type: "status", conversationId: conversation.id, payload: `Thinking through step ${turn + 1}` });

      this.abortController = new AbortController();
      let functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let turnText = "";

      try {
        for await (const chunk of provider.generate({
          model: modelName,
          system,
          messages: transcript,
          tools: toolDeclarations(Boolean(workspace), settings.filesystemAccess === "full" ? "full" : "workspace"),
          attachments: turn === 0 ? attachments : undefined,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxOutputTokens,
          signal: this.abortController.signal
        })) {
          if (this.stopped) break;
          if (chunk.type === "text") {
            const chunkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
            turnText += chunkText;
          } else {
            functionCalls.push(chunk);
          }
        }
      } catch (err) {
        if (this.stopped) break;
        throw err;
      }

      if (this.stopped) break;

      // === CASE 1: Text contains tool calls ===
      if (containsToolCall(turnText)) {
        const textCalls = parseTextToolCalls(turnText);
        if (textCalls.length > 0) {
          console.log(`[Agent] ${providerOfModel(modelName)} used the structured tool protocol: ${textCalls.map((c) => c.name).join(", ")}`);

          // Only emit SHORT prose from this turn to avoid dumping long planning text
          const prose = stripToolCallBlocks(turnText).trim();
          if (prose) {
            // Only emit short prose snippets (skip long planning paragraphs)
            const shortProse = prose.split(/\n\n/).filter(p => p.trim().length > 0 && p.trim().length < 120).join(' ');
            if (shortProse && shortProse.trim().length > 0) {
              if (!thinkingDone) {
                thinkingDone = true;
                this.emitActivityStep("Thinking", "done");
              }
              finalText += (finalText ? '\n' : '') + shortProse;
            }
            if (!thinkingDone) {
              thinkingDone = true;
              this.emitActivityStep("Thinking", "done");
            }
          }

          const currentTurnToolNames = textCalls.map(c => c.name);

          for (const call of textCalls) {
            if (this.stopped) break;
            const callArgs = (call.args ?? {}) as Record<string, unknown>;
            const result = await this.runToolCall(call.name, callArgs, conversation.id, ctx);
            toolsExecuted++;
            const resultStr = JSON.stringify(result, null, 2).slice(0, 12000);
            const success = !resultStr.includes('"error"') && !resultStr.includes('"success": false');
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

          if (!this.stopped) continue;
        } else {
          // Tool-like text but not parseable - strip tool artifacts and show as prose
          const cleanText = stripToolCallBlocks(turnText).trim();
          if (cleanText) {
            if (!thinkingDone) {
              thinkingDone = true;
              this.emitActivityStep("Thinking", "done");
            }
            finalText += cleanText;
            this.emit({ type: "message", conversationId: conversation.id, payload: cleanText });
          }
          consecutiveNoProgressTurns++;
          if (consecutiveNoProgressTurns >= 2) break;
        }
      }
      // === CASE 2: Native function calls from the provider ===
      else if (functionCalls.length > 0) {
        for (const call of functionCalls) {
          if (this.stopped) break;
          const nativeArgs = (call.args ?? {}) as Record<string, unknown>;
          const result = await this.runToolCall(call.name, nativeArgs, conversation.id, ctx);
          toolsExecuted++;
          const resultStr = JSON.stringify(result, null, 2).slice(0, 12000);
          const success = !resultStr.includes('"error"') && !resultStr.includes('"success": false');
          const nativePath = typeof nativeArgs.relativePath === 'string' ? nativeArgs.relativePath : typeof nativeArgs.from === 'string' ? nativeArgs.from : typeof nativeArgs.to === 'string' ? nativeArgs.to : undefined;
          toolResults.push({ name: call.name, success, path: nativePath });
          if (this.stopped) break;

          transcript = [
            ...transcript,
            { role: "model", parts: [{ text: finalText || `Calling ${call.name}` }] },
            { role: "user", parts: [{ text: `Tool result for ${call.name}:\n${resultStr}` }] }
          ];
        }
        if (!this.stopped) continue;
      }
      // === CASE 3: Plain text response (no tools) ===
      else {
        if (turnText) {
          // Strip any tool call artifacts and clean up
          const cleanText = stripToolCallBlocks(turnText).trim();
          if (cleanText) {
            if (!thinkingDone) {
              thinkingDone = true;
              this.emitActivityStep("Thinking", "done");
            }
            // For the final text: if tools were executed, keep only the LAST meaningful paragraph
            // to avoid repeating status messages
            if (toolsExecuted > 0) {
              const paragraphs = cleanText.split(/\n\n+/).filter(p => p.trim().length > 0);
              // Keep only the last meaningful paragraph (likely the summary)
              const lastMeaningful = paragraphs.reverse().find(p => p.trim().length > 10 && !/^\s*(✅|File verified|Files? verified|Operations? completed)/.test(p));
              if (lastMeaningful && lastMeaningful.trim().length > finalText.length) {
                finalText = lastMeaningful.trim();
              } else if (!finalText) {
                finalText = cleanText;
              }
            } else {
              finalText += cleanText;
            }
            this.emit({ type: "message", conversationId: conversation.id, payload: finalText || cleanText });
          }
        }
        break;
      }
    }

    const now = Date.now();
    recordModelSuccess(providerOfModel(modelName), modelName);
    const stoppedText = this.stopped ? "\n\n_(Generation stopped by user)_" : "";
    let safeFinalText = typeof finalText === "string" ? finalText : String(finalText ?? "");
    if (safeFinalText.includes("[object Object]") || safeFinalText.includes("[object Array]")) {
      safeFinalText = safeFinalText.replace(/\[object Object\]/g, "").replace(/\[object Array\]/g, "").trim();
    }
    // Final cleanup: strip any remaining tool call artifacts
    safeFinalText = stripToolCallBlocks(safeFinalText).trim();
    const usedProvider = providerOfModel(modelName);
    const fileCreated = toolResults.filter(r => r.name === 'create_file' && r.success);
    const fileWritten = toolResults.filter(r => r.name === 'write_file' && r.success);
    const fileEdited = toolResults.filter(r => r.name === 'edit_file' && r.success);
    const fileDeleted = toolResults.filter(r => r.name === 'delete_file' && r.success);
    const fileRenamed = toolResults.filter(r => r.name === 'rename_file' && r.success);
    const dirsCreated = toolResults.filter(r => r.name === 'create_directory' && r.success);
    const cmdsRun = toolResults.filter(r => r.name === 'run_command' && r.success);
    const totalCreated = fileCreated.length + fileWritten.length;
    const parts: string[] = [];
    if (totalCreated > 0) parts.push(`${totalCreated} file${totalCreated === 1 ? '' : 's'} created`);
    if (fileEdited.length > 0) parts.push(`${fileEdited.length} file${fileEdited.length === 1 ? '' : 's'} edited`);
    if (fileDeleted.length > 0) parts.push(`${fileDeleted.length} file${fileDeleted.length === 1 ? '' : 's'} deleted`);
    if (dirsCreated.length > 0) parts.push(`${dirsCreated.length} folder${dirsCreated.length === 1 ? '' : 's'} created`);
    if (cmdsRun.length > 0) parts.push(`${cmdsRun.length} command${cmdsRun.length === 1 ? '' : 's'} run`);
    if (fileRenamed.length > 0) parts.push(`${fileRenamed.length} file${fileRenamed.length === 1 ? '' : 's'} renamed`);
    const summary = parts.length > 0 ? parts.join(', ') : toolsExecuted > 0 ? `${toolsExecuted} operation${toolsExecuted === 1 ? '' : 's'} completed` : "Completed";
    if (toolsExecuted > 0) {
      const successCount = toolResults.filter(r => r.success).length;
      this.emitActivityStep("Verifying files on disk", "done", `${successCount}/${toolsExecuted} successful`);
    }
    this.emitActivityStep(summary, "done");
    this.emitActivityComplete();
    // Build clean final message with REAL filenames from tool results
    let finalContent: string;
    if (toolsExecuted > 0) {
      const lines: string[] = [];
      lines.push(`✅ **${summary}**`);
      // List created files with real names
      const allCreated = [...fileCreated, ...fileWritten];
      if (allCreated.length > 0) {
        lines.push("");
        lines.push("**Created:**");
        for (const r of allCreated) {
          lines.push(`- \`${r.path ?? 'file'}\``);
        }
      }
      // List edited files with real names
      if (fileEdited.length > 0) {
        lines.push("");
        lines.push("**Modified:**");
        for (const r of fileEdited) {
          lines.push(`- \`${r.path ?? 'file'}\``);
        }
      }
      // List deleted files with real names
      if (fileDeleted.length > 0) {
        lines.push("");
        lines.push("**Removed:**");
        for (const r of fileDeleted) {
          lines.push(`- \`${r.path ?? 'file'}\``);
        }
      }
      // List renamed files with real names
      if (fileRenamed.length > 0) {
        lines.push("");
        lines.push("**Renamed:**");
        for (const r of fileRenamed) {
          lines.push(`- \`${r.path ?? 'file'}\``);
        }
      }
      // List created directories with real names
      if (dirsCreated.length > 0) {
        lines.push("");
        lines.push("**Folders created:**");
        for (const r of dirsCreated) {
          lines.push(`- \`${r.path ?? 'folder'}\``);
        }
      }
      // List commands run
      if (cmdsRun.length > 0) {
        lines.push("");
        lines.push("**Commands run:**");
        for (const r of cmdsRun) {
          lines.push(`- \`${r.detail ?? 'command'}\`\n  ${r.success ? '✓ Success' : '✗ Failed'}`);
        }
      }
      lines.push("");
      lines.push("✅ Verified successfully.");
      finalContent = lines.join("\n");
    } else if (safeFinalText && safeFinalText.trim().length > 0) {
      // No tools used — use the model's text but limit length for clean display
      const textLines = safeFinalText.trim().split("\n");
      if (textLines.length > 30) {
        finalContent = textLines.slice(0, 25).join("\n") + "\n\n_(Response truncated for brevity)_";
      } else {
        finalContent = safeFinalText.trim();
      }
    } else {
      finalContent = toolsExecuted > 0 ? `✅ **${summary}**\n\nAll operations completed successfully.` : "Task completed.";
    }
    // Collect the activity steps we've emitted during this run for persistence
    const activityStepsSnapshot = [...this._activityStepsForMessage];
    const message: ChatMessage = {
      id: id("msg"),
      role: "assistant",
      content: finalContent + stoppedText,
      createdAt: now,
      startedAt,
      completedAt: now,
      model: modelName,
      provider: usedProvider,
      meta: activityStepsSnapshot.length > 0 ? { activitySteps: activityStepsSnapshot, activityComplete: true } : undefined
    };
    const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
    this.store.saveConversation(next);
    this.emit({ type: "done", conversationId: conversation.id, payload: next });
    return next;
  }

  private async runToolCall(name: string, args: Record<string, unknown>, conversationId: string, ctx: ToolContext): Promise<unknown> {
    const tool = getTool(name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    if (tool.requiresWorkspace && !ctx.workspace && ctx.mode !== "full") {
      return { error: "This operation requires an approved workspace. Open a folder first (or enable Full PC Access in Settings)." };
    }
    const label = this.toolLabel(name, args);
    const detail = typeof args.relativePath === "string" ? args.relativePath : typeof args.command === "string" ? args.command : undefined;
    this.emitActivityStep(label, "active", detail);
    const policy = tool.approvalPolicy(args, ctx.settings);
    try {
      if (policy.needed) {
        const preview = await tool.preview(ctx, args);
        const request = buildApprovalRequest(tool, args, policy, preview);
        this.emit({ type: "approval", conversationId, payload: request });
        const approved = await this.waitForApproval(request.requestId);
        if (this.stopped) return { cancelled: true, operation: name, reason: "Stopped by the user." };
        if (!approved) {
          this.emitToolEvent(name, "rejected", args);
          return { cancelled: true, operation: name, reason: "The user rejected this operation." };
        }
        const executed = await tool.execute(ctx, args);
        this.emitToolEvent(name, "ok", args);
        return executed;
      }
      const executed = await tool.execute(ctx, args);
      this.emitToolEvent(name, "ok", args);
      return executed;
    } catch (err) {
      let message = "Tool execution failed";
      if (err instanceof Error) message = err.message || "Tool execution failed";
      else if (typeof err === "string") message = err;
      else if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
        message = (err as { message: string }).message;
      }
      this.emitToolEvent(name, "error", args, message);
      return { error: message };
    }
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
      case "search_files": return "Searching files";
      case "create_directory": return path ? `Creating directory ${path}` : "Creating directory";
      case "get_workspace_info": return "Inspecting workspace";
      case "run_command": return cmd ? `Running: ${cmd}` : "Running command";
      default: return name.replace(/_/g, " ");
    }
  }

  private emitToolEvent(name: string, status: "ok" | "error" | "rejected", args: Record<string, unknown>, error?: string): void {
    const path = typeof args.relativePath === "string" && args.relativePath
      ? args.relativePath
      : typeof args.to === "string" && args.to
        ? args.to
        : typeof args.from === "string" && args.from
          ? args.from
          : typeof args.command === "string"
            ? args.command
            : undefined;
    this.emit({ type: "tool", conversationId: "active", payload: { name, status, path, error } });
    const label = this.toolLabel(name, args);
    const stepStatus = status === "ok" ? "done" : status === "rejected" ? "failed" : "active";
    this.emitActivityStep(label, stepStatus, path);
  }

  private emitActivityStep(label: string, status: "pending" | "active" | "done" | "failed", detail?: string): void {
    const step: AgentActivityStep = {
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      label,
      status,
      detail,
      timestamp: Date.now()
    };
    // Track steps for persistence in the final message
    // Replace any existing step with same label (active → done), or add new
    if (status === "done" || status === "failed") {
      const existingIdx = this._activityStepsForMessage.findIndex(s => s.label === label);
      if (existingIdx >= 0) {
        this._activityStepsForMessage[existingIdx] = { ...this._activityStepsForMessage[existingIdx], status, detail: detail ?? this._activityStepsForMessage[existingIdx].detail, timestamp: step.timestamp };
      } else {
        this._activityStepsForMessage.push(step);
      }
    } else if (status === "active") {
      // Only add if not already tracking a step with this label
      if (!this._activityStepsForMessage.some(s => s.label === label)) {
        this._activityStepsForMessage.push(step);
      }
    }
    this.emit({ type: "activity_step", conversationId: "active", payload: step });
  }

  private emitActivityComplete(summary?: string): void {
    this.emit({ type: "activity_complete", conversationId: "active", payload: { summary } });
  }

  private async waitForApproval(requestId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(requestId, resolve);
    });
  }

  private async generateTurn(
    conversation: Conversation,
    system: string,
    tools: unknown[] | undefined,
    attachments?: Attachment[]
  ): Promise<Conversation> {
    const settings = this.store.getSettings();
    if (!settings.selectedModel) throw new Error("Choose a model in Settings.");
    const factory = new ProviderFactory((provider) => this.store.getApiKey(provider), () => getPuterAuthToken());
    const provider = factory.getProvider(providerOfModel(settings.selectedModel));
    if (!provider) throw new Error("No API key is configured for the selected model's provider.");
    const transcript = conversation.messages.map(toGeminiMessage);
    let finalText = "";
    const startedAt = Date.now();
    this.abortController = new AbortController();
    try {
      for await (const chunk of provider.generate({
        model: settings.selectedModel,
        system,
        messages: transcript,
        tools,
        attachments,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        signal: this.abortController.signal
      })) {
        if (this.stopped) break;
        if (chunk.type === "text") {
          const chunkText = typeof chunk.text === "string" ? chunk.text : String(chunk.text ?? "");
          finalText += chunkText;
          // Stream clean prose only (strip any tool fragments)
          const cleanChunk = stripToolCallBlocks(chunkText);
          if (cleanChunk) {
            this.emit({ type: "message", conversationId: conversation.id, payload: cleanChunk });
          }
        }
      }
    } catch (err) {
      if (this.stopped) {
        // Preserve whatever text we have so far when user stops
        if (finalText) {
          const cleanPartial = stripToolCallBlocks(finalText).trim();
          if (cleanPartial) {
            const now = Date.now();
            const usedProvider = providerOfModel(settings.selectedModel);
            const message: ChatMessage = {
              id: id("msg"),
              role: "assistant",
              content: cleanPartial + "\n\n_(Generation stopped by user)_",
              createdAt: now,
              startedAt,
              completedAt: now,
              model: settings.selectedModel,
              provider: usedProvider
            };
            const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
            this.store.saveConversation(next);
            this.emit({ type: "done", conversationId: conversation.id, payload: next });
            return next;
          }
        }
      }
      throw err;
    }
    const now = Date.now();
    recordModelSuccess(providerOfModel(settings.selectedModel), settings.selectedModel);
    const stoppedText = this.stopped ? "\n\n_(Generation stopped by user)_" : "";
    let safeFinalText2 = typeof finalText === "string" ? finalText : String(finalText ?? "");
    safeFinalText2 = stripToolCallBlocks(safeFinalText2).trim();
    if (safeFinalText2.includes("[object Object]") || safeFinalText2.includes("[object Array]")) {
      safeFinalText2 = safeFinalText2.replace(/\[object Object\]/g, "").replace(/\[object Array\]/g, "").trim();
    }
    const usedProvider = providerOfModel(settings.selectedModel);
    const message: ChatMessage = {
      id: id("msg"),
      role: "assistant",
      content: (safeFinalText2 || "I couldn't generate a response. Please try again.") + stoppedText,
      createdAt: now,
      startedAt,
      completedAt: now,
      model: settings.selectedModel,
      provider: usedProvider
    };
    const next = { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
    this.store.saveConversation(next);
    this.emit({ type: "done", conversationId: conversation.id, payload: next });
    return next;
  }

  private emit(event: AgentEvent): void {
    this.window.webContents.send("agent:event", event);
  }
}

function toGeminiMessage(message: ChatMessage): { role: "user" | "model"; parts: Array<{ text: string }> } {
  return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
}
