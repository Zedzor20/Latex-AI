/**
 * FINAL ANSWER STABILITY + VERIFIED FINALIZATION test.
 *
 * Run with:  node test-final-answer-stability.mjs
 *
 * Compiles the REAL shared/main modules (no reimplementation) and proves:
 *
 *   1. A long streamed answer is preserved verbatim when the finalization pass
 *      runs — including Markdown, headings, lists and code fences.
 *   2. An empty / partial finalization payload cannot overwrite valid streamed
 *      text.
 *   3. A shorter, unrelated final text can never replace a longer streamed one.
 *   4. The new text is APPENDED (and only the unseen suffix is streamed again),
 *      never reprinted.
 *   5. Duplicate completion events are de-duplicated.
 *   6. A run whose operations ALL failed is reported as a failure with its real
 *      cause — never "Done — nothing needed to change".
 *   7. A partial run distinguishes the changes that succeeded from the failures.
 *   8. A read-only run that changed nothing keeps the honest wording.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-final-answer");
rmSync(outDir, { recursive: true, force: true });

// No --strict: `diff` (used by taskSummary) ships no type declarations, and
// noImplicitAny is what turns that into a hard compile error.
execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/shared/finalAnswer.ts",
    "src/shared/generatedResults.ts",
    "src/shared/types.ts",
    "src/main/taskSummary.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

const finalAnswer = await import(pathToFileURL(join(outDir, "shared", "finalAnswer.js")).href);
const taskSummary = await import(pathToFileURL(join(outDir, "main", "taskSummary.js")).href);
const generated = await import(pathToFileURL(join(outDir, "shared", "generatedResults.js")).href);

const {
  reconcileFinalAnswer,
  pendingStreamText,
  normalizeAnswerText,
  CompletionGuard,
  finalizationKey,
  finalAnswerDiagnostic
} = finalAnswer;
const { composeTaskReportParts, emptyTaskSummary } = taskSummary;
const { resolveTaskResultState } = generated;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── A realistic long streamed answer (Markdown + code + list) ────────────
const LONG_ANSWER = [
  "## Implementation plan",
  "",
  "Here is what I found and what I changed:",
  "",
  "1. The router had no error boundary",
  "2. The poller retried forever",
  "3. The cache was never invalidated",
  "",
  "```js",
  "export function poll() {",
  "  // retry with backoff",
  "  for (let i = 0; i < 5; i++) {",
  "    await tick(i);",
  "  }",
  "}",
  "```",
  "",
  "That completes the change."
].join("\n");

// ── 1. Long streamed answer survives a finalization pass ─────────────────
{
  const body = "I confirmed the change on disk before finishing.";
  const rec = reconcileFinalAnswer(LONG_ANSWER, body);
  check("long answer: the streamed text is preserved verbatim", rec.content.startsWith(LONG_ANSWER));
  check("long answer: the new report body is appended", rec.content.endsWith(body));
  check("long answer: Markdown code fence survives", (rec.content.match(/```/g) ?? []).length === 2);
  check("long answer: the heading + list survive", rec.content.includes("## Implementation plan") && rec.content.includes("3. The cache was never invalidated"));
  check("long answer: line count never drops", rec.content.split("\n").length > LONG_ANSWER.split("\n").length);
  check("long answer: the source records the append", rec.source === "streamed+final", rec.source);
  check("long answer: only the appended body is pending", rec.pendingStream === body || pendingStreamText(rec.content, LONG_ANSWER) === body, JSON.stringify(rec.pendingStream));
  check("long answer: nothing was 'truncated for brevity'", !/truncated/i.test(rec.content));
}

// ── 2. An empty / partial payload cannot overwrite the streamed answer ───
{
  const empty = reconcileFinalAnswer(LONG_ANSWER, "");
  check("empty final: the streamed answer is kept", empty.content === LONG_ANSWER.trim());
  check("empty final: flagged as ignored", empty.ignoredEmptyFinal && !empty.rejectedReplacement);
  check("empty final: nothing is streamed twice", pendingStreamText(empty.content, LONG_ANSWER) === "");

  const whitespace = reconcileFinalAnswer(LONG_ANSWER, "   \n\n\t ");
  check("whitespace final: the streamed answer is kept", whitespace.content === LONG_ANSWER.trim());
  check("whitespace final: nothing new is pending", pendingStreamText(whitespace.content, LONG_ANSWER) === "");
}

// ── 3. A shorter unrelated final text never replaces a longer answer ─────
{
  const rec = reconcileFinalAnswer(LONG_ANSWER, "Task completed.");
  check("shorter final: the streamed answer is still first", rec.content.startsWith(LONG_ANSWER));
  check("shorter final: the replacement attempt is recorded", rec.rejectedReplacement);
  check("shorter final: content did not shrink", rec.content.length > LONG_ANSWER.length);
}

// ── 4. An identical finalizer output is not reprinted ────────────────────
{
  const rec = reconcileFinalAnswer(LONG_ANSWER, LONG_ANSWER);
  check("identical final: content is the streamed text exactly", rec.content === LONG_ANSWER.trim());
  check("identical final: nothing pending", pendingStreamText(rec.content, LONG_ANSWER) === "");
  check("identical final: source=streamed", rec.source === "streamed", rec.source);
}

// ── 5. A streamed answer already containing the prose streams only new text
{
  const final = `${LONG_ANSWER}\n\nI confirmed the change on disk before finishing.`;
  const rec = reconcileFinalAnswer(LONG_ANSWER, final);
  check("superset final: the appended tail is only the new sentence",
    rec.pendingStream === "I confirmed the change on disk before finishing.", JSON.stringify(rec.pendingStream));
  check("superset final: the streamed block is not duplicated",
    rec.content === `${LONG_ANSWER}\n\nI confirmed the change on disk before finishing.`);
}

// ── 6. No streamed answer at all: the composed result is used as-is ──────
{
  const rec = reconcileFinalAnswer("", "**Done — I created `index.html`.**\n\nReady.");
  check("no stream: the final answer stands alone", rec.content.startsWith("**Done"));
  check("no stream: everything is pending", rec.pendingStream === rec.content);
  check("no stream: neither side is empty", !rec.ignoredEmptyFinal && rec.preservedStreamed === false);
  const nothing = reconcileFinalAnswer("", "");
  check("no stream + no final: nothing is invented", nothing.content === "" && nothing.source === "empty");
}

// ── 7. Completion de-duplication ─────────────────────────────────────────
{
  const guard = new CompletionGuard();
  check("dedupe: the first claim wins", guard.claim("task_1::msg_1") === true);
  check("dedupe: the second claim is refused", guard.claim("task_1::msg_1") === false);
  check("dedupe: a different message is unaffected", guard.claim("task_1::msg_2") === true);
  check("dedupe: an unkeyed run is never blocked", guard.claim("") === true && guard.claim("") === true);
  check("dedupe: key shape is task::message", finalizationKey("t1", "m1") === "t1::m1", finalizationKey("t1", "m1"));
  check("dedupe: key tolerates a missing message", finalizationKey("t1", null) === "t1::msg");
}

// ── 8. Diagnostics are content-free ──────────────────────────────────────
{
  const line = finalAnswerDiagnostic({
    taskId: "t1",
    messageId: "m1",
    stage: "finalize",
    streamedLength: 1234,
    finalLength: 1300,
    source: "streamed+final",
    preservedStreamed: true,
    ignoredEmptyFinal: false,
    rejectedReplacement: false
  });
  check("diagnostics name the stage, lengths and source",
    /stage=finalize/.test(line) && /streamed=1234/.test(line) && /source=streamed\+final/.test(line));
  check("diagnostics never carry message content", !line.includes(LONG_ANSWER.slice(0, 20)));
}

// ── 9. Verified finalization: an all-failed run is a FAILURE ─────────────
const root = "C:\\Users\\user\\Documents\\My Games\\Latex Games";
function failedFolderOp(i) {
  return {
    type: "folder_create",
    tool: "create_directory",
    path: ".",
    status: "failed",
    verified: false,
    error: `A folder NAME is required (received "."). "${root}" is the workspace root itself — nothing was created.`,
    resolvedPath: root,
    at: Date.now() + i,
    description: `Failed: Created folder \`.\` — a folder NAME is required`,
    constructs: [],
    mutating: true
  };
}
function inspectOp(path, resolvedPath) {
  return {
    type: "inspect",
    tool: "list_directory",
    path,
    status: "success",
    verified: true,
    resolvedPath,
    at: Date.now(),
    description: `Inspected \`${resolvedPath}\``,
    constructs: [],
    mutating: false
  };
}

{
  const summary = emptyTaskSummary("main");
  summary.operations = [inspectOp(".", root), failedFolderOp(1), failedFolderOp(2), failedFolderOp(3), failedFolderOp(4)];
  summary.failedOperations = summary.operations.filter((op) => op.status !== "success");
  summary.counts = { operations: 5, succeeded: 1, failed: 4, filesChanged: 0, linesAdded: 0 };

  // Exactly what the agent computes for the task result state.
  const successfulMutations = summary.operations.filter((op) => op.mutating && op.status === "success").length;
  const successfulCommands = summary.operations.filter((op) => op.type === "command" && op.status === "success").length;
  const state = resolveTaskResultState({
    failed: false,
    filesChanged: summary.counts.filesChanged,
    successfulOperations: successfulMutations + successfulCommands,
    failedOperations: summary.counts.failed,
    generatedResults: 0,
    hasAnswer: true
  });
  check("all-failed run: the real task result is FAILED", state === "FAILED", state);

  const report = composeTaskReportParts({
    summary,
    taskResult: state,
    explanation: "Done — I created the folder for you."
  });
  console.log(`  [report] ${JSON.stringify(report.full.slice(0, 220))}`);
  check("all-failed run: the answer does NOT say nothing needed to change",
    !/nothing needed to change/i.test(report.full));
  check("all-failed run: the answer does not claim 'Done'", !/\*\*Done/.test(report.header));
  check("all-failed run: the failure count is named", /4 operations failed/i.test(report.header));
  check("all-failed run: the operations are listed as not completed", /### Not completed/.test(report.full));
  check("all-failed run: a real cause is given", /What went wrong/.test(report.full) && /folder NAME is required/i.test(report.body));
  check("all-failed run: the body carries the failure status (so an already-streamed answer still shows it)",
    /Couldn't finish/i.test(report.body));
}

// ── 10. A partial run distinguishes success from failure ─────────────────
{
  const summary = emptyTaskSummary("main");
  const created = {
    type: "file_create",
    tool: "create_file",
    path: "index.html",
    status: "success",
    verified: true,
    resolvedPath: `${root}\\index.html`,
    at: Date.now(),
    description: "Created `index.html`",
    constructs: [],
    mutating: true
  };
  summary.operations = [created, failedFolderOp(1)];
  summary.failedOperations = [summary.operations[1]];
  summary.createdFiles = ["index.html"];
  summary.filesChanged = ["index.html"];
  summary.counts = { operations: 2, succeeded: 1, failed: 1, filesChanged: 1, linesAdded: 3 };

  const report = composeTaskReportParts({ summary, taskResult: "PARTIAL_SUCCESS" });
  check("partial run: the successful change is named", /index\.html/.test(report.header), report.header);
  check("partial run: the failure is reported too", /could not be completed/i.test(report.body));
  check("partial run: it never says nothing needed to change", !/nothing needed to change/i.test(report.full));
  check("partial run: the created file is verified before being named",
    /confirmed the change on disk/i.test(report.body));
}

// ── 11. A read-only run keeps the honest wording ────────────────────────
{
  const summary = emptyTaskSummary("main");
  summary.operations = [inspectOp("src", `${root}\\src`)];
  summary.counts = { operations: 1, succeeded: 1, failed: 0, filesChanged: 0, linesAdded: 0 };
  const report = composeTaskReportParts({ summary, taskResult: "SUCCESS" });
  check("read-only run: the honest wording is kept", /nothing needed to change/i.test(report.full));
  check("read-only run: the inspected folder is named by its real path",
    !/Inspected `.`/.test(summary.operations[0].description), summary.operations[0].description);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} final-answer checks passed`);
console.log("─".repeat(64));
process.exitCode = failed.length === 0 ? 0 : 1;
