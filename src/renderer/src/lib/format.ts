import type { FileTreeNode, GeminiModel } from "../../../shared/types";

export function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/** Flatten a file tree into path strings (directories and files). */
export function flattenTree(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (items: FileTreeNode[], prefix: string) => {
    for (const node of items) {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      out.push(path);
      if (node.children) walk(node.children, path);
    }
  };
  walk(nodes, "");
  return out;
}

/** A short capability tag derived from model metadata. */
export function modelCapability(model: GeminiModel): string | undefined {
  if (model.supportsVision) return "Vision";
  if (model.supportsReasoning) return "Reasoning";
  const context = model.contextLength ?? model.inputTokenLimit ?? 0;
  if (context >= 1_000_000) return "Long context";
  const description = `${model.description ?? ""} ${model.displayName ?? ""}`.toLowerCase();
  if (/vision|image/.test(description)) return "Vision";
  if (/long|context/.test(description) || context >= 1_000_000) return "Long context";
  if (/flash|fast|light|mini/.test(description) || (context > 0 && context <= 256_000)) return "Fast";
  return undefined;
}

export function formatCommandOutput(output: string): string {
  return output.trim() || "(no output)";
}
