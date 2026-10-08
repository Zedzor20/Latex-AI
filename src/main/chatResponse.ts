/**
 * Chat response normalisation — the Chat tab must never look like it operated
 * on the workspace.
 *
 * Chat mode has no tools: no file writes, no terminal, no rendering. Local
 * models nevertheless *narrate* tool use — leaking `/thought>` markers, raw
 * `write_file` JSON, fake shell transcripts, or a plain sentence like
 * "I changed script.js". Two separate things have to happen:
 *
 *   1. PROTOCOL LEAKS are removed from the visible answer (they are internal
 *      execution payload, not conversation).
 *   2. FAKE WORKSPACE CLAIMS are detected and reported honestly. They are NOT
 *      silently rewritten: the model's text stays as the model's explanation,
 *      and the caller attaches a boundary notice so the user can tell
 *      "model explanation" apart from "real Latex tool operation".
 *
 * Legitimate code examples are preserved. A fenced ```js block is stripped only
 * when it parses as a tool call for a known Latex tool — an example of editing
 * a JavaScript file is exactly what the user may have asked for.
 */

import { isKnownToolName, stripProtocolArtifacts } from "./toolProtocol.js";

export interface WorkspaceClaimReport {
  /** The model stated that it created/edited/deleted files or folders. */
  fileChange: boolean;
  /** The model stated that it ran a command/test/build in the workspace. */
  commandRun: boolean;
  /** The sentences that triggered the report (for diagnostics/meta). */
  matches: string[];
}

export interface ChatNormalizationResult {
  /** Answer text with internal protocol artifacts removed. */
  text: string;
  claims: WorkspaceClaimReport;
  /** True when protocol artifacts (markers/JSON) were removed. */
  strippedProtocol: boolean;
}

/** Verb phrases a model uses when it believes it acted on the filesystem. */
const CLAIM_VERB =
  /\b(?:i|we)\s+(?:have\s+|just\s+|already\s+|successfully\s+)?(?:changed|updated|modified|created|added|wrote|written|deleted|removed|renamed|moved|edited|patched|implemented|rebuilt|built|generated|saved)\b|\b(?:changes?|edits?|updates?)\s+(?:have|has)\s+been\s+(?:applied|saved|written|made)\b|\b(?:the|your|this|that)\s+[\w./\\-]+\s+(?:has|have)\s+been\s+(?:created|updated|modified|changed|deleted|renamed|written|added)\b|\bi'?ve\s+(?:changed|updated|created|modified|written|added|deleted|edited|built|implemented)\b/i;

/** Something that looks like a file or a workspace object. */
const CLAIM_TARGET =
  /[`'"][\w./\\-]+\.[a-z0-9]{1,8}[`'"]|\b[\w-]+\.(?:html?|css|js|mjs|cjs|jsx|tsx?|json|py|md|txt|yml|yaml|xml|svg|sh|ps1|rb|go|rs|java|c|cpp|cs)\b|\b(?:the|your|this|that|a|new)\s+(?:file|folder|directory|project|workspace|codebase|repo|repository|code|script|page|app|application|site|website|component|module|class|stylesheet|markup|environment|renderer|simulation|game|scene|canvas|level|sprite|world)\b/i;

/** Command/test execution claims. */
const COMMAND_CLAIM =
  /\b(?:i|we)\s+(?:have\s+|just\s+|already\s+|successfully\s+)?(?:ran|run|executed|launched|started)\b|\b(?:command|build|test|tests|script)\s+(?:completed|succeeded|passed|finished)\b|\bexit\s+code\s+0\b/i;

/** Backticked command that looks like a shell invocation. */
const SHELL_SNIPPET = /`(?:npm|npx|yarn|pnpm|node|pip|python\d?|git|tsc|vite|jest|pytest|dotnet|cargo|go)\s+[^`]{1,80}`/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Report whether the model claimed to have performed workspace operations.
 *
 * This is intentionally conservative: it only fires on first-person past-tense
 * action language tied to a file/workspace object, so a normal explanation
 * ("the file would need to be changed like this") is left alone.
 */
export function detectWorkspaceClaims(text: string): WorkspaceClaimReport {
  const report: WorkspaceClaimReport = { fileChange: false, commandRun: false, matches: [] };
  if (!text) return report;
  for (const sentence of splitSentences(text)) {
    const verb = CLAIM_VERB.test(sentence);
    const target = CLAIM_TARGET.test(sentence);
    const command = COMMAND_CLAIM.test(sentence) || (SHELL_SNIPPET.test(sentence) && /(?:i|we)\s+\w*\s*(?:ran|run|executed)/i.test(sentence));
    if (verb && target) {
      report.fileChange = true;
      if (report.matches.length < 5) report.matches.push(sentence.slice(0, 160));
      continue;
    }
    if (command) {
      report.commandRun = true;
      if (report.matches.length < 5) report.matches.push(sentence.slice(0, 160));
    }
  }
  return report;
}

/** True when a fenced block parses as a call to a real Latex tool. */
function isToolInvocationJson(body: string): boolean {
  const trimmed = body.trim().replace(/^json\s*/i, "");
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const objects = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of objects) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = record.name ?? record.tool ?? (record.function as Record<string, unknown> | undefined)?.name;
    if (typeof name === "string" && isKnownToolName(name)) return true;
  }
  return false;
}

/**
 * Remove internal protocol from a Chat answer.
 *
 * Handles the leaked `/thought>` marker, orphaned thought tags, fenced or bare
 * JSON tool invocations, and `write_file`-shaped payloads. Genuine code and
 * prose survive untouched.
 */
export function normalizeChatResponse(raw: string): ChatNormalizationResult {
  const original = raw ?? "";
  let text = original;
  let stripped = false;

  // Fenced tool invocations: ```json {"name": "write_file", ...} ```
  text = text.replace(/```(?:json|javascript|js|text)?\s*([\s\S]*?)```/g, (full, body: string) => {
    if (isToolInvocationJson(String(body))) {
      stripped = true;
      return "";
    }
    return full;
  });

  // Bare JSON tool invocations, with or without a surrounding <tool_call> tag.
  text = text.replace(/\{\s*"(?:name|tool)"\s*:\s*"[^"]{1,40}"[\s\S]{0,4000}?\}\s*\}/g, (full) => {
    const nameMatch = full.match(/"(?:name|tool)"\s*:\s*"([^"]{1,40})"/);
    if (nameMatch && isKnownToolName(nameMatch[1])) {
      stripped = true;
      return "";
    }
    return full;
  });
  text = text.replace(/\[\s*\{\s*"(?:name|tool)"[\s\S]{0,4000}?\}\s*\]/g, (full) => {
    const nameMatch = full.match(/"(?:name|tool)"\s*:\s*"([^"]{1,40})"/);
    if (nameMatch && isKnownToolName(nameMatch[1])) {
      stripped = true;
      return "";
    }
    return full;
  });

  // Leaked reasoning marker used by some local model templates. The capture
  // group keeps the leading whitespace that separated it from the answer.
  if (/\/thought>|<\/?thought\b/i.test(text)) stripped = true;
  text = text.replace(/(^|\s)\/?thought>\s*/gi, "$1");
  text = text.replace(/<\/?thought(?:\s[^>]*)?>/gi, "");

  // Existing protocol cleanup (tool_call tags, escaped JSON, orphaned keys).
  const cleaned = stripProtocolArtifacts(text, true);
  if (cleaned !== text.trim()) stripped = true;
  text = cleaned;

  if (!text.trim()) {
    text = "I don't have enough to answer that in Chat mode. Ask again, or switch to **Main** if you want Latex to change files.";
  }

  return { text, claims: detectWorkspaceClaims(text), strippedProtocol: stripped };
}

/** Honest boundary note attached when a Chat reply claims workspace changes. */
export function chatBoundaryNotice(claims: WorkspaceClaimReport): string {
  if (!claims.fileChange && !claims.commandRun) return "";
  const what = claims.fileChange && claims.commandRun
    ? "files were changed and commands were run"
    : claims.fileChange
      ? "files were changed"
      : "commands were run";
  return `_(Chat mode has no file or terminal access — the reply above says ${what}, but nothing was changed on disk. Switch to **Main** to have Latex actually do it.)_`;
}
