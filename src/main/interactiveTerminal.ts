/**
 * Interactive Terminal Service (node-pty based)
 *
 * Provides a real PTY terminal session inside Latex.
 * Uses node-pty for authentic shell interaction with proper resize support.
 * Output is streamed to the renderer via IPC events.
 */

import { EventEmitter } from "node:events";
import path from "node:path";

// node-pty is a native module — import lazily to avoid crash on platforms
// where it isn't compiled.
let pty: typeof import("node-pty") | null = null;

async function loadPty(): Promise<typeof import("node-pty")> {
  if (!pty) {
    pty = await import("node-pty");
  }
  return pty;
}

export interface TerminalSession {
  id: string;
  pid: number | undefined;
  cwd: string;
  shell: "powershell" | "cmd";
  status: "starting" | "running" | "stopped" | "error" | "closed";
  createdAt: number;
  ptyProcess: ReturnType<typeof import("node-pty").spawn> | null;
  cols: number;
  rows: number;
  minimized: boolean;
}

export interface TerminalOutput {
  terminalId: string;
  type: "stdout" | "stderr" | "system";
  data: string;
  timestamp: number;
}

const MAX_OUTPUT_BUFFER = 500_000;

/**
 * Window in which PTY chunks are coalesced into ONE forwarded message.
 *
 * A chatty command (`ping -t`, a build log) can produce hundreds of chunks a
 * second; one IPC message and one xterm parse per chunk is what makes the whole
 * window stutter on a slow machine. Chunks are therefore merged per ~16 ms —
 * occasionally a little more on a busy machine — with the bytes and their order
 * preserved exactly.
 */
const OUTPUT_FLUSH_MS = 16;

/** One queued piece of output, tagged with the kind it arrived as. */
interface PendingChunk {
  type: "stdout" | "stderr" | "system";
  data: string;
}

export class InteractiveTerminal extends EventEmitter {
  private sessions = new Map<string, TerminalSession>();
  /**
   * Per-session scrollback, stored as CHUNKS rather than one concatenated
   * string: rebuilding a 500 KB string on every chunk (the old behaviour) is
   * quadratic under a firehose, appending to a list is not.
   */
  private outputBuffers = new Map<string, string[]>();
  /** Running byte total per session, so trimming never re-measures the buffer. */
  private outputLengths = new Map<string, number>();
  /** Chunks not yet forwarded to the renderer. */
  private pending = new Map<string, PendingChunk[]>();
  private flushTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Create a new terminal session with a real PTY.
   */
  async createSession(
    id: string,
    cwd: string,
    shell: "powershell" | "cmd" = "powershell",
    cols = 120,
    rows = 30
  ): Promise<TerminalSession> {
    // ── One id, one shell ──────────────────────────────────────────────
    // Asking for a terminal that is ALREADY RUNNING returns that session
    // instead of killing and respawning the shell, so a renderer that
    // bootstraps twice (a development remount, or the panel being shown again)
    // attaches to the running PowerShell rather than creating a rival one.
    // That double-spawn is exactly how Latex ended up with duplicate shells.
    const existing = this.sessions.get(id);
    if (existing && existing.status === "running" && existing.ptyProcess) {
      this.resize(id, cols, rows);
      return existing;
    }
    // A dead or errored session under this id is genuinely replaced.
    if (existing) {
      this.destroySession(id);
    }

    const session: TerminalSession = {
      id,
      pid: undefined,
      cwd,
      shell,
      status: "starting",
      createdAt: Date.now(),
      ptyProcess: null,
      cols,
      rows,
      minimized: false
    };

    this.outputBuffers.set(id, []);
    this.pending.delete(id);

    try {
      const ptyMod = await loadPty();

      // Select the shell program
      const shellPath = process.platform === "win32"
        ? (shell === "cmd" ? "cmd.exe" : "powershell.exe")
        : (process.env.SHELL ?? "bash");

      const shellArgs = process.platform === "win32"
        ? (shell === "cmd" ? [] : ["-NoProfile", "-NoLogo"])
        : ["--norc", "--noprofile"];

      const ptyProcess = ptyMod.spawn(shellPath, shellArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: process.env as Record<string, string>
      });

      session.ptyProcess = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";

      // Stream PTY output to renderer
      ptyProcess.onData((data: string) => {
        this.appendOutput(id, "stdout", data);
      });

      ptyProcess.onExit(({ exitCode }) => {
        session.status = "closed";
        this.appendOutput(
          id,
          "system",
          `\r\n[Process exited with code ${exitCode}]\r\n`
        );
        this.emit("session:closed", { terminalId: id, code: exitCode });
      });

      console.log(
        `[Terminal] Created PTY session: ${id} (PID: ${ptyProcess.pid}, shell: ${shell}, ${cols}x${rows})`
      );
    } catch (err) {
      session.status = "error";
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      this.appendOutput(id, "system", `\r\n[Failed to start PTY: ${errMsg}]\r\n`);
      this.emit("session:error", { terminalId: id, error: errMsg });
      console.error(`[Terminal] Failed to create PTY:`, errMsg);
    }

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Send input to a terminal session.
   */
  sendInput(terminalId: string, data: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session?.ptyProcess || session.status !== "running") {
      return false;
    }
    session.ptyProcess.write(data);
    return true;
  }

  /**
   * Send a command (input + newline).
   */
  sendCommand(terminalId: string, command: string): boolean {
    return this.sendInput(terminalId, command + "\r");
  }

  /**
   * Send Ctrl+C to interrupt.
   */
  sendInterrupt(terminalId: string): boolean {
    return this.sendInput(terminalId, "\x03");
  }

  /**
   * Resize the PTY.
   */
  resize(terminalId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(terminalId);
    if (!session?.ptyProcess || session.status !== "running") {
      return false;
    }
    try {
      session.ptyProcess.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
      return true;
    } catch (err) {
      console.error(`[Terminal] Resize failed:`, err);
      return false;
    }
  }

  /**
   * Set minimized state (PTY continues running).
   */
  setMinimized(terminalId: string, minimized: boolean): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.minimized = minimized;
    }
  }

  /**
   * Get the output buffer for a session.
   */
  getOutput(terminalId: string): string {
    return (this.outputBuffers.get(terminalId) ?? []).join("");
  }

  /**
   * Clear the output buffer.
   */
  clearOutput(terminalId: string): void {
    this.outputBuffers.set(terminalId, []);
    this.outputLengths.set(terminalId, 0);
    this.pending.delete(terminalId);
  }

  /**
   * Destroy a terminal session.
   */
  destroySession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    // Forward whatever the shell printed on its way out before dropping it.
    const timer = this.flushTimers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(terminalId);
    }
    this.flushOutput(terminalId);

    if (session.ptyProcess) {
      try {
        session.ptyProcess.kill();
      } catch { /* ignore */ }
    }

    session.status = "closed";
    this.sessions.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    this.outputLengths.delete(terminalId);
    this.pending.delete(terminalId);
    console.log(`[Terminal] Destroyed session: ${terminalId}`);
  }

  /**
   * Destroy all sessions (called on app quit).
   */
  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroySession(id);
    }
  }

  /**
   * Get session info.
   */
  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): Array<{
    id: string;
    cwd: string;
    shell: string;
    status: string;
    pid: number | undefined;
    minimized: boolean;
    cols: number;
    rows: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      shell: s.shell,
      status: s.status,
      pid: s.pid,
      minimized: s.minimized,
      cols: s.cols,
      rows: s.rows
    }));
  }

  /**
   * Count running sessions.
   */
  runningCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "running") count++;
    }
    return count;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private appendOutput(
    terminalId: string,
    type: "stdout" | "stderr" | "system",
    data: string
  ): void {
    // ── Scrollback (kept for a restored panel) ────────────────────────
    const stored = this.outputBuffers.get(terminalId) ?? [];
    stored.push(data);
    let total = this.outputLengths.get(terminalId) ?? 0;
    total += data.length;
    // Drop whole chunks from the front until the buffer is back inside its
    // bound — never re-copying what stays.
    while (total > MAX_OUTPUT_BUFFER && stored.length > 1) {
      const dropped = stored.shift();
      if (!dropped) break;
      total -= dropped.length;
    }
    this.outputBuffers.set(terminalId, stored);
    this.outputLengths.set(terminalId, total);

    // ── Forwarding (coalesced) ────────────────────────────────────────
    const queue = this.pending.get(terminalId) ?? [];
    queue.push({ type, data });
    this.pending.set(terminalId, queue);
    this.scheduleFlush(terminalId);
  }

  /** Coalesce this session's output into a single forward per window. */
  private scheduleFlush(terminalId: string): void {
    if (this.flushTimers.has(terminalId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(terminalId);
      this.flushOutput(terminalId);
    }, OUTPUT_FLUSH_MS);
    // Forwarding output is not a reason to keep the app alive.
    timer.unref?.();
    this.flushTimers.set(terminalId, timer);
  }

  /**
   * Forward everything queued for one session.
   *
   * Runs of the SAME kind are joined into one message; a kind change starts a
   * new one, so ordering and the stdout/system distinction are both preserved.
   */
  private flushOutput(terminalId: string): void {
    const queued = this.pending.get(terminalId);
    if (!queued || queued.length === 0) return;
    this.pending.delete(terminalId);
    let runType = queued[0].type;
    let run: string[] = [];
    const send = () => {
      if (run.length === 0) return;
      this.emit("output", {
        terminalId,
        type: runType,
        data: run.join(""),
        timestamp: Date.now()
      } satisfies TerminalOutput);
      run = [];
    };
    for (const chunk of queued) {
      if (chunk.type !== runType) {
        send();
        runType = chunk.type;
      }
      run.push(chunk.data);
    }
    send();
  }
}

// Singleton
let instance: InteractiveTerminal | null = null;

export function getTerminal(): InteractiveTerminal {
  if (!instance) {
    instance = new InteractiveTerminal();
  }
  return instance;
}
