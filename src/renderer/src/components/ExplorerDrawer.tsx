import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, FileCode2, FolderOpen, RefreshCw, X } from "lucide-react";
import type { FileTreeNode, Workspace } from "../../../shared/types";
import { IconButton } from "./ui";

interface ExplorerDrawerProps {
  workspace?: Workspace;
  tree: FileTreeNode[];
  onClose: () => void;
  onRefresh: () => void;
  onOpenFile: (node: FileTreeNode) => void;
}

export function ExplorerDrawer({ workspace, tree, onClose, onRefresh, onOpenFile }: ExplorerDrawerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="explorerDrawer">
      <div className="explorerHeader">
        <div className="explorerTitle">
          <FolderOpen size={15} />
          <span>Explorer</span>
        </div>
        <div className="explorerActions">
          <IconButton title="Refresh" onClick={onRefresh}><RefreshCw size={14} /></IconButton>
          <IconButton title="Close Explorer" onClick={onClose}><X size={15} /></IconButton>
        </div>
      </div>
      {workspace ? (
        <div className="explorerWorkspace" title={workspace.path}>{workspace.name}</div>
      ) : (
        <div className="explorerEmpty">No workspace selected.<br />Open a folder to inspect its files.</div>
      )}
      <div className="explorerTree">
        {tree.map((node) => (
          <TreeNode key={node.path} node={node} expanded={expanded} onToggle={toggle} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  expanded,
  onToggle,
  onOpenFile,
  depth = 0
}: {
  node: FileTreeNode;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (node: FileTreeNode) => void;
  depth?: number;
}) {
  const isDir = node.type === "directory";
  const isOpen = expanded.has(node.path);

  return (
    <div className="treeNode">
      <button
        type="button"
        className="treeLabel"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? onToggle(node.path) : onOpenFile(node))}
        title={isDir ? undefined : "Preview file"}
      >
        {isDir ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <FileCode2 size={13} />}
        <span className="treeName">{node.name}</span>
        {!isDir && <Eye size={12} className="treePreviewIcon" />}
      </button>
      {isDir && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} expanded={expanded} onToggle={onToggle} onOpenFile={onOpenFile} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
