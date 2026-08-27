import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/** Electron APIs are imported lazily so pure-Node tests (no Electron runtime) can load this module. */
async function electronShell(): Promise<{ openPath: (p: string) => Promise<string>; openExternal: (u: string) => Promise<void>; showItemInFolder: (p: string) => void }> {
  const { shell } = await import("electron");
  return shell;
}

async function electronDesktopCapturer(): Promise<{ getSources: (opts: { types: Array<"screen" | "window">; thumbnailSize: { width: number; height: number } }) => Promise<Array<{ thumbnail: { isEmpty: () => boolean; toPNG: () => Buffer; resize: (o: { width: number }) => { toJPEG: (q: number) => Buffer }; getSize: () => { width: number; height: number } } }>> }> {
  const { desktopCapturer } = await import("electron");
  return desktopCapturer;
}

const execFileP = promisify(execFile);

/** Launch a GUI app by friendly name via a small allowlist (never arbitrary strings). */
const KNOWN_APPS: Record<string, Array<{ path: string; args?: string[] }>> = {
  notepad: [{ path: "C:\\Windows\\System32\\notepad.exe" }],
  calculator: [{ path: "C:\\Windows\\System32\\calc.exe" }],
  calc: [{ path: "C:\\Windows\\System32\\calc.exe" }],
  paint: [{ path: "C:\\Windows\\System32\\mspaint.exe" }],
  mspaint: [{ path: "C:\\Windows\\System32\\mspaint.exe" }],
  explorer: [{ path: "C:\\Windows\\explorer.exe" }],
  "file explorer": [{ path: "C:\\Windows\\explorer.exe" }],
  chrome: [
    { path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
    { path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" }
  ],
  edge: [
    { path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
    { path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" }
  ],
  vscode: [
    { path: "C:\\Users\\user\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" },
    { path: "C:\\Program Files\\Microsoft VS Code\\Code.exe" },
    { path: `${os.homedir()}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe` }
  ],
  "vs code": [
    { path: "C:\\Users\\user\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" },
    { path: "C:\\Program Files\\Microsoft VS Code\\Code.exe" }
  ],
  terminal: [{ path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }],
  powershell: [{ path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }],
  "command prompt": [{ path: "C:\\Windows\\System32\\cmd.exe" }],
  cmd: [{ path: "C:\\Windows\\System32\\cmd.exe" }]
};

function findApp(name: string): { path: string; args: string[] } | null {
  const key = name.trim().toLowerCase();
  const candidates = KNOWN_APPS[key];
  if (!candidates) return null;
  const found = candidates.find((candidate) => fs.existsSync(candidate.path));
  void fsp;
  if (!found) return null;
  return { path: found.path, args: found.args ?? [] };
}

export function describePcTools(): Array<{ name: string; description: string; parameters: unknown; requiresWorkspace: boolean }> {
  return [
    {
      name: "open_file",
      description: "Open a file with its default Windows application.",
      parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "Absolute path of the file to open." } }, required: ["path"] },
      requiresWorkspace: false
    },
    {
      name: "open_folder",
      description: "Open a folder in Windows Explorer.",
      parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "Absolute path of the folder to open." } }, required: ["path"] },
      requiresWorkspace: false
    },
    {
      name: "reveal_in_explorer",
      description: "Open Windows Explorer with the given file or folder selected.",
      parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "Absolute path to reveal." } }, required: ["path"] },
      requiresWorkspace: false
    },
    {
      name: "open_application",
      description: "Launch a known Windows application (notepad, calculator, paint, explorer, chrome, edge, vscode, terminal, cmd).",
      parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: "Friendly app name, e.g. notepad, calculator, chrome." } }, required: ["name"] },
      requiresWorkspace: false
    },
    {
      name: "open_url",
      description: "Open a web URL in the user's default browser.",
      parameters: { type: "OBJECT", properties: { url: { type: "STRING", description: "http(s) URL to open." } }, required: ["url"] },
      requiresWorkspace: false
    },
    {
      name: "get_system_info",
      description: "Get OS, hostname, architecture, uptime, and version information.",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "get_cpu_info",
      description: "Get CPU model, cores, and speed.",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "get_memory_info",
      description: "Get total and free memory in bytes.",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "get_disk_info",
      description: "List drives and their total/free space.",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "get_environment_info",
      description: "Get environment variables (excluding secrets).",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "list_processes",
      description: "List running processes with PID, name, and memory usage.",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "take_screenshot",
      description: "Capture the current screen and return the PNG image path plus a small base64 preview.",
      parameters: { type: "OBJECT", properties: {} },
      requiresWorkspace: false
    },
    {
      name: "mouse_move",
      description: "Move the mouse cursor to screen coordinates.",
      parameters: { type: "OBJECT", properties: { x: { type: "INTEGER", description: "X coordinate." }, y: { type: "INTEGER", description: "Y coordinate." } }, required: ["x", "y"] },
      requiresWorkspace: false
    },
    {
      name: "mouse_click",
      description: "Click the mouse at its current position (left button).",
      parameters: { type: "OBJECT", properties: { button: { type: "STRING", description: "left or right" } } },
      requiresWorkspace: false
    },
    {
      name: "keyboard_type",
      description: "Type text into the currently focused window.",
      parameters: { type: "OBJECT", properties: { text: { type: "STRING", description: "Text to type." } }, required: ["text"] },
      requiresWorkspace: false
    },
    {
      name: "keyboard_press",
      description: "Press named keys (Enter, Tab, Escape, Backspace, F5, Ctrl+S, etc.) in the focused window.",
      parameters: { type: "OBJECT", properties: { keys: { type: "STRING", description: "Comma-separated key names." } }, required: ["keys"] },
      requiresWorkspace: false
    }
  ];
}

export interface PcToolResult {
  success: boolean;
  operation: string;
  data?: unknown;
  error?: string;
}

export async function openFile(filePath: string): Promise<PcToolResult> {
  try {
    const shell = await electronShell();
    const err = await shell.openPath(filePath);
    return err ? { success: false, operation: "open_file", error: err } : { success: true, operation: "open_file", data: { path: filePath } };
  } catch (err) {
    return { success: false, operation: "open_file", error: err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to open file" };
  }
}

export async function openFolder(folderPath: string): Promise<PcToolResult> {
  try {
    const shell = await electronShell();
    const err = await shell.openPath(folderPath);
    return err ? { success: false, operation: "open_folder", error: err } : { success: true, operation: "open_folder", data: { path: folderPath } };
  } catch (err) {
    return { success: false, operation: "open_folder", error: err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to open folder" };
  }
}

export async function revealInExplorer(filePath: string): Promise<PcToolResult> {
  const shell = await electronShell();
  shell.showItemInFolder(filePath);
  return { success: true, operation: "reveal_in_explorer", data: { path: filePath } };
}

export async function openApplication(name: string): Promise<PcToolResult> {
  const app = findApp(name);
  if (!app) {
    return {
      success: false,
      operation: "open_application",
      error: `Unknown application "${name}". Known apps: ${Object.keys(KNOWN_APPS).join(", ")}.`
    };
  }
  return new Promise((resolve) => {
    const child = spawn(app.path, app.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (err) => resolve({ success: false, operation: "open_application", error: err.message }));
    child.on("spawn", () => {
      child.unref();
      resolve({ success: true, operation: "open_application", data: { name, path: app.path } });
    });
  });
}

export async function openUrl(url: string): Promise<PcToolResult> {
  if (!/^https?:\/\//i.test(url)) {
    return { success: false, operation: "open_url", error: "Only http(s) URLs are allowed." };
  }
  try {
    const shell = await electronShell();
    await shell.openExternal(url);
    return { success: true, operation: "open_url", data: { url } };
  } catch (err) {
    return { success: false, operation: "open_url", error: err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to open URL" };
  }
}

export async function getSystemInfo(): Promise<PcToolResult> {
  return {
    success: true,
    operation: "get_system_info",
    data: {
      platform: process.platform,
      release: os.release(),
      version: os.version(),
      hostname: os.hostname(),
      arch: process.arch,
      machine: os.machine(),
      uptimeSeconds: Math.round(os.uptime()),
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      homeDir: os.homedir(),
      user: os.userInfo().username
    }
  };
}

export async function getCpuInfo(): Promise<PcToolResult> {
  const cpus = os.cpus();
  const first = cpus[0];
  return {
    success: true,
    operation: "get_cpu_info",
    data: {
      model: first?.model,
      cores: cpus.length,
      speedMHz: first?.speed,
      times: first?.times
    }
  };
}

export async function getMemoryInfo(): Promise<PcToolResult> {
  return {
    success: true,
    operation: "get_memory_info",
    data: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      usedBytes: os.totalmem() - os.freemem(),
      totalGb: +(os.totalmem() / 1024 ** 3).toFixed(2),
      freeGb: +(os.freemem() / 1024 ** 3).toFixed(2)
    }
  };
}

function statfsP(drive: string): Promise<{ totalBytes: number; freeBytes: number }> {
  return new Promise((resolve, reject) => {
    fs.statfs(drive, (err, stats) => {
      if (err || !stats) return reject(err ?? new Error(`No drive ${drive}`));
      resolve({ totalBytes: Number(stats.blocks) * Number(stats.bsize), freeBytes: Number(stats.bfree) * Number(stats.bsize) });
    });
  });
}

export async function getDiskInfo(): Promise<PcToolResult> {
  const drives: Array<{ drive: string; totalBytes: number; freeBytes: number }> = [];
  for (const letter of "CDEFGH".split("")) {
    const drive = `${letter}:\\`;
    try {
      const stat = await statfsP(drive);
      drives.push({ drive, ...stat });
    } catch {
      // Drive not present — skip.
    }
  }
  return { success: true, operation: "get_disk_info", data: { drives } };
}

export async function getEnvironmentInfo(): Promise<PcToolResult> {
  const SENSITIVE = /(key|token|secret|password|auth|cookie)/i;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !SENSITIVE.test(key) && key !== "PATH" && key !== "Path") {
      env[key] = String(value).slice(0, 400);
    }
  }
  return { success: true, operation: "get_environment_info", data: { env } };
}

export async function listProcesses(): Promise<PcToolResult> {
  try {
    const { stdout } = await execFileP("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const processes: Array<{ pid: number; name: string; memoryMb: number }> = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      // Format: "Name","PID","Session","Session#","Mem Usage"
      const match = line.match(/^"([^"]*)","(\d+)","([^"]*)","([^"]*)","([^"]*)"$/);
      if (match) {
        processes.push({ name: match[1], pid: Number(match[2]), memoryMb: Math.round(parseFloat(match[5].replace(/[^\d.]/g, "")) || 0) });
      }
    }
    return { success: true, operation: "list_processes", data: { count: processes.length, processes: processes.slice(0, 300) } };
  } catch (err) {
    return { success: false, operation: "list_processes", error: err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to list processes" };
  }
}

export async function takeScreenshot(): Promise<PcToolResult> {
  try {
    const desktopCapturer = await electronDesktopCapturer();
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 900 } });
    const source = sources[0];
    if (!source) return { success: false, operation: "take_screenshot", error: "No screen available to capture." };
    const image = source.thumbnail;
    if (image.isEmpty()) return { success: false, operation: "take_screenshot", error: "Screen capture returned an empty image." };
    const png = image.toPNG();
    const dir = path.join(os.tmpdir(), "latex-screenshots");
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `screen-${Date.now()}.png`);
    await fsp.writeFile(filePath, png);
    // Small JPEG preview for the model.
    const preview = image.resize({ width: 480 }).toJPEG(55).toString("base64");
    return {
      success: true,
      operation: "take_screenshot",
      data: { path: filePath, sizeBytes: png.length, width: image.getSize().width, height: image.getSize().height, previewBase64: preview }
    };
  } catch (err) {
    return { success: false, operation: "take_screenshot", error: err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to take screenshot" };
  }
}

// ---- mouse / keyboard (real Windows input via PowerShell user32) ----

function psCommand(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function mouseMove(x: number, y: number): Promise<PcToolResult> {
  const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);}'; [M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`;
  const { code, stderr } = await psCommand(script);
  return code === 0 ? { success: true, operation: "mouse_move", data: { x, y } } : { success: false, operation: "mouse_move", error: stderr || `Exit code ${code}` };
}

export async function mouseClick(button: "left" | "right" = "left"): Promise<PcToolResult> {
  const flag = button === "right" ? "0x8" : "0x2";
  const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MC{[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,IntPtr dwExtraInfo);}'; [MC]::mouse_event(${flag},0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40; [MC]::mouse_event(${button === "right" ? "0x10" : "0x4"},0,0,0,[IntPtr]::Zero)`;
  const { code, stderr } = await psCommand(script);
  return code === 0 ? { success: true, operation: "mouse_click", data: { button } } : { success: false, operation: "mouse_click", error: stderr || `Exit code ${code}` };
}

export async function keyboardType(text: string): Promise<PcToolResult> {
  const escaped = text
    .replace(/\+/g, "{+}")
    .replace(/\^/g, "{^}")
    .replace(/%/g, "{%}")
    .replace(/~/g, "{~}")
    .replace(/\(/g, "{(}")
    .replace(/\)/g, "{(})")
    .replace(/\{/g, "{{}")
    .replace(/\}/g, "{}}");
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(escaped)})`;
  const { code, stderr } = await psCommand(script);
  return code === 0 ? { success: true, operation: "keyboard_type", data: { typed: text.length } } : { success: false, operation: "keyboard_type", error: stderr || `Exit code ${code}` };
}

export async function keyboardPress(keys: string): Promise<PcToolResult> {
  const parts = keys.split(",").map((key) => key.trim());
  const script = `Add-Type -AssemblyName System.Windows.Forms; ${parts.map((key) => `[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(key)})`).join("; ")}`;
  const { code, stderr } = await psCommand(script);
  return code === 0 ? { success: true, operation: "keyboard_press", data: { keys: parts } } : { success: false, operation: "keyboard_press", error: stderr || `Exit code ${code}` };
}
