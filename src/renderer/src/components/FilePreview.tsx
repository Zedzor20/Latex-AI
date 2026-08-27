import { useEffect, useState } from "react";
import { Check, Clipboard, ExternalLink, FolderOpen, Loader2, X } from "lucide-react";
import type { Workspace } from "../../../shared/types";
import { safeMessage } from "../lib/errors";
import { Modal } from "./ui";
import { copyToClipboard } from "./ChatView";

interface FilePreviewProps {
  file: { path: string; name: string };
  workspace?: Workspace;
  onClose: () => void;
}

const PREVIEWABLE_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".cpp", ".h", ".cs", ".rs", ".go", ".php", ".rb", ".sql",
  ".html", ".css", ".scss", ".json", ".xml", ".yaml", ".yml", ".md", ".txt", ".env", ".toml", ".ini", ".cfg",
  ".sh", ".ps1", ".bat", ".gitignore", ".log", ".svg"
]);

function languageFor(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  switch (ext) {
    case ".ts": case ".tsx": return "TypeScript";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "JavaScript";
    case ".py": return "Python";
    case ".html": case ".htm": return "HTML";
    case ".css": case ".scss": return "CSS";
    case ".json": return "JSON";
    case ".md": return "Markdown";
    case ".yaml": case ".yml": return "YAML";
    case ".xml": return "XML";
    case ".sh": case ".bash": return "Shell";
    case ".ps1": return "PowerShell";
    case ".rs": return "Rust";
    case ".go": return "Go";
    case ".java": return "Java";
    case ".c": case ".h": return "C";
    case ".cpp": case ".cc": case ".hpp": return "C++";
    case ".cs": return "C#";
    case ".sql": return "SQL";
    case ".rb": return "Ruby";
    case ".txt": case ".log": case ".env": case ".gitignore": return "Text";
    default: return "Text";
  }
}

export function FilePreview({ file, workspace, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!workspace) {
      setError("No workspace is open — open a folder to preview its files.");
      return;
    }
    let cancelled = false;
    window.latex.file
      .read(workspace, file.path)
      .then((text: string) => { if (!cancelled) setContent(text); })
      .catch((err: unknown) => { if (!cancelled) setError(safeMessage(err)); });
    return () => { cancelled = true; };
  }, [file.path, workspace]);

  const copy = async () => {
    if (content === null) return;
    const ok = await copyToClipboard(content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  const lang = languageFor(file.name);
  const isHtml = /\.html?$/i.test(file.name);

  return (
    <Modal onClose={onClose} width={860}>
      <div className="filePreview">
        <div className="filePreviewHead">
          <div className="filePreviewTitle">
            <span className="filePreviewName">{file.name}</span>
            <span className="filePreviewLang">{lang}</span>
          </div>
          <button className="iconButton" title="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="filePreviewPath" title={workspace ? `${workspace.path}\\${file.path}` : file.path}>
          {workspace ? `${workspace.path}\\${file.path}` : file.path}
        </div>
        <div className="filePreviewBody">
          {error ? (
            <div className="filePreviewError">{error}</div>
          ) : content === null ? (
            <div className="filePreviewLoading"><Loader2 size={16} className="spin" /> Reading {file.name}…</div>
          ) : (
            <pre className="filePreviewCode">{content}</pre>
          )}
        </div>
        <div className="filePreviewFoot">
          <button className="btn sm" onClick={() => void copy()} disabled={content === null}>
            {copied ? <Check size={13} /> : <Clipboard size={13} />}
            {copied ? "Copied" : "Copy content"}
          </button>
          {workspace && (
            <button
              className="btn sm"
              onClick={() => void window.latex.file.open(workspace, file.path)}
              title={isHtml ? "Open this HTML file in your browser" : "Open with the default application"}
            >
              <ExternalLink size={13} /> {isHtml ? "Open in browser" : "Open"}
            </button>
          )}
          {workspace && (
            <button
              className="btn sm"
              onClick={() => void window.latex.shell.showInFolder(`${workspace.path}\\${file.path.replace(/\//g, "\\")}`)}
            >
              <FolderOpen size={13} /> Show in Explorer
            </button>
          )}
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}

/** True when a file should be previewable as text (unknown/binary files are not). */
export function isPreviewable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return PREVIEWABLE_EXTENSIONS.has(ext);
}
