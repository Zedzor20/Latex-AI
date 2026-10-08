/**
 * Interactive Terminal Component (xterm.js + node-pty)
 *
 * Real terminal inside Latex with:
 * - Full resize from all edges/corners
 * - Tab support for multiple sessions
 * - Minimize (background running)
 * - Persistent terminal sessions
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Terminal as TerminalIcon,
  X,
  Trash2,
  Square,
  Minus,
  Plus,
  Grip,
} from "lucide-react";

// xterm.js — loaded dynamically to avoid SSR issues
let TerminalCore: typeof import("@xterm/xterm").Terminal | null = null;
let FitAddon: typeof import("@xterm/addon-fit").FitAddon | null = null;

async function loadXterm() {
  if (!TerminalCore) {
    const xterm = await import("@xterm/xterm");
    TerminalCore = xterm.Terminal;
  }
  if (!FitAddon) {
    const fit = await import("@xterm/addon-fit");
    FitAddon = fit.FitAddon;
  }
}

// ─── Tab Session ──────────────────────────────────────────────────────────────

interface TabSession {
  id: string;
  title: string;
  isRunning: boolean;
  xterm: import("@xterm/xterm").Terminal | null;
  fitAddon: import("@xterm/addon-fit").FitAddon | null;
  /**
   * Input pipes, kept per session so they can be disposed WITH it. Two live
   * `onData` pipes on one xterm is precisely how a single keystroke gets sent
   * to PowerShell twice — so every pipe is owned and released by its session.
   */
  unsubInput: import("@xterm/xterm").IDisposable | null;
  unsubBinary: import("@xterm/xterm").IDisposable | null;
  resizeObserver: ResizeObserver | null;
}

/**
 * How many PTY chunks are coalesced into one xterm write.
 *
 * A chatty command (`ping -t`, a build log, `npm test`) produces hundreds of
 * chunks a second. Writing each one straight into xterm means a parse plus a
 * DOM update per chunk, which is what makes the whole renderer stutter on a
 * slow machine. Output is therefore queued per session and flushed once per
 * frame-ish tick: same bytes, same order, a fraction of the work.
 */
const OUTPUT_FLUSH_MS = 16;

interface TerminalProps {
  cwd?: string;
  onClose: () => void;
  onMinimize?: () => void;
  /**
   * Whether the panel is on screen. Hiding the panel must NOT tear it down:
   * the PTY, the xterm instance and its scrollback all stay alive, which is
   * what makes "minimize" different from "close".
   */
  visible?: boolean;
  /** Ask the host to show the panel again (the minimized chip). */
  onRestore?: () => void;
}

// ─── Persistent size ─────────────────────────────────────────────────────────

const SIZE_KEY = "latex_terminal_size";
const MIN_WIDTH = 360;
const MIN_HEIGHT = 120;

function loadSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.w === "number" && typeof p.h === "number") return p;
    }
  } catch {}
  return { w: 800, h: 340 };
}

function saveSize(w: number, h: number) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
  } catch {}
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Terminal({ cwd, onClose, onMinimize, visible = true, onRestore }: TerminalProps) {
  const [sessions, setSessions] = useState<TabSession[]>([]);
  // Current tab list for the central IPC listeners, which must not be
  // re-subscribed every time a session is added or its status flips.
  const sessionsRef = useRef<TabSession[]>([]);
  sessionsRef.current = sessions;
  // One bootstrap per mounted panel, even if the effect is invoked twice.
  const bootstrappedRef = useRef(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const [runningCount, setRunningCount] = useState(0);
  const [isMaximized, setIsMaximized] = useState(false);
  // Whether the panel is off screen. Declared up here because the effects
  // below (re-fit on restore) and the render both depend on it. Minimizing
  // HIDES the panel; it never tears it down — the PTY, the xterm instance and
  // the entire scrollback stay exactly as they were, so restoring reconnects to
  // the SAME PowerShell with the SAME history.
  const hidden = isMinimized || !visible;

  // Resize state
  const saved = loadSize();
  const [panelW, setPanelW] = useState(saved.w);
  const [panelH, setPanelH] = useState(saved.h);
  const [panelLeft, setPanelLeft] = useState(0);
  const [panelRight, setPanelRight] = useState(0);
  const [panelTop, setPanelTop] = useState(0);
  const [floating, setFloating] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const panelsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const activeSession = sessions[activeIdx] ?? null;

  // ── Create new tab ────────────────────────────────────────────────────────

  const createSession = useCallback(
    async (switchToTab = true) => {
      const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      await loadXterm();

      const term = new TerminalCore!({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        scrollback: 10000,
        theme: {
          background: "#0c0c0c",
          foreground: "#cccccc",
          cursor: "#ffffff",
          selectionBackground: "#264f78",
          black: "#0c0c0c",
          red: "#cd3131",
          green: "#0dbc79",
          yellow: "#e5e510",
          blue: "#2472c8",
          magenta: "#bc3fbc",
          cyan: "#11a8cd",
          white: "#e5e5e5",
          brightBlack: "#666666",
          brightRed: "#f14c4c",
          brightGreen: "#23d18b",
          brightYellow: "#f5f543",
          brightBlue: "#3b8eea",
          brightMagenta: "#d670d6",
          brightCyan: "#29b8db",
          brightWhite: "#e5e5e5",
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon!();
      term.loadAddon(fitAddon);

      const session: TabSession = {
        id,
        title: "powershell",
        isRunning: false,
        xterm: term,
        fitAddon,
        unsubInput: null,
        unsubBinary: null,
        resizeObserver: null,
      };

      // Add by ID, never blindly: a second bootstrap for the same tab must
      // attach to the session that already exists rather than stack a rival
      // tab (and a rival PowerShell process) beside it.
      setSessions((prev) => {
        if (prev.some((s) => s.id === id)) return prev;
        const next = [...prev, session];
        if (switchToTab) setActiveIdx(next.length - 1);
        return next;
      });

      // Wait for DOM
      await new Promise((r) => setTimeout(r, 50));

      const panelEl = panelsRef.current.get(id);
      if (panelEl) {
        term.open(panelEl);
        requestAnimationFrame(() => {
          try {
            fitAddon.fit();
          } catch {}
        });
      }

      // Create PTY — use the public cols/rows API (dimensions is internal)
      const cols = term.cols > 0 ? term.cols : 120;
      const rows = term.rows > 0 ? term.rows : 30;

      try {
        await window.latex.terminal.create(id, cwd, undefined, cols, rows);
        session.isRunning = true;
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, isRunning: true } : s))
        );
      } catch (err) {
        term.writeln(
          `\r\n\x1b[31mFailed to start terminal: ${err instanceof Error ? err.message : err}\x1b[0m`
        );
        return;
      }

      // Pipe input. Released with the session (see closeTab / unmount) so the
      // same keystroke can never be delivered by two competing pipes.
      session.unsubInput?.dispose();
      session.unsubBinary?.dispose();
      session.unsubInput = term.onData((data: string) => {
        void window.latex.terminal.send(id, data);
      });
      session.unsubBinary = term.onBinary((data: string) => {
        void window.latex.terminal.send(id, data);
      });

      // PTY output, session close and session errors are all handled by ONE
      // subscription for the whole panel (see the effect below). Registering a
      // listener per tab meant N listeners filtering N events on every chunk —
      // and a listener leak per tab that was opened and closed.

      // Resize observer
      session.resizeObserver = new ResizeObserver(() => {
        if (session.fitAddon && session.xterm) {
          try {
            session.fitAddon.fit();
            const fitted = session.xterm!;
            if (fitted.cols > 0 && fitted.rows > 0) {
              void window.latex.terminal.resize(id, fitted.cols, fitted.rows);
            }
          } catch {}
        }
      });
      if (panelEl) session.resizeObserver.observe(panelEl);

      term.focus();
      updateRunningCount();
    },
    [cwd]
  );

  // ── Close ─────────────────────────────────────────────────────────────────

  /**
   * Tear down ONE tab: its renderer resources AND its PTY.
   *
   * Deliberately outside the state updater. React may invoke an updater more
   * than once (StrictMode, a concurrent re-render), and this one kills a process
   * and writes to xterm — so a replay would have closed a session twice.
   */
  const destroyTab = useCallback((session: TabSession) => {
    session.unsubInput?.dispose();
    session.unsubBinary?.dispose();
    session.resizeObserver?.disconnect();
    session.xterm?.dispose();
    // ONLY an explicit close terminates the shell. Hiding the panel, switching
    // chats or unmounting it never does.
    void window.latex.terminal.close(session.id);
  }, []);

  /**
   * Close one session and drop its tab.
   *
   * Addressed by IDENTITY — the session object and its stable id — and never by
   * array index. An index is only a snapshot of where a tab happened to sit when
   * the handler was created: after a minimize/restore or a tab change it can
   * point at nothing (so Close silently does nothing, which is exactly how a
   * terminal appeared impossible to close) or at the wrong tab.
   */
  const closeSession = useCallback(
    (session: TabSession) => {
      destroyTab(session);
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== session.id);
        if (next.length === 0) {
          onClose();
        } else {
          // Shrink the selection from its CURRENT value, never from one
          // captured when this handler was created.
          setActiveIdx((idx) => Math.min(idx, next.length - 1));
        }
        return next;
      });
    },
    [destroyTab, onClose]
  );

  /** Close the tab at an index (tab-strip buttons); identity does the work. */
  const closeTab = useCallback(
    (idx: number) => {
      const session = sessionsRef.current[idx];
      if (session) closeSession(session);
    },
    [closeSession]
  );

  // ── Focus active terminal on tab switch ───────────────────────────────────

  useEffect(() => {
    const s = sessions[activeIdx];
    if (s?.xterm) {
      s.xterm.focus();
      requestAnimationFrame(() => {
        try {
          s.fitAddon?.fit();
        } catch {}
      });
    }
  }, [activeIdx, sessions]);

  // ── Create initial session on mount ───────────────────────────────────────

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void createSession();
    return () => {
      // Renderer resources are released here; the PTY is NOT.
      //
      // Unmount used to close every session, which meant hiding the panel (or
      // anything else that unmounted it) killed the user's PowerShell. The
      // shell now outlives the view: only an explicit close terminates it.
      for (const s of sessionsRef.current) {
        s.unsubInput?.dispose();
        s.unsubBinary?.dispose();
        s.resizeObserver?.disconnect();
        s.xterm?.dispose();
      }
      sessionsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── One subscription for the whole panel ──────────────────────────────────
  //
  // Output, session-close and session-error are routed by terminalId, so the
  // number of IPC listeners is a constant instead of one per open tab. Output
  // is additionally queued per session and written to xterm once per
  // OUTPUT_FLUSH_MS, which keeps a firehose command (ping -t) from turning into
  // a write-per-chunk render storm.
  useEffect(() => {
    const queues = new Map<string, string[]>();
    const timers = new Map<string, number>();

    const flush = (id: string) => {
      timers.delete(id);
      const parts = queues.get(id);
      if (!parts || parts.length === 0) return;
      queues.delete(id);
      const session = sessionsRef.current.find((s) => s.id === id);
      // One write for the whole tick: identical bytes, in order, parsed once.
      session?.xterm?.write(parts.join(""));
    };

    const unsubOutput = window.latex.terminal.onOutput((outputData: { terminalId: string; type: string; data: string; timestamp: number }) => {
      const id = outputData.terminalId;
      if (!id) return;
      const queue = queues.get(id);
      if (queue) queue.push(outputData.data);
      else queues.set(id, [outputData.data]);
      if (!timers.has(id)) {
        timers.set(id, window.setTimeout(() => flush(id), OUTPUT_FLUSH_MS));
      }
    });

    const unsubClose = window.latex.terminal.onSessionClosed((data: { terminalId: string; code: number | null }) => {
      // Flush what the shell printed on its way out before reporting the exit.
      flush(data.terminalId);
      const session = sessionsRef.current.find((s) => s.id === data.terminalId);
      if (!session) return;
      setSessions((prev) => prev.map((s) => (s.id === data.terminalId ? { ...s, isRunning: false } : s)));
      session.xterm?.writeln(`\r\n\x1b[33m[Process exited]\x1b[0m`);
    });

    const unsubError = window.latex.terminal.onSessionError((data: { terminalId: string; error: string }) => {
      const session = sessionsRef.current.find((s) => s.id === data.terminalId);
      session?.xterm?.writeln(`\r\n\x1b[31m[Error: ${data.error}]\x1b[0m`);
    });

    return () => {
      unsubOutput();
      unsubClose();
      unsubError();
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
      queues.clear();
    };
  }, []);

  // ── Resize handles ────────────────────────────────────────────────────────

  const resizeRef = useRef({
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
    startL: 0,
    startR: 0,
    startT: 0,
    dir: "" as string,
  });

  const startResize = useCallback(
    (dir: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: panelW,
        startH: panelH,
        startL: panelLeft,
        startR: panelRight,
        startT: panelTop,
        dir,
      };

      const onMove = (ev: MouseEvent) => {
        const { startX, startY, startW, startH, startL, startR, startT, dir } =
          resizeRef.current;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        let newW = startW;
        let newH = startH;
        let newL = startL;
        let newR = startR;
        let newT = startT;

        if (dir.includes("right")) newW = Math.max(MIN_WIDTH, startW + dx);
        if (dir.includes("left")) newW = Math.max(MIN_WIDTH, startW - dx);
        if (dir.includes("bottom")) newH = Math.max(MIN_HEIGHT, startH + dy);
        if (dir.includes("top")) newH = Math.max(MIN_HEIGHT, startH - dy);

        if (dir === "left") {
          newL = Math.max(0, startL - dx);
        } else if (dir === "right") {
          newR = Math.max(0, startR - dx);
        } else if (dir === "top") {
          newT = Math.max(0, startT - dy);
        }

        setPanelW(newW);
        setPanelH(newH);
        setPanelLeft(newL);
        setPanelRight(newR);
        setPanelTop(newT);
        saveSize(newW, newH);
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor =
        dir === "right" || dir === "left"
          ? "ew-resize"
          : dir === "bottom" || dir === "top"
            ? "ns-resize"
            : "nwse-resize";
      document.body.style.userSelect = "none";
    },
    [panelW, panelH, panelLeft, panelRight, panelTop]
  );

  // ── Running count poll ────────────────────────────────────────────────────

  const updateRunningCount = useCallback(() => {
    void window.latex.terminal
      .runningCount()
      .then(setRunningCount)
      .catch(() => {});
  }, []);

  useEffect(() => {
    updateRunningCount();
    const interval = setInterval(updateRunningCount, 5000);
    return () => clearInterval(interval);
  }, [updateRunningCount, sessions]);

  // ── Keyboard shortcut: Ctrl+C when no selection ───────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isMaximized) {
          setIsMaximized(false);
        } else {
          setIsMinimized(true);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMaximized]);

  // ── Minimize ──────────────────────────────────────────────────────────────

  /** Hide the panel — leaving every shell running (spec §25). */
  const handleMinimize = useCallback(() => {
    setIsMinimized(true);
    sessionsRef.current.forEach((s) => {
      void window.latex.terminal.minimize(s.id, true);
    });
    onMinimize?.();
  }, [onMinimize]);

  // Coming back from hidden: the panel may have been resized while it was away,
  // so re-fit and re-focus the same session (it is still the same shell).
  useEffect(() => {
    if (hidden || !activeSession?.fitAddon || !activeSession?.xterm) return;
    requestAnimationFrame(() => {
      try {
        activeSession.fitAddon!.fit();
        activeSession.xterm!.focus();
      } catch {}
    });
  }, [hidden, activeSession]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleClear = useCallback(() => {
    activeSession?.xterm?.clear();
    if (activeSession) {
      void window.latex.terminal.clear(activeSession.id);
    }
  }, [activeSession]);

  const handleInterrupt = useCallback(() => {
    if (activeSession) {
      void window.latex.terminal.interrupt(activeSession.id);
    }
  }, [activeSession]);

  const handleClose = useCallback(() => {
    const session = sessionsRef.current[activeIdx];
    if (session) closeSession(session);
  }, [activeIdx, closeSession]);

  // ── Restore ──────────────────────────────────────────────────────────────

  const restore = useCallback(() => {
    setIsMinimized(false);
    sessionsRef.current.forEach((s) => {
      void window.latex.terminal.minimize(s.id, false);
    });
    onRestore?.();
  }, [onRestore]);

  // ── Maximized overlay ─────────────────────────────────────────────────────

  const panelStyle: React.CSSProperties = isMaximized
    ? {
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100vw",
        height: "100vh",
        zIndex: 1000,
        display: hidden ? "none" : undefined,
      }
    : {
        position: "fixed",
        bottom: 0,
        left: floating ? panelLeft : 0,
        right: floating ? panelRight : 0,
        width: floating ? `calc(100vw - ${panelLeft + panelRight}px)` : "100%",
        height: panelH,
        minHeight: MIN_HEIGHT,
        zIndex: 1000,
        display: hidden ? "none" : undefined,
      };

  return (
    <>
    {hidden && (
      <div className="terminalMinimized" onClick={restore}>
        <TerminalIcon size={14} />
        <span>
          Terminal{runningCount > 0 ? ` • ${runningCount} Running` : ""}
        </span>
        <span className="terminalMinimizedHint">Click to restore</span>
      </div>
    )}
    <div className="terminalPanel" style={panelStyle}>
      {/* ── Resize handles ─────────────────────────────────────────────── */}
      {!isMaximized && (
        <>
          <div
            className="terminalResizeHandle terminalResizeTop"
            onMouseDown={startResize("top")}
          />
          <div
            className="terminalResizeHandle terminalResizeBottom"
            onMouseDown={startResize("bottom")}
          />
          <div
            className="terminalResizeHandle terminalResizeLeft"
            onMouseDown={startResize("left")}
          />
          <div
            className="terminalResizeHandle terminalResizeRight"
            onMouseDown={startResize("right")}
          />
          <div
            className="terminalResizeHandle terminalResizeCorner terminalResizeBottomRight"
            onMouseDown={startResize("bottomright")}
          />
          <div
            className="terminalResizeHandle terminalResizeCorner terminalResizeTopRight"
            onMouseDown={startResize("topright")}
          />
          <div
            className="terminalResizeHandle terminalResizeCorner terminalResizeBottomLeft"
            onMouseDown={startResize("bottomleft")}
          />
          <div
            className="terminalResizeHandle terminalResizeCorner terminalResizeTopLeft"
            onMouseDown={startResize("topleft")}
          />
        </>
      )}

      {/* ── Header with tabs ──────────────────────────────────────────── */}
      <div className="terminalHeader">
        <div className="terminalTabs">
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={`terminalTab ${i === activeIdx ? "active" : ""}`}
              onClick={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  // middle-click close
                  e.preventDefault();
                  closeTab(i);
                }
              }}
            >
              <TerminalIcon size={12} />
              <span className="terminalTabTitle">{s.title}</span>
              {s.isRunning && <span className="terminalTabDot" />}
              <button
                className="terminalTabClose"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(i);
                }}
              >
                <X size={10} />
              </button>
            </div>
          ))}
          <button
            className="terminalTabAdd"
            onClick={() => void createSession(true)}
            title="New terminal"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="terminalActions">
          <button
            className="terminalBtn"
            onClick={handleClear}
            title="Clear"
          >
            <Trash2 size={13} />
          </button>
          <button
            className="terminalBtn"
            onClick={handleInterrupt}
            title="Interrupt (Ctrl+C)"
          >
            <Square size={13} />
          </button>
          <button
            className="terminalBtn"
            onClick={handleMinimize}
            title="Minimize (keep running)"
          >
            <Minus size={13} />
          </button>
          <button
            className="terminalBtn"
            onClick={() => setIsMaximized((m) => !m)}
            title={isMaximized ? "Restore" : "Maximize"}
          >
            <Grip size={13} />
          </button>
          <button
            className="terminalBtn terminalBtnClose"
            onClick={handleClose}
            title="Close terminal"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Terminal panels (only active is visible) ───────────────────── */}
      <div className="terminalBody">
        {sessions.map((s, i) => (
          <div
            key={s.id}
            ref={(el) => {
              if (el) {
                panelsRef.current.set(s.id, el);
              } else {
                panelsRef.current.delete(s.id);
              }
            }}
            className="terminalXtermContainer"
            style={{ display: i === activeIdx ? "block" : "none" }}
            onClick={() => s.xterm?.focus()}
          />
        ))}
      </div>
    </div>
    </>
  );
}
