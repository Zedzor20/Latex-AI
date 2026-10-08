import type { FilesystemAccess } from "../shared/types.js";
import { registry } from "./tools.js";

/**
 * Reduced tool declarations for LOCAL Ollama models.
 *
 * Mirrors toolCatalogTextLocal(): PC-control tools (mouse/keyboard/screenshot)
 * are excluded from the function-call schema sent to local models. The full
 * registry still executes them — this only trims what the model can request.
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

/** Same shape as tools.ts toolDeclarations(), but filtered for local models. */
export function toolDeclarationsLocal(workspaceAvailable: boolean, mode: FilesystemAccess = "workspace") {
  return [{
    functionDeclarations: registry
      .filter((tool) => LOCAL_TOOLS.has(tool.name))
      .filter((tool) => !tool.requiresWorkspace || workspaceAvailable || mode === "full")
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
  }];
}
