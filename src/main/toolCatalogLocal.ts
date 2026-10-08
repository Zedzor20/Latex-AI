import { registry } from "./tools.js";

/**
 * Compact tool catalog for LOCAL Ollama models.
 *
 * The full catalog (33 tools, ~2.5k chars) costs small models thousands of
 * prompt tokens. Local models only get the tools that make sense for coding
 * tasks; PC-control tools (mouse/keyboard/screenshot/clipboard) are dropped,
 * and descriptions are shortened.
 */
const LOCAL_TOOLS = new Set([
  "list_directory",
  "read_file",
  "search_files",
  "search_project",
  "file_exists",
  "get_file_info",
  "create_file",
  "write_file",
  "edit_file",
  "copy_file",
  "rename_file",
  "create_directory",
  "delete_file",
  "delete_directory",
  "run_command",
  "get_workspace_info",
  "get_platform_info"
]);

const SHORT_DESCRIPTIONS: Record<string, string> = {
  list_directory: "List files in a directory.",
  read_file: "Read a text/code file.",
  search_files: "Find files by name.",
  search_project: "Search file contents for text.",
  file_exists: "Check whether a file exists.",
  get_file_info: "Get size/dates/type for a file.",
  create_file: "Create a new file with content.",
  write_file: "Overwrite a file with new content.",
  edit_file: "Replace text in a file (prefer for small changes).",
  copy_file: "Copy a file.",
  rename_file: "Rename or move a file.",
  create_directory: "Create a directory.",
  delete_file: "Delete a file.",
  delete_directory: "Delete a directory and contents.",
  run_command: "Run a shell command in the workspace.",
  get_workspace_info: "Get workspace metadata (frameworks, file count).",
  get_platform_info: "Get OS/runtime info."
};

/** Compact one-line-per-tool catalog for local models. */
export function toolCatalogTextLocal(): string {
  return registry
    .filter((tool) => LOCAL_TOOLS.has(tool.name))
    .map((tool) => {
      const params = tool.parameters as { required?: string[] } | undefined;
      const required = params?.required ?? [];
      const args = required.length > 0 ? required.join(", ") : "";
      return `- ${tool.name}${args ? `(${args})` : ""} — ${SHORT_DESCRIPTIONS[tool.name] ?? tool.description}`;
    })
    .join("\n");
}
