import { useCallback, useRef, useState } from "react";
import {
  Bot,
  FolderOpen,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { Conversation, Workspace } from "../../../shared/types";
import logo from "../assets/latex-logo.png";
import { timeAgo } from "../lib/format";
import { Kbd } from "./ui";

const SIDEBAR_KEY = "latex_sidebar_width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_COLLAPSED = 56;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (raw) {
      const v = parseInt(raw, 10);
      if (v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) return v;
    }
  } catch {}
  return 264;
}

function saveSidebarWidth(w: number) {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(w));
  } catch {}
}

interface SidebarProps {
  workspaces: Workspace[];
  workspace?: Workspace;
  conversations: Conversation[];
  conversation: Conversation;
  appMode: "main" | "chat";
  onSelectWorkspace: (workspace: Workspace) => void;
  onOpenFolder: () => void;
  onNewChat: () => void;
  onSelectConversation: (conversation: Conversation) => void;
  onDeleteConversation: (id: string) => void;
  onOpenSearch: () => void;
  onSettings: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    workspaces,
    workspace,
    conversations,
    conversation,
    appMode,
    onSelectWorkspace,
    onOpenFolder,
    onNewChat,
    onSelectConversation,
    onDeleteConversation,
    onOpenSearch,
    onSettings,
  } = props;

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("latex_sidebar_collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [width, setWidth] = useState(loadSidebarWidth);
  const resizeRef = useRef({ startX: 0, startW: 0 });

  const filteredConversations = conversations.filter(
    (c) => (c.mode ?? "main") === appMode
  );

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("latex_sidebar_collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = { startX: e.clientX, startW: width };
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - resizeRef.current.startX;
        const newW = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, resizeRef.current.startW + dx)
        );
        setWidth(newW);
      };
      const onUpWithEv = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUpWithEv);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        const finalW = Math.max(
          SIDEBAR_MIN,
          Math.min(
            SIDEBAR_MAX,
            resizeRef.current.startW +
              (ev.clientX - resizeRef.current.startX)
          )
        );
        setWidth(finalW);
        saveSidebarWidth(finalW);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUpWithEv);
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
    },
    [width]
  );

  const effectiveWidth = collapsed ? SIDEBAR_COLLAPSED : width;

  return (
    <aside
      className="sidebar"
      style={{
        width: effectiveWidth,
        minWidth: effectiveWidth,
        maxWidth: effectiveWidth,
      }}
    >
      {/* Resize handle (right edge, only when expanded) */}
      {!collapsed && (
        <div className="sidebarResizeHandle" onMouseDown={startResize} />
      )}

      {/* ── Top area ── */}
      <div className="sidebarTop">
        <div className="sidebarBrand">
          {/* Expand button — always visible at top */}
          <button
            className="sidebarExpandBtn"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapse}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={15} />
            )}
          </button>

          {/* Logo — always visible */}
          <img
            src={logo}
            className={`brandLogoImg ${collapsed ? "brandLogoCollapsed" : ""}`}
            alt="Latex logo"
          />

          {/* Text + nav — only when expanded */}
          {!collapsed && (
            <div className="brandText">
              <div className="brandName">Latex</div>
              <div className="brandSub">AI Workspace Agent</div>
            </div>
          )}
        </div>

        {/* Nav buttons */}
        <div className={`navStack ${collapsed ? "navStackCollapsed" : ""}`}>
          <button
            className={`navItem ${collapsed ? "navItemIcon" : ""}`}
            onClick={onOpenSearch}
            title="Search"
          >
            <Search size={15} />
            {!collapsed && (
              <>
                <span>Search</span>
                <Kbd>Ctrl+Shift+P</Kbd>
              </>
            )}
          </button>
          <button
            className={`navItem primary ${collapsed ? "navItemIcon" : ""}`}
            onClick={onNewChat}
            title="New Chat"
          >
            <Plus size={15} />
            {!collapsed && <span>New Chat</span>}
          </button>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="sidebarScroll">
        {!collapsed && (
          <>
            {/* Projects */}
            <section className="sidebarSection">
              <div className="sectionHeader">
                <span>Projects</span>
                <button
                  className="textButton"
                  onClick={onOpenFolder}
                  title="Open a folder as workspace"
                >
                  <FolderOpen size={13} /> Open Folder
                </button>
              </div>
              <div className="sectionBody">
                {workspaces.length === 0 ? (
                  <div className="emptyLine">No projects yet</div>
                ) : (
                  workspaces.map((item) => (
                    <button
                      key={item.id}
                      className={`projectRow ${item.id === workspace?.id ? "active" : ""}`}
                      onClick={() => onSelectWorkspace(item)}
                      title={item.path}
                    >
                      <FolderOpen size={15} />
                      <span className="sidebarItemLabel">{item.name}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            {/* Recents — EVERY conversation, in a list that scrolls on its own
                so older chats are always reachable instead of being cut off
                after the most recent handful. */}
            <section className="sidebarSection recentsSection">
              <div className="sectionHeader">
                <span>Recents</span>
              </div>
              <div className="sectionBody recentsBody">
                {filteredConversations.length === 0 ? (
                  <div className="emptyLine">
                    No recent {appMode === "main" ? "agent" : "chat"} conversations
                  </div>
                ) : (
                  filteredConversations.map((item) => (
                    <div
                      key={item.id}
                      className={`recentRow ${item.id === conversation.id ? "active" : ""}`}
                    >
                      <button
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                        }}
                        onClick={() => onSelectConversation(item)}
                      >
                        <Bot size={14} className="recentIcon" />
                        <span className="recentText">
                          <span className="recentTitle">{item.title}</span>
                          <span className="recentMeta">
                            {timeAgo(item.updatedAt)}
                          </span>
                        </span>
                      </button>
                      <button
                        className="chatDeleteBtn"
                        title="Delete chat"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(item.id);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}

        {/* Collapsed: show first 3 recent chats as icons */}
        {collapsed && (
          <div className="collapsedIcons">
            <button
              className="navItem navItemIcon"
              onClick={onOpenFolder}
              title="Projects"
            >
              <FolderOpen size={15} />
            </button>
            {filteredConversations.slice(0, 3).map((item) => (
              <button
                key={item.id}
                className={`navItem navItemIcon ${item.id === conversation.id ? "active" : ""}`}
                onClick={() => onSelectConversation(item)}
                title={item.title}
              >
                <Bot size={14} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className={`sidebarFooter ${collapsed ? "sidebarFooterCollapsed" : ""}`}>
        {!collapsed && (
          <>
            <button className="userPill" onClick={onSettings}>
              <div className="avatar">U</div>
              <span className="userName">Latex User</span>
              <span className="statusDot" />
            </button>
            <button className="iconButton" title="Help" onClick={onSettings}>
              <HelpCircle size={16} />
            </button>
          </>
        )}
      </div>
      {!collapsed && <div className="sidebarVersion">v1.1.0</div>}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div
          className="confirmOverlay"
          onClick={() => setConfirmDelete(null)}
        >
          <div className="confirmPanel" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this chat?</h3>
            <p>
              This will remove the conversation from your history. Your workspace
              files will not be affected.
            </p>
            <div className="confirmActions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  onDeleteConversation(confirmDelete);
                  setConfirmDelete(null);
                }}
              >
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
