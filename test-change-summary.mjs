/**
 * Regression test for the operation-derived change summary and the Chat
 * boundary/normalisation layer.
 *
 * Run with:  node test-change-summary.mjs
 *
 * What it locks down:
 *  - a task summary is built from REAL tool results only (success flags), never
 *    from what a model says it did;
 *  - Chat mode cannot record any workspace mutation, whatever the payload;
 *  - the final report contains the human-readable sections (What changed /
 *    New features / Controls / Files changed / Verification) and omits the ones
 *    with no real content;
 *  - controls are extracted from the code that was actually written;
 *  - Chat normalization strips /thought>, tool JSON and fake write_file
 *    payloads, reports fake "I changed X" claims, and keeps real code examples.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-change-summary");

execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/main/taskSummary.ts",
    "src/main/chatResponse.ts",
    "src/main/toolProtocol.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

const {
  TaskChangeRecorder,
  composeTaskReport,
  composeTaskReportParts,
  sanitizeExplanation,
  detectControls,
  htmlLocalReferences,
  summarizeForActivity
} = await import(`./.tmp-change-summary/main/taskSummary.js`);
const { normalizeChatResponse, detectWorkspaceClaims, chatBoundaryNotice } =
  await import(`./.tmp-change-summary/main/chatResponse.js`);

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

// ─── Chat mode records nothing ────────────────────────────────────────────

const chat = new TaskChangeRecorder("chat");
const chatRecord = chat.record("write_file", { relativePath: "script.js", content: "x" }, true, { verified: true });
check("chat: record() returns null", chatRecord, null);
const chatSummary = chat.summary();
check("chat: no created files", chatSummary.createdFiles, []);
check("chat: no modified files", chatSummary.modifiedFiles, []);
check("chat: no file changes at all", chatSummary.counts.filesChanged, 0);
check("chat: cannot mutate workspace", chat.canMutateWorkspace, false);
check("chat: report says nothing changed", composeTaskReport({ summary: chatSummary }).includes("nothing needed to change"), true);

// ─── Main mode records real operations ────────────────────────────────────

const main = new TaskChangeRecorder("main");
main.record("create_file", { relativePath: "index.html", content: '<canvas id="worldCanvas" width="1600" height="1200"></canvas>\n<button id="startBtn">Start</button>\n<script src="script.js"></script>' }, true, { success: true, operation: "create_file", verified: true });
main.record("create_file", { relativePath: "style.css", content: "#worldCanvas { display:block; width:100%; }\nbody { display: flex; background: linear-gradient(#000,#111); }" }, true, { success: true, verified: true });
main.record("write_file", { relativePath: "script.js", content: readScriptFixture() }, true, { success: true, verified: true });
// A failing edit must never be reported as a change.
main.record("edit_file", { relativePath: "broken.js", oldText: "a", newText: "b" }, false, { error: "oldText not found" }, "failed");
// A rejected operation must never be reported as a change either.
main.record("delete_file", { relativePath: "keep-me.txt" }, false, { cancelled: true, reason: "user rejected" }, "rejected");
main.record("run_command", { command: "node --check script.js" }, true, { command: "node --check script.js", exitCode: 0, stdout: "" });
main.addVerification("`index.html` references resolve on disk (script.js, style.css).");

const summary = main.summary();
// write_file replaces a file's contents — it is a modification, create_file is a creation.
check("main: created files", summary.createdFiles, ["index.html", "style.css"]);
check("main: modified files", summary.modifiedFiles, ["script.js"]);
check("main: failed edit not a change", summary.filesChanged.includes("broken.js"), false);
check("main: rejected delete not a change", summary.deletedFiles.includes("keep-me.txt"), false);
check("main: failed count", summary.counts.failed, 2);
check("main: files changed count", summary.counts.filesChanged, 3);
checkTrue("main: canvas feature detected", summary.features.includes("Canvas-based world rendering"));
checkTrue("main: render loop feature detected", summary.features.includes("Continuous render loop"));
checkTrue("main: keyboard controls feature detected", summary.features.includes("Keyboard controls"));
checkTrue("main: wheel zoom feature detected", summary.features.includes("Mouse-wheel zoom"));

// Controls must come from the code, not from a template.
const controlLabels = summary.controls.map((c) => c.mouse ?? c.button ?? c.keys.join("/"));
checkTrue("main: WASD control", controlLabels.includes("WASD"));
checkTrue("main: Space control", controlLabels.includes("Space"));
checkTrue("main: mouse wheel control", controlLabels.includes("Mouse Wheel"));
checkTrue("main: start button control", controlLabels.includes("Start"));
const wasd = summary.controls.find((c) => c.keys.join("") === "WASD");
check("main: WASD action from source", wasd?.action, "Move the camera");

// ─── Final report reads like an assistant, not a metadata dump ────────────

const report = composeTaskReport({ summary, explanation: "The island renderer now draws the world." });
checkTrue("report: natural headline names what happened",
  report.startsWith("**Done — I created `index.html` and `style.css` and updated `script.js`, all in the project root.**"));
checkTrue("report: model explanation kept", report.includes("The island renderer now draws the world."));
checkTrue("report: says the changes were verified on disk", report.includes("confirmed all 3 file changes on disk"));
checkTrue("report: mentions the command it ran", report.includes("node --check script.js"));
checkTrue("report: real reference check kept", report.includes("references resolve on disk"));
checkTrue("report: features section kept", report.includes("### New features"));
checkTrue("report: controls section kept", report.includes("### Controls"));
checkTrue("report: never says how many operations completed", /operation[s]? completed/i.test(report) === false);
checkTrue("report: no duplicated file inventory",
  report.includes("### What changed") === false && report.includes("### Files changed") === false && report.includes("### Verification") === false);
checkTrue("report: no tool JSON leaked", report.includes("write_file") === false);
check("report: activity receipt", summarizeForActivity(summary), "2 created • 1 edited • 1 command run • 2 failed");

// ── Finalization parts: stream what the user has not seen yet ─────────────

const parts = composeTaskReportParts({ summary, explanation: "The island renderer now draws the world." });
checkTrue("parts: header carries the headline", parts.header.startsWith("**Done — I created"));
checkTrue("parts: header carries the model prose", parts.header.includes("island renderer now draws the world"));
checkTrue("parts: body carries the extra detail", parts.body.includes("### New features") || parts.body.includes("### Controls"));
check("parts: full is header + body", parts.full, `${parts.header}\n\n${parts.body}`);

// The "model went silent after its last tool call" case: no explanation at all,
// yet a complete human-readable report must still be produced.
const silent = composeTaskReportParts({ summary });
check("silent model: header is just the headline", silent.header,
  "**Done — I created `index.html` and `style.css` and updated `script.js`, all in the project root.**");
checkTrue("silent model: the answer explains the outcome in prose", silent.full.includes("The workspace now reflects those changes."));
checkTrue("silent model: the answer says what was verified", silent.full.includes("confirmed all 3 file changes on disk"));
checkTrue("silent model: report keeps the controls it found", silent.full.includes("### Controls"));
checkTrue("silent model: report is not empty", silent.full.length > 150);

// A run that ended early must never claim success.
const incomplete = composeTaskReport({
  summary,
  statusLabel: "The task stopped before completion",
  incompleteReason: "the provider request failed — the remaining steps were not executed."
});
checkTrue("incomplete: headline is the status label", incomplete.startsWith("**The task stopped before completion**"));
check("incomplete: never says Done", /\*\*Done/.test(incomplete), false);
checkTrue("incomplete: explains what remains", incomplete.includes("### What remains"));
checkTrue("incomplete: still lists the real work", incomplete.includes("`script.js`"));
checkTrue("incomplete: says the run stopped early", incomplete.includes("stopped before the task was finished"));
checkTrue("incomplete: no generic completion filler", /operation[s]? completed/i.test(incomplete) === false);

// Sections with no real content are omitted.
const bare = new TaskChangeRecorder("main");
bare.record("read_file", { relativePath: "index.html" }, true, "…");
const bareReport = composeTaskReport({ summary: bare.summary() });
check("report: no Controls section when none exist", bareReport.includes("### Controls"), false);
check("report: no New features section when none exist", bareReport.includes("### New features"), false);
check("report: no file inventory when nothing changed", bareReport.includes("### Files changed"), false);
checkTrue("report: read-only task says nothing needed to change", bareReport.startsWith("**Done — nothing needed to change.**"));
checkTrue("report: read-only task never counts operations", /operation[s]? completed/i.test(bareReport) === false);

// ─── Explanation sanitiser (no code dumps in the answer) ──────────────────

const longBlock = `Done.\n\n\`\`\`js\n${Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join("\n")}\n\`\`\`\n\nThat is all.`;
const sanitized = sanitizeExplanation(longBlock);
check("sanitize: long code dump removed", sanitized.includes("const line50"), false);
checkTrue("sanitize: prose kept", sanitized.includes("That is all."));
const shortBlock = "Example:\n\n```js\nconst a = 1;\n```";
check("sanitize: short snippet kept", sanitizeExplanation(shortBlock), shortBlock);

// ─── HTML reference discovery ─────────────────────────────────────────────

check(
  "html refs: local only",
  htmlLocalReferences('<link href="style.css"><script src="./script.js"></script><a href="#top"></a><script src="https://cdn.x/y.js"></script>'),
  ["style.css", "script.js"]
);

// ─── Controls extraction is generic (not tied to one project) ─────────────

const pythonish = detectControls([
  { path: "game.js", code: 'window.addEventListener("keydown", (e) => {\n  if (e.code === "KeyP") { paused = !paused; } // pause or resume\n});' }
]);
check("controls: imperative handler key", pythonish[0]?.keys, ["P"]);
check("controls: imperative handler action", pythonish[0]?.action, "pause or resume");

// ─── Chat normalisation ──────────────────────────────────────────────────

const leaked = normalizeChatResponse('/thought>\nI changed `script.js` to add terrain rendering.\n\n```json\n{"name": "write_file", "arguments": {"relativePath": "script.js", "content": "…"}}\n```\n\nLet me know if you want more.');
check("chat: /thought> removed", leaked.text.includes("/thought>"), false);
check("chat: tool JSON removed", leaked.text.includes("write_file"), false);
check("chat: prose kept", leaked.text.includes("terrain rendering"), true);
check("chat: fake file claim detected", leaked.claims.fileChange, true);
checkTrue("chat: boundary notice explains it", chatBoundaryNotice(leaked.claims).includes("nothing was changed on disk"));

const legacy = normalizeChatResponse("I updated index.html and created the environment.");
check("chat: past-tense claim detected", legacy.claims.fileChange, true);

const commandClaim = normalizeChatResponse("I ran `npm run build` and the build passed with exit code 0.");
check("chat: command claim detected", commandClaim.claims.commandRun, true);

// Legitimate code examples survive normalisation.
const example = "Sure — here is how you edit a JavaScript file:\n\n```js\nconst fs = require('fs');\nfs.writeFileSync('a.txt', 'hi');\n```\nThat writes the file when you run it.";
const kept = normalizeChatResponse(example);
checkTrue("chat: code example preserved", kept.text.includes("fs.writeFileSync"));
check("chat: example is not a claim", kept.claims.fileChange, false);
check("chat: nothing stripped from example", kept.strippedProtocol, false);

const plain = normalizeChatResponse("Sure, here is a short explanation of closures in JavaScript.");
check("chat: plain prose untouched", plain.text, "Sure, here is a short explanation of closures in JavaScript.");
check("chat: no claims in prose", plain.claims.fileChange, false);

check("claims: hypothetical sentence is not a claim", detectWorkspaceClaims("If you switch to Main, Latex would change the file for you.").fileChange, false);

console.log(failures === 0 ? "\nALL CHANGE SUMMARY TESTS PASSED" : `\n${failures} CHANGE SUMMARY TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

/** A realistic "rendering project" file used as write evidence. */
function readScriptFixture() {
  return `const CONTROLS = [
  { keys: ["KeyW", "KeyA", "KeyS", "KeyD"], action: "Move the camera" },
  { keys: ["Space"], action: "Pause or resume the simulation" },
  { keys: ["KeyR"], action: "Reset the simulation" }
];
const canvas = document.getElementById("worldCanvas");
const ctx = canvas.getContext("2d");
canvas.addEventListener("wheel", (e) => { camera.zoom += e.deltaY * 0.001; }, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") paused = !paused;
});
function loop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0a4f75";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.arc(50, 50, 10, 0, Math.PI * 2);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
`;
}
