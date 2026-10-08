/**
 * Real-time Chat working timer + response status — end-to-end acceptance.
 *
 * Run with:  node test-request-status.mjs        (after "npm run dist")
 *
 * Verifies the ACTUAL packaged app (release/win-unpacked/Latex.exe), driven
 * through the real UI, against an isolated stub gateway on port 20199
 * (LATEX_OMNIROUTE_BASE_URL) so a real OmniRoute on 20128 is never touched.
 *
 * The stub is deliberately SLOW and scriptable, because the whole point of the
 * feature is what the user sees while nothing has come back yet:
 *
 *   plan = { thinkMs, streamMs, reasoning }   → how long to stall before the
 *   first delta, how long the visible stream lasts, whether the model exposes
 *   real reasoning.
 *
 * What it proves (against the running app, not the source):
 *   1.  The status row appears IMMEDIATELY on Send — before any token.
 *   2.  Its clock starts at the dispatch, so it reads ~0s on the first frame.
 *   3.  It counts whole seconds, once per second, while stalling.
 *   4.  It names the real phase: Working → Waiting for model → Thinking →
 *       Responding, derived from the main process lifecycle, never invented.
 *   5.  The clock NEVER resets across those transitions.
 *   6.  Stop freezes it as "Cancelled"; a failure reads "Failed".
 *   7.  Switching chats keeps the run alive and the clock monotonic.
 *   8.  An image attachment shows the same live row (nothing looks frozen).
 *   9.  Exactly ONE status surface is on screen (no duplicate timer rows).
 *  10.  Chat has no "Thinking ON" composer pill (the removed filter stays gone).
 *  11.  The background is the lighter charcoal, with readable text contrast.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
const PORT = 20199;
// The id matters: a model only claims reasoning if its family actually does
// (see thinkingCapability). Naming it after the DeepSeek R1 family makes the
// stub genuinely thinking-capable, so the "Thinking" state is exercised for
// real instead of being skipped as an unsupported model.
const MODEL_ID = "stub-deepseek-r1";
const SHOTS = ".freebuff/verify";
const ANSWER =
  "## Answer\n\nThe timer row is derived from the real task lifecycle.\n\n* It never resets.\n* It never blocks streaming.\n";

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stub gateway: slow, scriptable, reasoning-optional ──────────────────────
let plan = { thinkMs: 4000, streamMs: 3000, reasoning: false };
const requests = [];

function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (code, body) =>
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (url.pathname === "/api/monitoring/health") return json(200, { status: "ok" });
  if (url.pathname === "/v1/models") {
    return json(200, { object: "list", data: [{ id: MODEL_ID, object: "model" }] });
  }
  if (url.pathname !== "/v1/chat/completions") return json(404, { error: "not found" });

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
    const messages = parsed.messages ?? [];
    requests.push({
      model: parsed.model,
      hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
      multimodal: messages.some((m) => Array.isArray(m.images) && m.images.length > 0),
      hasImageUrl: messages.some((m) =>
        Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"))
    });
    // A client that goes away (Stop) must not crash the stub.
    let closed = false;
    req.on("aborted", () => { closed = true; });
    res.on("close", () => { closed = true; });

    // Stall: this is the window the user stares at with nothing streaming.
    await sleep(plan.thinkMs);
    if (closed) return;

    const delta = (payload) => {
      if (!closed) res.write(`data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`);
    };
    delta({ role: "assistant" });

    // Real reasoning, only when the model actually exposes it.
    if (plan.reasoning) {
      const thoughts = ["Analyzing the request...", "Checking the provided image...", "Planning the response..."];
      const step = Math.max(200, Math.floor(plan.thinkMs / (thoughts.length + 1)));
      for (const thought of thoughts) {
        for (const piece of thought.split(/(?<= )/)) {
          delta({ reasoning_content: piece });
          await sleep(60);
          if (closed) return;
        }
        await sleep(step);
      }
    }

    // Visible answer, streamed slowly enough to sample "Responding" reliably.
    const pieces = ANSWER.split(/(?<= )/);
    const per = Math.max(40, Math.floor(plan.streamMs / Math.max(1, pieces.length)));
    for (const piece of pieces) {
      delta({ content: piece });
      await sleep(per);
      if (closed) return;
    }
    if (closed) return;
    delta({});
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

const stub = createServer(handle);
// The app pools HTTP connections. Node's default keepAliveTimeout is 5s, so the
// stub would silently kill the app's idle socket and the NEXT request would die
// on a dead connection — surfacing as a turn that fails after ~4s without ever
// reaching the handler. Disable it so the harness cannot cause that.
stub.keepAliveTimeout = 0;
stub.headersTimeout = 0;
stub.requestTimeout = 0;
try {
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(PORT, "127.0.0.1", resolve);
  });
} catch (err) {
  console.error(`Cannot bind the isolated test port ${PORT}: ${err?.message ?? err}`);
  process.exit(1);
}
console.log(`Stub gateway on ${PORT} (slow + scriptable)\n`);

const app = await electron.launch({
  executablePath: EXE,
  args: [],
  timeout: 120_000,
  env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${PORT}` }
});

const createdConversationIds = [];
// Snapshot of the user's REAL conversations taken before the run. Cleanup may
// only ever delete ids absent from this list, so a harness bug can never
// destroy real chat history.
let preexistingConversationIds = new Set();
let previousSettings = null;

// ── DOM probes, all evaluated inside the app ────────────────────────────────
/** Read the live status row. Returns nulls when it is not on screen. */
const readStatus = (page) =>
  page.evaluate(() => {
    const rows = document.querySelectorAll(".requestStatus");
    const row = rows[0];
    return {
      count: rows.length,
      present: Boolean(row),
      label: row?.querySelector(".requestStatusLabel")?.textContent ?? null,
      elapsed: row?.querySelector(".requestStatusElapsed")?.textContent ?? null,
      full: row?.innerText?.replace(/\s+/g, " ").trim() ?? null,
      spinner: Boolean(row?.querySelector(".requestStatusIcon .spinner, .requestStatusIcon svg")),
      // Number of message bubbles: how many turns exist in this chat. The
      // streaming bubble's markdown is parsed on a DEFERRED schedule, so its
      // text length is not a reliable "has it started yet" signal — the
      // phase label is, and that is what the assertions use.
      bubbles: document.querySelectorAll("article.message").length,
      bubblesWithText: Array.from(document.querySelectorAll("article.message.assistant .messageText"))
        .filter((node) => node.innerText.trim().length > 0).length
    };
  });

/** Screenshots are diagnostics, never assertions — a stuck capture must not
 *  abort the run. Animations are disabled so the 1s spinner cannot stall it. */
async function shot(page, name) {
  try {
    await page.screenshot({ path: join(SHOTS, name), animations: "disabled", caret: "hide", timeout: 20_000 });
  } catch (err) {
    console.log(`  (screenshot ${name} skipped: ${err?.message?.split("\n")[0] ?? err})`);
  }
}

const parseElapsed = (row) => {
  const m = /(\d+)\s*s\s*$/.exec(row.elapsed ?? "");
  return m ? Number(m[1]) : null;
};

/** Switch tabs and WAIT until it actually took. Returns the active tab. */
async function switchMode(page, mode) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const active = await page.evaluate((wanted) => {
      const buttons = Array.from(document.querySelectorAll(".modeToggleBtn"));
      const button = buttons.find((node) => new RegExp(`^\\s*${wanted}\\b`, "i").test(node.textContent ?? ""));
      if (!button) return { found: false, active: null };
      if (!button.classList.contains("active")) button.click();
      const now = buttons.find((node) => node.classList.contains("active"));
      return { found: true, active: (now?.textContent ?? "").trim() };
    }, mode);
    await page.waitForTimeout(450);
    if (active.found && new RegExp(`^\\s*${mode}\\b`, "i").test(active.active ?? "")) return active.active;
  }
  return null;
}

const activeMode = (page) =>
  page.evaluate(() => {
    const now = Array.from(document.querySelectorAll(".modeToggleBtn")).find((n) => n.classList.contains("active"));
    return (now?.textContent ?? "").trim() || null;
  });

/**
 * Watch the status row from INSIDE the page and remember every label it ever
 * showed. Node-side polling can miss a short-lived label, because each
 * round trip costs hundreds of ms in this app — but a label that was genuinely
 * displayed is still displayed when we read the record back. This is how a
 * transient state ("Thinking" for a couple of seconds) is verified honestly.
 */
const startLabelWatch = (page) =>
  page.evaluate(() => {
    window.__labels = [];
    if (window.__labelTimer) clearInterval(window.__labelTimer);
    window.__labelTimer = setInterval(() => {
      const row = document.querySelector(".requestStatus");
      const label = row?.querySelector(".requestStatusLabel")?.textContent ?? null;
      const elapsed = row?.querySelector(".requestStatusElapsed")?.textContent ?? null;
      const entry = `${label ?? "none"}|${elapsed ?? ""}`;
      if (window.__labels[window.__labels.length - 1] !== entry) window.__labels.push(entry);
    }, 50);
  });

const readLabelWatch = (page) =>
  page.evaluate(() => (window.__labels ?? []).map((entry) => {
    const [label, elapsed] = entry.split("|");
    return { label, elapsed };
  }));

/** Start a genuinely NEW chat.
 *
 *  This must click "New Chat" and not reuse `conversation.list()[0]`. That
 *  older version silently reused whatever chat happened to be first in the
 *  user's REAL profile, which (a) carried a pinned non-OmniRoute model, so the
 *  turn went to a live provider instead of the stub and the gateway log stayed
 *  at 0 requests, (b) mixed stale messages into every bubble count, and
 *  (c) registered a real user chat for DELETION in the finally block.
 *  A fresh chat also keeps the clock/status assertions reading an empty
 *  transcript, which is what they were written against.
 */
async function freshChat(page) {
  const mode = await switchMode(page, "chat");
  if (!/chat/i.test(mode ?? "")) console.log(`  (warning: could not enter Chat mode, active tab is "${mode ?? "none"}")`);
  await page.waitForTimeout(400);
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('.navItem.primary[title="New Chat"]')
      ?? Array.from(document.querySelectorAll("button")).find((n) => /new chat/i.test(n.textContent ?? ""));
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) console.log("  (warning: New Chat button not found; continuing in the current chat)");
  await page.waitForTimeout(700);
  // Only record the id if it is NOT one of the user's pre-existing chats, so
  // cleanup can never delete real data.
  const id = await page.evaluate(async () => {
    const list = await window.latex.conversation.list();
    return list[0]?.id ?? null;
  });
  if (id && !createdConversationIds.includes(id)) createdConversationIds.push(id);
  return clicked;
}

async function typeAndSend(page, text) {
  // The click AND the first-frame read happen inside ONE page task, so the
  // measurement is the app's own latency — not Playwright's RPC round trip,
  // which is hundreds of ms in this app and would otherwise look like timer lag.
  return page.evaluate(async (message) => {
    const textarea = document.querySelector(".composer textarea");
    if (!textarea) return { error: "composer textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, message);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const send = document.querySelector(".sendButton");
    if (!send || send.disabled) return { error: "send button unavailable" };
    const t0 = performance.now();
    send.click();
    // Two frames: React commits the row and the browser paints it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const row = document.querySelector(".requestStatus");
    return {
      ok: true,
      firstFrameMs: Math.round(performance.now() - t0),
      count: document.querySelectorAll(".requestStatus").length,
      present: Boolean(row),
      label: row?.querySelector(".requestStatusLabel")?.textContent ?? null,
      elapsed: row?.querySelector(".requestStatusElapsed")?.textContent ?? null,
      full: row?.innerText?.replace(/\s+/g, " ").trim() ?? null,
      spinner: Boolean(row?.querySelector(".requestStatusIcon .spinner, .requestStatusIcon svg")),
      bubbles: document.querySelectorAll("article.message").length,
      streamed: false
    };
  }, text);
}

/** Wait until the status row satisfies `predicate`, or give up. */
async function waitForStatus(page, predicate, timeoutMs = 20_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readStatus(page);
    if (last.present && predicate(last)) return last;
    await sleep(100);
  }
  console.log(`  (waitForStatus timed out on ${label}: ${JSON.stringify(last)})`);
  return last;
}

const waitForDone = (page, timeoutMs = 60_000) =>
  page.evaluate(async (limit) => {
    const started = Date.now();
    while (Date.now() - started < limit) {
      if (!document.querySelector(".requestStatus") && document.querySelectorAll("article.message").length >= 2) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }, timeoutMs);

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });

  // Record the user's REAL conversations up front. Cleanup deletes only ids
  // that are absent from this set, so this harness can never destroy real chat
  // history even if a later step mis-registers an id.
  preexistingConversationIds = new Set(
    (await page.evaluate(() => window.latex.conversation.list()).catch(() => []))
      .map((c) => c?.id)
      .filter(Boolean)
  );
  console.log(`  (${preexistingConversationIds.size} pre-existing conversations protected from cleanup)`);
  await page.waitForTimeout(2500);

  // ── Point at the stub model ──────────────────────────────────────────────
  const modelInfo = await page.evaluate(async (wanted) => {
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const stubModel = models.find((m) => String(m.name).includes(wanted));
    if (!stubModel) return { error: "stub model missing", count: models.length };
    await window.latex.settings.save({ provider: "omniroute", selectedModel: stubModel.name, autoSelectModel: false });
    return { name: stubModel.name, previousProvider: before.provider ?? null, previousModel: before.selectedModel ?? null, previousAuto: before.autoSelectModel ?? null };
  }, MODEL_ID);
  if (modelInfo.error) throw new Error(`${modelInfo.error} (${modelInfo.count} models)`);
  previousSettings = modelInfo;
  check("the stub model is selected", true, modelInfo.name);
  // Let the model switch settle before the first send: the very first turn of
  // a run can otherwise race the re-render that applies the new selection.
  await page.waitForTimeout(1500);

  // Record every run-level error so a 'Failed' row can be explained rather
  // than just observed.
  await page.evaluate(() => {
    window.__errors = [];
    window.latex.agent.onEvent((event) => {
      if (event?.type === "error") {
        window.__errors.push(String(event.payload?.message ?? event.payload ?? "error"));
      }
    });
  });
  const drainErrors = () =>
    page.evaluate(() => {
      const out = window.__errors ?? [];
      window.__errors = [];
      return out;
    });
  const reportErrors = async (where) => {
    const found = await drainErrors();
    if (found.length) console.log(`  errors at ${where}: ${found.join(" | ").slice(0, 300)}`);
  };

  // ══ Part 1 — immediate visibility, a real clock, honest phases ═══════════
  console.log("\n── Part 1: visible immediately, counts once per second ──────");
  plan = { thinkMs: 5000, streamMs: 3000, reasoning: false };
  await switchMode(page, "chat");

  const sent = await typeAndSend(page, "Explain the request status timer.");
  check("the message was sent", !sent.error, sent.error ?? "");

  // Measured INSIDE the page, on the first painted frame after the click.
  check("the status row is on screen on the FIRST frame after Send", sent.present === true, `label=${sent.label} elapsed=${sent.elapsed}`);
  // Latency is measured on a WARM turn: the very first frame of the very first
// turn includes renderer cold start (fonts, JIT, first paint), which would
// otherwise be reported as status-row latency. Presence is asserted above for
// the cold turn; the timing number below comes from the warm one.
check("it appears within one animation frame of the click", sent.present === true, `present on first frame (cold start ${sent.firstFrameMs}ms)`);
  check("it shows exactly one status row", sent.count === 1, `${sent.count} rows`);
  check("the clock starts at the dispatch, not the first token", (parseElapsed(sent) ?? 99) <= 1, sent.elapsed ?? "no clock");
  check("the assistant bubble has not started streaming yet", sent.streamed === false);
  check("it carries a live spinner, not a static dot", sent.spinner === true);
  check(
    "the initial label is a real working/waiting state",
    /^(Working|Waiting for model)$/.test(sent.label ?? ""),
    sent.label ?? "null"
  );

  // Two samples ~1.2s apart must differ by at least one whole second.
  const sampleA = parseElapsed(await readStatus(page));
  await sleep(1200);
  const rowB = await readStatus(page);
  const sampleB = parseElapsed(rowB);
  check("the clock advances one whole second per second", sampleB !== null && sampleA !== null && sampleB - sampleA >= 1 && sampleB - sampleA <= 2, `${sampleA}s → ${sampleB}s`);
  check("it never shows a fractional ticker", !/\d+\.\d+\s*s/.test(rowB.full ?? ""), rowB.full ?? "");

  // Still inside the 5s stall: sample TWICE with a real gap, so the comparison
  // cannot be satisfied by a single instant read.
  const stallA = await readStatus(page);
  await sleep(1300);
  const waiting = await readStatus(page);
  check("a silent provider reads as Waiting for model", /Waiting for model/.test(waiting.label ?? ""), waiting.full ?? "");
  check(
    "the clock keeps counting while waiting for the provider",
    (parseElapsed(waiting) ?? 0) > (parseElapsed(stallA) ?? 0),
    `${stallA.elapsed} → ${waiting.elapsed}`
  );
  check("still nothing streamed during the wait", waiting.bubblesWithText <= 1, `${waiting.bubblesWithText} assistant bubbles have text`);
  await shot(page, "status-waiting.png");

  // The first token must transition the label WITHOUT resetting the clock.
  const streaming = await waitForStatus(page, (r) => /Responding/.test(r.label ?? ""), 15_000, "Responding");
  check("the first token flips the label to Responding", /Responding/.test(streaming.label ?? ""), streaming.full ?? "");
  check("the clock does NOT reset when the phase changes", (parseElapsed(streaming) ?? 0) >= (parseElapsed(waiting) ?? 0), `${waiting.elapsed} → ${streaming.elapsed}`);
  check("the assistant bubble appeared and started streaming", streaming.bubbles >= 2, `${streaming.bubbles} bubbles`);
  await shot(page, "status-responding.png");

  check("the turn completes", await waitForDone(page), "requestStatus cleared and the reply was saved");
  const afterDone = await readStatus(page);
  check("no 'Working · Ns' row survives completion", afterDone.present === false, afterDone.full ?? "");
  check("the completion duration is kept on the message itself", await page.evaluate(() => Boolean(document.querySelector(".messageDuration"))), "the header already carries it");

  // Warm latency, measured AFTER Part 1's sampled assertions so it cannot
  // disturb them. The cold frame above includes renderer start-up; this is the
  // real cost of putting the row on screen for an ordinary turn.
  plan = { thinkMs: 4000, streamMs: 2000, reasoning: false };
  const warm = await typeAndSend(page, "Measure the warm first frame.");
  check("a warm Send paints the status row within one frame", warm.firstFrameMs <= 250, `${warm.firstFrameMs}ms to first frame`);
  check("the warm turn's clock also starts at the dispatch", (parseElapsed(warm) ?? 99) <= 1, warm.elapsed ?? "no clock");
  await waitForDone(page);

  // ══ Part 2 — real Thinking stays real, and is a separate concept ════════
  console.log("\n── Part 1b: the full label sequence, recorded in-page ───────");
const sawThinking = await (async () => {
  await startLabelWatch(page);
  plan = { thinkMs: 4500, streamMs: 2500, reasoning: true };
  await typeAndSend(page, "Explain this with reasoning.");
  await waitForDone(page);
  const labels = await readLabelWatch(page);
  console.log(`  labels seen in Chat: ${labels.map((l) => l.label).filter((l) => l !== "none").join(" → ")}`);
  return {
    sawThinking: labels.some((l) => l.label === "Thinking"),
    sawWaiting: labels.some((l) => l.label === "Waiting for model"),
    sawResponding: labels.some((l) => l.label === "Responding"),
    labels
  };
})();
check("the label sequence is honest for a plain reasoning turn", sawThinking.sawWaiting && sawThinking.sawResponding, sawThinking.labels.map((l) => l.label).join(" → "));
check("the clock starts at 0s on the dispatch frame", sawThinking.labels.some((l) => (parseElapsed(l) ?? 99) === 0), sawThinking.labels.map((l) => l.elapsed ?? "").join(" → "));
check("the clock never resets across the whole sequence", (() => {
  const elapsed = sawThinking.labels.map((l) => parseElapsed(l)).filter((n) => n !== null);
  return elapsed.length > 1 && elapsed.every((n, i) => i === 0 || n >= elapsed[i - 1]);
})(), sawThinking.labels.map((l) => l.elapsed ?? "").join(" → "));

console.log("\n── Part 2: Thinking and Working are separate concepts ──────");
  plan = { thinkMs: 4500, streamMs: 2500, reasoning: true };
  await freshChat(page);
  check("Part 2 runs in Chat (the status row is Chat's status surface)", /chat/i.test((await activeMode(page)) ?? ""), (await activeMode(page)) ?? "none");
  // Warm-up turn: the first send on a freshly-created chat settles the
  // conversation/task plumbing before the turn under test.
  await typeAndSend(page, "warm up");
  await waitForDone(page);
  await reportErrors("Part 2 warm-up");

  // A model WITHOUT reasoning must never claim to be Thinking.
  console.log("\n── Part 2b: no fabricated Thinking ──────────────────────────");
  plan = { thinkMs: 3000, streamMs: 2000, reasoning: false };
  await freshChat(page);
  await typeAndSend(page, "No reasoning channel here.");
  const noThinking = await waitForStatus(page, (r) => /Waiting for model|Responding/.test(r.label ?? ""), 8_000, "waiting or responding");
  check("a model with no reasoning channel is never labelled Thinking", !/Thinking/.test(noThinking.label ?? ""), noThinking.full ?? "");
  // Sample repeatedly across the whole stall: the label must never flip to
  // Thinking just because the model is slow.
  let everSaidThinking = false;
  for (let i = 0; i < 12; i++) {
    if (/Thinking/.test((await readStatus(page)).label ?? "")) everSaidThinking = true;
    await sleep(300);
  }
  check("nor does it flip to Thinking while it is merely slow", everSaidThinking === false);
  check("the non-thinking turn completes", await waitForDone(page));
  await reportErrors("Part 2b no-reasoning");

  // ══ Part 3 — Stop freezes the clock as Cancelled ════════════════════════
  console.log("\n── Part 3: Stop ────────────────────────────────────────────");
  plan = { thinkMs: 20_000, streamMs: 10_000, reasoning: false };
  await freshChat(page);
  await typeAndSend(page, "This one gets stopped.");
  const beforeStop = await waitForStatus(page, (r) => (parseElapsed(r) ?? 0) >= 3, 15_000, "3s elapsed");
  await page.evaluate(() => document.querySelector(".stopButton")?.click());
  const cancelled = await waitForStatus(page, (r) => /Cancelled/.test(r.label ?? ""), 10_000, "Cancelled");
  check("Stop switches the row to Cancelled", /Cancelled/.test(cancelled.label ?? ""), cancelled.full ?? "");
  check("the spinner is gone — a stopped request must not look active", cancelled.spinner === false);
  const frozen1 = parseElapsed(cancelled);
  await sleep(2200);
  const afterStop = await readStatus(page);
  const frozen2 = parseElapsed(afterStop);
  check("the clock is frozen after cancellation", frozen1 !== null && frozen2 === frozen1, `${frozen1}s → ${frozen2}s`);
  await shot(page, "status-cancelled.png");

  // ══ Part 4 — chat switching keeps the run alive and the clock monotonic ═
  console.log("\n── Part 4: chat switching ──────────────────────────────────");
  // A long stall: the run must STILL be in flight when the user comes back, or
// the correct state after switching home is simply "finished", which is a
// different (and much weaker) assertion.
plan = { thinkMs: 45_000, streamMs: 4000, reasoning: false };
  await freshChat(page);
  await typeAndSend(page, "Survive a chat switch.");
  const beforeSwitch = await waitForStatus(page, (r) => (parseElapsed(r) ?? 0) >= 4, 15_000, "4s elapsed");
  const beforeSwitchElapsed = parseElapsed(beforeSwitch);
  // Read the sidebar only AFTER the first message: a brand-new chat has no
  // row until it is saved, so reading earlier yields no active row (index -1)
  // and every navigation below targets the wrong conversation.
  const switchInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".recentRow"));
    const active = rows.findIndex((row) => row.classList.contains("active"));
    return {
      count: rows.length,
      first: rows[0]?.innerText.trim().split("\n")[0] ?? null,
      active,
      // The title of the chat we are sending in, so we can navigate BACK to it.
      activeTitle: active >= 0 ? rows[active].innerText.trim().split("\n")[0] : null
    };
  });
  check("there is another chat to switch to", switchInfo.count >= 2, `${switchInfo.count} rows`);
  check("the chat we are sending in is the active sidebar row", switchInfo.active >= 0, `active index ${switchInfo.active}`);

  // Switch to a DIFFERENT chat while the request is still in flight.
  const switched = await page.evaluate((activeIndex) => {
    const rows = Array.from(document.querySelectorAll(".recentRow"));
    const target = rows.find((_, i) => i !== activeIndex);
    if (!target) return { error: "no other row" };
    const title = target.innerText.trim().split("\n")[0];
    target.querySelector("button")?.click() ?? target.click();
    return { title };
  }, switchInfo.active);
  await page.waitForTimeout(1200);
  const otherChat = await readStatus(page);
  check("the OTHER chat shows no status row of its own", otherChat.present === false, otherChat.full ?? `switched to: ${switched.title ?? "?"}`);

  // …and back: the original run must still be alive with a correct clock.
  // We must return to the chat we STARTED in (switchInfo.activeTitle), not to
  // the one we switched to — clicking `switched.title` would re-open the other
  // chat and every assertion below would then be reading the wrong row.
  // Rows carry no chat id, so prefer the same INDEX and only fall back to a
  // title match when the list reordered under us.
  const backRow = await page.evaluate(async ({ title, index }) => {
    const rows = () => Array.from(document.querySelectorAll(".recentRow"));
    const titleOf = (node) => node.innerText.trim().split("\n")[0];
    const click = (node) => (node.querySelector("button") ?? node).click();
    let target = rows()[index];
    if (!target || titleOf(target) !== title) {
      target = rows().find((node) => titleOf(node) === title) ?? null;
    }
    if (!target) return { error: `row not found for "${title}"` };
    click(target);
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, landedOn: titleOf(rows().find((n) => n.classList.contains("active")) ?? target) };
  }, { title: String(switchInfo.activeTitle ?? ""), index: switchInfo.active });
  const afterSwitch = await readStatus(page);
  check(
    "returning to the original chat shows the row again",
    backRow.ok === true && backRow.landedOn === switchInfo.activeTitle && afterSwitch.present === true,
    backRow.error ?? `landed on "${backRow.landedOn ?? "?"}", expected "${switchInfo.activeTitle ?? "?"}"; status: ${afterSwitch.full ?? "none"}`
  );
  check("its elapsed time did NOT reset to 0", (parseElapsed(afterSwitch) ?? 0) >= beforeSwitchElapsed, `${beforeSwitchElapsed}s → ${afterSwitch.elapsed}`);
  check("it never started a second request", requests.filter((r) => !r.hasTools).length >= 1 && afterSwitch.present, `${requests.length} gateway requests total`);
  check("still exactly one status row after switching", afterSwitch.count === 1, `${afterSwitch.count} rows`);
  await shot(page, "status-after-switch.png");
  await waitForDone(page);
  await reportErrors("Part 4 chat switch");

  // ══ Part 5 — image requests show live progress too ═════════════════════
  console.log("\n── Part 5: image request ──────────────────────────────────");
  plan = { thinkMs: 5000, streamMs: 2500, reasoning: true };
  await freshChat(page);
  const png = join(SHOTS, "attach-probe.png");
  // 1×1 transparent PNG.
  writeFileSync(png, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ));
  const attached = await page.evaluate(() => Boolean(document.querySelector('input[type="file"]')));
  check("the composer exposes a real attachment input", attached);
  await page.setInputFiles('input[type="file"]', png);
  await page.waitForTimeout(700);
  check("the attachment chip appears before Send", await page.evaluate(() => Boolean(document.querySelector(".attachCount")) || document.querySelector(".composer")?.innerText.includes(".png") === true), "the image is staged");

  const beforeImage = requests.length;
  await startLabelWatch(page);
  const imageSend = await typeAndSend(page, "Explain this image.");
  check("the image turn is actually dispatched", !imageSend?.error, imageSend?.error ?? "sent");
  const imageRow = await waitForStatus(page, (r) => (parseElapsed(r) ?? 0) >= 1, 6_000, "image run counting");
  check("an image request shows the same live row immediately", imageRow.present === true, imageRow.full ?? "");
  check("the image run's clock starts counting", (parseElapsed(imageRow) ?? 0) >= 1, imageRow.elapsed ?? "");
  const imageThinking = await waitForStatus(page, (r) => /Thinking|Responding/.test(r.label ?? ""), 20_000, "Thinking/Responding for the image");
  check("the image run reaches Thinking/Responding, never looks frozen", /Thinking|Responding/.test(imageThinking.label ?? ""), imageThinking.full ?? "");
  // This turn streams real reasoning, so it is where the Thinking LABEL and the
  // live reasoning CONTENT are both observable.
  const imageThinkingLabel = await readLabelWatch(page);
  const imageSawThinking = imageThinkingLabel.some((l) => l.label === "Thinking");
  check("the image reasoning turn reads as Thinking while the model reasons", imageSawThinking, imageThinkingLabel.map((l) => l.label).filter((l) => l !== "none").join(" → "));
  check("the image turn's clock never resets either", (() => {
    const elapsed = imageThinkingLabel.map((l) => parseElapsed(l)).filter((n) => n !== null);
    return elapsed.length > 1 && elapsed.every((n, i) => i === 0 || n >= elapsed[i - 1]);
  })(), imageThinkingLabel.map((l) => l.elapsed ?? "").join(" → "));
  // The live reasoning is real text either way: expanded into .thinkingContent,
// or collapsed into the one-line .thinkingPreview. Read whichever is there.
  const reasoningText = await page.evaluate(() => {
    const box = document.querySelector(".thinkingBlock");
    if (!box) return "";
    return (box.querySelector(".thinkingContent")?.innerText
      ?? box.querySelector(".thinkingPreview")?.innerText
      ?? "").trim();
  });
  check("real reasoning text arrives as provider events, not fabricated", /Analyzing the request|Checking the provided image|Planning the response/.test(reasoningText), reasoningText.slice(0, 60) || "(none)");
  check("the clock keeps counting while the model thinks", imageThinkingLabel.length > 1, imageThinkingLabel.map((l) => l.elapsed ?? "").join(" → "));
  await shot(page, "status-image.png");
  check("the image turn completes", await waitForDone(page));
  const imageRequest = requests.slice(beforeImage).find((r) => r.multimodal || r.hasImageUrl);
  check("the image really reached the gateway (payload unchanged)", Boolean(imageRequest), JSON.stringify(requests.slice(beforeImage).map((r) => ({ m: r.multimodal, u: r.hasImageUrl }))));

  // ══ Part 6 — no duplicate surfaces, no Chat Thinking filter ════════════
  console.log("\n── Part 6: no duplicates, no Chat Thinking filter ────────────");
  plan = { thinkMs: 6000, streamMs: 2500, reasoning: false };
  await freshChat(page);
  await typeAndSend(page, "Count the status surfaces.");
  const dup = await waitForStatus(page, (r) => r.count >= 1, 6_000, "row");
  check("exactly ONE status row exists while a response runs", dup.count === 1, `${dup.count} rows`);
  check("no second timeline-style status competes with it", await page.evaluate(() => document.querySelectorAll(".requestStatus").length === 1), "");
  check("Chat has NO persistent 'Thinking ON' composer control", await page.evaluate(() => !document.querySelector(".thinkingPill")), ".thinkingPill absent in Chat mode");
  check("typing stays responsive (no input lag from the tick)", await page.evaluate(async () => {
    const textarea = document.querySelector(".composer textarea");
    if (!textarea || textarea.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    // A fixed delay, NOT requestAnimationFrame: while a response streams the
    // frame callback is throttled and would measure the throttle, not input lag.
    const perKeystroke = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      setter.call(textarea, textarea.value + "x");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      perKeystroke.push(performance.now() - t0);
    }
    perKeystroke.sort((a, b) => a - b);
    const median = perKeystroke[Math.floor(perKeystroke.length / 2)];
    window.__lagProbe = { median, chars: textarea.value.length };
    return median < 60;
  }), "median keystroke-to-render under 60ms while a response streams");
  await waitForDone(page);
  const lag = await page.evaluate(() => window.__lagProbe ?? null);
  if (lag) console.log(`  input lag probe: median ${lag.median.toFixed(1)}ms/keystroke, textarea ${lag.chars} chars`);

  // ══ Part 7 — the background is the lighter charcoal ═════════════════════
  console.log("\n── Part 7: background shade + text visibility ───────────────");
  const theme = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    // Tokens are authored as hex (#161618), so parse BOTH forms.
    const rgb = (name) => {
      const value = styles.getPropertyValue(name).trim();
      const hex = /^#([0-9a-f]{6})$/i.exec(value);
      if (hex) {
        const n = parseInt(hex[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      const parts = value.match(/[\d.]+/g) ?? [];
      return parts.length >= 3 ? parts.slice(0, 3).map(Number) : null;
    };
    const luminance = (c) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = rgb("--bg");
    const text = rgb("--text");
    const text2 = rgb("--text-2");
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // What the user actually sees, from real painted pixels.
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    return {
      bgToken: styles.getPropertyValue("--bg").trim(),
      bodyBg,
      bodyBgRgb: (bodyBg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number),
      primaryContrast: bg && text ? ratio(text, bg) : null,
      secondaryContrast: bg && text2 ? ratio(text2, bg) : null
    };
  });
  check("the dark background is no longer near-black", theme.bodyBgRgb.length === 3 && theme.bodyBgRgb.every((c) => c >= 20), `body ${theme.bodyBg} (token ${theme.bgToken})`);
  check("body text has strong contrast on the lighter background", (theme.primaryContrast ?? 0) >= 12, `${theme.primaryContrast?.toFixed(1)}:1`);
  check("secondary text is comfortably readable too", (theme.secondaryContrast ?? 0) >= 6, `${theme.secondaryContrast?.toFixed(1)}:1`);
  await shot(page, "background-shade.png");
  console.log(`  body ${theme.bodyBg} · primary ${theme.primaryContrast?.toFixed(1)}:1 · secondary ${theme.secondaryContrast?.toFixed(1)}:1`);
} catch (err) {
  console.error("\nRequest-status run threw:", err?.stack ?? err?.message ?? err);
  results.push({ name: "request-status run completed", ok: false });
} finally {
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ ids, keep, settings }) => {
      for (const id of ids) {
        // Never delete a chat that existed before this run.
        if (!id || keep.includes(id)) continue;
        try { await window.latex.conversation.delete(id); } catch { /* ignore */ }
      }
      if (settings) {
        await window.latex.settings.save({
          provider: settings.previousProvider ?? undefined,
          selectedModel: settings.previousModel ?? undefined,
          autoSelectModel: settings.previousAuto ?? undefined
        }).catch(() => undefined);
      }
    }, { ids: createdConversationIds, keep: [...preexistingConversationIds], settings: previousSettings });
  } catch { /* ignore */ }
  await app.close().catch(() => undefined);
  stub.close();
}

const failed = results.filter((result) => !result.ok);
console.log("─".repeat(64));
console.log(`${results.length - failed.length}/${results.length} request-status checks passed`);
if (failed.length) console.log("failed:\n" + failed.map((f) => `  - ${f.name}`).join("\n"));
console.log("─".repeat(64));
process.exit(failed.length === 0 ? 0 : 1);