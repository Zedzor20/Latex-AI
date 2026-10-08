/**
 * Streaming-safe markdown for the live assistant response.
 *
 * While a response is still arriving, partial markdown can visibly break the
 * layout: an unterminated fenced code block makes everything after it render
 * as code, and a half-typed fence marker shows up as stray backticks.
 *
 * This closes an open fence and hides a fence marker that is still being typed.
 * Nothing is altered permanently — the stored message is rendered from the
 * final text once the response completes.
 *
 * Only the fence is treated specially: inline code, lists, headings and
 * intentional small code examples all render exactly as the model wrote them.
 */
/** Count fenced-code markers (```), including one that is only half-typed. */
function fenceCount(text: string): number {
  return (text.match(/\n?[ \t]*```/g) ?? []).length;
}

export function stabilizeStreamingMarkdown(text: string): string {
  if (!text) return text;
  let out = text;

  // A marker still being typed at the start of a line ("`", "``", "```js")
  // would flash as literal backticks. Hide it only when it would OPEN a block
  // — an even number of complete fences before it. The same marker at the end
  // of a finished block is a closer and must stay.
  const partial = out.match(/(^|\n)[ \t]*(`{1,3}[a-zA-Z0-9+#-]*)$/);
  if (partial) {
    const before = out.slice(0, out.length - partial[2].length);
    if (fenceCount(before) % 2 === 0) out = before;
  }

  // A block that is genuinely open is closed for display, so the rest of the
  // message keeps rendering as prose instead of a giant code block.
  if (fenceCount(out) % 2 === 1) out += "\n```";

  return out;
}
