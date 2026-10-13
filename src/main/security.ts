import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function id(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Is this tool path a request to act on the workspace ROOT itself?
 *
 * `.`, `./`, `.\`, `..`, an empty string and a bare drive/root separator all
 * mean "the workspace folder, whatever it is" — which must NEVER be turned into
 * a new-folder destination. The reported bug ("Created folder `.`") came from
 * exactly this string reaching `mkdir`.
 */
export function isRootEquivalentTarget(target: string | undefined): boolean {
  const cleaned = (target ?? "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) return true;
  if (cleaned === "." || cleaned === "..") return true;
  // ".", ".\\", "./.", ".\\a\\..", … — a path with no real name component.
  const named = cleaned.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
  return named.length === 0;
}

/**
 * Validate and canonicalize the approved workspace root.
 *
 * A missing, blank, relative-only or inaccessible root must fail LOUDLY and
 * early: falling back to `process.cwd()` (or to `.`) is how operations ended up
 * running against an unintended directory. The caller asks the user to choose a
 * folder instead.
 */
export async function requireWorkspaceRoot(workspaceRoot: string | undefined): Promise<string> {
  const raw = (workspaceRoot ?? "").trim();
  if (!raw || isRootEquivalentTarget(raw) || !path.isAbsolute(raw)) {
    throw new Error(
      "No workspace folder is selected. Open the folder you want Latex to work in (Workspace → Open Folder) and try again — Latex never guesses a location."
    );
  }
  let root: string;
  try {
    root = await fs.realpath(raw);
  } catch {
    throw new Error(
      `The workspace folder "${raw}" does not exist or cannot be opened. Choose an existing folder before running filesystem operations.`
    );
  }
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`"${raw}" is not a folder. Choose a folder as the workspace first.`);
  }
  return root;
}

/**
 * Resolve `target` (a relative path from the approved workspace root) to an
 * absolute path and verify it stays inside the root. Resolves symlinks via the
 * real path of the parent directory, so a symlink pointing outside the
 * workspace is rejected. Never creates directories.
 */
export async function safePath(workspaceRoot: string, target: string): Promise<string> {
  const root = await requireWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, target);
  const parent = path.dirname(resolved);
  let realParent = parent;
  try {
    realParent = await fs.realpath(parent);
  } catch {
    // The parent does not exist yet (e.g. creating a new nested file).
    // Resolve each existing ancestor to its real path to avoid symlink escapes.
    let current = parent;
    const tail: string[] = [];
    for (;;) {
      try {
        realParent = await fs.realpath(current);
        break;
      } catch {
        tail.unshift(path.basename(current));
        const next = path.dirname(current);
        if (next === current) throw outsideWorkspaceError(target, workspaceRoot);
        current = next;
      }
    }
    realParent = path.join(realParent, ...tail);
  }
  const finalPath = path.join(realParent, path.basename(resolved));
  assertContained(root, finalPath, target, workspaceRoot);
  return finalPath;
}

/**
 * Like safePath but also creates missing parent directories (for writes).
 *
 * CONTAINMENT IS CHECKED FIRST. The previous order created the parent folder
 * and only then rejected the path, so a rejected out-of-workspace write still
 * left directories behind on disk — a real, user-visible side effect of a
 * failure.
 */
export async function realSafePath(workspaceRoot: string, target: string): Promise<string> {
  const root = await requireWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, target);
  assertContained(root, resolved, target, workspaceRoot);
  const parent = path.dirname(resolved);
  assertContained(root, parent, target, workspaceRoot);
  await fs.mkdir(parent, { recursive: true }).catch(() => undefined);
  const realParent = await fs.realpath(parent);
  const finalPath = path.join(realParent, path.basename(resolved));
  assertContained(root, finalPath, target, workspaceRoot);
  return finalPath;
}

/** Resolve an existing path inside the workspace (read/list operations). */
export async function ensureInsideWorkspace(workspaceRoot: string, target: string): Promise<string> {
  const root = await requireWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, target);
  assertContained(root, resolved, target, workspaceRoot);
  return resolved;
}

/**
 * Resolve the destination for a NEW folder (create_directory).
 *
 * Separated from the generic write path because a folder creation has one extra
 * failure mode that a file write does not: the "path" may really mean the
 * workspace root itself (`.`), which must never become `mkdir`.
 */
export async function resolveNewFolderPath(workspaceRoot: string | undefined, target: string): Promise<string> {
  if (isRootEquivalentTarget(target)) {
    throw new Error(
      `A folder NAME is required (received "${(target ?? "").trim() || "."}"). "${(workspaceRoot ?? "").trim() || "the workspace"}" is the workspace root itself — nothing was created.`
    );
  }
  const root = await requireWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, target);
  assertContained(root, resolved, target, workspaceRoot);
  return resolved;
}

function outsideWorkspaceError(target: string, workspaceRoot: string): Error {
  return new Error(
    `"${target}" is outside the workspace folder "${workspaceRoot}". Latex only works inside the selected workspace — choose that folder as the workspace, or enable Full PC Access in Settings → Permissions.`
  );
}

function assertContained(root: string, candidate: string, target?: string, workspaceRoot?: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw outsideWorkspaceError(target ?? candidate, workspaceRoot ?? root);
  }
}

/**
 * Resolve a path in Full PC Access mode. Absolute Windows paths are allowed
 * (subject to the current Windows user's own permissions — nothing is
 * bypassed). Relative paths resolve against the active workspace when one is
 * set, otherwise the user's home directory. Guards against UNC escapes and
 * empty targets; Windows ACLs are enforced by the OS itself.
 */
export async function fullAccessPath(target: string, workspaceRoot?: string): Promise<string> {
  if (!target || typeof target !== "string" || !target.trim()) {
    throw new Error("A file path is required.");
  }
  if (/^(\\\\|\/\/)/.test(target)) {
    throw new Error("UNC paths are not allowed.");
  }
  if (path.isAbsolute(target)) {
    return path.normalize(target);
  }
  const base = workspaceRoot && workspaceRoot.trim() ? workspaceRoot : os.homedir();
  return path.resolve(base, target);
}

export function redactSecret(value: string): string {
  if (value.length < 10) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Redact credentials from text that is about to be shown in the ACTIVITY UI
 * (a command about to run, or captured stdout/stderr).
 *
 * Commands and their output are user-visible, and a shell line such as
 * `set OPENROUTER_API_KEY=sk-live-…` or `curl -H "Authorization: Bearer …"`
 * must never put a real secret on screen. Only the secret VALUE is masked:
 * the surrounding command stays readable so the activity remains truthful.
 */
export function redactActivityText(text: string | undefined): string | undefined {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  // Key/name = value (set, export, --env, JSON, .env lines, …)
  out = out.replace(
    /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|auth[_-]?token|bearer)\s*[:=]\s*)(["'`]?)([^\s"'`,;]+)\2/gi,
    (_match, prefix: string, quote: string) => `${prefix}${quote}********${quote}`
  );
  // Authorization: Bearer <token>
  out = out.replace(/(authorization\s*:\s*bearer\s+)([^\s"']+)/gi, (_m, prefix: string) => `${prefix}********`);
  // Vendor key shapes: sk-…, sk_live_…, gsk_…, xai-…, AIza…
  out = out.replace(/\b(sk-[\w-]{8,}|sk_live_[\w]{8,}|gsk_[\w]{8,}|xai-[\w-]{8,}|AIza[\w-]{20,})\b/g, "********");
  return out;
}
