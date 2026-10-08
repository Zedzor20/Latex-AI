/**
 * Normalization for PROVIDER-EXPOSED thinking text.
 *
 * Reasoning summaries arrive from many different upstreams and two things
 * routinely go wrong on the way:
 *
 *  1. Double-encoded text. Some proxies deliver the reasoning field as a JSON
 *     string inside the JSON chunk, so the Thinking box ends up rendering
 *     literal `\n\n` and `\"thinking box\"` instead of real line breaks.
 *     (`tryUnwrapJsonString` already handles this for normal text, but the
 *     reasoning channel had no equivalent.)
 *
 *  2. Markdown noise. Reasoning is not the answer: it is shown in a compact
 *     status box as plain text, so `**bold**` markers and `#` headings just
 *     read as clutter.
 *
 * The unescaping is deliberately conservative around Windows paths — a lone
 * `\n` followed by a letter is `C:\notes`, not a newline — so backslashes that
 * are part of real content survive.
 */

/** A run of escaped newlines is unambiguous, so the whole run is decoded. */
const ESCAPED_NEWLINE_RUN = /(?:\\r\\n|\\n){2,}/g;
/** A single `\n` is a newline only when it is not followed by a word character. */
const SINGLE_ESCAPED_NEWLINE = /\\n(?![A-Za-z0-9_])/g;
/** Tab escapes behave the same way (`\t` + letter is a path like `C:\temp`). */
const SINGLE_ESCAPED_TAB = /\\t(?![A-Za-z0-9_])/g;

function decodeEscapes(text: string): string {
  let out = text;
  out = out.replace(ESCAPED_NEWLINE_RUN, (run) => {
    const count = (run.match(/\\r\\n|\\n/g) ?? []).length;
    return "\n".repeat(Math.max(1, count));
  });
  out = out.replace(SINGLE_ESCAPED_NEWLINE, "\n");
  out = out.replace(SINGLE_ESCAPED_TAB, "\t");
  // Escaped quotes/slashes never appear in a real path or code sample that we
  // want to keep literally, but they do appear in double-encoded payloads.
  out = out.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\//g, "/");
  return out;
}

/** Strip the markdown that reads as clutter inside a compact status box. */
function stripMarkdownNoise(text: string): string {
  return text
    .split("\n")
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")   // headings
      .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold**
      .replace(/__(.+?)__/g, "$1")       // __bold__
      .trimEnd())
    .join("\n");
}

/**
 * Normalize one provider thinking/status string for display.
 *
 * Idempotent enough to run on every render of the accumulated buffer, which is
 * what keeps chunk-split escape sequences correct (they are only decoded once
 * the pair is complete in the text).
 */
export function normalizeThinkingText(text: string | undefined | null): string {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text;
  if (/\\[nrt"'/]/.test(out)) out = decodeEscapes(out);
  out = stripMarkdownNoise(out);
  // Collapse excessive blank lines without touching intentional paragraphs.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
