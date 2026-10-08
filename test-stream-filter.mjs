/**
 * Regression test for src/main/assistantStreamFilter.ts.
 *
 * Run with:  node test-stream-filter.mjs
 *
 * The filter is what keeps raw tool JSON, file contents, shell payloads and
 * <thought> blocks out of the visible assistant answer while text is still
 * streaming. It is subtle enough that these cases must stay green.
 *
 * Compiles the two main-process modules it needs, then exercises them with the
 * same chunk boundaries a provider stream produces (a tool call is split across
 * many small chunks, which is exactly what used to leak raw JSON into chat).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-stream-filter");

// Invoke the local TypeScript compiler through node directly: spawning a
// .cmd shim is refused by recent Node versions on Windows.
execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/main/assistantStreamFilter.ts",
    "src/main/toolProtocol.ts",
    "src/renderer/src/lib/streamMarkdown.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

// tsc mirrors the source tree (src/main, src/renderer) into the output dir.
const { AssistantStreamFilter } = await import(`./.tmp-stream-filter/main/assistantStreamFilter.js`);
const { stabilizeStreamingMarkdown } = await import(`./.tmp-stream-filter/renderer/src/lib/streamMarkdown.js`);

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

/** Feed text in fixed-size pieces, mimicking a provider stream. */
function stream(text, size = 7, onThinking) {
  const f = new AssistantStreamFilter(onThinking);
  let out = "";
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  out += f.flush();
  return { out, dropped: f.droppedChars };
}

const BS = String.fromCharCode(92);
const Q = BS + '"'; // escaped-quote delimiter of the Puter NDJSON tool form

// 1. A big write_file call split into tiny chunks must never leak.
const html = '<!doctype html><html><head><style>body { color: "red"; }</style></head><body>{ok}</body></html>';
const toolCall = `{"name": "write_file", "arguments": {"path": "index.html", "content": ${JSON.stringify(html)}}}`;
const t1 = stream(`Sure, I'll create the page now.\n\n${toolCall}`);
check("1. split tool JSON never shown", t1.out.includes("write_file"), false);
check("1. split tool JSON body never shown", t1.out.includes("doctype"), false);
check("1. prose before tool call kept", t1.out.includes("create the page"), true);

// 2. Prose after a closed tool call resumes.
const t2 = stream(`${toolCall}\n\nDone — the page is ready.`);
check("2. prose after tool call kept", t2.out.includes("page is ready"), true);
check("2. tool call dropped", t2.out.includes("arguments"), false);

// 3. Genuine JSON in prose (non-tool name) is preserved.
const t3 = stream('Example config: {"name": "primary", "value": 3} works.');
check("3. non-tool JSON preserved", t3.out.includes('"name": "primary"'), true);

// 4. Tagged tool call is dropped entirely.
const t4 = stream('Working...\n<tool_call>{"name": "run_command", "arguments": {"command": "npm test"}}</tool_call>\nAll good.');
check("4. tagged tool call dropped", t4.out.includes("run_command"), false);
check("4. prose around tag kept", t4.out.includes("Working") && t4.out.includes("All good"), true);

// 5. <thought> routes to thinking, never to the answer.
let thoughts = "";
const t5 = stream("<thought>the user wants a dark theme</thought>Here is the answer.", 5, (t) => { thoughts += t; });
check("5. thought not in answer", t5.out.includes("dark theme"), false);
check("5. thought forwarded", thoughts.includes("dark theme"), true);
check("5. answer kept", t5.out.includes("Here is the answer"), true);

// 6. Escaped NDJSON Puter form: {\"name\": \"create_file\", ...}
const escaped = `{${Q}name${Q}: ${Q}create_file${Q}, ${Q}arguments${Q}: {${Q}path${Q}: ${Q}a.txt${Q}}}`;
const t6 = stream(`Making the file.\n${escaped}`);
check("6. escaped JSON dropped", t6.out.includes("create_file"), false);
check("6. escaped JSON args dropped", t6.out.includes("a.txt"), false);
check("6. prose kept", t6.out.includes("Making the file"), true);

// 7. Unterminated JSON at flush is dropped, never leaked.
const f7 = new AssistantStreamFilter();
let out7 = f7.push('Here you go: {"name": "write_file", "arguments": {"content": "<div>unclosed');
out7 += f7.flush();
check("7. unterminated JSON dropped", out7.includes("unclosed"), false);
check("7. lead prose kept", out7.includes("Here you go"), true);

// 8. Plain prose is emitted immediately (no artificial delay).
check("8. prose emitted immediately", new AssistantStreamFilter().push("The build succeeded."), "The build succeeded.");

// 9. A held trailing backtick is released on flush, not lost.
const f9 = new AssistantStreamFilter();
f9.push("Use the `npm test` command`");
check("9. trailing backtick released on flush", f9.flush().endsWith("`"), true);

// 10. Markdown code fences in a real answer survive untouched.
const t10 = stream("Here is the code:\n\n```html\n<div class=\"x\">hi</div>\n```\n\nThat's it.");
check("10. code fence preserved", t10.out.includes("```html"), true);
check("10. code body preserved", t10.out.includes('<div class="x">hi</div>'), true);
check("10. closing fence preserved", t10.out.includes("```\n\nThat's it"), true);

// 11. Fenced tool call is fully hidden, including both fences.
const t11 = stream('On it.\n```json\n{"name": "create_file", "arguments": {"path": "x"}}\n```\nFinished.');
check("11. fenced tool call hidden", t11.out.includes("create_file"), false);
check("11. no stray fence", t11.out.includes("```"), false);
check("11. surrounding prose kept", t11.out.includes("On it") && t11.out.includes("Finished"), true);

// 12. Fence opener arriving in its own chunk, tool call several chunks later.
const t12 = stream("Alright:\n\n```json\n" + toolCall + "\n```\n\nAll set.");
check("12. split fence+call hidden", t12.out.includes("write_file"), false);
check("12. no stray fence", t12.out.includes("```"), false);
check("12. prose kept", t12.out.includes("Alright") && t12.out.includes("All set"), true);

// 13. A fenced JSON block that is NOT a tool call stays visible.
const t13 = stream('Config example:\n\n```json\n{"name": "theme", "value": "dark"}\n```\n\nDone.');
check("13. non-tool fenced json kept", t13.out.includes('"name": "theme"'), true);
check("13. its fence kept", t13.out.includes("```json"), true);

// 14. HTML/JS content with quotes and braces cannot unbalance the scanner.
const nasty = '{"name":"write_file","arguments":{"path":"a.html","content":"<script>if (a) { b(\'}\') }</script>"}}';
const t14 = stream(`Writing it.\n${nasty}\n\nWritten.`);
check("14. nasty content dropped", t14.out.includes("<script>"), false);
check("14. nasty tool name dropped", t14.out.includes("write_file"), false);
check("14. prose kept", t14.out.includes("Written."), true);

// ─── Streaming-safe markdown (final response animation) ────────────────

// 15. An unterminated fence is closed so the tail keeps rendering as prose.
const f15 = stabilizeStreamingMarkdown("Here is the code:\n\n```html\n<div>hi</div>");
check("15. open fence closed", f15.endsWith("```"), true);
check("15. content preserved", f15.includes("<div>hi</div>"), true);

// 16. A fence marker still being typed is hidden, not flashed as backticks.
check("16. partial fence hidden", stabilizeStreamingMarkdown("Done.\n\n``"), "Done.\n\n");
check("16. partial fence with lang hidden", stabilizeStreamingMarkdown("Done.\n\n```js"), "Done.\n\n");

// 17. Balanced fences are left exactly as the model wrote them.
const complete = "Text\n\n```js\nconst a = 1;\n```\n\nMore text.";
check("17. balanced fences untouched", stabilizeStreamingMarkdown(complete), complete);

// 18. Inline code mid-line is never eaten.
const inline = "Run `npm test` to verify";
check("18. inline code preserved", stabilizeStreamingMarkdown(inline), inline);

// 19. Intentional small code examples survive streaming.
const example = "Example:\n\n```js\nconst example = true;\n```";
check("19. intentional code block preserved", stabilizeStreamingMarkdown(example), example);

// 20. A long prose answer with markdown headings/lists is never altered.
const prose = "Done — I updated the page.\n\n### What I changed\n\n- Fixed the HTML.\n- Updated the CSS.\n";
check("20. plain markdown untouched", stabilizeStreamingMarkdown(prose), prose);

console.log(failures === 0 ? "\nALL STREAM FILTER TESTS PASSED" : `\n${failures} STREAM FILTER TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
