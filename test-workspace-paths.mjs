/**
 * WORKSPACE PATH SAFETY test (real FileTools + security resolvers).
 *
 * Run with:  node test-workspace-paths.mjs
 *
 * Why this test exists — the reported task showed:
 *
 *     Inspected `.`
 *     Created folder `.`
 *     Failed: Ran mkdir "C:\Users\user\Documents\My Games\Latex Games"   (twice)
 *     4 operations could not be completed
 *     …and then "Done — nothing needed to change."
 *
 * The rules proven here:
 *   1. `.` (and an empty path) is NEVER a new-folder destination.
 *   2. A relative path resolves against the AUTHORIZED workspace root.
 *   3. An absolute path outside the workspace is refused with an actionable
 *      message — and creates nothing on disk while failing.
 *   4. A Windows path containing spaces works, both relative and absolute, and
 *      the resolved ABSOLUTE destination is reported back.
 *   5. A missing/blank workspace is refused instead of falling back to `.` or
 *      the process working directory.
 *   6. Every result reports its own verification state.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-workspace-paths");
rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/main/security.ts",
    "src/main/fileTools.ts",
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

const fileToolsMod = await import(pathToFileURL(join(outDir, "main", "fileTools.js")).href);
const security = await import(pathToFileURL(join(outDir, "main", "security.js")).href);
const { FileTools } = fileToolsMod;
const { isRootEquivalentTarget, requireWorkspaceRoot } = security;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// A real workspace whose name contains spaces — the reported failing case.
const sandbox = mkdtempSync(join(tmpdir(), "latex-ws-"));
const wsParent = join(sandbox, "My Games");
const workspaceRoot = join(wsParent, "Latex Games");
mkdirSync(workspaceRoot, { recursive: true });

/** Guard used by several checks: nothing new appeared in the sandbox parent. */
const sandboxBefore = null;
let strayDir = "";

const tools = new FileTools();
tools.setMode("workspace");

// ── 1. `.` is never a folder destination ────────────────────────────────
{
  const dot = await tools.createDirectory(workspaceRoot, ".");
  check("folder create: `.` is refused", dot.success === false, JSON.stringify(dot));
  check("folder create: `.` is refused with an actionable reason",
    /folder NAME is required/i.test(String(dot.error ?? "")), String(dot.error ?? ""));
  check("folder create: `.` reports no verification", dot.verified === false);

  const empty = await tools.createDirectory(workspaceRoot, "");
  check("folder create: an empty path is refused", empty.success === false);
  const dotted = await tools.createDirectory(workspaceRoot, ".");
  check("folder create: a repeated `.` stays refused (no retry that 'succeeds')", dotted.success === false);

  const escaped = await tools.createDirectory(workspaceRoot, "..\\escape");
  check("folder create: `..\\escape` cannot climb out of the workspace", escaped.success === false, String(escaped.error ?? ""));
}

// ── 2. A real relative folder resolves inside the workspace ─────────────
{
  const created = await tools.createDirectory(workspaceRoot, "Latex Games Assets");
  check("folder create: a real name succeeds", created.success === true, JSON.stringify(created));
  check("folder create: the ABSOLUTE destination is reported",
    created.resolvedPath === join(workspaceRoot, "Latex Games Assets"), String(created.resolvedPath));
  check("folder create: the folder really exists on disk", existsSync(join(workspaceRoot, "Latex Games Assets")));
  check("folder create: the result is verified", created.verified === true);

  const again = await tools.createDirectory(workspaceRoot, "Latex Games Assets");
  check("folder create: an existing folder is a confirmation, not a new change",
    again.success === true && again.alreadyExisted === true, JSON.stringify(again));
}

// ── 3. An absolute path INSIDE the workspace is usable ──────────────────
{
  const inside = join(workspaceRoot, "absolute target");
  const created = await tools.createDirectory(workspaceRoot, inside);
  check("folder create: an absolute path inside the workspace works", created.success === true, String(created.error ?? ""));
  check("folder create: it targets the intended destination", created.resolvedPath === inside);
  check("folder create: a spaces path is normalized safely", existsSync(inside));
}

// ── 4. An absolute path OUTSIDE the workspace fails without side effects ─
{
  const outside = join(wsParent, "..", "Somewhere Else", "Latex Games");
  strayDir = join(sandbox, "Somewhere Else");

  const created = await tools.createDirectory(workspaceRoot, outside);
  check("folder create: an outside absolute path is refused", created.success === false);
  check("folder create: the refusal explains the boundary",
    /outside the workspace folder/i.test(String(created.error ?? "")), String(created.error ?? ""));
  check("folder create: NOTHING was created outside the workspace", !existsSync(strayDir), strayDir);
  check("folder create: the refused path is reported back for diagnosis",
    typeof created.path === "string" && created.path.length > 0);
}

// ── 5. File writes use the same rules ───────────────────────────────────
{
  const dotFile = await tools.createFile(workspaceRoot, ".", "nope");
  check("file create: `.` is refused", dotFile.success === false, String(dotFile.error ?? ""));

  const outsideFile = join(sandbox, "escape.txt");
  let threw = false;
  let file = null;
  try {
    file = await tools.createFile(workspaceRoot, outsideFile, "nope");
  } catch (err) {
    threw = true;
    check("file create: an outside path explains the boundary",
      /outside the workspace folder/i.test(err instanceof Error ? err.message : String(err)));
  }
  check("file create: an outside path never writes", !existsSync(outsideFile) && (threw || file?.success === false));

  const inside = await tools.createFile(workspaceRoot, "hello world.txt", "hi");
  check("file create: a normal name succeeds", inside.success === true, JSON.stringify(inside));
  check("file create: the absolute path is reported", inside.resolvedPath === join(workspaceRoot, "hello world.txt"));
}

// ── 6. A missing / blank workspace is refused, never guessed ────────────
{
  const noWorkspace = await tools.createFile(undefined, "test.txt", "x").catch((err) => ({ success: false, error: String(err?.message ?? err) }));
  check("no workspace: the file operation fails", noWorkspace.success === false);
  check("no workspace: the user is told to choose a folder",
    /workspace/i.test(String(noWorkspace.error ?? "")), String(noWorkspace.error ?? ""));

  const blank = await tools.listDirectory("", ".").catch((err) => ({ error: String(err?.message ?? err) }));
  check("blank workspace: refused rather than resolved to `.`", !Array.isArray(blank), JSON.stringify(blank).slice(0, 120));

  const dotRoot = await tools.createDirectory(".", "new folder").catch((err) => ({ success: false, error: String(err?.message ?? err) }));
  check("`.` as a workspace root is refused", dotRoot.success === false);
  check("`.` as a workspace root never creates a folder in the cwd", !existsSync(join(process.cwd(), "new folder")));
}

// ── 7. Root-equivalence + workspace validation helpers ──────────────────
{
  check("root-equivalent: `.`", isRootEquivalentTarget(".") === true);
  check("root-equivalent: `./`", isRootEquivalentTarget("./") === true);
  check("root-equivalent: `.\\`", isRootEquivalentTarget(".\\") === true);
  check("root-equivalent: empty", isRootEquivalentTarget("") === true);
  check("root-equivalent: a real name is not", isRootEquivalentTarget("Latex Games") === false);
  check("root-equivalent: a nested name is not", isRootEquivalentTarget("a\\b") === false);
  check("root-equivalent: `.\\a\\..` is not (it names a)", isRootEquivalentTarget(".\\a\\..") === false);

  const real = await requireWorkspaceRoot(workspaceRoot);
  check("workspace validation: a real folder canonicalizes", real.toLowerCase().endsWith("latex games"));

  const missing = await requireWorkspaceRoot(join(sandbox, "nope")).then(() => null, (err) => err);
  check("workspace validation: a missing folder is refused", missing instanceof Error);
  check("workspace validation: the message asks for a real folder",
    /does not exist or cannot be opened/i.test(String(missing?.message ?? "")));

  const relative = await requireWorkspaceRoot("relative\\folder").then(() => null, (err) => err);
  check("workspace validation: a relative root is refused", relative instanceof Error);
}

// ── 8. Listing the root still works (`. ` remains a valid READ path) ────
{
  const entries = await tools.listDirectory(workspaceRoot, ".");
  check("list: `.` is still a valid read of the workspace root", Array.isArray(entries) && entries.length > 0);
}

// ── 9. Delete refuses the root ──────────────────────────────────────────
{
  const del = await tools.deleteDirectory(workspaceRoot, ".");
  check("delete: the workspace root is protected", del.success === false, String(del.error ?? ""));
  check("delete: the workspace root still exists", existsSync(workspaceRoot));
}

void sandboxBefore;
rmSync(sandbox, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} workspace path checks passed`);
console.log("─".repeat(64));
process.exitCode = failed.length === 0 ? 0 : 1;
