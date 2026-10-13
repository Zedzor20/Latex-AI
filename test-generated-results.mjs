/**
 * Regression test for GENERATED RESULTS + the honest task result state.
 *
 * Run with:  node test-generated-results.mjs
 *
 * What it locks down:
 *  - a result is created only from a REAL provider image chunk or a REAL
 *    successful tool result — never from model prose, never fabricated;
 *  - a failed / rejected / cancelled tool result can never become a result;
 *  - results are deduplicated by a stable resultId (a duplicated event, an IPC
 *    reconnect, a restored task cannot stack the same graph twice);
 *  - only NORMALIZED chart data is stored (bounded labels/values), never the
 *    tool's raw JSON;
 *  - "no filesystem change" is NOT "nothing happened": a task with only a
 *    generated graph/image is SUCCESS and the answer says so naturally;
 *  - a task that genuinely produced nothing is still NO_RESULT and still reads
 *    "nothing needed to change".
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-generated-results");

execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/main/taskSummary.ts",
    "src/shared/generatedResults.ts",
    "src/shared/types.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

const {
  generatedResultFromImage,
  generatedResultFromToolResult,
  mergeGeneratedResults,
  generatedResultClause,
  generatedResultSentence,
  generatedResultCounts,
  resolveTaskResultState,
  normalizeChartData,
  looksLikeBase64Image
} = await import(pathToFileURL(join(outDir, "shared", "generatedResults.js")).href);
const { TaskChangeRecorder, composeTaskReport, composeTaskReportParts } =
  await import(pathToFileURL(join(outDir, "main", "taskSummary.js")).href);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}
function checkTrue(name, actual) {
  check(name, Boolean(actual), true);
}

// A tiny but REAL base64 payload (valid alphabet + padding).
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
// JPEG payloads start with "/9j/" — the leading slash is NOT a path marker.
// Built from real JPEG magic bytes so the padding is genuinely correct.
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c
]).toString("base64");
if (!TINY_JPEG.startsWith("/9j/")) throw new Error(`fixture is not a JPEG base64 payload: ${TINY_JPEG}`);

// ─── Only real, successful producers create a result ──────────────────────

check("plain string result → no result", generatedResultFromToolResult("read_file", "file contents", { toolCallId: "tc_1" }), null);
check("ordinary json result → no result",
  generatedResultFromToolResult("list_directory", { entries: ["a.js", "b.css"] }, { toolCallId: "tc_2" }), null);
check("failed tool → no result",
  generatedResultFromToolResult("take_screenshot", { success: false, error: "no screen", data: { previewBase64: TINY_PNG } }, { toolCallId: "tc_3" }), null);
check("cancelled tool → no result",
  generatedResultFromToolResult("run_command", { cancelled: true }, { toolCallId: "tc_4" }), null);
check("error field → no result",
  generatedResultFromToolResult("run_command", { error: "command failed" }, { toolCallId: "tc_5" }), null);
check("a file path is not an image",
  generatedResultFromToolResult("open_file", { data: { path: "C:\\shots\\a.png" } }, { toolCallId: "tc_6" }), null);

// A JPEG preview (the real `take_screenshot` shape) must be recognized too.
const jpegShot = generatedResultFromToolResult(
  "take_screenshot",
  { success: true, operation: "take_screenshot", data: { path: "C:\\tmp\\s.png", width: 100, height: 50, previewBase64: TINY_JPEG } },
  { toolCallId: "tc_shot_jpeg" }
);
check("jpeg preview → image result", jpegShot?.kind, "image");
check("jpeg preview → mime is jpeg", jpegShot?.mimeType, "image/jpeg");

// A real screenshot preview IS a visual result.
const shot = generatedResultFromToolResult(
  "take_screenshot",
  { success: true, operation: "take_screenshot", data: { path: "C:\\tmp\\s.png", width: 100, height: 50, previewBase64: TINY_PNG } },
  { toolCallId: "tc_shot", taskId: "task_a", messageId: "msg_a" }
);
check("screenshot → image result kind", shot?.kind, "image");
checkTrue("screenshot → mime is an image", /^image\//.test(shot.mimeType));
check("screenshot → stable result id from toolCallId", shot.resultId, "gr_tc_shot");
check("screenshot → carries base64", shot.base64, TINY_PNG);

// A structured graph becomes a normalized graph result.
const graph = generatedResultFromToolResult(
  "make_graph",
  { graph: { type: "bar", title: "Latency", labels: ["a", "b", "c"], values: [3, 7, 5] } },
  { toolCallId: "tc_graph" }
);
check("structured graph → graph kind", graph?.kind, "graph");
check("structured graph → normalized series", graph?.data?.chart, { labels: ["a", "b", "c"], values: [3, 7, 5], type: "bar", title: "Latency" });

// An unrecognized structured visual still counts (kind only, never raw JSON).
const odd = generatedResultFromToolResult("make_visual", { visual: { nested: { secret: "x".repeat(5000) } } }, { toolCallId: "tc_odd" });
check("unrecognized visual → still a result", odd?.kind, "visual");
check("unrecognized visual → no raw payload stored", odd?.data, undefined);

// ─── Dedup by stable id ───────────────────────────────────────────────────

let list = mergeGeneratedResults([], graph);
list = mergeGeneratedResults(list, graph);
list = mergeGeneratedResults(list, { ...graph, status: "failed" });
check("duplicate result merges to ONE", list.length, 1);
check("a completed result is not downgraded by a later failure", list[0].status, "completed");

// Distinct tool calls stay distinct.
list = mergeGeneratedResults(list, generatedResultFromToolResult(
  "make_graph", { graph: { labels: ["x"], values: [1] } }, { toolCallId: "tc_graph2" }
));
check("a different tool call is a different result", list.length, 2);

// Bounded.
let many = [];
for (let i = 0; i < 30; i++) {
  many = mergeGeneratedResults(many, generatedResultFromImage({ mimeType: "image/png", data: TINY_PNG }, { taskId: "t" }, i, 1000 + i));
}
check("results are bounded", many.length, 12);
checkTrue("image results get distinct stable ids", new Set(many.map((r) => r.resultId)).size === many.length);

// ─── Normalized chart data only ───────────────────────────────────────────

check("chart: labels/values", normalizeChartData({ labels: ["Jan", "Feb"], values: [1, 2] }), { labels: ["Jan", "Feb"], values: [1, 2] });
check("chart: rows", normalizeChartData({ data: [{ label: "A", value: 4 }, { label: "B", value: 8 }] }), { labels: ["A", "B"], values: [4, 8] });
check("chart: bare numbers", normalizeChartData([5, 6, 7]), { labels: ["1", "2", "3"], values: [5, 6, 7] });
check("chart: unrecognized → null", normalizeChartData({ foo: "bar" }), null);
check("base64: a path is not base64", looksLikeBase64Image("C:/shots/a.png"), false);
check("base64: a real payload passes", looksLikeBase64Image(TINY_PNG), true);

// ─── Natural language naming ──────────────────────────────────────────────

const graphResult = { resultId: "r1", kind: "graph", status: "completed", createdAt: 1 };
const imageResult = { resultId: "r2", kind: "image", status: "completed", createdAt: 2 };
check("clause: one graph", generatedResultClause([graphResult]), "generated the graph above");
check("sentence: one image", generatedResultSentence([imageResult]), "I generated the image above.");
check("clause: graph + image", generatedResultClause([graphResult, imageResult]), "generated the graph and the image above");
check("clause: nothing", generatedResultClause([]), "");
check("counts", generatedResultCounts([graphResult, imageResult]), { total: 2, images: 1, graphs: 1, charts: 0, artifacts: 0, visuals: 0 });
check("counts: failures are not results", generatedResultCounts([{ ...graphResult, status: "failed" }]).total, 0);

// ─── The REAL task result state ───────────────────────────────────────────

check("state: no files + one graph → SUCCESS",
  resolveTaskResultState({ filesChanged: 0, generatedResults: 1, hasAnswer: true }), "SUCCESS");
check("state: no files + one image → SUCCESS",
  resolveTaskResultState({ filesChanged: 0, generatedResults: 1 }), "SUCCESS");
check("state: files changed → SUCCESS",
  resolveTaskResultState({ filesChanged: 2 }), "SUCCESS");
check("state: nothing at all → NO_RESULT",
  resolveTaskResultState({ filesChanged: 0, successfulOperations: 0, failedOperations: 0, generatedResults: 0 }), "NO_RESULT");
check("state: only failures → FAILED",
  resolveTaskResultState({ failed: true, failedOperations: 2 }), "FAILED");
check("state: failed after real work → PARTIAL_SUCCESS",
  resolveTaskResultState({ failed: true, filesChanged: 1 }), "PARTIAL_SUCCESS");
check("state: stopped with a result → PARTIAL_SUCCESS",
  resolveTaskResultState({ stopped: true, generatedResults: 1 }), "PARTIAL_SUCCESS");
check("state: stopped with nothing → CANCELLED",
  resolveTaskResultState({ stopped: true }), "CANCELLED");

// ─── The finalizer: no filesystem change ≠ nothing happened ───────────────

const readOnly = new TaskChangeRecorder("main");
readOnly.record("read_file", { relativePath: "index.html" }, true, "…");

const graphOnly = composeTaskReportParts({
  summary: readOnly.summary(),
  generatedResults: [graphResult],
  taskResult: "SUCCESS"
});
check("finalizer: graph-only headline names the graph", graphOnly.header, "**Done — I generated the graph above.**");
check("finalizer: never says nothing needed to change",
  /nothing needed to change/i.test(graphOnly.full), false);
check("finalizer: never says the workspace needed nothing",
  /Nothing in the workspace needed to change/i.test(graphOnly.full), false);

const imageOnly = composeTaskReportParts({ summary: readOnly.summary(), generatedResults: [imageResult], taskResult: "SUCCESS" });
check("finalizer: image-only headline", imageOnly.header, "**Done — I generated the image above.**");

// No-model-prose path (the exact reported bug) must also name the result.
const report = composeTaskReport({ summary: readOnly.summary(), generatedResults: [graphResult], taskResult: "SUCCESS" });
checkTrue("report: names the generated graph", report.includes("I generated the graph above."));

// Files AND a result: mention both, naturally, without dumping tool info.
const withFiles = new TaskChangeRecorder("main");
withFiles.record("create_file", { relativePath: "index.html", content: "<h1>hi</h1>" }, true, { verified: true });
const both = composeTaskReport({ summary: withFiles.summary(), generatedResults: [graphResult], taskResult: "SUCCESS" });
checkTrue("report: names the file and the graph", both.startsWith("**Done — I created `index.html` in the project root and generated the graph above.**"));
checkTrue("report: no raw tool JSON leaked", both.includes("make_graph") === false && both.includes('"values"') === false);

// A genuinely empty read-only task keeps the honest existing wording.
const bare = composeTaskReportParts({ summary: readOnly.summary() });
check("finalizer: no result → unchanged behaviour", bare.header, "**Done — nothing needed to change.**");
checkTrue("finalizer: no result → workspace wording kept", /Nothing in the workspace needed to change/.test(bare.full));

// A stopped run still never claims Done.
const stopped = composeTaskReport({
  summary: readOnly.summary(),
  generatedResults: [graphResult],
  stopped: true,
  statusLabel: "The task stopped before completion",
  incompleteReason: "the provider request failed — the remaining steps were not executed."
});
check("finalizer: stopped run never says Done", /\*\*Done/.test(stopped), false);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
