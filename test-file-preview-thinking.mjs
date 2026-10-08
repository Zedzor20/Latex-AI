/**
 * Headless acceptance test for two behaviours added to the coding-agent UX.
 *
 * Run with:  node test-file-preview-thinking.mjs
 *
 * It compiles the REAL shared modules (no reimplementation) and checks:
 *
 *  1. THINKING DEFAULT — a supported model is ON by default, an unsupported
 *     model never requests reasoning, an explicit user OFF wins, and a
 *     preference can never leak onto a different (or unsupported) model.
 *
 *  2. FILE OPERATION PREVIEW — streamed start/complete/failed events fold into
 *     ONE aggregated, collapsible entry per file, the preview buffer is only
 *     what the event carried, a stop is never marked "committed", and only the
 *     most recent in-progress file is the active (expanded) one.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-file-preview");

execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/shared/fileOperations.ts",
    "src/shared/modelCapabilities.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

// tsc's common root here is src/shared, so files land directly in outDir.
const { resolveThinkingEnabled } = await import(new URL(`file://${join(outDir, "modelCapabilities.js")}`).href);
const { applyFileOperationEvent, activeFileOperationPath } = await import(new URL(`file://${join(outDir, "fileOperations.js")}`).href);

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

console.log("\n[1] Thinking is ON by default for models that genuinely support it");
check("gemini 2.5 pro → thinking ON by default", resolveThinkingEnabled(undefined, "gemini", "gemini-2.5-pro") === true);
check("miniMax M2 → thinking ON by default", resolveThinkingEnabled(undefined, "minimax", "MiniMax-M2") === true);
check("deepseek-r1 via omniroute → ON", resolveThinkingEnabled(undefined, "omniroute", "deepseek/deepseek-r1") === true);

console.log("\n[2] Unsupported models never request thinking");
check("gemini 1.5 pro → OFF", resolveThinkingEnabled(undefined, "gemini", "gemini-1.5-pro") === false);
check("gemini imagen → OFF", resolveThinkingEnabled(undefined, "gemini", "gemini-2.5-flash-image") === false);
check("unknown provider → OFF", resolveThinkingEnabled(undefined, undefined, "whatever") === false);

console.log("\n[3] Explicit user preference is preserved (per model)");
const off = { "gemini:gemini-2.5-pro": false };
check("explicit OFF wins over the default", resolveThinkingEnabled(off, "gemini", "gemini-2.5-pro") === false);
const on = { "gemini:gemini-2.5-pro": true };
check("explicit ON respected for a capable model", resolveThinkingEnabled(on, "gemini", "gemini-2.5-pro") === true);

console.log("\n[4] A preference never carries onto another or unsupported model");
check("preference for model A leaves model B at its default", resolveThinkingEnabled(off, "gemini", "gemini-2.5-flash") === true);
check("an explicit ON cannot force an unsupported model", resolveThinkingEnabled({ "gemini:gemini-1.5-pro": true }, "gemini", "gemini-1.5-pro") === false);
check("explicit OFF on a capable model never spills to the next model", resolveThinkingEnabled(off, "minimax", "MiniMax-M2") === true);

console.log("\n[5] File-operation events aggregate per file");
let files = [];
files = applyFileOperationEvent(files, { phase: "start", operation: "create", filePath: "src/Button.tsx", preview: "export function Button() {}", at: 1 });
check("start creates ONE writing entry", files.length === 1 && files[0].status === "writing");
check("preview buffer is the real content", files[0].preview === "export function Button() {}");
files = applyFileOperationEvent(files, { phase: "start", operation: "edit", filePath: "src/Button.tsx", preview: "export function Button() { return null; }", at: 2 });
check("repeated write to the same file stays ONE entry", files.length === 1);
check("operations count aggregates", files[0].operations === 2);
check("preview updates in place", files[0].preview.includes("return null"));
files = applyFileOperationEvent(files, { phase: "complete", operation: "edit", filePath: "src/Button.tsx", verified: true, at: 3 });
check("complete marks it committed + verified", files[0].status === "committed" && files[0].verified === true);

console.log("\n[6] Multiple files, only the active one is in-progress");
files = applyFileOperationEvent(files, { phase: "start", operation: "write", filePath: "src/App.tsx", at: 4 });
check("a second file gets its own entry", files.length === 2);
check("active path is the in-progress file", activeFileOperationPath(files) === "src/App.tsx");
files = applyFileOperationEvent(files, { phase: "complete", operation: "write", filePath: "src/App.tsx", verified: true, at: 5 });
check("no in-progress file once committed", activeFileOperationPath(files) === null);

console.log("\n[7] A stopped operation is never committed");
files = applyFileOperationEvent(files, { phase: "start", operation: "edit", filePath: "src/Other.ts", preview: "const a = 1;", at: 6 });
files = applyFileOperationEvent(files, { phase: "failed", operation: "edit", filePath: "src/Other.ts", error: "Stopped by the user.", at: 7 });
const other = files.find((f) => f.filePath === "src/Other.ts");
check("stop → status stopped (not committed)", other.status === "stopped");
check("preview received before the stop is kept", other.preview === "const a = 1;");

console.log("\n[8] Preview buffer is never fabricated");
files = applyFileOperationEvent(files, { phase: "start", operation: "write", filePath: "src/NoStream.ts", at: 8 });
const ns = files.find((f) => f.filePath === "src/NoStream.ts");
check("no content streamed → preview stays undefined (waiting state)", ns.preview === undefined);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
