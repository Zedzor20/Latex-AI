import { useState } from "react";
import { Bot, ChevronDown, FolderOpen, HelpCircle, Plus, Search, Trash2 } from "lucide-react";
import type { Conversation, Workspace } from "../../../shared/types";
import logo from "../assets/latex-logo.svg";
import { timeAgo } from "../lib/format";
import { Kbd } from "./ui";

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
    onSettings
  } = props;
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const filteredConversations = conversations.filter((c) => (c.mode ?? "main") === appMode);

  return (
    <aside className="sidebar">
      <div className="sidebarTop">
        <div className="sidebarBrand">
          <img src={logo} className="brandLogoImg" alt="Latex logo" />
          <div className="brandText">
            <div className="brandName">Latex</div>
            <div className="brandSub">AI Workspace Agent</div>
          </div>
          <ChevronDown size={14} className="brandChevron" />
        </div>
        <div className="navStack">
          <button className="navItem" onClick={onOpenSearch}>
            <Search size={15} />
            <span>Search</span>
            <Kbd>Ctrl+Shift+P</Kbd>
          </button>
          <button className="navItem primary" onClick={onNewChat}>
            <Plus size={15} />
            <span>New Chat</span>
          </button>
        </div>
      </div>

      <div className="sidebarScroll">
        <section className="sidebarSection">
          <div className="sectionHeader">
            <span>Projects</span>
            <button className="textButton" onClick={onOpenFolder} title="Open a folder as workspace">
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
                  <span>{item.name}</span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="sidebarSection">
          <div className="sectionHeader">
            <span>Recents</span>
          </div>
          <div className="sectionBody">
            {filteredConversations.length === 0 ? (
              <div className="emptyLine">No recent {appMode === "main" ? "agent" : "chat"} conversations</div>
            ) : (
              filteredConversations.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className={`recentRow ${item.id === conversation.id ? "active" : ""}`}
                >
                  <button
                    style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
                    onClick={() => onSelectConversation(item)}
                  >
                    <Bot size={14} className="recentIcon" />
                    <span className="recentText">
                      <span className="recentTitle">{item.title}</span>
                      <span className="recentMeta">{timeAgo(item.updatedAt)}</span>
                    </span>
                  </button>
                  <button
                    className="chatDeleteBtn"
                    title="Delete chat"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(item.id); }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="sidebarFooter">
        <button className="userPill" onClick={onSettings}>
          <div className="avatar">GA</div>
          <span className="userName">Gamers</span>
          <span className="statusDot" />
        </button>
        <button className="iconButton" title="Help" onClick={onSettings}>
          <HelpCircle size={16} />
        </button>
      </div>
      <div className="sidebarVersion">v1.0.1</div>

      {confirmDelete && (
        <div className="confirmOverlay" onClick={() => setConfirmDelete(null)}>
          <div className="confirmPanel" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this chat?</h3>
            <p>This will remove the conversation from your history. Your workspace files will not be affected.</p>
            <div className="confirmActions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={() => { onDeleteConversation(confirmDelete); setConfirmDelete(null); }}>
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
