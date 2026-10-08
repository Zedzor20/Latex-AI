import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import fg from "fast-glob";
import { createTwoFilesPatch } from "diff";
import type { FileOperationResult, FileTreeNode, FilesystemAccess, PendingChange, WorkspaceInfo } from "../shared/types.js";
import { changeKindOf, describeFileChange, editNote } from "./taskSummary.js";
import { ensureInsideWorkspace, fullAccessPath, id, realSafePath, safePath } from "./security.js";

const TEXT_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".cpp", ".cs", ".html", ".css", ".json", ".xml", ".yaml", ".yml", ".md", ".gradle", ".properties", ".toml", ".rs", ".go", ".php", ".sql", ".txt", ".env", ".gitignore"
]);

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "release", "out", ".cache", "target", ".next", ".vite"]);

function ok(operation: string, filePath?: string): FileOperationResult {
  return { success: true, operation, path: filePath, verified: true };
}

function fail(operation: string, error: string, filePath?: string): FileOperationResult {
  return { success: false, operation, path: filePath, verified: false, error };
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

/**
 * Replace all occurrences of oldText in current, tolerating line-ending
 * mismatches (models often send \\n while Windows files use \\r\\n). Returns
 * the new content and the number of replacements, or undefined when the text
 * is not found in any variant.
 */
function applyEdit(current: string, oldText: string, newText: string): { next: string; count: number } | undefined {
  const variants = [oldText, oldText.replace(/\n/g, "\r\n"), oldText.replace(/\r\n/g, "\n")];
  const seen = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant)) continue;
    seen.add(variant);
    if (!current.includes(variant)) continue;
    let next = "";
    let cursor = 0;
    let count = 0;
    while (cursor < current.length) {
      const index = current.indexOf(variant, cursor);
      if (index === -1) {
        next += current.slice(cursor);
        break;
      }
      next += current.slice(cursor, index) + newText;
      cursor = index + variant.length;
      count++;
    }
    return { next, count };
  }
  return undefined;
}

export class FileTools {
  /** Permission boundary for path resolution. Defaults to workspace-only. */
  private mode: FilesystemAccess = "workspace";

  setMode(mode: FilesystemAccess): void {
    this.mode = mode;
  }

  /** Resolve a tool path against the current permission mode. */
  async resolvePath(workspaceRoot: string | undefined, target: string): Promise<string> {
    if (this.mode === "full") return fullAccessPath(target, workspaceRoot);
    if (!workspaceRoot) throw new Error("This operation requires an approved workspace. Open a folder first.");
    return ensureInsideWorkspace(workspaceRoot, target);
  }

  /** Resolve a path that may not exist yet (writes/mkdir) against the current mode. */
  async resolveWritePath(workspaceRoot: string | undefined, target: string): Promise<string> {
    if (this.mode === "full") return fullAccessPath(target, workspaceRoot);
    if (!workspaceRoot) throw new Error("This operation requires an approved workspace. Open a folder first.");
    return realSafePath(workspaceRoot, target);
  }

  // ---------- reads ----------

  async tree(workspaceRoot: string, depth = 3): Promise<FileTreeNode[]> {
    return this.readDir(workspaceRoot, workspaceRoot, depth);
  }

  async listDirectory(workspaceRoot: string | undefined, relativePath = "."): Promise<FileTreeNode[]> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    return this.readDir(target, target, 1);
  }

  async readFile(workspaceRoot: string | undefined, relativePath: string): Promise<string> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    const ext = path.extname(target).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && path.basename(target) !== "package.json") {
      throw new Error("Latex only reads known text/code files by default.");
    }
    const stat = await fs.stat(target);
    if (stat.size > 512_000) throw new Error("File is too large to read into context.");
    return fs.readFile(target, "utf8");
  }

  async fileExists(workspaceRoot: string | undefined, relativePath: string): Promise<boolean> {
    try {
      const target = await this.resolvePath(workspaceRoot, relativePath);
      return exists(target);
    } catch {
      return false;
    }
  }

  async getFileInfo(workspaceRoot: string | undefined, relativePath: string): Promise<Record<string, unknown>> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    const stat = await fs.stat(target);
    return {
      name: path.basename(target),
      path: relativePath,
      extension: path.extname(target) || null,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      sizeBytes: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString()
    };
  }

  async searchFiles(workspaceRoot: string, query: string): Promise<string[]> {
    const entries = await fg(["**/*"], {
      cwd: workspaceRoot,
      dot: true,
      onlyFiles: true,
      ignore: [ "**/node_modules/**", "**/.git/**", "**/dist/**", "**/release/**", "**/.cache/**", "**/target/**" ]
    });
    const lower = query.toLowerCase();
    return entries.filter((entry) => entry.toLowerCase().includes(lower)).slice(0, 100);
  }

  async searchProject(workspaceRoot: string, query: string): Promise<Array<{ file: string; line: number; text: string }>> {
    const files = await this.searchFiles(workspaceRoot, "");
    const results: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files.slice(0, 500)) {
      const full = await ensureInsideWorkspace(workspaceRoot, file);
      if (!TEXT_EXTENSIONS.has(path.extname(full).toLowerCase())) continue;
      const text = await fs.readFile(full, "utf8").catch(() => "");
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.toLowerCase().includes(query.toLowerCase()) && results.length < 100) {
          results.push({ file, line: index + 1, text: line.trim().slice(0, 240) });
        }
      });
    }
    return results;
  }

  async getWorkspaceInfo(workspaceRoot: string): Promise<WorkspaceInfo> {
    const isGitRepository = await exists(path.join(workspaceRoot, ".git"));
    let branch: string | undefined;
    if (isGitRepository) {
      branch = await new Promise<string | undefined>((resolve) => {
        execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceRoot, windowsHide: true }, (err, stdout) => {
          resolve(err ? undefined : stdout.trim() || undefined);
        });
      });
    }
    let frameworks: string[] = [];
    const pkgPath = path.join(workspaceRoot, "package.json");
    if (await exists(pkgPath)) {
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as Record<string, unknown>;
        const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
        const keys = Object.keys(deps ?? {});
        const detected: string[] = [];
        if (keys.some((k) => k === "react" || k.startsWith("@react"))) detected.push("React");
        if (keys.some((k) => k === "next")) detected.push("Next.js");
        if (keys.some((k) => k === "vue")) detected.push("Vue");
        if (keys.some((k) => k === "svelte")) detected.push("Svelte");
        if (keys.some((k) => k === "typescript")) detected.push("TypeScript");
        if (keys.some((k) => k === "vite")) detected.push("Vite");
        if (keys.some((k) => k === "webpack")) detected.push("Webpack");
        if (keys.some((k) => k === "electron")) detected.push("Electron");
        if (keys.some((k) => k === "jest" || k === "vitest")) detected.push("Testing");
        frameworks = detected;
      } catch {
        // unparseable package.json — ignore
      }
    }
    let fileCount = 0;
    try {
      const entries = await fg(["**/*"], { cwd: workspaceRoot, dot: true, onlyFiles: true, ignore: [ "**/node_modules/**", "**/.git/**", "**/dist/**", "**/release/**" ] });
      fileCount = entries.length;
    } catch {
      // ignore
    }
    return {
      path: workspaceRoot,
      isGitRepository,
      branch,
      frameworks,
      fileCount,
      ignoredDirs: ["node_modules", ".git", "dist", "release", "out", ".cache", "target"]
    };
  }

  // ---------- previews ----------

  async prepareWrite(workspaceRoot: string | undefined, relativePath: string, nextContent: string): Promise<PendingChange> {
    const target = await this.resolveWritePath(workspaceRoot, relativePath);
    const existed = await exists(target);
    const previousContent = existed ? await fs.readFile(target, "utf8") : "";
    const diff = createTwoFilesPatch(relativePath, relativePath, previousContent, nextContent, "", "");
    const kind = changeKindOf(existed, nextContent);
    return {
      id: id("change"), filePath: relativePath, previousContent, nextContent, diff, status: "pending", existed, kind, operations: 1,
      description: describeFileChange(kind, nextContent.split("\n").length, 1)
    };
  }

  /** Change record for a file this turn brought into existence (copy/new file). */
  async prepareCreate(workspaceRoot: string | undefined, relativePath: string, content: string): Promise<PendingChange> {
    const diff = createTwoFilesPatch(relativePath, relativePath, "", content, "", "");
    return {
      id: id("change"), filePath: relativePath, previousContent: "", nextContent: content, diff, status: "pending", existed: false,
      kind: "created", operations: 1, description: describeFileChange("created", content.split("\n").length, 1)
    };
  }

  /**
   * Change record for a deletion: the diff shows the content that went away, so
   * a removed file is visible in the review (and can be restored by undo).
   */
  async prepareDelete(workspaceRoot: string | undefined, relativePath: string): Promise<PendingChange> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    const previousContent = await fs.readFile(target, "utf8").catch(() => "");
    const diff = createTwoFilesPatch(relativePath, relativePath, previousContent, "", "", "");
    const lines = previousContent.split("\n").length;
    return {
      id: id("change"), filePath: relativePath, previousContent, nextContent: "", diff, status: "pending", existed: true,
      kind: "deleted", operations: 1, description: `Deleted during this task (${lines} line${lines === 1 ? "" : "s"} removed)`
    };
  }

  /** Change record for a rename/move — the review shows `from → to`. */
  async prepareRename(workspaceRoot: string | undefined, from: string, to: string): Promise<PendingChange> {
    const source = await this.resolvePath(workspaceRoot, from);
    const content = await fs.readFile(source, "utf8").catch(() => "");
    const diff = createTwoFilesPatch(from, to, content, content, "", "");
    return {
      id: id("change"), filePath: to, renamedFrom: from, previousContent: content, nextContent: content, diff,
      status: "pending", existed: true, kind: "renamed", operations: 1, description: `Renamed \`${from}\` → \`${to}\``
    };
  }

  /** Build a pending change for a targeted oldText → newText edit. */
  async prepareEdit(workspaceRoot: string | undefined, relativePath: string, oldText: string, newText: string): Promise<{ change: PendingChange; matches: number }> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    const current = await fs.readFile(target, "utf8").catch(() => {
      throw new Error(`The file ${relativePath} does not exist.`);
    });
    const edited = applyEdit(current, oldText, newText);
    if (!edited || edited.count === 0) throw new Error(`The requested text was not found in ${relativePath}.`);
    const nextContent = edited.next;
    const diff = createTwoFilesPatch(relativePath, relativePath, current, nextContent, "", "");
    return {
      change: {
        id: id("change"), filePath: relativePath, previousContent: current, nextContent, diff, status: "pending", existed: true,
        kind: nextContent === "" ? "deleted" : "modified",
        operations: 1,
        description: describeFileChange(nextContent === "" ? "deleted" : "modified", nextContent.split("\n").length, 1, editNote(oldText))
      },
      matches: edited.count
    };
  }

  // ---------- mutations (each writes then verifies against disk) ----------

  async applyChange(workspaceRoot: string | undefined, change: PendingChange): Promise<FileOperationResult> {
    const target = await this.resolveWritePath(workspaceRoot, change.filePath);
    const current = await fs.readFile(target, "utf8").catch(() => "");
    if (current === change.nextContent) {
      // Already applied (e.g. duplicate approval or undo path) — nothing to do.
      return ok("write_file", change.filePath);
    }
    if (change.existed !== false && current !== change.previousContent) {
      throw new Error(`The file ${change.filePath} changed outside Latex. Reload it before writing.`);
    }
    // A change that created a file (existed=false) may still legitimately run
    // when it is being reverted (nextContent === "" deletes it) or when the
    // file was created by an earlier tool step in the same run.
    if (change.existed === false && current !== "" && change.nextContent !== "") {
      throw new Error(`The file ${change.filePath} was created outside Latex. Reload it before writing.`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, change.nextContent, "utf8");
    const written = await fs.readFile(target, "utf8").catch(() => null);
    if (written !== change.nextContent) {
      throw new Error(`Failed to verify the write to ${change.filePath}.`);
    }
    return ok("write_file", change.filePath);
  }

  async createFile(workspaceRoot: string | undefined, relativePath: string, content: string): Promise<FileOperationResult> {
    const target = await this.resolveWritePath(workspaceRoot, relativePath);
    if (await exists(target)) return fail("create_file", `The file ${relativePath} already exists.`, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    const written = await fs.readFile(target, "utf8").catch(() => null);
    if (written !== content) throw new Error(`Failed to verify the creation of ${relativePath}.`);
    return ok("create_file", relativePath);
  }

  async editFile(workspaceRoot: string | undefined, relativePath: string, oldText: string, newText: string): Promise<FileOperationResult> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    const current = await fs.readFile(target, "utf8").catch(() => {
      throw new Error(`The file ${relativePath} does not exist.`);
    });
    const edited = applyEdit(current, oldText, newText);
    if (!edited || edited.count === 0) return fail("edit_file", `The requested text was not found in ${relativePath}.`, relativePath);
    const nextContent = edited.next;
    await fs.writeFile(target, nextContent, "utf8");
    const written = await fs.readFile(target, "utf8").catch(() => null);
    if (written === null || !written.includes(newText)) {
      throw new Error(`Failed to verify the edit to ${relativePath}.`);
    }
    return ok("edit_file", relativePath);
  }

  async deleteFile(workspaceRoot: string | undefined, relativePath: string): Promise<FileOperationResult> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return fail("delete_file", `${relativePath} is a directory; use delete_directory.`, relativePath);
    await fs.unlink(target);
    const verified = !(await exists(target));
    if (!verified) throw new Error(`Failed to verify the deletion of ${relativePath}.`);
    return ok("delete_file", relativePath);
  }

  async deleteDirectory(workspaceRoot: string | undefined, relativePath: string): Promise<FileOperationResult> {
    const target = await this.resolvePath(workspaceRoot, relativePath);
    if (relativePath === "." || relativePath === "") return fail("delete_directory", "Refusing to delete the workspace root.");
    const stat = await fs.stat(target);
    if (stat.isFile()) return fail("delete_directory", `${relativePath} is a file; use delete_file.`, relativePath);
    await fs.rm(target, { recursive: true, force: false });
    const verified = !(await exists(target));
    if (!verified) throw new Error(`Failed to verify the deletion of ${relativePath}.`);
    return ok("delete_directory", relativePath);
  }

  async renameFile(workspaceRoot: string | undefined, from: string, to: string): Promise<FileOperationResult> {
    const source = await this.resolvePath(workspaceRoot, from);
    const destination = await this.resolveWritePath(workspaceRoot, to);
    if (!(await exists(source))) return fail("rename_file", `The file ${from} does not exist.`, from);
    if (source === destination) return fail("rename_file", "Source and destination are the same path.", from);
    await fs.rename(source, destination);
    const verified = !(await exists(source)) && (await exists(destination));
    if (!verified) throw new Error(`Failed to verify the rename of ${from}.`);
    return ok("rename_file", to);
  }

  async copyFile(workspaceRoot: string | undefined, from: string, to: string): Promise<FileOperationResult> {
    const source = await this.resolvePath(workspaceRoot, from);
    const destination = await this.resolveWritePath(workspaceRoot, to);
    if (!(await exists(source))) return fail("copy_file", `The file ${from} does not exist.`, from);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    const [a, b] = await Promise.all([fs.readFile(source).catch(() => null), fs.readFile(destination).catch(() => null)]);
    if (a === null || b === null || Buffer.compare(a, b) !== 0) {
      throw new Error(`Failed to verify the copy to ${to}.`);
    }
    return ok("copy_file", to);
  }

  async createDirectory(workspaceRoot: string | undefined, relativePath: string): Promise<FileOperationResult> {
    const target = await this.resolveWritePath(workspaceRoot, relativePath);
    await fs.mkdir(target, { recursive: true });
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error(`Failed to verify the directory ${relativePath}.`);
    return ok("create_directory", relativePath);
  }

  // ---------- tree ----------

  private async readDir(root: string, target: string, depth: number): Promise<FileTreeNode[]> {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const visible = entries.filter((entry) => !IGNORED_DIRS.has(entry.name)).slice(0, 120);
    return Promise.all(visible.map(async (entry) => {
      const full = path.join(target, entry.name);
      const relative = path.relative(root, full) || ".";
      const node: FileTreeNode = { name: entry.name, path: relative, type: entry.isDirectory() ? "directory" : "file" };
      if (entry.isDirectory() && depth > 1) node.children = await this.readDir(root, full, depth - 1);
      return node;
    }));
  }
}
