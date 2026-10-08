/**
 * THINKING SEPARATION + REAL-TIME STREAMING test.
 *
 * Drives the PACKAGED app against a local OpenAI-compatible stub that streams a
 * real `reasoning_content` channel followed by `content` (the answer), the way
 * DeepSeek/OpenRouter/Groq/OmniRoute actually do. It proves:
 *
 *   1. the Thinking box renders the PROVIDER'S REASONING, progressively, while
 *      the model is still working (not dumped at the end);
 *   2. it never renders request/activity text — specifically it must never show
 *      "Waiting for model response..." (the exact regression);
 *   3. Thinking and Agent Activity carry DIFFERENT content at the same instant
 *      (reasoning vs. application status), and neither leaks into the other;
 *   4. a non-reasoning model gets NO Thinking box at all — no invented thinking.
 *
 * Runs in the default Main mode so the Agent Activity timeline is on screen at
 * the same time as the Thinking box — that is what makes (3) provable.
 *
 * The run uses an ISOLATED `--user-data-dir`, so it never reads or writes the
 * real user's settings, conversations or seen-version state.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const EXE = join(ROOT, "release", "win-unpacked", "Latex.exe");
const SHOTS = join(ROOT, ".freebuff", "verify");
const PROFILE = resolve(join(ROOT, ".freebuff", "verify", "thinking-profile"));
const PORT = 20297;

const REASON_MODEL = "stub-deepseek-r1";      // reasoning family → supportsThinking
const PLAIN_MODEL = "stub-plain-4o";          // no reasoning family → unsupported
const REASON_SENTINEL = "REASONONLY";
const ANSWER_SENTINEL = "ANSWERONLY";
const FORBIDDEN_IN_THINKING = ["Waiting for model response", "Receiving response", "Verifying the changes"];

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npx electron-builder --win nsis" first.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── The stub's reasoning + answer ────────────────────────────────────────────
const REASONING = [
  `${REASON_SENTINEL} I need to work out which part of the existing implementation drives this behaviour.`,
  `I should inspect the scroll logic first, because that is where the reported symptom comes from.`,
  `The bottom-follow path looks like the cause: it re-anchors on every streamed delta.`,
  `I will keep the change narrow and leave the rest of the conversation architecture untouched.`,
  `Then I should verify that a long response still streams without jitter or repeated re-parsing.`
].join(" ");
const ANSWER = `${ANSWER_SENTINEL} Here is the final answer, written only after the reasoning above finished.`;

// ── Stub gateway ─────────────────────────────────────────────────────────────
let mode = "reasoning"; // "reasoning" | "plain"
let delayMs = 90;
const requestPaths = [];

function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  requestPaths.push(`${req.method} ${url.pathname}`);
  const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/api/monitoring/health") return json(200, { status: "ok" });
  if (url.pathname === "/v1/models") {
    return json(200, { object: "list", data: [{ id: REASON_MODEL, object: "model" }, { id: PLAIN_MODEL, object: "model" }] });
  }
  if (url.pathname !== "/v1/chat/completions") return json(404, { error: "not found" });

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let closed = false;
    req.on("aborted", () => { closed = true; });
    res.on("close", () => { closed = true; });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const delta = (payload) => { if (!closed) res.write(`data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`); };

    delta({ role: "assistant" });
    if (mode === "reasoning") {
      // 40 chunks so the UI has many real deltas to paint progressively.
      const pieces = REASONING.match(/\S+\s*/g) ?? [REASONING];
      for (const piece of pieces) {
        delta({ reasoning_content: piece });
        await sleep(delayMs);
      }
      await sleep(400); // the model is "paused" between thinking and answering
    }
    for (const piece of ANSWER.match(/\S+\s*/g) ?? [ANSWER]) {
      delta({ content: piece });
      await sleep(40);
    }
    if (!closed) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    if (!closed) res.write("data: [DONE]\n\n");
    res.end();
  });
}

const server = createServer(handle);

// ── Launch helpers ───────────────────────────────────────────────────────────
async function boot() {
  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${PROFILE}`, "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"],
    timeout: 120_000,
    env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${PORT}` }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent && window.latex?.settings), null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  return { app, page };
}

async function selectModel(page, wanted) {
  const picked = await page.evaluate(async (name) => {
    const models = await window.latex.ai.models().catch(() => []);
    const found = models.find((m) => String(m.name).includes(name));
    if (!found) return { error: "model missing", count: models.length };
    await window.latex.settings.save({ provider: "omniroute", selectedModel: found.name, autoSelectModel: false, thinkingPreferences: {} });
    return { name: found.name };
  }, wanted);
  if (picked.error) return picked;
  // The renderer has no settings-change subscription, so a direct save does not
  // refresh React state. Reload once so the app BOOTS with the saved model —
  // exactly what happens for a real user who picks the model in the UI.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent && window.latex?.settings), null, { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(document.querySelector(".composer textarea")), null, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  return picked;
}

const sendMessage = (page, text) =>
  page.evaluate(async (message) => {
    const textarea = document.querySelector(".composer textarea");
    if (!textarea) return { error: "composer textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, message);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const send = document.querySelector(".sendButton");
    if (!send || send.disabled) return { error: "send button unavailable" };
    send.click();
    return { ok: true };
  }, text);

/** Sample the Thinking box + Activity title every 150ms for `ms`. */
const sample = (page, ms) =>
  page.evaluate(async (limit) => {
    const out = [];
    const started = Date.now();
    while (Date.now() - started < limit) {
      const block = document.querySelector(".thinkingBlock");
      const body = document.querySelector(".thinkingContent");
      const preview = document.querySelector(".thinkingPreview");
      const activityTitle = document.querySelector(".activityCodexTitle");
      out.push({
        t: Date.now() - started,
        block: Boolean(block),
        expanded: Boolean(body),
        thinking: (body ? body.innerText : preview ? preview.innerText : "") ?? "",
        activity: (activityTitle?.innerText ?? "").trim(),
        answerLen: (document.querySelector(".messageText.markdown")?.innerText ?? "").length
      });
      await new Promise((r) => setTimeout(r, 150));
    }
    return out;
  }, ms);

// ── Run 1 — reasoning model ──────────────────────────────────────────────────
server.listen(PORT, "127.0.0.1");
rmSync(PROFILE, { recursive: true, force: true });
console.log("\n▶ Run 1 — reasoning model (stub streams reasoning_content then content)\n");
{
  const { app, page } = await boot();
  const picked = await selectModel(page, REASON_MODEL);
  check("stub reasoning model is available", !picked.error, picked.error ? `${picked.error} (${picked.count} models)` : picked.name);
  await page.waitForTimeout(1200);

  const sent = await sendMessage(page, "Explain the scroll behaviour.");
  check("message was dispatched", sent.ok === true, sent.error ?? "");
  const samples = await sample(page, 9000);

  const withBlock = samples.filter((s) => s.block);
  check("Thinking box appeared during the turn", withBlock.length > 0, `${withBlock.length}/${samples.length} samples`);
  const thinkingSamples = samples.filter((s) => s.thinking.trim().length > 0);
  check("Thinking box had content while running", thinkingSamples.length >= 3, `${thinkingSamples.length} non-empty samples`);

  // Progressive growth: length strictly increases across several samples, and an
  // early sample is a PREFIX of the final one (real streaming, not a late dump).
  const lengths = thinkingSamples.map((s) => s.thinking.trim().length);
  const grew = lengths.length >= 3 && lengths[lengths.length - 1] > lengths[0] && new Set(lengths).size >= 3;
  check("thinking grows progressively", grew, `lengths ${lengths.slice(0, 6).join(",")}…→${lengths[lengths.length - 1] ?? 0}`);
  // Progressive growth must be measured on REASONING samples only: the first
  // non-empty sample is the temporary "Waiting for thinking…" transport state,
  // which is intentionally NOT a prefix of the reasoning that replaces it.
  const reasoningSamples = thinkingSamples.filter((s) => s.thinking.includes(REASON_SENTINEL));
  const firstR = reasoningSamples[0]?.thinking.trim() ?? "";
  const lastR = reasoningSamples[reasoningSamples.length - 1]?.thinking.trim() ?? "";
  check("later reasoning contains the earlier reasoning (prefix)", firstR.length > 0 && lastR.startsWith(firstR.slice(0, Math.min(40, firstR.length))), `first=${JSON.stringify(firstR.slice(0, 48))} last=${JSON.stringify(lastR.slice(0, 48))}`);
  check("reasoning arrives in many visible steps", reasoningSamples.length >= 5, `${reasoningSamples.length} reasoning samples`);
  // The transport placeholder must be REPLACED once real reasoning lands.
  const sawPlaceholder = thinkingSamples.some((s) => s.thinking.includes("Waiting for thinking"));
  const placeholderGone = reasoningSamples.length > 0 && !reasoningSamples[reasoningSamples.length - 1].thinking.includes("Waiting for thinking");
  check("temporary waiting state is replaced by real thinking", sawPlaceholder && placeholderGone, `saw=${sawPlaceholder} gone=${placeholderGone}`);
  check("Thinking box is open (not just a truncated preview)", samples.some((s) => s.expanded), `expanded samples=${samples.filter((s) => s.expanded).length}`);

  // Source separation.
  check("Thinking shows provider reasoning", lastR.includes(REASON_SENTINEL), `has ${REASON_SENTINEL}=${lastR.includes(REASON_SENTINEL)}`);
  check("Thinking does NOT show the assistant answer", !lastR.includes(ANSWER_SENTINEL), "");

  // The exact regression: request-status text must never be Thinking content.
  const contaminated = samples.filter((s) => FORBIDDEN_IN_THINKING.some((bad) => s.thinking.includes(bad)));
  check("Thinking NEVER shows request/status text", contaminated.length === 0, contaminated.length ? `saw: ${JSON.stringify(contaminated[0].thinking.slice(0, 80))}` : "clean");

  // Thinking arrives BEFORE the answer: reasoning is visible while the answer is empty.
  const early = samples.find((s) => s.thinking.includes(REASON_SENTINEL) && s.answerLen === 0);
  check("thinking streams BEFORE the answer starts", Boolean(early), early ? `reasoning at t=${early.t}ms with no answer yet` : "no such sample");

  // Activity is present and DIFFERENT from Thinking at the same instant.
  const both = samples.find((s) => s.thinking.trim() && s.activity.trim());
  check("Activity and Thinking coexist as separate content", Boolean(both), both ? `activity=${JSON.stringify(both.activity)} thinking=${JSON.stringify(both.thinking.slice(0, 40))}` : "never both visible");
  if (both) {
    check("Activity text is NOT inside the Thinking box", !both.thinking.includes(both.activity), "");
    check("reasoning is NOT inside the Activity title", !both.activity.includes(REASON_SENTINEL), "");
    check("Activity shows real application status", /waiting|receiving|response|thinking|working|reading|running/i.test(both.activity), both.activity);
  }

  // Final state: the answer really did arrive (turn completed normally).
  const finalAnswerLen = Math.max(...samples.map((s) => s.answerLen));
  check("assistant answer still streamed normally", finalAnswerLen > 0, `answerLen=${finalAnswerLen}`);
  try { await page.screenshot({ path: join(SHOTS, "thinking-separation.png"), animations: "disabled", timeout: 20_000 }); } catch { /* non-fatal */ }
  await app.close().catch(() => undefined);
}

// ── Run 2 — non-reasoning model: no fake Thinking ────────────────────────────
console.log("\n▶ Run 2 — non-reasoning model (no reasoning channel)\n");
{
  mode = "plain";
  const { app, page } = await boot();
  const picked = await selectModel(page, PLAIN_MODEL);
  check("stub plain model is available", !picked.error, picked.error ?? picked.name);
  await page.waitForTimeout(1200);

  const state = await page.evaluate(async () => {
    const s = await window.latex.settings.get();
    return { model: s.selectedModel };
  });
  check("plain model selected as expected", String(state.model).includes(PLAIN_MODEL), state.model);

  const sent = await sendMessage(page, "Say hello.");
  check("plain-model message was dispatched", sent.ok === true, sent.error ?? "");
  const samples = await sample(page, 7000);
  const anyBlock = samples.some((s) => s.block);
  check("no Thinking box for a non-reasoning model", !anyBlock, anyBlock ? "box appeared" : "");
  const answerArrived = Math.max(...samples.map((s) => s.answerLen)) > 0;
  check("non-reasoning model still responds normally", answerArrived, "");
  await app.close().catch(() => undefined);
}

// ── Run 3 — nothing is routed that should not be ─────────────────────────────
console.log("\n▶ Run 3 — event routing\n");
{
  mode = "reasoning";
  const { app, page } = await boot();
  await selectModel(page, REASON_MODEL);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__events = [];
    window.__off = window.latex.agent.onEvent((e) => window.__events.push({ type: e.type, payload: typeof e.payload === "string" ? e.payload : e.payload?.text ?? null }));
  });
  const routedSend = await sendMessage(page, "Explain the scroll behaviour.");
  check("routing message was dispatched", routedSend.ok === true, routedSend.error ?? "");
  await page.waitForTimeout(9000);
  const events = await page.evaluate(() => { window.__off?.(); return window.__events; });

  const thinkingText = events.filter((e) => e.type === "thinking").map((e) => e.payload ?? "").join("");
  const activityText = events.filter((e) => e.type === "activity_status").map((e) => e.payload ?? "").join(" | ");
  const statusText = events.filter((e) => e.type === "status").map((e) => e.payload ?? "").join(" | ");

  check("real thinking deltas arrived as `thinking` events", thinkingText.includes(REASON_SENTINEL), `${thinkingText.length} chars`);
  check("activity carried application status, not reasoning", activityText.length > 0 && !activityText.includes(REASON_SENTINEL), JSON.stringify(activityText.slice(0, 90)));
  check("no channel merges the two", !thinkingText.includes("Waiting for model response") && !statusText.includes(REASON_SENTINEL), "");
  check("thinking deltas are many (not one final blob)", events.filter((e) => e.type === "thinking").length >= 10, `${events.filter((e) => e.type === "thinking").length} deltas`);
  await app.close().catch(() => undefined);
}

server.close();
rmSync(PROFILE, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log("\n" + "-".repeat(64));
console.log(`${results.length - failed.length}/${results.length} thinking checks passed`);
if (failed.length) console.log("failed:\n" + failed.map((f) => `  - ${f.name}`).join("\n"));
console.log("-".repeat(64));
process.exit(failed.length ? 1 : 0);
