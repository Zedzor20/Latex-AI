/**
 * Final-response UI acceptance test (deterministic, no live model required).
 *
 * Run with:  node test-final-response-ui.mjs      (after "npm run dist")
 *
 * Why this test exists: the packaged app's OmniRoute provider talks to a local
 * OpenAI-compatible gateway on http://127.0.0.1:20128. This test serves a stub
 * gateway on that port, so the ENTIRE Main Agent pipeline (model call → tool
 * call → filesystem → verification → finalization → persistence → renderer) can
 * be driven deterministically — including the two cases a live model can never
 * be relied on for:
 *
 *   1. A model that STOPS after its last tool call (empty final turn). Latex
 *      must still produce a human-readable final assistant message.
 *   2. A provider that FAILS halfway: the user must still get a summary of what
 *      was completed, never a bare error.
 *
 * It then inspects the real DOM, where the conversation must read:
 *   user prompt → assistant answer → "Agent changed N files" review card
 * and the review must show ONE row per file (a model that writes the same file
 * repeatedly is aggregated), including deletions.
 *
 * Finally it measures the layout at four window sizes: the conversation column
 * and the composer must stay centered with a bounded width — never pinned to the
 * left edge of a maximized window.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
const PROJECT_DIR = join(process.cwd(), ".tmp-final", "site");
const SHOT_DIR = join(process.cwd(), ".freebuff", "verify");

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

// ── Stub gateway ─────────────────────────────────────────────────────────
// An isolated port (pointed at with LATEX_OMNIROUTE_BASE_URL) so the test never
// shadows a real OmniRoute instance that may be running on 20128.
const STUB_PORT = 20199;
const MODEL_ID = "stub-silent-test";
let scenario = "edit-two-files";
let modelCalls = 0;

const INDEX_BEFORE = `<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>Island</h1>
  <canvas id="stage" width="640" height="360"></canvas>
  <script src="script.js"></script>
</body>
</html>
`;
const CSS_BEFORE = `body { margin: 0; font-family: sans-serif; }\n.controls { display: flex; }\n`;

const EDITS = {
  "index.html": { oldText: "  <h1>Island</h1>", newText: "  <h1>Island</h1>\n  <button id=\"startBtn\">Start Game</button>" },
  "style.css": { oldText: "body { margin: 0; font-family: sans-serif; }", newText: "body { margin: 0; font-family: sans-serif; background: #0a1628; color: #e6f1ff; }" }
};

// The final on-disk content of index.html, written twice by the stub below to
// reproduce the "same file written five times" noise in the review card.
const INDEX_FINAL = INDEX_BEFORE
  .replace("  <h1>Island</h1>", "  <h1>Island</h1>\n  <button id=\"startBtn\">Start Game</button>")
  .replace("</body>", "  <p class=\"hint\">Press Start</p>\n</body>");
const SCRATCH = "old-note.txt";

function sse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function toolCallEvents(name, args) {
  return [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ];
}

function textEvents(text) {
  return [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];
}

const requestLog = [];

const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
  if (url.pathname === "/__scenario") {
    scenario = url.searchParams.get("name") ?? scenario;
    modelCalls = 0;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ scenario, modelCalls }));
    return;
  }
  if (url.pathname === "/__state") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ scenario, modelCalls, requestLog }));
    return;
  }
  if (url.pathname === "/api/monitoring/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      object: "list",
      data: [{ id: MODEL_ID, object: "model", owned_by: "stub" }]
    }));
    return;
  }
  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    modelCalls++;
    requestLog.push({ call: modelCalls, model: parsed.model, hasTools, stream: parsed.stream, scenario });
    console.log(`  [stub] call ${modelCalls}: model=${parsed.model} tools=${hasTools} stream=${parsed.stream} scenario=${scenario}`);

    // ── Chat mode (no tools are offered) ──────────────────────────────
    if (!hasTools) {
      if (scenario === "chat-claim") {
        sse(res, textEvents(
          "Sure, I changed `script.js` and updated index.html for you. The renderer is now connected.\n\n" +
          '```json\n{"name": "write_file", "arguments": {"relativePath": "chat-only-proof.txt", "content": "hello"}}\n```\n\n' +
          "Let me know if you want anything else."
        ));
        return;
      }
      sse(res, textEvents("Hello — this is a plain chat reply."));
      return;
    }

    // ── Main Agent (tools offered) ─────────────────────────────────────
    if (scenario === "fail-after-first" && modelCalls >= 2) {
      res.writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "stub provider exploded mid-task", type: "server_error" } }));
      return;
    }

    if (scenario === "fail-after-first" || scenario === "edit-two-files") {
      if (modelCalls === 1) return sse(res, toolCallEvents("edit_file", { relativePath: "index.html", ...EDITS["index.html"] }));
      if (modelCalls === 2) return sse(res, toolCallEvents("edit_file", { relativePath: "style.css", ...EDITS["style.css"] }));
      // A model that keeps rewriting the same file — the review must still show
      // ONE entry for index.html, with the net diff from the original content.
      if (modelCalls === 3) return sse(res, toolCallEvents("write_file", { relativePath: "index.html", content: INDEX_FINAL }));
      if (modelCalls === 4) return sse(res, toolCallEvents("write_file", { relativePath: "index.html", content: INDEX_FINAL }));
      // …and a deletion, which must be reported instead of silently vanishing.
      if (modelCalls === 5) return sse(res, toolCallEvents("delete_file", { relativePath: SCRATCH }));
    }

    // Everything after the tools: a model that goes completely silent — no
    // prose, no tool calls. This is the case the final response must survive.
    return sse(res, [
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]);
  });
});

await new Promise((resolve) => stub.listen(STUB_PORT, "127.0.0.1", resolve));
console.log(`Stub gateway listening on http://127.0.0.1:${STUB_PORT} (model ${MODEL_ID})\n`);

// ── Fresh workspace for the agent to edit ─────────────────────────────────
rmSync(join(process.cwd(), ".tmp-final"), { recursive: true, force: true });
mkdirSync(PROJECT_DIR, { recursive: true });
writeFileSync(join(PROJECT_DIR, "index.html"), INDEX_BEFORE);
writeFileSync(join(PROJECT_DIR, "style.css"), CSS_BEFORE);
writeFileSync(join(PROJECT_DIR, SCRATCH), "scratch notes to be removed\n");
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const CONV_IDS = ["conv_final_main", "conv_final_chat", "conv_final_fail", "conv_select_long", "conv_select_short"];
const app = await electron.launch({
  executablePath: EXE,
  args: [],
  timeout: 120_000,
  env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${STUB_PORT}` }
});
let previousSettings = null;
let stubModelName = `omniroute/${MODEL_ID}`;

/** Re-select the stub model so a scenario can never leak onto a live provider. */
async function useStubModel() {
  const page = await app.firstWindow();
  return page.evaluate(async (name) => {
    await window.latex.settings.save({ selectedModel: name, autoSelectModel: false });
    const confirmed = await window.latex.settings.get();
    return String(confirmed.selectedModel ?? "");
  }, stubModelName);
}

/** Open the tab a conversation belongs to, if it is not already active. */
async function openTab(label) {
  const page = await app.firstWindow();
  const button = page.locator(".modeToggleBtn", { hasText: label }).first();
  if ((await button.count()) === 0) return;
  const active = await button.evaluate((element) => element.classList.contains("active")).catch(() => false);
  if (active) return;
  await button.click();
  await page.waitForTimeout(350);
}

/**
 * Click a chat in the sidebar the way a user does: it must become selected and
 * its conversation must load into the centre.
 */
async function selectChat(title, tab = "main", timeout = 15_000) {
  const page = await app.firstWindow();
  await openTab(tab === "chat" ? "Chat" : "Main");
  const row = page.locator(".recentRow", { hasText: title }).first();
  await row.waitFor({ state: "visible", timeout });
  await row.locator("button").first().click();
  await page.waitForTimeout(800);
}

/** What the conversation area currently looks like. */
async function measureConversation() {
  const page = await app.firstWindow();
  return page.evaluate(() => {
    const scroller = document.querySelector(".chatScroll");
    const bubbles = Array.from(document.querySelectorAll("article.message"));
    const last = bubbles[bubbles.length - 1];
    const remaining = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null;
    return {
      bubbles: bubbles.length,
      activeRows: Array.from(document.querySelectorAll(".recentRow.active")).map((element) => element.innerText.trim().split("\n")[0]),
      remaining: remaining === null ? null : Math.round(remaining),
      scrollHeight: scroller?.scrollHeight ?? 0,
      lastMessageText: last ? last.innerText.slice(0, 90) : ""
    };
  });
}

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });

  // ── Startup: the app must NOT open a previous chat in the centre ────────
  // This runs before the test creates anything of its own, so it sees exactly
  // what a user sees the moment Latex opens.
  console.log("── Startup state (no chat auto-loaded) ────────────────────");
  await page.waitForTimeout(2500);
  const startup = await page.evaluate(async () => {
    const list = await window.latex.conversation.list();
    const panel = document.querySelector(".home");
    return {
      persisted: list.length,
      bubbles: document.querySelectorAll("article.message").length,
      panelText: panel ? panel.innerText.replace(/\s+/g, " ") : "",
      activeRows: document.querySelectorAll(".recentRow.active").length,
      recents: document.querySelectorAll(".recentRow").length
    };
  });
  check("chat history is still persisted", startup.persisted > 0, `${startup.persisted} conversations`);
  check("no conversation is loaded into the centre on startup", startup.bubbles === 0, `${startup.bubbles} message bubbles on screen`);
  check("nothing is highlighted as selected", startup.activeRows === 0, `${startup.activeRows} active sidebar rows`);
  check("the centre shows the start screen", /what should we work on in latex/i.test(startup.panelText), startup.panelText.slice(0, 140));
  check("the start screen offers the quick actions", /build a new feature/i.test(startup.panelText) && /review code/i.test(startup.panelText), startup.panelText.slice(0, 140));

  // Point Latex at the stub model.
  const modelInfo = await page.evaluate(async (modelId) => {
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const stub = models.find((m) => String(m.name).includes(modelId));
    if (!stub) return { error: `stub model ${modelId} was not discovered`, count: models.length, providers: [...new Set(models.map((m) => m.provider))] };
    await window.latex.settings.save({ selectedModel: stub.name, autoSelectModel: false });
    const confirmed = await window.latex.settings.get();
    return {
      name: stub.name,
      provider: stub.provider,
      confirmedModel: confirmed.selectedModel ?? null,
      confirmedAuto: confirmed.autoSelectModel ?? null,
      previousModel: before.selectedModel ?? null,
      previousAuto: before.autoSelectModel ?? null
    };
  }, MODEL_ID);
  if (modelInfo.error) throw new Error(`${modelInfo.error} (${modelInfo.count} models: ${modelInfo.providers})`);
  previousSettings = modelInfo;
  stubModelName = modelInfo.name;
  console.log(`Using stub model: ${modelInfo.name} (provider ${modelInfo.provider}) — settings now report ${modelInfo.confirmedModel} / auto=${modelInfo.confirmedAuto}\n`);
  check("the stub model is the selected model", String(modelInfo.confirmedModel).includes(MODEL_ID), String(modelInfo.confirmedModel));

  // The conversation is created first and the window reloaded, then the user's
  // real flow is followed: pick the chat in the sidebar (startup no longer
  // opens anything by itself) and watch that conversation.
  await page.evaluate(async ({ convId, wsPath }) => {
    const now = Date.now();
    await window.latex.conversation.save({
      id: convId,
      title: "Final response test",
      mode: "main",
      messages: [{ id: `m_${now}`, role: "user", content: "Add a start button to index.html and restyle style.css.", createdAt: now }],
      createdAt: now,
      updatedAt: now
    });
  }, { convId: CONV_IDS[0], wsPath: PROJECT_DIR });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  // A reload is a fresh start: nothing may be open until it is clicked.
  const afterReload = await page.evaluate(() => {
    const panel = document.querySelector(".home");
    return {
      bubbles: document.querySelectorAll("article.message").length,
      panelText: panel ? panel.innerText.replace(/\s+/g, " ") : ""
    };
  });
  check("a reopened app loads no conversation by itself", afterReload.bubbles === 0, `${afterReload.bubbles} message bubbles`);
  check("the reloaded app shows the start screen", /what should we work on in latex/i.test(afterReload.panelText), afterReload.panelText.slice(0, 140));
  await selectChat("Final response test");
  const onScreen = await page.evaluate(() => document.body.innerText);
  check("the test conversation is the one on screen", /Add a start button to index\.html/.test(onScreen), onScreen.slice(0, 120));

  // ── 1. Main task where the model stops after its last tool call ────────
  console.log("── Main Agent task (model goes silent after the tools) ───");
  const run = await page.evaluate(async ({ wsPath, convId, modelName }) => {
    // Re-pin the stub model immediately before the run: a renderer reload can
    // reset the account-scoped settings, and Auto mode would otherwise pick a
    // live provider instead of the stub.
    await window.latex.settings.save({ selectedModel: modelName, autoSelectModel: false });
    // Warm up the local gateway so the very first Main request cannot race the
    // OmniRoute liveness probe (which otherwise sends it to the wrong port).
    await window.latex.omniroute.refresh().catch(() => undefined);
    const events = [];
    const unsubscribe = window.latex.agent.onEvent((event) => {
      events.push({ type: event?.type, payload: event?.payload });
      if (event?.type === "approval" && event.payload?.requestId) {
        void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
      }
    });
    const now = Date.now();
    const conversation = {
      id: convId,
      title: "Final response test",
      mode: "main",
      messages: [{ id: `m_${now}`, role: "user", content: "Add a start button to index.html and restyle style.css.", createdAt: now }],
      createdAt: now,
      updatedAt: now
    };
    let next = null;
    let error = null;
    try {
      // Re-read the conversation from the store so the object the agent mutates
      // is the one the UI is showing.
      const stored = (await window.latex.conversation.list()).find((c) => c.id === convId) ?? conversation;
      next = await window.latex.agent.run(stored, { id: "ws_final", name: "site", path: wsPath, trusted: true, lastOpenedAt: now });
    } catch (err) {
      error = String(err?.message ?? err);
    }
    unsubscribe();
    const assistant = (next?.messages ?? []).filter((m) => m.role === "assistant").pop();
    return {
      error,
      model: assistant?.model ?? null,
      answer: String(assistant?.content ?? ""),
      meta: assistant?.meta ?? null,
      changesEvents: events.filter((e) => e.type === "changes").length,
      changedPaths: events.filter((e) => e.type === "changes")
        .flatMap((e) => (Array.isArray(e.payload) ? e.payload.map((c) => c.filePath) : [])),
      streamed: events.filter((e) => e.type === "message").map((e) => String(e.payload ?? "")).join(""),
      phases: events.filter((e) => e.type === "activity_step").map((e) => e.payload?.label ?? "").filter(Boolean),
      // Live file-writing preview channel: start/complete events per real file op.
      fileOps: events.filter((e) => e.type === "file_operation").map((e) => ({
        phase: e.payload?.phase,
        operation: e.payload?.operation,
        filePath: e.payload?.filePath,
        hasPreview: typeof e.payload?.preview === "string" && e.payload.preview.length > 0,
        verified: e.payload?.verified
      }))
    };
  }, { wsPath: PROJECT_DIR, convId: CONV_IDS[0], modelName: stubModelName });

  // Diagnostic: what the stub actually received.
  const stubState = await (await fetch(`http://127.0.0.1:${STUB_PORT}/__state`)).json();
  console.log(`  [stub] ${JSON.stringify(stubState.requestLog)}`);
  console.log(`  [stub] response model used by the run: ${run.model}`);

  check("main task completed without error", !run.error, run.error ?? "");
  check("the run used the stub model", String(run.model).includes(MODEL_ID), String(run.model));
  // §25 — the model never wrote a summary; Latex must still produce one.
  check("final assistant message exists even though the model went silent", run.answer.trim().length > 80, `${run.answer.trim().length} chars`);
  // The response must READ like an assistant: a natural "Done — I …" line plus
  // prose, with no metadata dump and no fact stated three times.
  check("final message opens with a natural headline", /^\*\*Done — I (created|updated|deleted|renamed)/.test(run.answer.trim()), run.answer.split("\n")[0]);
  check("final message explains the outcome in prose", /was removed|now contains|are in place|reflects those changes|I confirmed/i.test(run.answer), run.answer.slice(0, 200));
  check("final message never counts operations", !/operation[s]? (completed|succeeded)/i.test(run.answer));
  check("final message names the real paths", /`index\.html`/.test(run.answer) && /`style\.css`/.test(run.answer));
  check("final message does not repeat the file inventory", !/###\s*(What changed|Files changed|Verification)/i.test(run.answer));
  check("final message never exposes tool JSON", !/"name"\s*:\s*"(?:edit_file|write_file|create_file|run_command)"/.test(run.answer));
  check("final message is tagged with its task id", typeof run.meta?.taskId === "string" && run.meta.taskId.length > 0, String(run.meta?.taskId));
  check("activity reported the finalization phase", run.phases.some((label) => /finalizing response/i.test(label)), run.phases.slice(-4).join(" | "));
  check("final response was streamed on the assistant channel", /Done — I /.test(run.streamed), `${run.streamed.length} streamed chars`);
  check("change events fired for the edited files", run.changesEvents > 0 && run.changedPaths.includes("index.html"), run.changedPaths.join(", "));

  // ── Live file-writing preview (ACTIVITY channel, preview buffer only) ──
  const opPaths = [...new Set(run.fileOps.map((o) => o.filePath))];
  check("file_operation start events fired for the edited files", run.fileOps.some((o) => o.phase === "start" && o.filePath === "index.html"), opPaths.join(", "));
  check("a start event carries the real preview content", run.fileOps.some((o) => o.phase === "start" && o.hasPreview), String(run.fileOps.filter((o) => o.hasPreview).length));
  check("a completed (verified) event marks the committed write", run.fileOps.some((o) => o.phase === "complete" && o.verified === true), "");
  // Repeated writes to index.html each stream a start event; the renderer
  // aggregates them into ONE card (verified by test-file-preview-thinking.mjs).
  check("repeated writes to index.html each stream a preview", run.fileOps.filter((o) => o.phase === "start" && o.filePath === "index.html").length >= 2, String(run.fileOps.filter((o) => o.phase === "start" && o.filePath === "index.html").length));

  const htmlAfter = readFileSync(join(PROJECT_DIR, "index.html"), "utf8");
  check("the real file on disk was actually changed", htmlAfter.includes("startBtn") && htmlAfter.includes("Press Start"));
  check("the deleted file is really gone from disk", !existsSync(join(PROJECT_DIR, SCRATCH)));
  check("the final answer reports the deletion", run.answer.includes(SCRATCH) && /deleted/i.test(run.answer), run.answer.slice(-200));

  // §7/§20 — five operations on index.html must read as ONE entry with the net
  // diff, not one row per write. (The file also appears in "What changed" and in
  // a verification note, so the inventory section is what must not repeat it.)
  const bodyRows = (run.answer.match(/^- `index\.html`/gm) ?? []).length;
  check("the explanation lists index.html at most once", bodyRows <= 1, `${bodyRows} list rows`);
  check("the response says what happened to the deleted file", run.answer.includes(SCRATCH), run.answer.slice(0, 240));
  check("the response does not claim operations it did not do",
    !/I (created|updated|deleted|renamed) /.test(run.answer.slice(run.answer.indexOf("###"))) || !/###/.test(run.answer),
    run.answer.slice(-160));

  // Dump the exact final answers so the wording can be reviewed by hand.
  writeFileSync(join(SHOT_DIR, "final-answer-main.txt"), String(run.answer));

  // ── Renderer: final response, THEN the change review ──────────────────
  await page.waitForTimeout(1500);
  const dom = await page.evaluate(() => {
    const card = document.querySelector(".changesCard");
    const bubbles = Array.from(document.querySelectorAll("article.message.assistant"));
    const last = bubbles[bubbles.length - 1];
    const order = card && last ? Boolean(card.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    const rows = card ? Array.from(card.querySelectorAll(".changeRow")) : [];
    const rowTexts = rows.map((row) => row.innerText.replace(/\s+/g, " ").trim());
    return {
      cardPresent: Boolean(card),
      cardText: card ? card.innerText.replace(/\s+/g, " ").slice(0, 400) : "",
      rowTexts,
      rowCount: rows.length,
      bubbleCount: bubbles.length,
      lastText: last ? last.innerText.replace(/\s+/g, " ").slice(0, 400) : "",
      cardBeforeResponse: order
    };
  });

  check("the file-change card is rendered", dom.cardPresent, dom.cardText);
  check("the card still shows the changed file", /index\.html/.test(dom.cardText), dom.cardText);
  check("a final assistant response is rendered in the conversation", dom.bubbleCount > 0 && /Done — I /.test(dom.lastText), dom.lastText.slice(-160));
  check("the card comes AFTER the assistant response", dom.cardBeforeResponse === false, `responseBeforeCard=${dom.cardBeforeResponse === false}`);
  check("the card shows one row per file, not one per write", dom.rowCount === 3, `${dom.rowCount} rows: ${dom.rowTexts.join(" | ")}`);
  check("the repeated writes to index.html collapsed into one row",
    dom.rowTexts.filter((row) => /index\.html/.test(row)).length === 1,
    dom.rowTexts.join(" | "));
  check("the card labels created/modified/deleted entries",
    /Modified/i.test(dom.cardText) && /Deleted/i.test(dom.cardText),
    dom.cardText);
  check("the deleted file appears in the card", dom.cardText.includes(SCRATCH), dom.cardText);
  check("the card carries a real description, not just counts", /(Created with|Updated|Deleted)/i.test(dom.cardText), dom.cardText);

  // ── Layout: the conversation column stays centered at every width ──────
  // Widths are produced with page zoom instead of setSize(): a window cannot be
  // sized past the physical screen, and the layout viewport is what matters.
  console.log("── Layout (centered conversation column) ──────────────────");
  const layout = await (async () => {
    const zooms = [1, 0.55, 1.6];
    const out = [];
    for (const zoom of zooms) {
      await app.evaluate(({ BrowserWindow }, factor) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        win.setSize(1500, 940);
        win.webContents.setZoomFactor(factor);
      }, zoom);
      await page.waitForTimeout(400);
      const measured = await page.evaluate(() => {
        const scroller = document.querySelector(".chatScroll");
        const bubble = Array.from(document.querySelectorAll("article.message.assistant")).pop()
          ?? document.querySelector("article.message");
        const card = document.querySelector(".changesCard");
        const composer = document.querySelector(".composer");
        const box = scroller?.getBoundingClientRect();
        const center = (el) => {
          const r = el?.getBoundingClientRect();
          return r ? Math.round(r.left + r.width / 2) : null;
        };
        return {
          viewport: window.innerWidth,
          scrollerCenter: box ? Math.round(box.left + box.width / 2) : null,
          messageCenter: center(bubble),
          cardCenter: center(card),
          composerCenter: center(composer),
          messageLeft: bubble ? Math.round(bubble.getBoundingClientRect().left) : null,
          scrollerLeft: box ? Math.round(box.left) : null,
          messageWidth: bubble ? Math.round(bubble.getBoundingClientRect().width) : null,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        };
      });
      out.push(measured);
    }
    return out;
  })();
  for (const row of layout) {
    const offset = Math.abs((row.messageCenter ?? 0) - (row.scrollerCenter ?? 0));
    console.log(`  ${row.viewport}px → message ${row.messageWidth}px, column centre ${row.scrollerCenter}, message centre ${row.messageCenter}, composer centre ${row.composerCenter}, offset ${offset}px`);
  }
  check("the conversation column is centered on a wide window",
    layout.every((row) => Math.abs((row.messageCenter ?? 0) - (row.scrollerCenter ?? 0)) <= 12), layout.map((r) => `${r.viewport}:${Math.abs((r.messageCenter ?? 0) - (r.scrollerCenter ?? 0))}`).join(" "));
  // Wide windows: a real inset on both sides. Narrow windows: the column is
  // allowed to fill the width, but must still keep padding.
  check("the conversation is not pushed against the left edge",
    layout.every((row) => {
      const inset = (row.messageLeft ?? 0) - (row.scrollerLeft ?? 0);
      return row.viewport >= 1200 ? inset > 40 : inset > 8;
    }), layout.map((r) => `${r.viewport}:${(r.messageLeft ?? 0) - (r.scrollerLeft ?? 0)}`).join(" "));
  check("the content column has a maximum width",
    layout.every((row) => (row.messageWidth ?? 0) <= 920), layout.map((r) => `${r.viewport}:${r.messageWidth}`).join(" "));
  check("the composer shares the conversation column",
    layout.every((row) => Math.abs((row.composerCenter ?? 0) - (row.messageCenter ?? 0)) <= 14), layout.map((row) => `${row.viewport}:${Math.abs((row.composerCenter ?? 0) - (row.messageCenter ?? 0))}`).join(" "));
  check("no horizontal overflow at any size", layout.every((row) => row.horizontalOverflow === false), layout.map((row) => `${row.viewport}:${row.horizontalOverflow}`).join(" "));
  check("the change review is centered too",
    layout.every((row) => row.cardCenter === null || Math.abs(row.cardCenter - (row.scrollerCenter ?? 0)) <= 12), layout.map((row) => `${row.viewport}:${row.cardCenter}/${row.scrollerCenter}`).join(" "));
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.webContents.setZoomFactor(1);
    win.maximize();
  });
  await page.waitForTimeout(400);
  // Maximized is the case the user reported: the column must still be centered.
  const maximized = await page.evaluate(() => {
    const scroller = document.querySelector(".chatScroll");
    const bubble = Array.from(document.querySelectorAll("article.message.assistant")).pop();
    const composer = document.querySelector(".composer");
    const box = scroller?.getBoundingClientRect();
    const center = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? Math.round(r.left + r.width / 2) : null;
    };
    return {
      viewport: window.innerWidth,
      maximized: true,
      scrollerCenter: box ? Math.round(box.left + box.width / 2) : null,
      messageCenter: center(bubble),
      cardCenter: center(document.querySelector(".changesCard")),
      composerCenter: center(composer),
      messageLeft: bubble ? Math.round(bubble.getBoundingClientRect().left) : null,
      scrollerLeft: box ? Math.round(box.left) : null,
      messageWidth: bubble ? Math.round(bubble.getBoundingClientRect().width) : null,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  });
  console.log(`  maximized ${maximized.viewport}px → message ${maximized.messageWidth}px, column centre ${maximized.scrollerCenter}, message centre ${maximized.messageCenter}, composer centre ${maximized.composerCenter}`);
  check("a maximized window keeps the conversation centered",
    Math.abs((maximized.messageCenter ?? 0) - (maximized.scrollerCenter ?? 0)) <= 12
    && (maximized.messageLeft ?? 0) - (maximized.scrollerLeft ?? 0) > 20,
    `centre offset ${Math.abs((maximized.messageCenter ?? 0) - (maximized.scrollerCenter ?? 0))}px, left inset ${(maximized.messageLeft ?? 0) - (maximized.scrollerLeft ?? 0)}px`);

  // Screenshot is best-effort: some Windows/driver combinations refuse to
  // composite an Electron window, which must not fail the suite.
  try {
    await page.screenshot({ path: join(SHOT_DIR, "final-response-ui.png"), fullPage: false, timeout: 8000 });
    console.log(`  screenshot → ${join(SHOT_DIR, "final-response-ui.png")}`);
  } catch (shotErr) {
    console.log(`  (screenshot unavailable: ${String(shotErr.message).split("\n")[0]})`);
  }
  console.log("");

  // Persistence: the answer must survive reload/close (same store as messages).
  const persisted = await page.evaluate(async (convId) => {
    const list = await window.latex.conversation.list();
    const conv = list.find((c) => c.id === convId);
    const assistant = (conv?.messages ?? []).filter((m) => m.role === "assistant").pop();
    return { found: Boolean(conv), content: String(assistant?.content ?? ""), role: assistant?.role ?? null };
  }, CONV_IDS[0]);
  check("final response is persisted to the conversation store",
    persisted.found && persisted.role === "assistant" && /^\*\*Done — I /.test(persisted.content.trim()),
    persisted.content.slice(0, 90));

  // ── 2. Chat mode: a model that claims it changed files ────────────────
  console.log("── Chat mode (model claims it changed files) ─────────────");
  await fetch(`http://127.0.0.1:${STUB_PORT}/__scenario?name=chat-claim`);
  // Pin the stub again: the app's own model recovery may have moved on, and
  // this scenario must exercise the stub, not a live provider.
  console.log(`  model pinned for the chat check: ${await useStubModel()}`);
  const chat = await page.evaluate(async ({ convId, wsPath }) => {
    const events = [];
    const unsubscribe = window.latex.agent.onEvent((event) => events.push({ type: event?.type, payload: event?.payload }));
    const now = Date.now();
    const conversation = {
      id: convId,
      title: "Chat boundary",
      mode: "chat",
      messages: [{ id: `c_${now}`, role: "user", content: "Change script.js and update index.html for me.", createdAt: now }],
      createdAt: now,
      updatedAt: now
    };
    let answer = "";
    let error = null;
    try {
      const next = await window.latex.agent.chat(conversation, { id: "ws_final", name: "site", path: wsPath, trusted: true, lastOpenedAt: now });
      answer = String(next.messages[next.messages.length - 1]?.content ?? "");
    } catch (err) {
      error = String(err?.message ?? err);
    }
    unsubscribe();
    return { answer, error, changeEvents: events.filter((e) => e.type === "changes").length, toolEvents: events.filter((e) => e.type === "tool").length };
  }, { convId: CONV_IDS[1], wsPath: PROJECT_DIR });

  check("chat run completed", !chat.error, chat.error ?? "");
  check("chat produced no workspace change events", chat.changeEvents === 0 && chat.toolEvents === 0, `changes=${chat.changeEvents} tools=${chat.toolEvents}`);
  check("chat created no file from the fake tool call", !existsSync(join(PROJECT_DIR, "chat-only-proof.txt")));
  check("chat reply has no raw tool JSON", !/"name"\s*:\s*"write_file"/.test(chat.answer));
  check("chat reply keeps the model's own explanation", /renderer is now connected/i.test(chat.answer), chat.answer.slice(0, 160));
  check("chat marks the file claim as NOT a real operation",
    /chat mode has no file|nothing was changed on disk/i.test(chat.answer),
    chat.answer.slice(-220));

  // ── 3. Provider fails after the first successful edit ─────────────────
  console.log("\n── Provider failure after partial work ────────────────────");
  await fetch(`http://127.0.0.1:${STUB_PORT}/__scenario?name=fail-after-first`);
  console.log(`  model pinned for the failure check: ${await useStubModel()}`);
  rmSync(join(process.cwd(), ".tmp-final", "broken"), { recursive: true, force: true });
  const breakDir = join(process.cwd(), ".tmp-final", "broken");
  mkdirSync(breakDir, { recursive: true });
  writeFileSync(join(breakDir, "index.html"), INDEX_BEFORE);
  writeFileSync(join(breakDir, "style.css"), CSS_BEFORE);

  const failure = await page.evaluate(async ({ wsPath, convId }) => {
    const events = [];
    const unsubscribe = window.latex.agent.onEvent((event) => {
      events.push({ type: event?.type, payload: event?.payload });
      if (event?.type === "approval" && event.payload?.requestId) {
        void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
      }
    });
    const now = Date.now();
    const conversation = {
      id: convId,
      title: "Failure test",
      mode: "main",
      messages: [{ id: `f_${now}`, role: "user", content: "Add a start button to index.html and restyle style.css.", createdAt: now }],
      createdAt: now,
      updatedAt: now
    };
    let error = null;
    try {
      await window.latex.agent.run(conversation, { id: "ws_final", name: "broken", path: wsPath, trusted: true, lastOpenedAt: now });
    } catch (err) {
      error = String(err?.message ?? err);
    }
    unsubscribe();
    const messages = events.filter((e) => e.type === "done").map((e) => e.payload).filter(Boolean);
    const lastDone = messages[messages.length - 1];
    const assistant = (lastDone?.messages ?? []).filter((m) => m.role === "assistant").pop();
    return { error, answer: String(assistant?.content ?? ""), incomplete: Boolean(assistant?.meta?.incomplete) };
  }, { wsPath: breakDir, convId: CONV_IDS[2] });

  check("provider failure is still reported to the user", Boolean(failure.error), failure.error ?? "");
  check("a final message was still produced after the failure", failure.answer.trim().length > 40, `${failure.answer.trim().length} chars`);
  check("it does not claim the task completed", !/^\*\*Done/.test(failure.answer.trim()), failure.answer.slice(0, 80));
  check("it says the task stopped before completion", /stopped before completion/i.test(failure.answer));
  check("it lists what was completed", /which was completed first|I (created|updated|deleted|renamed)/i.test(failure.answer), failure.answer.slice(0, 200));
  check("it lists what remains", /###\s*What remains/i.test(failure.answer));
  check("it is flagged incomplete in metadata", failure.incomplete);
  check("the successful edit is on disk", readFileSync(join(breakDir, "index.html"), "utf8").includes("startBtn"));
  writeFileSync(join(SHOT_DIR, "final-answer-failure.txt"), String(failure.answer));

  // ── Selecting a chat: loads THAT chat and opens at its latest message ────
  console.log("\n── Chat selection and scroll position ─────────────────────");
  const seeded = await page.evaluate(async ({ longId, shortId, longMessages, shortMessages }) => {
    const now = Date.now();
    await window.latex.conversation.save({
      id: longId,
      title: "Long conversation",
      mode: "chat",
      messages: longMessages.map((content, index) => ({ id: `${longId}_${index}`, role: index % 2 === 0 ? "user" : "assistant", content, createdAt: now + index })),
      createdAt: now,
      updatedAt: now + longMessages.length
    });
    await window.latex.conversation.save({
      id: shortId,
      title: "Short conversation",
      mode: "chat",
      messages: shortMessages.map((content, index) => ({ id: `${shortId}_${index}`, role: index % 2 === 0 ? "user" : "assistant", content, createdAt: now + index })),
      createdAt: now,
      updatedAt: now - 60_000
    });
    return { ok: true };
  }, {
    longId: CONV_IDS[3],
    shortId: CONV_IDS[4],
    longMessages: Array.from({ length: 40 }, (_, index) => `Message number ${index + 1} of a deliberately long saved conversation so it has to scroll.`),
    shortMessages: ["Short question about the build.", "Short answer about the build."]
  });
  check("two chats were seeded for the selection test", seeded.ok);
  // The seeded chats only appear after the renderer re-reads the store, and a
  // relaunch is exactly the "does Latex restore a chat by itself?" check.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const reopened = await page.evaluate(() => {
    const panel = document.querySelector(".home");
    return {
      bubbles: document.querySelectorAll("article.message").length,
      panelText: panel ? panel.innerText.replace(/\s+/g, " ") : ""
    };
  });
  check("reopening Latex does not restore the last chat", reopened.bubbles === 0, `${reopened.bubbles} message bubbles`);
  check("the reopened app still shows the start screen", /what should we work on in latex/i.test(reopened.panelText), reopened.panelText.slice(0, 140));

  await selectChat("Long conversation", "chat");
  const longOpen = await measureConversation();
  check("clicking a sidebar chat loads that chat", longOpen.bubbles === 40, `${longOpen.bubbles} messages`);
  check("the selected chat is marked active in the sidebar", longOpen.activeRows.some((row) => /Long conversation/.test(row)), longOpen.activeRows.join(" | "));
  check("a long chat opens scrolled to the latest message", longOpen.scrollHeight > 0 && longOpen.remaining !== null && longOpen.remaining <= 12, `${longOpen.remaining}px from the bottom`);
  check("the newest message is the one on screen", /Message number 40/.test(longOpen.lastMessageText), longOpen.lastMessageText);

  // The reader owns the scroll position once a chat is open: an idle re-render
  // must not drag them back to the bottom.
  const afterScrollUp = await page.evaluate(async () => {
    const scroller = document.querySelector(".chatScroll");
    scroller.scrollTop = 0;
    const before = scroller.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { before: Math.round(before), after: Math.round(scroller.scrollTop) };
  });
  check("scrolling up is not overridden while reading",
    afterScrollUp.after <= afterScrollUp.before + 40,
    `${afterScrollUp.before}px → ${afterScrollUp.after}px`);

  await selectChat("Short conversation", "chat");
  const shortOpen = await measureConversation();
  check("switching chats loads the other conversation", shortOpen.bubbles === 2, `${shortOpen.bubbles} messages`);
  check("switching chats re-opens at the latest message", shortOpen.remaining !== null && shortOpen.remaining <= 12, `${shortOpen.remaining}px from the bottom`);
  check("switching chats moves the sidebar highlight", shortOpen.activeRows.some((row) => /Short conversation/.test(row)), shortOpen.activeRows.join(" | "));

  console.log("");
} catch (err) {
  console.error("\nFinal-response UI run threw:", err?.message ?? err);
  results.push({ name: "final-response UI run completed", ok: false });
} finally {
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ ids, settings }) => {
      for (const id of ids) {
        try { await window.latex.conversation.delete(id); } catch { /* ignore */ }
      }
      if (settings) {
        await window.latex.settings.save({
          selectedModel: settings.previousModel ?? undefined,
          autoSelectModel: settings.previousAuto ?? undefined
        }).catch(() => undefined);
      }
    }, { ids: CONV_IDS, settings: previousSettings });
  } catch { /* ignore */ }
  await app.close().catch(() => undefined);
  stub.close();
}

const failed = results.filter((r) => !r.ok);
console.log("─".repeat(64));
console.log(`${results.length - failed.length}/${results.length} final-response checks passed`);
console.log("─".repeat(64));
process.exit(failed.length === 0 ? 0 : 1);
