import { spawn } from "node:child_process";
import type { TerminalResult } from "../shared/types.js";
import { ensureInsideWorkspace } from "./security.js";

const DANGEROUS_COMMAND = /\b(del|rmdir|rd|format|diskpart|shutdown|reg|regedit|taskkill|sc|bcdedit|takeown|cipher|format|clean|cleanmgr|powershell\s+\-\s*enc|Invoke-Expression|Remove-Item|Clear-Content|Set-Content|New-ItemProperty|Remove-ItemProperty|Stop-Process|Restart-Computer|Stop-Computer)\b/i;

/** True for commands that can delete data, change system state, or brick a machine. */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command);
}

export async function runCommand(workspaceRoot: string, command: string, shell: "powershell" | "cmd" = "powershell"): Promise<TerminalResult> {
  const cwd = await ensureInsideWorkspace(workspaceRoot, ".");
  return new Promise((resolve) => {
    // Spawn the shell directly (not via Node's shell: option, which double-wraps
    // through cmd and mangles quoting/exit codes). PowerShell must propagate the
    // native exit code explicitly via $LASTEXITCODE.
    const child =
      process.platform === "win32"
        ? shell === "cmd"
          ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true })
          : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${command}; exit $LASTEXITCODE`], { cwd, windowsHide: true })
        : spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (exitCode) => resolve({ command, cwd, exitCode, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000) }));
  });
}
