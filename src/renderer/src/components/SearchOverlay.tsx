import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, FileCode2, FolderOpen, Search } from "lucide-react";
import type { Conversation, Workspace } from "../../../shared/types";
import { timeAgo } from "../lib/format";
import { Modal } from "./ui";

interface SearchOverlayProps {
  conversations: Conversation[];
  workspaces: Workspace[];
  files: string[];
  onSelectConversation: (conversation: Conversation) => void;
  onSelectWorkspace: (workspace: Workspace) => void;
  onClose: () => void;
}

interface Result {
  kind: "conversation" | "project" | "file";
  label: string;
  meta: string;
  conversation?: Conversation;
  workspace?: Workspace;
}

export function SearchOverlay({
  conversations,
  workspaces,
  files,
  onSelectConversation,
  onSelectWorkspace,
  onClose
}: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const build = (kind: Result["kind"], label: string, meta: string): Result => ({ kind, label, meta });
    if (!q) return [];
    const list: Result[] = [];
    for (const c of conversations) {
      if (c.title.toLowerCase().includes(q)) list.push({ ...build("conversation", c.title, timeAgo(c.updatedAt)), conversation: c });
    }
    for (const w of workspaces) {
      if (w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q)) {
        list.push({ ...build("project", w.name, w.path), workspace: w });
      }
    }
    for (const f of files) {
      if (f.toLowerCase().includes(q)) list.push(build("file", f.split("/").pop() ?? f, f));
    }
    return list.slice(0, 30);
  }, [query, conversations, workspaces, files]);

  useEffect(() => setCursor(0), [query]);

  const activate = (result: Result) => {
    if (result.kind === "conversation" && result.conversation) onSelectConversation(result.conversation);
    if (result.kind === "project" && result.workspace) onSelectWorkspace(result.workspace);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter" && results[cursor]) {
      event.preventDefault();
      activate(results[cursor]);
    }
  };

  return (
    <Modal onClose={onClose} width={560}>
      <div className="searchOverlay">
        <div className="searchInputRow">
          <Search size={16} className="searchIcon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search conversations, projects, files..."
          />
          <kbd>Esc</kbd>
        </div>
        <div className="searchResults">
          {query.trim() === "" && <div className="searchHint">Type to search conversations, projects, and workspace files.</div>}
          {query.trim() !== "" && results.length === 0 && <div className="searchHint">No results for “{query}”.</div>}
          {results.map((result, index) => (
            <button
              key={`${result.kind}-${result.label}`}
              className={`searchRow ${index === cursor ? "active" : ""}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => activate(result)}
            >
              {result.kind === "conversation" && <Bot size={15} />}
              {result.kind === "project" && <FolderOpen size={15} />}
              {result.kind === "file" && <FileCode2 size={15} />}
              <span className="searchRowText">
                <span className="searchRowLabel">{result.label}</span>
                <span className="searchRowMeta">{result.meta}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
