/**
 * Model Context Protocol (MCP) integration layer.
 *
 * This does NOT reimplement any filesystem logic. It adapts Latex's existing,
 * verified Electron main-process tool registry (`tools.ts`) to the MCP
 * tools/list + tools/call shape so local models and automation can consume
 * the same safe capabilities:
 *
 *   - same tool registry + schemas
 *   - same approval policy + preview + permission UI (never bypassed)
 *   - same executor (workspace boundary, path security, verification)
 *
 * The renderer never gains filesystem access from this module — everything
 * privileged happens in the Electron main process behind IPC.
 */
import {
  buildApprovalRequest,
  getTool,
  registry,
  type ApprovalPolicy,
  type ToolContext,
  type ToolDef
} from "./tools.js";

/** MCP tool descriptor (tools/list entry). */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool result (tools/call entry). */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** Latex's structured result (success/verified/path/…) when available. */
  structuredContent?: unknown;
}

/**
 * Convert Latex/Gemini-style parameter declarations (STRING/OBJECT/…)
 * into standard JSON Schema for the MCP inputSchema field.
 */
function toJsonSchema(decl: unknown): Record<string, unknown> {
  if (!decl || typeof decl !== "object") return { type: "string" };
  const d = decl as {
    type?: string;
    description?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
  };
  const upper = String(d.type ?? "").toUpperCase();
  const base: Record<string, unknown> = {};
  if (d.description) base.description = d.description;

  if (upper === "OBJECT") {
    base.type = "object";
    if (d.properties) {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(d.properties)) {
        properties[key] = toJsonSchema(value);
      }
      base.properties = properties;
    }
    if (Array.isArray(d.required) && d.required.length > 0) base.required = d.required;
    return base;
  }
  if (upper === "ARRAY") {
    base.type = "array";
    base.items = toJsonSchema(d.items);
    return base;
  }
  const typeMap: Record<string, string> = {
    STRING: "string",
    INTEGER: "integer",
    NUMBER: "number",
    BOOLEAN: "boolean"
  };
  base.type = typeMap[upper] ?? "string";
  return base;
}

/**
 * MCP tools/list — expose Latex's existing local capabilities.
 * `requiresWorkspace` tools are filtered when no workspace is available
 * (same rule the agent uses).
 */
export function listMcpTools(workspaceAvailable: boolean, mode: "workspace" | "full" = "workspace"): McpToolDescriptor[] {
  return registry
    .filter((tool) => !tool.requiresWorkspace || workspaceAvailable || mode === "full")
    .map((tool: ToolDef) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toJsonSchema(tool.parameters)
    }));
}

/**
 * MCP tools/call — execute through the EXISTING permission-gated executor.
 *
 * Flow (identical to the Main Agent tool pipeline):
 *   getTool → workspace boundary check → approvalPolicy → preview →
 *   USER APPROVES → tool.execute → structured result
 *
 * `requestApproval` must surface the request to the user and resolve with
 * their decision. Denials and failures return isError results — success is
 * never faked.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  requestApproval: (request: ReturnType<typeof buildApprovalRequest>) => Promise<boolean>,
  conversationId = "mcp"
): Promise<McpToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  if (tool.requiresWorkspace && !ctx.workspace && ctx.mode !== "full") {
    return {
      content: [{ type: "text", text: "This operation requires an approved workspace. Open a folder first (or enable Full PC Access in Settings)." }],
      isError: true
    };
  }

  let policy: ApprovalPolicy;
  try {
    policy = tool.approvalPolicy(args, ctx.settings);
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }

  try {
    if (policy.needed) {
      const preview = await tool.preview(ctx, args);
      const request = buildApprovalRequest(tool, args, policy, preview);
      const approved = await requestApproval(request);
      if (!approved) {
        return {
          content: [{ type: "text", text: "User denied operation" }],
          isError: true,
          structuredContent: { success: false, verified: false, error: "User denied operation", tool: name }
        };
      }
    }

    const result = await tool.execute(ctx, args);
    const serialized = typeof result === "string" ? result : safeStringify(result);
    const failed = result !== null && typeof result === "object" && "error" in (result as Record<string, unknown>);
    if (failed) {
      return { content: [{ type: "text", text: serialized }], isError: true, structuredContent: result };
    }
    return { content: [{ type: "text", text: serialized }], structuredContent: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void conversationId;
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      structuredContent: { success: false, verified: false, error: message, tool: name }
    };
  }
}

/** Never emit "[object Object]" to an MCP client. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
