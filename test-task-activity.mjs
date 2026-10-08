/**
 * Unit test for the structured ACTIVITY layer (phases, live counters and the
 * task plan) plus activity-channel secret redaction.
 *
 * Run with:  node test-task-activity.mjs
 *
 * What it locks down:
 *  - every real operation maps to the phase a user would name it by
 *    (Reading / Creating / Editing / Deleting / Renaming / Running command);
 *  - a build, test runner, typecheck or lint run is classified as TESTING, so
 *    verification is visible as its own phase;
 *  - counters use unique paths and count only COMPLETED operations, so five
 *    writes to one file never become five edits and a failed write is never a
 *    created file;
 *  - the plan shown at task start is derived from the request, states intent
 *    only (never a completed action) and always ends in verification;
 *  - credentials inside a command or its output are masked before either can
 *    reach the UI.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-task-activity");

execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/shared/taskActivity.ts",
    "src/main/security.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

const {
  activityPhase,
  classifyCommandPhase,
  activityCounts,
  activityCountLabel,
  planIntentForRequest
} = await import(`./.tmp-task-activity/shared/taskActivity.js`);
const { redactActivityText } = await import(`./.tmp-task-activity/main/security.js`);

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

/** Minimal activity step factory (only the fields the view reads). */
let seq = 0;
function step(over = {}) {
  seq += 1;
  return { id: `s${seq}`, label: "step", status: "done", timestamp: 1_700_000_000_000, ...over };
}

// ─── Phases ────────────────────────────────────────────────────────────────

check("phase: read_file", activityPhase(step({ kind: "file_read", tool: "read_file", path: "a.ts" })), "Reading");
check("phase: create_file", activityPhase(step({ kind: "file_edit", tool: "create_file", path: "a.ts" })), "Creating");
check("phase: write_file", activityPhase(step({ kind: "file_edit", tool: "write_file", path: "a.ts" })), "Editing");
check("phase: edit_file", activityPhase(step({ kind: "file_edit", tool: "edit_file", path: "a.ts" })), "Editing");
check("phase: delete_file", activityPhase(step({ kind: "file_edit", tool: "delete_file", path: "a.ts" })), "Deleting");
check("phase: rename_file", activityPhase(step({ kind: "file_edit", tool: "rename_file", path: "a.ts" })), "Renaming");
check("phase: search_project", activityPhase(step({ kind: "tool", tool: "search_project" })), "Searching");
check("phase: list_directory", activityPhase(step({ kind: "tool", tool: "list_directory" })), "Inspecting");
check("phase: thinking", activityPhase(step({ kind: "thinking", label: "Thinking" })), "Thinking");
check("phase: planning", activityPhase(step({ kind: "planning", label: "Planning" })), "Planning");
check("phase: verification", activityPhase(step({ kind: "verification", label: "Verifying results" })), "Verifying");
check("phase: unknown has no phase", activityPhase(step({ kind: undefined, tool: undefined })), null);

// ─── Command classification (builds/tests ARE the verification step) ──────

check("command: npm run build is testing", classifyCommandPhase("npm run build"), "Testing");
check("command: npm test is testing", classifyCommandPhase("npm test"), "Testing");
check("command: vitest is testing", classifyCommandPhase("npx vitest run"), "Testing");
check("command: pytest is testing", classifyCommandPhase("python -m pytest tests/"), "Testing");
check("command: tsc is testing", classifyCommandPhase("npx tsc -p tsconfig.main.json --noEmit"), "Testing");
check("command: eslint is testing", classifyCommandPhase("npx eslint src"), "Testing");
check("command: install is a plain command", classifyCommandPhase("npm install lodash"), "Running command");
check("command: dir is a plain command", classifyCommandPhase("dir /b"), "Running command");
check("command: empty is a plain command", classifyCommandPhase(undefined), "Running command");

// ─── Live counters: unique paths, completed operations only ───────────────

const countingSteps = [
  step({ kind: "file_read", tool: "read_file", path: "src/app.ts" }),
  step({ kind: "file_read", tool: "read_file", path: "src/app.ts" }), // same file twice
  step({ kind: "file_edit", tool: "create_file", path: "index.html" }),
  step({ kind: "file_edit", tool: "write_file", path: "src/app.ts" }),
  step({ kind: "file_edit", tool: "edit_file", path: "src/app.ts" }),
  step({ kind: "file_edit", tool: "edit_file", path: "src/app.ts" }),
  step({ kind: "file_edit", tool: "edit_file", path: "src/app.ts" }),
  step({ kind: "file_edit", tool: "edit_file", path: "src/app.ts" }),
  step({ kind: "file_edit", tool: "delete_file", path: "old.js" }),
  step({ kind: "file_edit", tool: "rename_file", path: "a.js" }),
  step({ kind: "command", tool: "run_command", command: "npm run build", exitCode: 0 }),
  step({ kind: "command", tool: "run_command", command: "node script.js", exitCode: 0 }),
  step({ kind: "file_edit", tool: "write_file", path: "broken.ts", status: "failed" }), // failed → not counted
  step({ kind: "file_edit", tool: "write_file", path: "pending.ts", status: "active" }) // active → not counted
];
const counts = activityCounts(countingSteps);
check("counts: created files", counts.created, ["index.html"]);
check("counts: edited files deduplicated", counts.edited, ["src/app.ts"]);
check("counts: deleted files", counts.deleted, ["old.js"]);
check("counts: renamed files", counts.renamed, ["a.js"]);
check("counts: inspected files deduplicated", counts.filesInspected, ["src/app.ts"]);
check("counts: commands run", counts.commands, 2);
check("counts: tests detected", counts.tests, 1);
check("counts: one failed step", counts.failed, 1);
check(
  "counts: compact label",
  activityCountLabel(counts),
  "1 created • 1 edited • 1 deleted • 1 renamed • 1 inspected • 2 commands run • 1 failed"
);
check("counts: empty activity has no label", activityCountLabel(activityCounts([])), "");

// ─── Plan: intent from the request, never a claim ─────────────────────────

const deletePlan = planIntentForRequest("Delete testing.html from the workspace");
checkTrue("plan: delete names the file", deletePlan.includes("testing.html"));
checkTrue("plan: delete states intent only", /^I'll locate/.test(deletePlan));
checkTrue("plan: delete ends in verification", /verify/i.test(deletePlan));

const fixPlan = planIntentForRequest("Fix the terminal resize bug in src/main/terminal.ts");
checkTrue("plan: fix names the file", fixPlan.includes("src/main/terminal.ts"));
checkTrue("plan: fix promises the smallest change", /smallest change/.test(fixPlan));

const createPlan = planIntentForRequest("Add a dark mode toggle to my website");
checkTrue("plan: create/inspect", /inspect the existing structure/.test(createPlan));
checkTrue("plan: create runs checks", /checks to verify/.test(createPlan));

const readPlan = planIntentForRequest("Review index.html and explain the layout");
checkTrue("plan: read-only says nothing will change", /no files will be changed/.test(readPlan));

const genericPlan = planIntentForRequest("do the thing");
checkTrue("plan: generic still plans then verifies", /^I'll inspect/.test(genericPlan) && /verify/i.test(genericPlan));

for (const [label, plan] of [
  ["delete", deletePlan], ["fix", fixPlan], ["create", createPlan], ["read", readPlan], ["generic", genericPlan]
]) {
  checkTrue(`plan: ${label} never claims completed work`,
    /(?:^|\s)(?:I (?:have|already)|done|successfully created|I created|I deleted|I edited)/i.test(plan) === false);
  checkTrue(`plan: ${label} is one concise sentence`, plan.split(". ").length <= 3 && plan.length < 320);
}

// ─── Redaction: credentials never reach the activity UI ───────────────────

check("redact: sk- key in a command",
  redactActivityText("set OPENROUTER_API_KEY=sk-or-v1-abcdef1234567890"),
  "set OPENROUTER_API_KEY=********");
check("redact: quoted key value",
  redactActivityText('curl -d \'{"api_key": "gsk_live_abcdefghijkl"}\''),
  'curl -d \'{"api_key": "********"}\'');
check("redact: auth bearer header",
  redactActivityText("curl -H \"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc\""),
  "curl -H \"Authorization: Bearer ********\"");
check("redact: bare vendor key in output",
  redactActivityText("token is AIzaSyD-1234567890abcdefghij"),
  "token is ********");
check("redact: ordinary command untouched",
  redactActivityText("npm run build --if-present"),
  "npm run build --if-present");
check("redact: undefined stays undefined", redactActivityText(undefined), undefined);

console.log(failures === 0 ? "\nAll activity checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
