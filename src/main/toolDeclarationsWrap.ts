import type { FilesystemAccess } from "../shared/types.js";
import { toolDeclarations } from "./tools.js";
import { toolDeclarationsLocal } from "./toolDeclarationsLocal.js";

/**
 * Provider-aware tool declaration wrapper: local Ollama models get the reduced
 * schema (see toolDeclarationsLocal.ts); every other provider keeps the full
 * tool set unchanged.
 */
export function toolDeclarationsFor(
  workspaceAvailable: boolean,
  mode: FilesystemAccess = "workspace",
  localOllama = false
) {
  return localOllama
    ? toolDeclarationsLocal(workspaceAvailable, mode)
    : toolDeclarations(workspaceAvailable, mode);
}

// Re-export under the name agent.ts already imports for minimal diff.
export const toolDeclarationsExport = toolDeclarations;
