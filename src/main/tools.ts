import os from "node:os";
import type { ApprovalMode, FilesystemAccess, LatexSettings, PcControlMode, PendingChange, Workspace } from "../shared/types.js";
import { FileTools } from "./fileTools.js";
import { isDangerousCommand, runCommand } from "./terminal.js";
import { id } from "./security.js";
import {
  describePcTools,
  getCpuInfo,
  getDiskInfo,
  getEnvironmentInfo,
  getMemoryInfo,
  getSystemInfo,
  keyboardPress,
  keyboardType,
  listProcesses,
  mouseClick,
  mouseMove,
  openApplication,
  openFile,
  openFolder,
  openUrl,
  revealInExplorer,
  takeScreenshot
} from "./pcTools.js";

export interface ToolContext {
  workspace?: Workspace;
  settings: LatexSettings;
  fileTools: FileTools;
  /** Filesystem boundary for this run (workspace-only or full PC access). */
  mode: FilesystemAccess;
  /** Record an applied change so the UI can show the changes card. */
  collectChange: (change: PendingChange) => void;
}

export interface ApprovalPolicy {
  needed: boolean;
  destructive: boolean;
  reason: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
  requiresWorkspace: boolean;
  approvalPolicy: (args: Record<string, unknown>, settings: LatexSettings) => ApprovalPolicy;
  preview: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>;
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function stringParam(description: string) {
  return { type: "STRING", description };
}

function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "OBJECT", properties, required };
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.text === "string") return obj.text;
  }
  throw new Error("Tool argument must be a string.");
}

function filesystemApproval(settings: LatexSettings): ApprovalMode {
  return settings.approvalMode;
}

function terminalApproval(settings: LatexSettings): ApprovalMode {
  return settings.terminalApprovalMode;
}

/** Non-destructive file mutations auto-apply in "destructive" (Workspace Only) mode and looser. */
function mutationPolicy(args: Record<string, unknown>, settings: LatexSettings): ApprovalPolicy {
  const mode = filesystemApproval(settings);
  if (mode === "trusted" || mode === "autonomous") return { needed: false, destructive: false, reason: "Workspace changes are allowed by your permission settings." };
  if (mode === "destructive") return { needed: false, destructive: false, reason: "Safe workspace change allowed by your permission settings." };
  return { needed: true, destructive: false, reason: "Ask before modifying workspace files." };
}

function destructivePolicy(args: Record<string, unknown>, settings: LatexSettings): ApprovalPolicy {
  const mode = filesystemApproval(settings);
  if (mode === "autonomous") return { needed: false, destructive: true, reason: "Autonomous mode allows destructive operations." };
  return { needed: true, destructive: true, reason: "This operation permanently removes files or folders." };
}

function commandPolicy(args: Record<string, unknown>, settings: LatexSettings): ApprovalPolicy {
  const command = asString(args.command);
  const dangerous = isDangerousCommand(command);
  const mode = terminalApproval(settings);
  if (mode === "autonomous") return { needed: false, destructive: dangerous, reason: "Autonomous mode runs commands without approval." };
  if (mode === "trusted" && !dangerous) return { needed: false, destructive: false, reason: "Trusted commands run without approval." };
  if (mode === "destructive" && !dangerous) return { needed: false, destructive: false, reason: "Safe command allowed by your terminal settings." };
  return { needed: true, destructive: dangerous, reason: dangerous ? "This command can damage the system or delete data." : "Ask before running commands." };
}

/** PC control (screenshot / mouse / keyboard / open app) approval policy. */
function pcControlPolicy(args: Record<string, unknown>, settings: LatexSettings): ApprovalPolicy {
  const level: PcControlMode = settings.pcControl ?? "ask";
  if (level === "off") return { needed: false, destructive: false, reason: "PC Control is turned off in Settings." };
  if (level === "on") return { needed: false, destructive: false, reason: "PC Control is allowed by your permission settings." };
  return { needed: true, destructive: false, reason: "Ask before controlling the computer." };
}

const readPreview = async (_ctx: ToolContext, args: Record<string, unknown>) => `Read ${asString(args.relativePath)}`;

/** Resolve a PC-control path: absolute paths pass through, relative resolve against the workspace/home. */
async function fullAccessResolve(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const raw = asString(args.path ?? args.url ?? "");
  const { fullAccessPath } = await import("./security.js");
  return fullAccessPath(raw, ctx.workspace?.path);
}

/** Gate a PC-control action behind the user's pcControl permission level. */
function gatePc(ctx: ToolContext, action: () => Promise<unknown>): Promise<unknown> {
  const level: PcControlMode = ctx.settings.pcControl ?? "ask";
  if (level === "off") {
    return Promise.resolve({ success: false, operation: "pc_control", error: "PC Control is turned off in Settings → Permissions. Enable it to allow computer-control actions." });
  }
  return action();
}

function resolvePcPreview(ctx: ToolContext, _args: Record<string, unknown>, fallback: string): Promise<string> {
  const level: PcControlMode = ctx.settings.pcControl ?? "ask";
  if (level === "off") return Promise.resolve(`${fallback}\n\nPC Control is turned off — this action cannot run.`);
  return Promise.resolve(fallback);
}

const registry: ToolDef[] = [
  {
    name: "list_directory",
    description: "List files in a directory (relative to the workspace, or an absolute path in Full PC Access mode).",
    parameters: object({ relativePath: stringParam("Directory path (relative to the workspace, or absolute in Full PC Access).") }),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: readPreview,
    execute: (ctx, args) => ctx.fileTools.listDirectory(ctx.workspace?.path, asString(args.relativePath) || ".")
  },
  {
    name: "read_file",
    description: "Read a text/code file (relative to the workspace, or an absolute path in Full PC Access mode).",
    parameters: object({ relativePath: stringParam("File path (relative to the workspace, or absolute in Full PC Access).") }, ["relativePath"]),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: readPreview,
    execute: (ctx, args) => ctx.fileTools.readFile(ctx.workspace?.path, asString(args.relativePath))
  },
  {
    name: "search_files",
    description: "Find files by filename query inside the workspace (or a directory in Full PC Access mode).",
    parameters: object({ query: stringParam("Filename query."), directory: stringParam("Directory to search (defaults to the workspace).") }),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: (_ctx, args) => Promise.resolve(`Search files: ${asString(args.query)}`),
    execute: (ctx, args) => ctx.fileTools.searchFiles(ctx.workspace?.path ?? (asString(args.directory ?? "") || os.homedir()), asString(args.query))
  },
  {
    name: "search_project",
    description: "Search file contents for text inside the workspace.",
    parameters: object({ query: stringParam("Text query.") }, ["query"]),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: (_ctx, args) => Promise.resolve(`Search project for: ${asString(args.query)}`),
    execute: (ctx, args) => ctx.fileTools.searchProject(ctx.workspace?.path ?? "", asString(args.query))
  },
  {
    name: "file_exists",
    description: "Check whether a file exists in the workspace.",
    parameters: object({ relativePath: stringParam("File path relative to the workspace.") }, ["relativePath"]),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: readPreview,
    execute: (ctx, args) => ctx.fileTools.fileExists(ctx.workspace?.path, asString(args.relativePath))
  },
  {
    name: "get_file_info",
    description: "Get size, dates, and type information for a file or directory.",
    parameters: object({ relativePath: stringParam("Path relative to the workspace.") }, ["relativePath"]),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: readPreview,
    execute: (ctx, args) => ctx.fileTools.getFileInfo(ctx.workspace?.path, asString(args.relativePath))
  },
  {
    name: "create_file",
    description: "Create a new file with the given content. Fails if the file already exists.",
    parameters: object({ relativePath: stringParam("File path relative to the workspace."), content: stringParam("Complete file content.") }, ["relativePath", "content"]),
    requiresWorkspace: true,
    approvalPolicy: mutationPolicy,
    preview: async (ctx, args) => {
      const rel = asString(args.relativePath);
      const content = asString(args.content);
      return `Creating new file: ${rel}\n\n${content.slice(0, 2000)}`;
    },
    execute: (ctx, args) => ctx.fileTools.createFile(ctx.workspace?.path, asString(args.relativePath), asString(args.content))
  },
  {
    name: "write_file",
    description: "Overwrite a file with new content (the previous content is replaced entirely).",
    parameters: object({ relativePath: stringParam("File path relative to the workspace."), content: stringParam("New complete file content.") }, ["relativePath", "content"]),
    requiresWorkspace: true,
    approvalPolicy: mutationPolicy,
    preview: async (ctx, args) => {
      const rel = asString(args.relativePath);
      const change = await ctx.fileTools.prepareWrite(ctx.workspace?.path, rel, asString(args.content));
      return change.diff;
    },
    execute: async (ctx, args) => {
      const rel = asString(args.relativePath);
      const change = await ctx.fileTools.prepareWrite(ctx.workspace?.path, rel, asString(args.content));
      ctx.collectChange(change);
      return ctx.fileTools.applyChange(ctx.workspace?.path, change);
    }
  },
  {
    name: "edit_file",
    description: "Replace a specific text occurrence in a file. Prefer this over write_file for small targeted changes.",
    parameters: object({ relativePath: stringParam("File path relative to the workspace."), oldText: stringParam("Exact text to replace."), newText: stringParam("Replacement text.") }, ["relativePath", "oldText", "newText"]),
    requiresWorkspace: true,
    approvalPolicy: mutationPolicy,
    preview: async (ctx, args) => {
      const { change } = await ctx.fileTools.prepareEdit(ctx.workspace?.path, asString(args.relativePath), asString(args.oldText), asString(args.newText));
      return change.diff;
    },
    execute: async (ctx, args) => {
      const { change } = await ctx.fileTools.prepareEdit(ctx.workspace?.path, asString(args.relativePath), asString(args.oldText), asString(args.newText));
      ctx.collectChange(change);
      return ctx.fileTools.applyChange(ctx.workspace?.path, change);
    }
  },
  {
    name: "copy_file",
    description: "Copy a file to a new location inside the workspace.",
    parameters: object({ from: stringParam("Source path relative to the workspace."), to: stringParam("Destination path relative to the workspace.") }, ["from", "to"]),
    requiresWorkspace: true,
    approvalPolicy: mutationPolicy,
    preview: (ctx, args) => Promise.resolve(`Copy ${asString(args.from)} → ${asString(args.to)}`),
    execute: (ctx, args) => ctx.fileTools.copyFile(ctx.workspace?.path, asString(args.from), asString(args.to))
  },
  {
    name: "rename_file",
    description: "Rename or move a file to a new path inside the workspace.",
    parameters: object({ from: stringParam("Current path relative to the workspace."), to: stringParam("New path relative to the workspace.") }, ["from", "to"]),
    requiresWorkspace: true,
    approvalPolicy: mutationPolicy,
    preview: (ctx, args) => Promise.resolve(`Rename ${asString(args.from)} → ${asString(args.to)}`),
    execute: (ctx, args) => ctx.fileTools.renameFile(ctx.workspace?.path, asString(args.from), asString(args.to))
  },
  {
    name: "create_directory",
    description: "Create a directory (and any missing parents) inside the workspace.",
    parameters: object({ relativePath: stringParam("Directory path relative to the workspace.") }, ["relativePath"]),
    requiresWorkspace: true,
    approvalPolicy: mutationPolicy,
    preview: (ctx, args) => Promise.resolve(`Create directory: ${asString(args.relativePath)}`),
    execute: (ctx, args) => ctx.fileTools.createDirectory(ctx.workspace?.path, asString(args.relativePath))
  },
  {
    name: "delete_file",
    description: "Permanently delete a file from the workspace.",
    parameters: object({ relativePath: stringParam("File path relative to the workspace.") }, ["relativePath"]),
    requiresWorkspace: true,
    approvalPolicy: destructivePolicy,
    preview: (ctx, args) => Promise.resolve(`Delete file: ${asString(args.relativePath)}`),
    execute: (ctx, args) => ctx.fileTools.deleteFile(ctx.workspace?.path, asString(args.relativePath))
  },
  {
    name: "delete_directory",
    description: "Permanently delete a directory and all of its contents from the workspace.",
    parameters: object({ relativePath: stringParam("Directory path relative to the workspace.") }, ["relativePath"]),
    requiresWorkspace: true,
    approvalPolicy: destructivePolicy,
    preview: (ctx, args) => Promise.resolve(`Delete directory: ${asString(args.relativePath)}\n\nThis will remove the folder and everything inside it.`),
    execute: (ctx, args) => ctx.fileTools.deleteDirectory(ctx.workspace?.path, asString(args.relativePath))
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace (or the user's home directory in Full PC Access mode).",
    parameters: object({ command: stringParam("Command to run.") }, ["command"]),
    requiresWorkspace: true,
    approvalPolicy: commandPolicy,
    preview: (ctx, args) => Promise.resolve(`Run command:\n\n${asString(args.command)}`),
    execute: (ctx, args) => runCommand(ctx.workspace?.path ?? "", asString(args.command), ctx.settings.shell ?? "powershell")
  },
  {
    name: "get_workspace_info",
    description: "Get metadata about the active workspace: git repository, branch, detected frameworks, and file count.",
    parameters: object({}),
    requiresWorkspace: true,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("Workspace metadata"),
    execute: (ctx) => ctx.fileTools.getWorkspaceInfo(ctx.workspace?.path ?? os.homedir())
  },
  {
    name: "get_platform_info",
    description: "Get operating system and runtime information.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("Platform info"),
    execute: async () => ({ platform: process.platform, arch: process.arch, versions: process.versions })
  },

  // ---- PC control tools (open, reveal, system info, processes, input) ----

  {
    name: "open_file",
    description: "Open a file with its default Windows application.",
    parameters: object({ path: stringParam("Absolute path of the file to open.") }, ["path"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Open file: ${asString(args.path)}`),
    execute: (ctx, args) => gatePc(ctx, () => fullAccessResolve(args, ctx).then((resolved) => openFile(resolved)))
  },
  {
    name: "open_folder",
    description: "Open a folder in Windows Explorer.",
    parameters: object({ path: stringParam("Absolute path of the folder to open.") }, ["path"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Open folder: ${asString(args.path)}`),
    execute: (ctx, args) => gatePc(ctx, () => fullAccessResolve(args, ctx).then((resolved) => openFolder(resolved)))
  },
  {
    name: "reveal_in_explorer",
    description: "Open Windows Explorer with the given file or folder selected.",
    parameters: object({ path: stringParam("Absolute path to reveal.") }, ["path"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Reveal in Explorer: ${asString(args.path)}`),
    execute: (ctx, args) => gatePc(ctx, () => fullAccessResolve(args, ctx).then((resolved) => revealInExplorer(resolved)))
  },
  {
    name: "open_application",
    description: "Launch a known Windows application (notepad, calculator, paint, explorer, chrome, edge, vscode, terminal, cmd).",
    parameters: object({ name: stringParam("Friendly app name.") }, ["name"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Open application: ${asString(args.name)}`),
    execute: (ctx, args) => gatePc(ctx, () => openApplication(asString(args.name)))
  },
  {
    name: "open_url",
    description: "Open a web URL in the user's default browser.",
    parameters: object({ url: stringParam("http(s) URL to open.") }, ["url"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Open URL: ${asString(args.url)}`),
    execute: (ctx, args) => gatePc(ctx, () => openUrl(asString(args.url)))
  },
  {
    name: "get_system_info",
    description: "Get OS, hostname, architecture, uptime, and version information.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("System info"),
    execute: getSystemInfo
  },
  {
    name: "get_cpu_info",
    description: "Get CPU model, cores, and speed.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("CPU info"),
    execute: getCpuInfo
  },
  {
    name: "get_memory_info",
    description: "Get total and free memory in bytes.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("Memory info"),
    execute: getMemoryInfo
  },
  {
    name: "get_disk_info",
    description: "List drives and their total/free space.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("Disk info"),
    execute: getDiskInfo
  },
  {
    name: "get_environment_info",
    description: "Get environment variables (excluding secrets).",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("Environment info"),
    execute: getEnvironmentInfo
  },
  {
    name: "list_processes",
    description: "List running processes with PID, name, and memory usage.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: () => ({ needed: false, destructive: false, reason: "" }),
    preview: () => Promise.resolve("List processes"),
    execute: listProcesses
  },
  {
    name: "take_screenshot",
    description: "Capture the current screen and return the PNG image path plus a small base64 preview.",
    parameters: object({}),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, "Take a screenshot"),
    execute: (ctx) => gatePc(ctx, takeScreenshot)
  },
  {
    name: "mouse_move",
    description: "Move the mouse cursor to screen coordinates.",
    parameters: object({ x: stringParam("X coordinate."), y: stringParam("Y coordinate.") }, ["x", "y"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Move mouse to (${asString(args.x)}, ${asString(args.y)})`),
    execute: (ctx, args) => gatePc(ctx, () => mouseMove(Number(asString(args.x)), Number(asString(args.y))))
  },
  {
    name: "mouse_click",
    description: "Click the mouse at its current position (left or right button).",
    parameters: object({ button: stringParam("left or right (default left).") }),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Mouse click (${asString(args.button ?? "left")})`),
    execute: (ctx, args) => gatePc(ctx, () => mouseClick((asString(args.button ?? "left") === "right" ? "right" : "left")))
  },
  {
    name: "keyboard_type",
    description: "Type text into the currently focused window.",
    parameters: object({ text: stringParam("Text to type.") }, ["text"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Type text (${String(asString(args.text)).length} chars)`),
    execute: (ctx, args) => gatePc(ctx, () => keyboardType(asString(args.text)))
  },
  {
    name: "keyboard_press",
    description: "Press named keys (Enter, Tab, Escape, Backspace, F5, Ctrl+S, etc.) in the focused window.",
    parameters: object({ keys: stringParam("Comma-separated key names.") }, ["keys"]),
    requiresWorkspace: false,
    approvalPolicy: pcControlPolicy,
    preview: (ctx, args) => resolvePcPreview(ctx, args, `Press keys: ${asString(args.keys)}`),
    execute: (ctx, args) => gatePc(ctx, () => keyboardPress(asString(args.keys)))
  }
];

const registryMap = new Map(registry.map((tool) => [tool.name, tool]));

/** The Gemini function declaration block (only tools that can run in this context). */
export function toolDeclarations(workspaceAvailable: boolean, mode: FilesystemAccess = "workspace") {
  return [{
    functionDeclarations: registry
      .filter((tool) => !tool.requiresWorkspace || workspaceAvailable || mode === "full")
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
  }];
}

export function getTool(name: string): ToolDef | undefined {
  return registryMap.get(name);
}

/**
 * Compact text catalog of every registered tool (name, required args, purpose).
 * Injected into the system prompt so models without native function calling
 * can still request the same Latex tools via the structured tool protocol.
 */
export function toolCatalogText(): string {
  return registry
    .map((tool) => {
      const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> } | undefined;
      const required = params?.required ?? Object.keys(params?.properties ?? {});
      const args = required.length > 0 ? required.join(", ") : "";
      return `- ${tool.name}${args ? `(${args})` : ""} — ${tool.description}`;
    })
    .join("\n");
}

export function buildApprovalRequest(
  tool: ToolDef,
  args: Record<string, unknown>,
  policy: ApprovalPolicy,
  preview: string
) {
  const rel =
    (typeof args.relativePath === "string" && args.relativePath) ||
    (typeof args.to === "string" && args.to) ||
    (typeof args.from === "string" && args.from) ||
    undefined;
  return {
    requestId: id("aprv"),
    operation: tool.name,
    title: approvalTitle(tool.name, rel),
    description: policy.reason,
    path: rel,
    preview,
    reason: policy.reason,
    destructive: policy.destructive
  };
}

function approvalTitle(operation: string, rel?: string): string {
  const names: Record<string, string> = {
    create_file: "Create file",
    write_file: "Write file",
    edit_file: "Edit file",
    copy_file: "Copy file",
    rename_file: "Rename file",
    create_directory: "Create folder",
    delete_file: "Delete file",
    delete_directory: "Delete folder",
    run_command: "Run command"
  };
  const base = names[operation] ?? operation.replace(/_/g, " ");
  return rel ? `${base}: ${rel}` : base;
}
