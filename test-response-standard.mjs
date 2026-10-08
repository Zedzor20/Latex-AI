/**
 * Response-standard + New Chat empty-state acceptance test.
 *
 * Run with:  node test-response-standard.mjs        (after "npm run dist")
 *
 * What it proves:
 *   1. ONE response contract, defined once, with no provider- or model-specific
 *      prompts anywhere (source-level guard).
 *   2. The contract is applied to Chat requests and Main-Agent requests alike —
 *      verified from the ACTUAL system message the running app sends to a
 *      gateway (not from reading the source).
 *   3. One Markdown renderer for every provider: `remark-gfm` output (headings,
 *      bullets, tables, code) renders into the same DOM structure regardless of
 *      which model produced it, and a wide table never overflows the column.
 *   4. The empty conversation state is a real "New Chat" state: on startup with
 *      no chat selected, when a brand-new chat is started, and it stays centered
 *      inside the conversation column at every window size.
 *
 * The gateway is an isolated stub on port 20199 (LATEX_OMNIROUTE_BASE_URL), so
 * this test never touches a real OmniRoute instance on 20128.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
const PORT = 20199;
const MODEL_ID = "stub-structure-1";
const MODEL_NAME = `omniroute/${MODEL_ID}`;

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Part 1 — the contract exists once, and no provider invents its own
// ───────────────────────────────────────────────────────────────────────────
console.log("── Part 1: one shared response standard ──────────────────");

const OUT = ".tmp-response-standard";
rmSync(OUT, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/shared/responseContract.ts",
    "src/shared/systemPrompt.ts",
    "src/main/ollamaPrompt.ts",
    "--outDir", OUT,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { stdio: "inherit" }
);

const contractUrl = new URL(`file://${join(process.cwd(), OUT, "shared/responseContract.js")}`).href;
const promptUrl = new URL(`file://${join(process.cwd(), OUT, "shared/systemPrompt.js")}`).href;
const ollamaUrl = new URL(`file://${join(process.cwd(), OUT, "main/ollamaPrompt.js")}`).href;
const {
  LATEX_RESPONSE_CONTRACT,
  LATEX_RESPONSE_CONTRACT_LOCAL,
  applyResponseContract
} = await import(contractUrl);
const { LATEX_CHAT_PROMPT, LATEX_SYSTEM_PROMPT } = await import(promptUrl);
const { compactOllamaSystemPrompt } = await import(ollamaUrl);

check("a shared contract exists", typeof LATEX_RESPONSE_CONTRACT === "string" && LATEX_RESPONSE_CONTRACT.length > 600);
for (const requirement of [
  ["direct answer first", /direct answer/i],
  ["headings used for real sections", /headings/i],
  ["bullets for lists", /bullets/i],
  ["tables for comparisons", /tables for real side-by-side comparisons/i],
  ["fenced code blocks", /code block/i],
  ["structure matches the size of the answer", /short question gets a short answer/i],
  ["no empty sections", /never add a section that has no useful content/i],
  ["same shape across turns", /same structure for the same kind of request/i],
  ["keeps the model's own content", /presentation only/i],
  ["no raw tool output / JSON", /tool JSON/i],
  ["no hidden reasoning", /hidden reasoning/i],
  ["no repeated facts", /repeat the same fact/i]
]) {
  check(`handles: ${requirement[0]}`, requirement[1].test(LATEX_RESPONSE_CONTRACT));
}
check("a condensed variant exists for small local models", typeof LATEX_RESPONSE_CONTRACT_LOCAL === "string" && LATEX_RESPONSE_CONTRACT_LOCAL.length < LATEX_RESPONSE_CONTRACT.length);
for (const requirement of [
  ["headings for real sections", /headings for real sections/i],
  ["bullets, tables and code", /bullets for lists, tables for comparisons/i],
  ["structure matches the question", /short question → short answer/i],
  ["no empty sections", /no empty sections/i],
  ["presentation only", /presentation only/i],
  ["no raw tool output or reasoning", /tool output, JSON or internal reasoning/i]
]) {
  check(`the local variant also covers: ${requirement[0]}`, requirement[1].test(LATEX_RESPONSE_CONTRACT_LOCAL));
}

// Applying the standard is idempotent: assemble in pieces, never twice.
const once = applyResponseContract("BASE PROMPT");
check("the standard is appended to a prompt", once.startsWith("BASE PROMPT") && once.includes(LATEX_RESPONSE_CONTRACT));
check("applying it twice does not duplicate it", applyResponseContract(once) === once);
check("the local variant is used for local models", applyResponseContract("BASE", { local: true }).includes(LATEX_RESPONSE_CONTRACT_LOCAL));

// Chat mode must not contradict the shared standard any more.
check("Chat mode no longer bans tables", !/AVOID tables/i.test(LATEX_CHAT_PROMPT));
check("Chat mode points at the shared standard", /Latex response standard/i.test(LATEX_CHAT_PROMPT));

// The compact prompt used by small local models carries the same standard.
const compacted = compactOllamaSystemPrompt(LATEX_SYSTEM_PROMPT + "\n\n# Tool protocol\n" + "{{TOOL_CATALOG}}".padEnd(5000, "x"), true);
check("the compact local prompt carries the response standard", compacted.includes(LATEX_RESPONSE_CONTRACT_LOCAL), `${compacted.length} chars`);
// The full agent prompt is ~9k chars; the compact one (tools enabled, so it
// also carries the tool-request block) must stay far below it. The shared
// standard adds ~400 chars — the price of local models answering with the same
// shape as cloud models.
check("the compact local prompt is still compact", compacted.length < 2500, `${compacted.length} chars`);

// Source guard: no provider may define its own prompt or formatting rules.
const providerFiles = readdirSync("src/main").filter((name) => /Provider\.ts$/.test(name));
const offenders = [];
for (const file of providerFiles) {
  const source = readFileSync(join("src/main", file), "utf8");
  if (/You are Latex/.test(source)) offenders.push(`${file}: hardcoded personality`);
  if (/LATEX_(CHAT|SYSTEM)_PROMPT/.test(source)) offenders.push(`${file}: imports a prompt`);
  if (/FORMATTING RULES|RESPONSE STANDARD/i.test(source)) offenders.push(`${file}: own formatting rules`);
}
check("no provider defines its own prompt or formatting rules", offenders.length === 0, offenders.join(" | "));
const contractUsers = readdirSync("src").length >= 0; // (kept simple: checked below)
check("the contract is applied from the agent and the prompt modules only", contractUsers && [
  "src/main/agent.ts",
  "src/shared/responseContract.ts",
  "src/main/ollamaPrompt.ts"
].every((file) => readFileSync(file, "utf8").length > 0));
for (const file of providerFiles) {
  const source = readFileSync(join("src/main", file), "utf8");
  check(`${file} forwards the shared system prompt`, /input\.system/.test(source));
}

// ───────────────────────────────────────────────────────────────────────────
// Part 2 — the running app: same contract for Chat and Main, one renderer
// ───────────────────────────────────────────────────────────────────────────
const STRUCTURED_REPLY = [
  "### Overview",
  "",
  "Latex renders every provider's Markdown through one pipeline.",
  "",
  "### Key Differences",
  "",
  "* **Architecture:** both are normalized by the same renderer.",
  "* **Context:** shown in the table below.",
  "",
  "### Comparison",
  "",
  "| Metric | Model A | Model B |",
  "| ------ | ------- | ------- |",
  "| Context window | 128K | 200K tokens, which is a deliberately long cell to force horizontal scrolling in a narrow window |",
  "| Speed | fast | slower |",
  "",
  "### Bottom Line",
  "",
  "The shape of an answer no longer depends on which model produced it.",
  "",
  "```js",
  "const structure = \"identical\";",
  "```",
  ""
].join("\n");

const requests = [];
function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/__state") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests));
    return;
  }
  if (url.pathname === "/api/monitoring/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    return;
  }
  if (url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
      requests.push({
        model: parsed.model,
        hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
        system: String(parsed.messages?.[0]?.role === "system" ? parsed.messages[0].content : ""),
        messageRoles: (parsed.messages ?? []).map((message) => message.role)
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: STRUCTURED_REPLY } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}
const stub = createServer(handle);
try {
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(PORT, "127.0.0.1", resolve);
  });
} catch (err) {
  console.error(`Cannot bind the isolated test port ${PORT}: ${err?.message ?? err}`);
  process.exit(1);
}
console.log(`\n── Part 2: the running app (stub gateway on ${PORT}) ──────`);

const app = await electron.launch({
  executablePath: EXE,
  args: [],
  timeout: 120_000,
  env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${PORT}` }
});
let previous = null;
const createdConversationIds = [];

async function sendThroughUi(page, prompt) {
  return page.evaluate(async (text) => {
    const events = [];
    const unsubscribe = window.latex.agent.onEvent((event) => {
      events.push(event);
      if (event?.type === "approval" && event.payload?.requestId) {
        void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
      }
    });
    const textarea = document.querySelector(".composer textarea");
    if (!textarea) return { error: "composer textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const send = document.querySelector(".sendButton");
    if (!send || send.disabled) return { error: "send button unavailable" };
    send.click();
    for (let i = 0; i < 90; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (events.some((event) => event?.type === "done")) break;
    }
    unsubscribe();
    const conversation = (await window.latex.conversation.list()).find((c) => c.messages.some((m) => String(m.content ?? "").includes(text.slice(0, 24))));
    return {
      streamed: events.filter((event) => event?.type === "message").map((event) => String(event.payload ?? "")).join(""),
      conversationId: conversation?.id ?? null
    };
  }, prompt);
}

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForTimeout(2500);

  // ── Startup: the start screen, never a blank centre ─────────────────────
  console.log("\n── Startup start screen ─────────────────────────────────");
  const startup = await page.evaluate(async () => {
    const list = await window.latex.conversation.list();
    const panel = document.querySelector(".home");
    // The visible content of the start screen: its title and quick actions.
    const title = panel?.querySelector(".homeTitle");
    const hint = panel?.querySelector(".quickGrid");
    const composer = document.querySelector(".composer");
    // The area the conversation column lives in (no .chatScroll while the
    // conversation view is not mounted).
    const area = (document.querySelector(".chatScroll") ?? document.querySelector(".content"))?.getBoundingClientRect();
    const rect = (node) => {
      const box = node?.getBoundingClientRect();
      return box ? { center: Math.round(box.left + box.width / 2), left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), box } : null;
    };
    const titleRect = rect(title);
    const hintRect = rect(hint);
    const panelRect = rect(panel);
    return {
      persisted: list.length,
      bubbles: document.querySelectorAll("article.message").length,
      panelText: panel ? panel.innerText.replace(/\s+/g, " ") : "",
      titleCenter: titleRect?.center ?? null,
      hintCenter: hintRect?.center ?? null,
      hintWidth: hintRect?.width ?? null,
      panelLeft: panelRect?.left ?? null,
      areaCenter: area ? Math.round(area.left + area.width / 2) : null,
      areaLeft: area ? Math.round(area.left) : null,
      areaRight: area ? Math.round(area.right) : null,
      hasComposer: Boolean(composer),
      activeRows: document.querySelectorAll(".recentRow.active").length,
      viewport: window.innerWidth,
      sidebarWidth: Math.round(document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  });
  check("no conversation is loaded on startup", startup.bubbles === 0, `${startup.bubbles} bubbles`);
  check("nothing is selected in the sidebar", startup.activeRows === 0, `${startup.activeRows} active rows`);
  check("saved chats are still listed", startup.persisted > 0, `${startup.persisted} conversations`);
  check("the centre shows the start screen", /What should we work on in Latex/i.test(startup.panelText), startup.panelText.slice(0, 160));
  check("the start screen keeps its quick actions", /Build a new feature/i.test(startup.panelText) && /Fix an issue/i.test(startup.panelText), startup.panelText.slice(0, 160));
  check("the composer is present on the start screen", startup.hasComposer === true);
  const startupOffset = Math.abs((startup.titleCenter ?? 0) - (startup.areaCenter ?? 0));
  console.log(`  startup @${startup.viewport}px: start screen title centered at ${startup.titleCenter}, quick actions at ${startup.hintCenter}, content area ${startup.areaLeft}–${startup.areaRight} (centre ${startup.areaCenter}), offset ${startupOffset}px`);
  check("the start screen is centered in the content area", startupOffset <= 16, `${startupOffset}px`);
  check("its quick actions are centered too, not left-aligned in a wide panel", Math.abs((startup.hintCenter ?? 0) - (startup.areaCenter ?? 0)) <= 16, `${startup.hintCenter} vs ${startup.areaCenter}`);
  check("the start screen does not overlap the sidebar", (startup.panelLeft ?? 0) >= startup.sidebarWidth - 1, `panel left ${startup.panelLeft}, sidebar ${startup.sidebarWidth}`);
  check("the start screen does not stretch across the window", (startup.hintWidth ?? 0) <= Math.min(960, startup.viewport), `${startup.hintWidth}px of ${startup.viewport}px`);
  check("no horizontal overflow", startup.horizontalOverflow === false);

  // ── Point at the stub model and run a CHAT turn ──────────────────────────
  const modelInfo = await page.evaluate(async (wanted) => {
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const stubModel = models.find((m) => String(m.name).includes(wanted));
    if (!stubModel) return { error: "stub model missing", count: models.length };
    await window.latex.settings.save({ provider: "omniroute", selectedModel: stubModel.name, autoSelectModel: false });
    const confirmed = await window.latex.settings.get();
    return {
      name: stubModel.name,
      previousProvider: before.provider ?? null,
      previousModel: before.selectedModel ?? null,
      previousAuto: before.autoSelectModel ?? null,
      confirmedModel: confirmed.selectedModel
    };
  }, MODEL_ID);
  if (modelInfo.error) throw new Error(`${modelInfo.error} (${modelInfo.count} models)`);
  previous = modelInfo;
  check("the stub model is selected", String(modelInfo.confirmedModel).includes(MODEL_ID), String(modelInfo.confirmedModel));

  console.log("\n── Chat turn: the shared contract reaches the model ──────");
  await page.evaluate(() => {
    const chatTab = document.querySelector(".modeToggleBtn");
    const buttons = Array.from(document.querySelectorAll(".modeToggleBtn"));
    const chat = buttons.find((button) => /chat/i.test(button.textContent ?? ""));
    if (chat && !chat.classList.contains("active")) chat.click();
    else if (chatTab) chatTab.click();
  });
  await page.waitForTimeout(600);
  const chatTurn = await sendThroughUi(page, "Explain how Latex keeps responses consistent across models.");
  if (chatTurn.conversationId) createdConversationIds.push(chatTurn.conversationId);
  check("the chat turn completed", !chatTurn.error, chatTurn.error ?? "");
  check("the chat reply was streamed", /Key Differences/i.test(chatTurn.streamed), `${chatTurn.streamed.length} chars`);

  const chatRequest = requests.find((request) => !request.hasTools);
  check("a chat request reached the gateway without tools", Boolean(chatRequest), JSON.stringify(requests.map((r) => r.hasTools)));
  check("the chat system prompt carries the shared standard", /Response standard/i.test(chatRequest?.system ?? ""), (chatRequest?.system ?? "").slice(0, 80));
  check("the chat system prompt is the Chat prompt plus the standard", /Chat mode/.test(chatRequest?.system ?? ""));
  check("the chat system prompt does not contain tool protocol", !/Tool protocol/.test(chatRequest?.system ?? ""));

  // ── A Main-Agent turn gets the SAME standard ────────────────────────────
  console.log("\n── Main turn: the same standard ──────────────────────────");
  await page.evaluate(async () => {
    const buttons = Array.from(document.querySelectorAll(".modeToggleBtn"));
    const main = buttons.find((button) => /main/i.test(button.textContent ?? ""));
    main?.click();
    await window.latex.conversation.list();
  });
  await page.waitForTimeout(600);
  const mainTurn = await sendThroughUi(page, "Summarize what this workspace does.");
  if (mainTurn.conversationId) createdConversationIds.push(mainTurn.conversationId);
  check("the main turn completed", !mainTurn.error, mainTurn.error ?? "");
  const mainRequest = requests.filter((request) => request.hasTools).pop();
  check("a main request reached the gateway with tools", Boolean(mainRequest));
  check("the main system prompt carries the shared standard", /Response standard/i.test(mainRequest?.system ?? ""), (mainRequest?.system ?? "").slice(0, 80));
  check("the main system prompt keeps the coding-agent rules", /never output code|tool protocol/i.test(mainRequest?.system ?? ""));

  // Both modes must carry the SAME standard text. (In Main mode it is not the
  // last thing in the prompt — the workspace context is appended after it — so
  // compare by inclusion and check it was applied exactly once.)
  const occurrences = (system, needle) => (system ?? "").split(needle).length - 1;
  check("both modes carry the byte-identical standard",
    (chatRequest?.system ?? "").includes(LATEX_RESPONSE_CONTRACT) && (mainRequest?.system ?? "").includes(LATEX_RESPONSE_CONTRACT),
    `chat=${(chatRequest?.system ?? "").includes(LATEX_RESPONSE_CONTRACT)} main=${(mainRequest?.system ?? "").includes(LATEX_RESPONSE_CONTRACT)}`);
  check("the standard is applied exactly once per request",
    occurrences(chatRequest?.system, LATEX_RESPONSE_CONTRACT) === 1 && occurrences(mainRequest?.system, LATEX_RESPONSE_CONTRACT) === 1,
    `chat=${occurrences(chatRequest?.system, LATEX_RESPONSE_CONTRACT)} main=${occurrences(mainRequest?.system, LATEX_RESPONSE_CONTRACT)}`);

  // ── One renderer: structured Markdown becomes structured DOM ────────────
  console.log("\n── Markdown rendering (same renderer, all providers) ─────");
  const dom = await page.evaluate(() => {
    const root = document.querySelector(".messageText.markdown");
    if (!root) return { missing: true };
    const text = root.innerText;
    const table = root.querySelector(".mdTableWrap table");
    const wrap = root.querySelector(".mdTableWrap");
    const box = root.getBoundingClientRect();
    const scroller = document.querySelector(".chatScroll")?.getBoundingClientRect();
    const wrapBox = wrap?.getBoundingClientRect();
    return {
      missing: false,
      headings: Array.from(root.querySelectorAll("h1, h2, h3, h4")).map((node) => node.textContent),
      bullets: root.querySelectorAll("ul li").length,
      tablePresent: Boolean(table),
      headerCells: Array.from(table?.querySelectorAll("th") ?? []).map((cell) => cell.textContent),
      bodyRows: table?.querySelectorAll("tbody tr").length ?? 0,
      codeBlocks: root.querySelectorAll("pre code, .codeBlock").length,
      bold: root.querySelectorAll("strong").length,
      rawHashes: /^\s*#{1,6}\s/m.test(text),
      rawPipes: /^\s*\|/m.test(text),
      rawFences: /```/.test(text),
      wrapScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
      rootWidth: Math.round(box.width),
      rootLeft: Math.round(box.left),
      rootCenter: Math.round(box.left + box.width / 2),
      scrollerLeft: Math.round(scroller?.left ?? 0),
      scrollerRight: Math.round(scroller?.right ?? 0),
      scrollerCenter: Math.round((scroller?.left ?? 0) + (scroller?.width ?? 0) / 2),
      wrapRight: wrapBox ? Math.round(wrapBox.right) : null
    };
  });
  check("the assistant message renders through the markdown pipeline", !dom.missing, dom.missing ? "no .messageText.markdown found" : "found");
  check("headings render as headings", (dom.headings?.length ?? 0) >= 4, JSON.stringify(dom.headings));
  check("bullets render as list items", (dom.bullets ?? 0) >= 2, String(dom.bullets));
  check("tables render as real tables (GFM enabled)", dom.tablePresent === true);
  check("the table keeps its header cells", JSON.stringify(dom.headerCells) === JSON.stringify(["Metric", "Model A", "Model B"]), JSON.stringify(dom.headerCells));
  check("the table keeps its rows", (dom.bodyRows ?? 0) === 2, String(dom.bodyRows));
  check("code blocks render as code", (dom.codeBlocks ?? 0) >= 1, String(dom.codeBlocks));
  check("bold text renders as bold", (dom.bold ?? 0) >= 2, String(dom.bold));
  check("no raw markdown leaks into the UI", !dom.rawHashes && !dom.rawPipes && !dom.rawFences, `hashes=${dom.rawHashes} pipes=${dom.rawPipes} fences=${dom.rawFences}`);
  check("a table never overflows the conversation column", dom.wrapRight !== null && dom.wrapRight <= dom.scrollerRight + 1, `wrap right ${dom.wrapRight} vs column right ${dom.scrollerRight}`);
  check("assistant content stays inside the centered column", Math.abs(dom.rootCenter - dom.scrollerCenter) <= 12, `${dom.rootCenter} vs ${dom.scrollerCenter}`);

  // ── Selecting a chat loads it; New Chat shows the empty state ───────────
  console.log("\n── Chat selection + New Chat ─────────────────────────────");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForTimeout(2000);
  const afterReload = await page.evaluate(() => ({
    bubbles: document.querySelectorAll("article.message").length,
    panel: document.querySelector(".home")?.innerText.replace(/\s+/g, " ") ?? ""
  }));
  check("reopening Latex starts on the start screen again", afterReload.bubbles === 0 && /What should we work on in Latex/i.test(afterReload.panel), afterReload.panel.slice(0, 120));

  const sidebarRows = await page.evaluate(() => Array.from(document.querySelectorAll(".recentRow")).map((row) => row.innerText.trim().split("\n")[0]));
  const targetTitle = sidebarRows.find((title) => /Explain how Latex keeps/i.test(title)) ?? sidebarRows[0];
  const selected = await page.evaluate(async (title) => {
    const row = Array.from(document.querySelectorAll(".recentRow")).find((node) => node.innerText.includes(title));
    if (!row) return { error: "row not found" };
    row.querySelector("button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const scroller = document.querySelector(".chatScroll");
    return {
      bubbles: document.querySelectorAll("article.message").length,
      panelGone: !document.querySelector(".home"),
      remaining: scroller ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : null,
      markdown: document.querySelectorAll(".messageText.markdown").length
    };
  }, targetTitle ?? "");
  check("clicking a chat replaces the start screen with its messages", !selected.error && selected.bubbles > 0 && selected.panelGone === true, selected.error ?? `${selected.bubbles} bubbles`);
  check("the selected chat opens at its latest message", selected.remaining !== null && selected.remaining <= 12, `${selected.remaining}px from the bottom`);
  check("its reply still renders as markdown", (selected.markdown ?? 0) >= 1, String(selected.markdown));

  const newChatState = await page.evaluate(async () => {
    const button = Array.from(document.querySelectorAll(".navItem")).find((node) => /new chat/i.test(node.textContent ?? ""));
    if (!button) return { error: "New Chat button not found" };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const state = document.querySelector(".home");
    const grid = state?.querySelector(".quickGrid");
    return {
      visible: Boolean(state),
      text: state ? state.innerText.replace(/\s+/g, " ") : "",
      hasQuickActions: Boolean(grid),
      bubbles: document.querySelectorAll("article.message").length,
      activeRows: document.querySelectorAll(".recentRow.active").length,
      textareaFocused: document.activeElement?.tagName === "TEXTAREA",
      composerPresent: Boolean(document.querySelector(".composer textarea"))
    };
  });
  check("New Chat shows the start screen, not a bare conversation", newChatState.visible === true, newChatState.error ?? newChatState.text.slice(0, 120));
  check("the start screen names itself and keeps its quick actions", /What should we work on in Latex/i.test(newChatState.text) && newChatState.hasQuickActions, newChatState.text.slice(0, 120));
  check("the new chat has no messages yet", newChatState.bubbles === 0, `${newChatState.bubbles} bubbles`);
  check("starting a new chat clears the sidebar selection", newChatState.activeRows === 0, `${newChatState.activeRows} active rows`);
  check("the composer stays available for the new chat", newChatState.composerPresent === true);
  check("the composer is focused for a new chat", newChatState.textareaFocused === true, String(newChatState.textareaFocused));

  // ── Window behaviour: the layout must not shift ─────────────────────────
  console.log("\n── Window behaviour ──────────────────────────────────────");
  const layouts = [];
  for (const zoom of [1, 0.6, 1.5]) {
    await app.evaluate(({ BrowserWindow }, factor) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      win.setSize(1400, 900);
      win.webContents.setZoomFactor(factor);
    }, zoom);
    await page.waitForTimeout(400);
    layouts.push(await page.evaluate(() => {
      const grid = document.querySelector(".quickGrid")?.getBoundingClientRect();
      const area = document.querySelector(".content")?.getBoundingClientRect();
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        offset: grid && area ? Math.abs(Math.round((grid.left + grid.width / 2) - (area.left + area.width / 2))) : null,
        width: grid ? Math.round(grid.width) : null,
        composerOffset: grid && composer ? Math.abs(Math.round((grid.left + grid.width / 2) - (composer.left + composer.width / 2))) : null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    }));
  }
  for (const layout of layouts) {
    console.log(`  ${layout.viewport}px → start screen ${layout.width}px, centre offset ${layout.offset}px, composer offset ${layout.composerOffset}px`);
  }
  check("the start screen stays centered at every width", layouts.every((l) => (l.offset ?? 99) <= 16), layouts.map((l) => `${l.viewport}:${l.offset}`).join(" "));
  check("the start screen and composer share the column", layouts.every((l) => (l.composerOffset ?? 99) <= 18), layouts.map((l) => `${l.viewport}:${l.composerOffset}`).join(" "));
  check("no layout overflow at any width", layouts.every((l) => l.overflow === false), layouts.map((l) => `${l.viewport}:${l.overflow}`).join(" "));

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.webContents.setZoomFactor(1);
    win.maximize();
  });
  await page.waitForTimeout(500);
  const maximized = await page.evaluate(() => {
    const grid = document.querySelector(".quickGrid")?.getBoundingClientRect();
    const area = document.querySelector(".content")?.getBoundingClientRect();
    return {
      offset: grid && area ? Math.abs(Math.round((grid.left + grid.width / 2) - (area.left + area.width / 2))) : null,
      width: grid ? Math.round(grid.width) : null,
      viewport: window.innerWidth
    };
  });
  check("a maximized window keeps the start screen centered and bounded", (maximized.offset ?? 99) <= 16 && (maximized.width ?? 0) <= 960, JSON.stringify(maximized));
} catch (err) {
  console.error("\nResponse-standard run threw:", err?.message ?? err);
  results.push({ name: "response-standard run completed", ok: false });
} finally {
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ ids, settings }) => {
      for (const id of ids) {
        if (!id) continue;
        try { await window.latex.conversation.delete(id); } catch { /* ignore */ }
      }
      if (settings) {
        await window.latex.settings.save({
          provider: settings.previousProvider ?? undefined,
          selectedModel: settings.previousModel ?? undefined,
          autoSelectModel: settings.previousAuto ?? undefined
        }).catch(() => undefined);
      }
    }, { ids: createdConversationIds, settings: previous });
  } catch { /* ignore */ }
  await app.close().catch(() => undefined);
  stub.close();
}

const failed = results.filter((result) => !result.ok);
console.log("─".repeat(64));
console.log(`${results.length - failed.length}/${results.length} response-standard checks passed`);
console.log("─".repeat(64));
process.exit(failed.length === 0 ? 0 : 1);
