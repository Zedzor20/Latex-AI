import { FolderOpen, MessageSquare, PanelLeft, Search, Settings, Terminal as TerminalIcon, TerminalSquare } from "lucide-react";
import type { FilesystemAccess, Workspace } from "../../../shared/types";
import { IconButton } from "./ui";
import { UpdateIndicator } from "./UpdateIndicator";

export type ConnectionStatus = "none" | "loading" | "ok" | "offline";
export type AppMode = "main" | "chat";

interface TopBarProps {
  workspace?: Workspace;
  filesystemAccess?: FilesystemAccess;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  onOpenSearch: () => void;
  onSettings: () => void;
  connectionStatus: ConnectionStatus;
  onOpenWorkspaceInfo: () => void;
  appMode: AppMode;
  onSetAppMode: (mode: AppMode) => void;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  none: "No API key",
  loading: "Connecting…",
  ok: "Connected",
  offline: "Offline"
};

export function TopBar({ workspace, filesystemAccess = "workspace", explorerOpen, onToggleExplorer, onOpenSearch, onSettings, connectionStatus, onOpenWorkspaceInfo, appMode, onSetAppMode, terminalOpen, onToggleTerminal }: TopBarProps) {
  const fullAccess = filesystemAccess === "full";
  const title = fullAccess ? "Full PC Access" : workspace?.name ?? "No workspace";
  const clickable = Boolean(workspace) || fullAccess;
  const hint = fullAccess
    ? "Full PC Access — Latex can work with files anywhere your Windows account has permission"
    : workspace
      ? "Workspace information"
      : "Open a folder to give Latex access";
  return (
    <header className="topbar">
      <button className={`topbarLeft ${clickable ? "clickable" : ""}`} onClick={onOpenWorkspaceInfo} title={hint}>
        <FolderOpen size={15} className={`topbarFolder ${fullAccess ? "fullAccess" : ""}`} />
        <span className="topbarTitle">{title}</span>
        {fullAccess && <span className="topbarModeBadge">● Full Access</span>}
        <span className="topbarMore">…</span>
      </button>
      <div className="topbarCenter">
        <div className="modeToggle">
          <button
            className={`modeToggleBtn ${appMode === "main" ? "active" : ""}`}
            onClick={() => onSetAppMode("main")}
            title="Main — Agent mode with full workspace tools"
          >
            <TerminalSquare size={14} />
            <span>Main</span>
          </button>
          <button
            className={`modeToggleBtn ${appMode === "chat" ? "active" : ""}`}
            onClick={() => onSetAppMode("chat")}
            title="Chat — Conversation only, no file modifications"
          >
            <MessageSquare size={14} />
            <span>Chat</span>
          </button>
        </div>
      </div>
      <div className="topbarRight">
        {/* Renders nothing unless an update is downloading or ready. */}
        <UpdateIndicator />
        <span className={`connStatus ${connectionStatus}`} title={CONNECTION_LABEL[connectionStatus]}>
          <span className={`connDot ${connectionStatus}`} />
          <span className="connLabel">{CONNECTION_LABEL[connectionStatus]}</span>
        </span>
        <IconButton
          title={explorerOpen ? "Close Explorer" : "Open Explorer"}
          className={explorerOpen ? "active" : ""}
          onClick={onToggleExplorer}
        >
          <PanelLeft size={16} />
        </IconButton>
        <IconButton title="Search (Ctrl+Shift+P)" onClick={onOpenSearch}>
          <Search size={16} />
        </IconButton>
        <IconButton
          title={terminalOpen ? "Close Terminal" : "Open Terminal"}
          className={terminalOpen ? "active" : ""}
          onClick={onToggleTerminal}
        >
          <TerminalIcon size={16} />
        </IconButton>
        <IconButton title="Settings" onClick={onSettings}>
          <Settings size={16} />
        </IconButton>
      </div>
    </header>
  );
}
