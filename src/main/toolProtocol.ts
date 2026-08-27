/**
 * Provider-independent structured tool protocol.
 *
 * Supports multiple tool call formats that different models may produce:
 * 1. <tool_call>{"name": "create_file", "arguments": {...}}</tool_call>
 * 2. <function_call>{"name": "create_file", ...}</function_call>
 * 3. {"name": "create_file", "arguments": {...}}   (bare JSON)
 * 4. [{"name": "create_file", ...}]                (bare JSON array)
 * 5. function_calls [{"name": "create_file", ...}] (Puter wrapper)
 * 6. ```json {"name": "create_file", ...} ```      (fenced JSON)
 * 7. Malformed tags mixed with bare JSON (Puter sometimes outputs this)
 * 8. Escaped JSON strings: "{\"name\":\"create_file\"...}" (Puter NDJSON)
 */

export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Known tool names in the Latex tool system. */
const KNOWN_TOOLS = new Set([
  "read_file", "write_file", "create_file", "edit_file", "delete_file",
  "rename_file", "move_file", "list_directory", "search_files",
  "create_directory", "get_workspace_info", "run_command", "list_files"
]);

const TOOL_NAME_LIST = [
  "read_file", "write_file", "create_file", "edit_file", "delete_file",
  "rename_file", "move_file", "list_directory", "search_files",
  "create_directory", "get_workspace_info", "run_command", "list_files"
];

const TOOL_NAME_PATTERN = TOOL_NAME_LIST.join("|");

// ─── Helpers ──────────────────────────────────────────────────────────────

function isToolCallLike(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  const name = String(r.name ?? r.tool ?? "").trim().toLowerCase();
  if (name && KNOWN_TOOLS.has(name)) return true;
  if (typeof r.arguments === "object" || typeof r.args === "object") return true;
  return false;
}

function hasToolName(text: string): boolean {
  if (!text) return false;
  for (const name of TOOL_NAME_LIST) {
    if (text.includes(`"${name}"`) || text.includes(`\\"${name}\\"`)) return true;
  }
  return false;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") return obj;
  } catch { /* skip */ }
  return null;
}

function extractJsonByBraces(text: string, fromIdx: number): Record<string, unknown> | null {
  let start = fromIdx;
  while (start > 0 && text[start] !== '{') start--;
  if (start < 0 || text[start] !== '{') return null;
  let depth = 0, end = start;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (depth !== 0 || end <= start) return null;
  let candidate = text.substring(start, end);
  // Unescape if needed
  if (candidate.includes('\\"')) {
    candidate = candidate.replace(/\\"/g, '"');
  }
  try {
    const obj = JSON.parse(candidate);
    if (isToolCallLike(obj)) return obj;
  } catch { /* skip */ }
  return null;
}

// ─── parseTextToolCalls ───────────────────────────────────────────────────

export function parseTextToolCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  const push = (obj: unknown) => {
    if (!isToolCallLike(obj)) return;
    const r = obj as Record<string, unknown>;
    const name = String(r.name ?? r.tool ?? "").trim();
    const argsRaw = r.arguments ?? r.args ?? {};
    calls.push({ name, args: (argsRaw && typeof argsRaw === "object" ? argsRaw : {}) as Record<string, unknown> });
  };

  let match: RegExpExecArray | null;

  // 1. <tool_call>...</tool_call>
  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  while ((match = tagRe.exec(text))) {
    try { push(JSON.parse(match[1].trim())); } catch { /* skip */ }
  }

  // 2. <function_call>...</function_call>
  const fnTagRe = /<function_call(?:s)?>\s*([\s\S]*?)\s*<\/function_call(?:s)?>/gi;
  while ((match = fnTagRe.exec(text))) {
    try { push(JSON.parse(match[1].trim())); } catch {
      for (const line of match[1].split(/\n+/)) {
        if (line.includes('"name"') || line.includes('\\"name\\"')) {
          try { push(JSON.parse(line.trim())); } catch { /* skip */ }
        }
      }
    }
  }

  // 3. Fenced JSON
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  while ((match = fenceRe.exec(text))) {
    try {
      const obj = tryParseJsonObject(match[1].trim());
      if (obj && isToolCallLike(obj)) push(obj);
    } catch { /* skip */ }
  }

  // If we already found calls from structured formats, return
  if (calls.length > 0) return calls;

  // 4. function_calls [...] wrapper
  const fnArrRe = /function_calls?\s*\[([\s\S]*?)\]/g;
  while ((match = fnArrRe.exec(text))) {
    try {
      const items = JSON.parse(`[${match[1]}]`);
      if (Array.isArray(items)) items.forEach(push);
    } catch { /* skip */ }
  }
  if (calls.length > 0) return calls;

  // 5. Bare JSON array [{...}]
  const arrRe = /\[\s*\{[^[\]]*"name"\s*:\s*"[^"]*"[^[\]]*\]/g;
  while ((match = arrRe.exec(text))) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) arr.forEach(push);
    } catch { /* skip */ }
  }
  if (calls.length > 0) return calls;

  // 6. Bare JSON object {...}
  const bareRe = /\{[^{}]*"name"\s*:\s*"[^"]*"[^{}]*\}/g;
  while ((match = bareRe.exec(text))) {
    const obj = tryParseJsonObject(match[0]);
    if (obj && isToolCallLike(obj)) push(obj);
  }
  if (calls.length > 0) return calls;

  // 7. Escaped JSON from Puter: {\"name\":\"create_file\",...}
  const escRe = /\{[^{}]*\\"name\\"\s*:\s*\\"[^\\"]*\\"[^{}]*\}/g;
  while ((match = escRe.exec(text))) {
    let candidate = match[0].replace(/\\"/g, '"');
    const obj = tryParseJsonObject(candidate);
    if (obj && isToolCallLike(obj)) push(obj);
  }
  if (calls.length > 0) return calls;

  // 8. Malformed Puter fragments - use brace matching
  const nameIdx = text.indexOf('"name"');
  if (nameIdx >= 0) {
    const obj = extractJsonByBraces(text, nameIdx);
    if (obj) push(obj);
  }
  const escNameIdx = text.indexOf('\\"name\\"');
  if (calls.length === 0 && escNameIdx >= 0) {
    let searchFrom = escNameIdx;
    while (searchFrom > 0 && text[searchFrom] !== '{') searchFrom--;
    if (searchFrom > 0) {
      const candidate = text.substring(searchFrom);
      let cleaned = candidate.replace(/\\"/g, '"');
      // Extract just the JSON object
      const braceStart = cleaned.indexOf('{');
      if (braceStart >= 0) {
        let depth = 0, end = braceStart;
        for (let i = braceStart; i < cleaned.length; i++) {
          if (cleaned[i] === '{') depth++;
          if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (depth === 0) {
          const obj = tryParseJsonObject(cleaned.substring(braceStart, end));
          if (obj && isToolCallLike(obj)) push(obj);
        }
      }
    }
  }

  return calls;
}

// ─── stripToolCallBlocks ──────────────────────────────────────────────────

/**
 * Remove all tool-protocol artifacts from a reply so the final message is
 * clean prose only. Uses a multi-pass approach to catch every variant.
 */
export function stripToolCallBlocks(text: string): string {
  if (!text) return "";
  let out = text;

  // Pass 1: Remove properly-tagged blocks
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  out = out.replace(/<function_call(?:s)?>[\s\S]*?<\/function_call(?:s)?>/gi, "");

  // Pass 2: Remove fenced JSON tool calls
  out = out.replace(/```(?:json)?\s*([\s\S]*?)```/g, (full, body: string) => {
    const obj = tryParseJsonObject(body.trim());
    if (obj && isToolCallLike(obj)) return "";
    return full;
  });

  // Pass 3: Remove function_calls wrapper + arrays
  out = out.replace(/function_calls?\s*\[?[\s\S]*?\]?\s*$/m, "");

  // Pass 4: Remove bare JSON arrays with tool names
  for (const name of TOOL_NAME_LIST) {
    const re = new RegExp(`\\[[^\\[]*"name"\\s*:\\s*"${name}"[^\\[]*\\]`, "g");
    out = out.replace(re, "");
  }

  // Pass 5: Remove bare JSON objects with tool names (unescaped)
  for (const name of TOOL_NAME_LIST) {
    const re = new RegExp(`\\{[^{}]*"name"\\s*:\\s*"${name}"[^{}]*\\}`, "g");
    out = out.replace(re, "");
  }

  // Pass 6: Remove escaped JSON objects with tool names
  for (const name of TOOL_NAME_LIST) {
    const re = new RegExp(`\\{[^{}]*\\\\"name\\\\"\\s*:\\s*\\\\"${name}\\\\"[^{}]*\\}`, "g");
    out = out.replace(re, "");
  }

  // Pass 7: Remove any remaining line that contains a tool name reference
  // This catches malformed fragments like: me": "create_file", "arguments": {...}
  for (const name of TOOL_NAME_LIST) {
    const re = new RegExp(`^.*"name"\\s*:\\s*"${name}"[^\\n]*$`, "gm");
    out = out.replace(re, "");
    const reEsc = new RegExp(`^.*\\\\"name\\\\"\\s*:\\s*\\\\"${name}\\\\"[^\\n]*$`, "gm");
    out = out.replace(reEsc, "");
  }

  // Pass 8: Remove orphaned tool tags
  out = out.replace(/<\/?function_call(?:s)?>/gi, "");
  out = out.replace(/<\/?tool_call>/gi, "");

  // Pass 9: Clean up empty JSON artifacts and excessive whitespace
  out = out.replace(/\{\s*\}/g, "");
  out = out.replace(/\[\s*\]/g, "");
  out = out.replace(/\n{3,}/g, "\n\n").trim();

  // Final check: if nothing meaningful remains, return empty
  const stripped = out.replace(/[\s\n\r]/g, "");
  if (stripped.length < 2) return "";

  return out;
}

// ─── containsToolCall ─────────────────────────────────────────────────────

/** True when a text reply contains a tool-protocol request. */
export function containsToolCall(text: string): boolean {
  if (!text) return false;
  if (/<tool_call/.test(text)) return true;
  if (/<function_call/.test(text)) return true;
  if (/"type"\s*:\s*"tool_call"/.test(text)) return true;
  if (/function_calls?\s*\[/.test(text)) return true;
  if (/```[\s\S]*"name"[\s\S]*```/.test(text)) return true;
  return hasToolName(text);
}

// ─── looksLikeToolCallJson ────────────────────────────────────────────────

/**
 * Heuristic: does accumulated text look like it could be an incomplete
 * JSON tool call split across streaming chunks?
 */
export function looksLikeToolCallJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"name"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return isToolCallLike(parsed);
    } catch {
      return true; // Incomplete JSON with "name" key is likely tool call
    }
  }
  if (trimmed.includes('{"name"') || trimmed.includes('\\"name\\"')) return true;
  if (/function_calls?\s*\[/.test(text)) return true;
  if (/"name"\s*:\s*"/.test(text) && hasToolName(text)) return true;
  return false;
}
