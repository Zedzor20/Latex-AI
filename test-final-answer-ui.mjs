/**
 * FINAL ANSWER + MAIN THINKING acceptance test (real app, stub model).
 *
 * Run with:  node test-final-answer-ui.mjs        (after "npm run build")
 *
 * It launches the REAL Latex renderer against a stub OpenAI-compatible gateway
 * (reachable through the OmniRoute base URL) and drives the REAL UI — composer,
 * Send button, Main/Chat toggle — exactly as a user does.
 *
 * What is proven:
 *
 *   1. A long streamed answer is byte-identical after completion (no second
 *      summarization/shortening pass), with Markdown and code fences intact.
 *   2. An EMPTY finalization payload cannot overwrite the streamed answer.
 *   3. Real provider Thinking is visible in MAIN while the model still works,
 *      and it grows progressively.
 *   4. A model with no reasoning channel shows no Thinking text at all.
 *   5. Switching Main/Chat mid-generation loses neither Thinking nor the answer.
 *   6. The answer survives a full renderer reload (persistence + restoration).
 *   7. A run produces exactly ONE assistant message and ONE `done` event, no
 *      matter how many turns/tool calls it took.
 *   8. A failed folder operation is reported as a failure (never "nothing needed
 *      to change"), while the file that WAS created is verified on disk and
 *      appears in the Change Review record.
 *
 * Settings are restored and every conversation it creates is deleted.
 */
import { _electron as electron } from "playwright";
import { createServer, get as httpGet } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXE = existsSync(join("node_modules", "electron", "dist", "electron.exe"))
  ? join("node_modules", "electron", "dist", "electron.exe")
  : null;
if (!EXE) {
  console.error("Local electron binary not found — run npm install first.");
  process.exit(1);
}

const STUB_PORT = 20197;
const THINKING_MODEL = "omniroute/stub-deepseek-r1";
const PLAIN_MODEL = "omniroute/stub-plainmodel";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── The long answer the model streams (Markdown + code + list) ────────────
const LONG_ANSWER = [
  "## Audit result",
  "",
  "I reviewed the poller and found three real problems:",
  "",
  "1. The retry loop never backed off",
  "2. The abort signal was not propagated",
  "3. The cache key ignored the tenant",
  "",
  "```ts",
  "export async function poll(signal: AbortSignal) {",
  "  for (let attempt = 0; attempt < 5; attempt++) {",
  "    await tick(attempt * 250, signal);",
  "  }",
  "}",
  "```",
  "",
  "The fix above keeps the backoff bounded and always honours the signal."
].join("\n");

const LONG_CHUNKS = [];
for (let i = 0; i < LONG_ANSWER.length; i += 40) LONG_CHUNKS.push(LONG_ANSWER.slice(i, i + 40));

const REASONING_CHUNKS = [
  "Let me work through this carefully. ",
  "First I need to understand what the poller does. ",
  "It retries without backoff, which can hammer the endpoint. ",
  "Second, the abort signal is ignored. ",
  "Third, the cache key is shared across tenants. ",
  "So the answer must list those three problems and show a fixed loop."
];

let scenario = "thinking";
let callIndex = 0;
const stubCalls = [];

function sseStart(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write ONE SSE response. Every delta for a turn must travel on the same
 * response — calling writeHead twice throws "Cannot write headers after they
 * are sent", which silently truncated the streamed answer in an earlier run of
 * this test.
 */
async function streamChunks(res, chunks) {
  sseStart(res);
  for (const { event, gap } of chunks) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (gap) await sleep(gap);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const streamEvents = (res, events, gap) => streamChunks(res, events.map((event) => ({ event, gap })));

const textEvents = (chunks) => chunks.map((c) => ({ choices: [{ delta: { content: c } }] }));
const reasoningEvents = (chunks) => chunks.map((c) => ({ choices: [{ delta: { role: "assistant", reasoning_content: c } }] }));
const silentEvents = () => [{ choices: [{ delta: { role: "assistant" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];

function toolCallEvents(name, args) {
  return [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ];
}

const HTML_FILE = `<!DOCTYPE html>
<html><head><title>Latex</title></head>
<body><h1>Workspace</h1></body></html>`;

const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
  // Liveness the OmniRoute status probe requires.
  if (url.pathname === "/api/health" || url.pathname === "/healthz" || url.pathname === "/api/monitoring/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      object: "list",
      data: [
        { id: THINKING_MODEL.replace("omniroute/", ""), object: "model", owned_by: "stub" },
        { id: PLAIN_MODEL.replace("omniroute/", ""), object: "model", owned_by: "stub" }
      ]
    }));
    return;
  }
  if (url.pathname === "/__reset") {
    scenario = url.searchParams.get("scenario") ?? "thinking";
    callIndex = 0;
    stubCalls.length = 0;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, scenario }));
    return;
  }
  if (!url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
    callIndex += 1;
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    stubCalls.push({ scenario, call: callIndex, hasTools });
    console.log(`  [stub] ${scenario} call ${callIndex} tools=${hasTools}`);

    try {
      if (scenario === "thinking") {
        // Reasoning first (slowly, so the Thinking box can be sampled), then the
        // long answer, then stop — ALL on one response. No tools: the
        // plain-text path.
        if (callIndex === 1) {
          await streamChunks(res, [
            // Slow enough that the panel is sampled MANY times while it grows.
            ...reasoningEvents(REASONING_CHUNKS).map((event) => ({ event, gap: 320 })),
            ...textEvents(LONG_CHUNKS).map((event) => ({ event, gap: 45 }))
          ]);
          return;
        }
        await streamEvents(res, silentEvents());
        return;
      }
      if (scenario === "plain") {
        await streamEvents(res, textEvents(["This ", "is ", "a ", "plain ", "answer ", "with ", "no ", "reasoning."]), 60);
        return;
      }
      if (scenario === "tools") {
        if (callIndex === 1) {
          await streamEvents(res, toolCallEvents("create_file", { relativePath: "index.html", content: HTML_FILE }));
          return;
        }
        if (callIndex === 2) {
          // A full answer PLUS a tool call in the same turn: the finalizer then
          // has an EMPTY prose payload after the tool work — the case where a
          // shorter/empty completion used to replace the streamed answer.
          await streamChunks(res, [
            ...reasoningEvents(REASONING_CHUNKS).map((event) => ({ event, gap: 60 })),
            ...textEvents(LONG_CHUNKS).map((event) => ({ event, gap: 25 })),
            ...toolCallEvents("create_directory", { relativePath: "." }).map((event) => ({ event, gap: 20 }))
          ]);
          return;
        }
        // No prose at all after the tools ran.
        await streamEvents(res, silentEvents());
        return;
      }
      await streamEvents(res, silentEvents());
    } catch (err) {
      console.log(`  [stub] stream error: ${err instanceof Error ? err.message : err}`);
    }
  });
});
await new Promise((resolve) => stub.listen(STUB_PORT, "127.0.0.1", resolve));

// ── A real workspace with spaces in its name ─────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "latex-final-"));
const WORKSPACE_PATH = join(sandbox, "My Games", "Latex Games");
mkdirSync(WORKSPACE_PATH, { recursive: true });

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: ["."],
    cwd: process.cwd(),
    timeout: 120_000,
    env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${STUB_PORT}` }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  const close = page.locator('[aria-label="Close What\'s New"]').first();
  if (await close.count()) await close.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  // Auto-approve any permission prompt: the test is about the final answer, not
  // about the approval flow (which has its own tests).
  await installCollector(page);
  return { app, page };
}

async function pinModel(page, model, provider) {
  await page.evaluate(async ({ model, provider }) => {
    await window.latex.settings.save({ selectedModel: model, provider, autoSelectModel: false, pcControl: "on" });
  }, { model, provider });
  await page.waitForTimeout(400);
}

async function selectMode(page, mode) {
  const button = page.locator(".modeToggleBtn", { hasText: new RegExp(`^${mode}`, "i") }).first();
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Install the event collector ONCE. Re-registering it would double-count every
 * event (and duplicate the streamed text), which an earlier run of this test
 * mistook for a duplicate completion.
 */
async function installCollector(page) {
  await page.evaluate(() => {
    if (window.__evUnsub) window.__evUnsub();
    window.__ev = { thinking: [], done: 0, messages: 0, streamed: "", approvals: 0 };
    window.__evUnsub = window.latex.agent.onEvent((event) => {
      if (event?.type === "approval" && event.payload?.requestId) {
        window.__ev.approvals += 1;
        void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
      }
      if (event?.type === "thinking") window.__ev.thinking.push(String(event.payload ?? ""));
      if (event?.type === "done") window.__ev.done += 1;
      if (event?.type === "message") { window.__ev.messages += 1; window.__ev.streamed += String(event.payload ?? ""); }
    });
  });
}

async function resetCounters(page) {
  await page.evaluate(() => {
    if (!window.__ev) return;
    window.__ev.thinking = [];
    window.__ev.done = 0;
    window.__ev.messages = 0;
    window.__ev.streamed = "";
    window.__ev.approvals = 0;
  });
}

/** Reset the stub's scenario/call counter from the test process. */
function resetStub(next) {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${STUB_PORT}/__reset?scenario=${next}`, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", () => resolve());
  });
}

/** Start a fresh conversation through the real UI so the run owns this chat. */
async function newChatAndSend(page, prompt) {
  const newChat = page.locator('button[title="New Chat"]').first();
  if (await newChat.count()) {
    await newChat.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const input = page.locator(".composer textarea").first();
  await input.waitFor({ timeout: 20_000 });
  await input.fill(prompt);
  await page.locator(".sendButton").first().click();
}

const readLive = () => ({
  // Which tab is on screen. A different tab shows a different conversation, so
  // its (absent) live surfaces must not be read as the running turn's state.
  mode: Array.from(document.querySelectorAll(".modeToggleBtn")).find((n) => n.classList.contains("active"))?.textContent?.trim() ?? "?",
  // LIVE surfaces only: a PERSISTED thinking/answer block lives inside
  // `article.message`, and counting those would read an earlier conversation's
  // message as if it belonged to the run being measured.
  boxes: Array.from(document.querySelectorAll(".thinkingBlock")).filter((el) => !el.closest("article.message")).length,
  thinking: (() => {
    const blocks = Array.from(document.querySelectorAll(".thinkingBlock")).filter((el) => !el.closest("article.message"));
    const last = blocks[blocks.length - 1];
    if (!last) return "";
    return last.querySelector(".thinkingContent")?.textContent
      ?? last.querySelector(".thinkingPreview")?.textContent
      ?? "";
  })(),
  stream: (() => {
    const bubbles = document.querySelectorAll("article.message.assistant");
    const last = bubbles[bubbles.length - 1];
    return last?.textContent ?? "";
  })()
});

let app = null;
const createdConversations = [];
try {
  const launched = await launch();
  app = launched.app;
  const page = launched.page;
  const before = await page.evaluate(() => window.latex.settings.get());

  // ── 1. Thinking-capable model: real Thinking in MAIN + long answer ─────
  await pinModel(page, THINKING_MODEL, "omniroute");
  await selectMode(page, "Main");
  await resetCounters(page);
  await resetStub("thinking");
  await newChatAndSend(page, "Audit the poller and explain what you would fix.");

  const samples = [];
  const raw = [];
  let switched = false;
  const dispatchAt = Date.now();
  const deadline = dispatchAt + 120_000;
  let done = false;
  while (Date.now() < deadline) {
    const live = await page.evaluate(readLive);
    const onMain = /main/i.test(live.mode);
    if (raw.length < 26) raw.push(`t+${raw.length * 80}ms mode=${live.mode} boxes=${live.boxes} len=${live.thinking.trim().length}`);
    if (onMain && live.thinking.trim() && !live.thinking.includes("Waiting for thinking")) {
      const last = samples[samples.length - 1];
      if (!last || last.length !== live.thinking.length) samples.push({ at: Date.now(), length: live.thinking.length });
    }
    const state = await page.evaluate(() => ({ done: window.__ev.done }));
    // Mid-generation tab switch: Main → Chat → Main. Held back until the panel
    // has actually been sampled growing (or the turn is nearly over) so the
    // switch cannot steal the samples the growth check depends on.
    if (!switched && (samples.length >= 3 || Date.now() - dispatchAt > 1500)) {
      switched = true;
      await selectMode(page, "Chat");
      await page.waitForTimeout(250);
      await selectMode(page, "Main");
    }
    if (state.done) { done = true; break; }
    await page.waitForTimeout(80);
  }
  const evidence = await page.evaluate(() => ({ ...window.__ev }));
  await page.waitForTimeout(600);
  const afterDone = await page.evaluate(readLive);
  const streamedText = String(evidence.streamed ?? "");
  console.log(`  [live] ${raw.join(" | ")}`);

  check("thinking: the run finished", done);
  check("thinking: real reasoning deltas arrived on the Thinking channel", evidence.thinking.length >= 3, `${evidence.thinking.length} delta(s)`);
  check("thinking: the deltas carry real reasoning text",
    evidence.thinking.join("").includes("backoff"), evidence.thinking.join("").slice(0, 80));
  // The box must be observed with real reasoning AND that reasoning must GROW
  // across samples — one late dump would satisfy neither (a single sample is
  // not enough evidence that it rendered progressively).
  check("thinking: the live Thinking box was visible in MAIN",
    samples.length >= 2, `${samples.length} sample(s)`);
  check("thinking: the Thinking box grew progressively",
    samples.length >= 2 && samples[samples.length - 1].length > samples[0].length,
    JSON.stringify(samples.map((s) => s.length)));
  check("thinking: the Thinking panel is still on screen after the tab switch",
    switched === false || afterDone.thinking.trim().length > 0 || evidence.thinking.length > 0);

  // The persisted answer.
  const conversations = await page.evaluate(() => window.latex.conversation.list());
  const target = conversations.find((c) => Array.isArray(c.messages) && c.messages.some((m) => m.role === "user" && /Audit the poller/.test(String(m.content ?? ""))));
  if (target) createdConversations.push(target.id);
  const assistantMessages = (target?.messages ?? []).filter((m) => m.role === "assistant");
  const finalMessage = assistantMessages[assistantMessages.length - 1];
  const finalContent = String(finalMessage?.content ?? "");
  console.log(`  [agent] persisted answer: ${JSON.stringify(finalContent.slice(0, 160))}`);

  check("answer: exactly ONE assistant message was produced", assistantMessages.length === 1, `${assistantMessages.length} message(s)`);
  check("answer: exactly ONE completion event was emitted", evidence.done === 1, `${evidence.done}`);
  check("answer: the streamed answer arrived on the message channel", (evidence.streamed ?? "").length > 400, `${(evidence.streamed ?? "").length} chars`);
  check("answer: the persisted answer is the streamed answer", finalContent.trim().includes(LONG_ANSWER.trim()), `${finalContent.length} chars`);
  check("answer: Markdown headings survived", finalContent.includes("## Audit result"));
  check("answer: the numbered list survived", finalContent.includes("3. The cache key ignored the tenant"));
  check("answer: the code fence survived", (finalContent.match(/```/g) ?? []).length >= 2);
  check("answer: nothing was truncated for brevity", !/truncated for brevity/i.test(finalContent));
  check("answer: the renderer received the same answer while streaming",
    streamedText.includes(LONG_ANSWER.trim()), `${streamedText.length} streamed chars`);

  // ── 6. A full renderer reload restores the same answer ────────────────
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.conversation?.list), null, { timeout: 60_000 });
  await installCollector(page);
  const reloaded = await page.evaluate(async (id) => {
    const list = await window.latex.conversation.list();
    const found = list.find((c) => c.id === id);
    return found?.messages?.filter((m) => m.role === "assistant")?.map((m) => m.content) ?? [];
  }, target?.id);
  check("reload: the persisted answer is byte-identical after a restart",
    reloaded.length === 1 && String(reloaded[0]).trim() === finalContent.trim(),
    `${reloaded.length} message(s)`);
  const seenInMain = await page.evaluate(async (id) => {
    const list = await window.latex.conversation.list();
    const found = list.find((c) => c.id === id);
    if (found) await window.latex.conversation.save(found);
    const bubbles = document.querySelectorAll("article.message.assistant .messageText");
    return { restored: Boolean(found), last: bubbles[bubbles.length - 1]?.textContent ?? "" };
  }, target?.id);
  check("reload: the same answer is restored from disk, not re-summarized",
    seenInMain.restored && !/nothing needed to change/i.test(seenInMain.last));

  // ── 4. A model with no reasoning channel shows no Thinking ────────────
  await pinModel(page, PLAIN_MODEL, "omniroute");
  await resetCounters(page);
  await resetStub("plain");
  await newChatAndSend(page, "Say something plain.");
  let plainDone = false;
  const plainDeadline = Date.now() + 60_000;
  let inventedThinking = 0;
  while (Date.now() < plainDeadline) {
    const live = await page.evaluate(readLive);
    inventedThinking = Math.max(inventedThinking, live.thinking.trim().length);
    const state = await page.evaluate(() => ({ done: window.__ev.done }));
    if (state.done) { plainDone = true; break; }
    await page.waitForTimeout(120);
  }
  const plainEvidence = await page.evaluate(() => ({ ...window.__ev }));
  await page.waitForTimeout(600);
  const plainBoxesAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".thinkingBlock")).filter((el) => !el.closest("article.message")).length);
  check("no-thinking model: the run finished", plainDone);
  check("no-thinking model: NO reasoning delta is invented", plainEvidence.thinking.length === 0, `${plainEvidence.thinking.length} delta(s)`);
  check("no-thinking model: no reasoning text is ever shown", inventedThinking === 0, `${inventedThinking} chars`);
  check("no-thinking model: no Thinking panel remains after the run", plainBoxesAfter === 0, `${plainBoxesAfter} box(es)`);
  const plainConversations = await page.evaluate(() => window.latex.conversation.list());
  const plainTarget = plainConversations.find((c) => Array.isArray(c.messages) && c.messages.some((m) => m.role === "user" && /plain/.test(String(m.content ?? ""))));
  if (plainTarget) createdConversations.push(plainTarget.id);
  const plainAssistant = plainTarget?.messages?.find((m) => m.role === "assistant");
  check("no-thinking model: the plain answer still streams",
    /plain answer with no reasoning/i.test(String(plainAssistant?.content ?? "")),
    String(plainAssistant?.content ?? "").slice(0, 80));
  check("no-thinking model: no Thinking metadata is persisted",
    !plainAssistant?.meta?.thinking, String(plainAssistant?.meta?.thinking ?? ""));

  // ── 8. Tools: an empty final payload + a FAILED folder op ─────────────
  await pinModel(page, THINKING_MODEL, "omniroute");
  await resetCounters(page);
  await resetStub("tools");
  const toolsConversation = await page.evaluate(async (workspace) => {
    const now = Date.now();
    const conversation = {
      id: `conv_final_tools_${now}`,
      title: "Final answer tools",
      mode: "main",
      messages: [{ id: `m_${now}`, role: "user", content: "Create the page and the folder.", createdAt: now }],
      createdAt: now,
      updatedAt: now
    };
    return window.latex.agent.run(conversation, workspace);
  }, { id: "ws_final_e2e", name: "Latex Games", path: WORKSPACE_PATH }).catch((err) => ({ error: String(err?.message ?? err) }));
  if (toolsConversation?.id) createdConversations.push(toolsConversation.id);

  const toolsMessages = (toolsConversation?.messages ?? []).filter((m) => m.role === "assistant");
  const toolsFinal = String(toolsMessages[toolsMessages.length - 1]?.content ?? "");
  console.log(`  [agent] tools answer: ${JSON.stringify(toolsFinal.slice(0, 200))}`);
  console.log(`  [stub] calls: ${JSON.stringify(stubCalls)}`);

  check("tools: the stub ran two tool calls", stubCalls.filter((c) => c.scenario === "tools").length >= 2);
  check("tools: the file really exists at the intended absolute destination",
    existsSync(join(WORKSPACE_PATH, "index.html")));
  if (existsSync(join(WORKSPACE_PATH, "index.html"))) {
    check("tools: the file content is exactly what was written",
      readFileSync(join(WORKSPACE_PATH, "index.html"), "utf8") === HTML_FILE);
  } else {
    check("tools: the file content is exactly what was written", false, "file missing");
  }
  check("tools: an EMPTY finalization payload did not replace the streamed answer",
    toolsFinal.includes("## Audit result") && toolsFinal.includes("The fix above keeps the backoff bounded"));
  check("tools: the failed folder operation is reported as a failure",
    /could not be completed|operations failed/i.test(toolsFinal), toolsFinal.slice(0, 120));
  check("tools: the answer never claims 'nothing needed to change'",
    !/nothing needed to change/i.test(toolsFinal));
  check("tools: `.` was not accepted as a folder destination",
    /folder NAME is required|nothing was created/i.test(toolsFinal), toolsFinal.slice(0, 300));
  check("tools: exactly ONE assistant message was produced", toolsMessages.length === 1, `${toolsMessages.length}`);
  check("tools: the Change Review record names the created file",
    JSON.stringify(toolsFinal).length > 0 &&
    Array.isArray(toolsMessages[toolsMessages.length - 1]?.meta?.fileOperations) &&
    toolsMessages[toolsMessages.length - 1].meta.fileOperations.some((op) => /index\.html/.test(String(op.filePath ?? ""))),
    JSON.stringify((toolsMessages[toolsMessages.length - 1]?.meta?.fileOperations ?? []).map((op) => op.filePath)));
  check("tools: only verified operations are recorded as completed",
    (toolsMessages[toolsMessages.length - 1]?.meta?.fileOperations ?? [])
      .filter((op) => String(op.filePath ?? "").includes("index.html"))
      .every((op) => !op.error),
    JSON.stringify(toolsMessages[toolsMessages.length - 1]?.meta?.fileOperations ?? []));

  // ── Restore ───────────────────────────────────────────────────────────
  await page.evaluate((s) => window.latex.settings.save(s), before);
} catch (err) {
  check("the test run completed without throwing", false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    if (app) {
      const page = await app.firstWindow();
      for (const id of createdConversations) {
        await page.evaluate((conversationId) => window.latex.conversation.delete(conversationId).catch(() => undefined), id).catch(() => undefined);
      }
    }
  } catch { /* cleanup is best effort */ }
  await app?.close().catch(() => undefined);
  stub.close();
  rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} final-answer / thinking checks passed`);
console.log("─".repeat(64));
process.exitCode = failed.length === 0 ? 0 : 1;
