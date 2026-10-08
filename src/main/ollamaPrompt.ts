/**
 * Ollama prompt compaction — local models (1–8B) cannot carry the full 9k-char
 * Latex agent prompt plus a 33-tool catalog: prompt evaluation takes tens of
 * seconds on 4-core CPUs and can crash low-VRAM Ollama runners. Cloud models
 * keep the full prompt.
 *
 * Also provides transcript trimming so long conversations don't blow the
 * context budget of small local models.
 *
 * The RESPONSE STANDARD comes from shared/responseContract.ts — the condensed
 * variant, so a local model still answers with the same shape as a cloud one.
 */

import { LATEX_RESPONSE_CONTRACT_LOCAL } from "../shared/responseContract.js";

/** Rough token estimate (~4 chars/token English/code mix). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compact system prompt for LOCAL Ollama models.
 *
 * Keeps the behavior-critical rules (tool usage, honesty, concise output) but
 * drops the long worked examples, PC-control catalogs, and repeated warnings
 * that dominate the full prompt. ~1/8 the size.
 */
export function compactOllamaSystemPrompt(fullSystem: string, hasTools: boolean): string {
  // Chat mode passes a short dedicated prompt (LATEX_CHAT_PROMPT ≈1k chars) —
  // it is already light, use it unchanged.
  if (fullSystem && fullSystem.length <= 1600) return fullSystem;

  const base = `You are Latex, a careful coding agent on the user's Windows PC. You work inside an approved workspace folder and act through tools. The host executes every tool and returns verified results; you never touch the filesystem directly.

Core rules:
- ACT, don't narrate: your first reply to a task must call tools (get_workspace_info or list_directory to inspect, then create_file/write_file/edit_file to make changes). Never start with a planning paragraph.
- Outputting code in a markdown block does NOT change files. To create or edit files you MUST call create_file, write_file, or edit_file.
- Inspect before you modify: read_file the target, then make the smallest precise change. Prefer edit_file over write_file for small edits.
- Never claim a file operation succeeded unless the tool result says "success": true. Report errors honestly.
- Paths are relative to the workspace (or absolute in Full PC Access mode). Never use ".." in workspace mode.
- Use run_command only for build/test commands the user asked for. Never suggest admin commands.
- Explain actions briefly. Do not invent file contents or command output.
- FINAL RESPONSE: brief — what you did, the real file names, one verification line. Never paste whole files.

${LATEX_RESPONSE_CONTRACT_LOCAL}
${hasTools ? `
Tool requests: emit a JSON block wrapped in <tool_call> tags, one per request:

<tool_call>
{"name": "create_file", "arguments": {"relativePath": "app.js", "content": "..."}}
</tool_call>

After emitting tool requests, STOP and wait for results. Your first reply to a task must contain at least one tool call.` : ""}

Rules:
- To create/edit files, ALWAYS call create_file/write_file/edit_file. Code in a markdown block does NOT change files.
- Never claim success unless the tool result says "success": true.
- Keep replies short. After finishing tools, give a brief summary (files changed, what was done).`;
  return base;
}

/** Char budget for tool results fed back into the transcript. */
const TOOL_RESULT_CHAR_BUDGET = 4000;
/** Max transcript turns kept verbatim for local models. */
const MAX_TURNS = 12;
/** Char budget for the whole transcript (excluding system prompt). */
const TOTAL_CHAR_BUDGET = 16_000;

/**
 * Trim a chat transcript for local models: keep the most recent turns, cap
 * each message, and summarize dropped history in one line. Cloud models and
 * small transcripts pass through unchanged.
 */
export function trimTranscriptForOllama<
  T extends { role: "user" | "assistant"; content: string }
>(
  messages: T[]
): T[] {
  if (messages.length <= MAX_TURNS) {
    const total = messages.reduce((sum, m) => sum + m.content.length, 0);
    if (total <= TOTAL_CHAR_BUDGET) return messages;
  }
  // Keep the last MAX_TURNS messages; cap each; add a summary of dropped turns.
  // Extra fields (e.g. vision `attachments`) are preserved via spread so
  // images survive transcript trimming.
  const kept = messages.slice(-MAX_TURNS).map((m) => ({
    ...m,
    content: m.content.length > TOOL_RESULT_CHAR_BUDGET
      ? m.content.slice(0, TOOL_RESULT_CHAR_BUDGET) + "\n…(truncated)"
      : m.content
  }));
  const dropped = messages.length - kept.length;
  if (dropped > 0) {
    kept.unshift({
      role: "user",
      content: `(Earlier conversation omitted: ${dropped} messages.)`
    } as unknown as T);
  }
  return kept;
}
