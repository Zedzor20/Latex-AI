import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function id(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Resolve `target` (a relative path from the approved workspace root) to an
 * absolute path and verify it stays inside the root. Resolves symlinks via the
 * real path of the parent directory, so a symlink pointing outside the
 * workspace is rejected. Never creates directories.
 */
export async function safePath(workspaceRoot: string, target: string): Promise<string> {
  const root = await fs.realpath(workspaceRoot);
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
        if (next === current) throw new Error("Path is outside the approved workspace.");
        current = next;
      }
    }
    realParent = path.join(realParent, ...tail);
  }
  const finalPath = path.join(realParent, path.basename(resolved));
  assertContained(root, finalPath);
  return finalPath;
}

/** Like safePath but also creates missing parent directories (for writes). */
export async function realSafePath(workspaceRoot: string, target: string): Promise<string> {
  const root = await fs.realpath(workspaceRoot);
  const resolved = path.resolve(root, target);
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true }).catch(() => undefined);
  const realParent = await fs.realpath(parent);
  const finalPath = path.join(realParent, path.basename(resolved));
  assertContained(root, finalPath);
  return finalPath;
}

/** Resolve an existing path inside the workspace (read/list operations). */
export async function ensureInsideWorkspace(workspaceRoot: string, target: string): Promise<string> {
  const root = await fs.realpath(workspaceRoot);
  const resolved = path.resolve(root, target);
  assertContained(root, resolved);
  return resolved;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the approved workspace.");
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
