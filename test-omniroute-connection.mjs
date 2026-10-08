/**
 * OmniRoute connection/authentication acceptance test — the REAL packaged app
 * against a controllable stub gateway on 127.0.0.1:20128.
 *
 * Run with:  node test-omniroute-connection.mjs      (after "npm run dist")
 *
 * The reported bug: Latex showed "Connect your OmniRoute API key to start
 * working." while OmniRoute was running, because `/v1/models` was used as the
 * only liveness test — so a 401/403 (or a keyless instance) looked like
 * "offline", and a *stored* key was treated as proof of a working connection.
 *
 * States exercised over live HTTP against the packaged app:
 *
 *   A. nothing listening                 → OFFLINE, not ready
 *   B. running, keyless                  → ONLINE, completions stream through
 *   C. running, key required/rejected    → ONLINE but not usable (never "offline")
 *   D. key rejected                      → key kept, UI asks for a corrected key
 *   E. valid key stored                  → ONLINE_AUTHENTICATED (only when the
 *                                          profile has no key of its own yet)
 *   F. gateway stops and comes back      → CONNECTED → OFFLINE → CONNECTED
 *
 * The profile may already hold a real OmniRoute key, so the test NEVER clears or
 * overwrites an existing credential: the write/clear path only runs when no key
 * was stored to begin with. (The "no key stored" states are still covered by
 * clearing and immediately restoring the profile's own key.)
 *
 * The gateway runs on an ISOLATED port via LATEX_OMNIROUTE_BASE_URL so the test
 * never shadows a real OmniRoute instance that may be running on 20128.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
// A port reserved for this test: the app is pointed here with
// LATEX_OMNIROUTE_BASE_URL, so a live OmniRoute on 20128 is left untouched.
const PORT = 20199;
const MODEL_ID = "stub-omniroute-1";
const MODEL_NAME = `omniroute/${MODEL_ID}`;
const GATEWAY_KEY = "omni-endpoint-key-42";
const REPLY = "OMNIROUTE TEST OK — this reply came back through /v1/chat/completions from the stub gateway.";
const PROMPT = "Reply with exactly: OMNIROUTE TEST OK";

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

// ── Controllable stub gateway on OmniRoute's port ─────────────────────────
let mode = "keyless";           // "keyless" | "keyed"
let listening = false;
const log = { models: [], completions: [], health: 0, healthPaths: [], rejected: [] };

function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const auth = req.headers.authorization ?? null;

  if (url.pathname === "/__mode") {
    mode = url.searchParams.get("mode") ?? mode;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mode }));
    return;
  }
  if (url.pathname === "/__state") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mode, log }));
    return;
  }

  // Layered liveness: the app probes /api/health first, then /healthz, and
  // only falls back to the heavy monitoring route. All three are served here.
  if (url.pathname === "/api/health" || url.pathname === "/healthz" || url.pathname === "/api/monitoring/health") {
    log.health += 1;
    log.healthPaths.push(url.pathname);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, status: "ok", version: "stub" }));
    return;
  }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    const allowed = mode === "keyless" || auth === `Bearer ${GATEWAY_KEY}`;
    log.models.push({ auth, allowed, mode });
    if (!allowed) {
      log.rejected.push({ path: url.pathname, auth });
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      object: "list",
      data: [{ id: MODEL_ID, object: "model", owned_by: "stub" }]
    }));
    return;
  }

  if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
      const allowed = mode === "keyless" || auth === `Bearer ${GATEWAY_KEY}`;
      log.completions.push({ auth, allowed, model: parsed.model, stream: parsed.stream, mode });
      if (!allowed) {
        log.rejected.push({ path: url.pathname, auth });
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}

const stub = createServer(handle);
function startStub() {
  return new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(PORT, "127.0.0.1", () => { listening = true; resolve(); });
  });
}
function stopStub() {
  return new Promise((resolve) => { stub.close(() => { listening = false; resolve(); }); });
}
const state = async () => (await fetch(`http://127.0.0.1:${PORT}/__state`)).json().catch(() => ({ log }));
try {
  await startStub();
} catch (err) {
  console.error(`Cannot bind the isolated test port ${PORT}: ${err?.message ?? err}`);
  process.exit(1);
}
// Refuse to run against anything that is not this stub.
const marker = await fetch(`http://127.0.0.1:${PORT}/__state`).then((res) => res.json()).catch(() => null);
if (!marker || typeof marker.mode !== "string") {
  console.error(`Something other than this stub is answering on ${PORT} — aborting.`);
  process.exit(1);
}
console.log(`Stub OmniRoute on http://127.0.0.1:${PORT} (model ${MODEL_ID}, mode ${mode})\n`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await electron.launch({
  executablePath: EXE,
  args: [],
  timeout: 120_000,
  env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${PORT}` }
});
let previous = null;
let wroteKey = false;
const createdConversationIds = [];

/**
 * Some phases need "no key stored". This profile may already hold a real
 * OmniRoute key, so the test captures it from the gateway's own request log,
 * clears it for a few seconds, and puts the exact same value back immediately
 * after each phase — plus again in the finally block. An existing credential is
 * never left removed, and is never overwritten with a different value.
 */
let realKey = "";
let keyCleared = false;
// Only a profile that starts WITHOUT an OmniRoute key may have test keys
// written and cleared; a real credential is never replaced.
let writeThroughAllowed = false;
async function clearOmniRouteKey(page) {
  await page.evaluate(() => window.latex.settings.clearApiKey("omniroute"));
  keyCleared = true;
}
async function restoreOmniRouteKey(page) {
  if (!realKey) return;
  await page.evaluate((key) => window.latex.settings.saveApiKey(key, "omniroute"), realKey);
  keyCleared = false;
}

async function reloadAndWait(page, waitMs = 2000) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.latex?.omniroute?.getStatus), null, { timeout: 60_000 });
  await page.waitForTimeout(waitMs);
}

async function bannerState(page) {
  return page.evaluate(() => {
    const node = document.querySelector(".setupBanner");
    return { present: Boolean(node), text: node ? node.innerText.replace(/\s+/g, " ") : "", body: document.body.innerText };
  });
}

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.omniroute?.getStatus), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  // ── Baseline ─────────────────────────────────────────────────────────────
  const before = await page.evaluate(async () => {
    const settings = await window.latex.settings.get();
    const status = await window.latex.omniroute.getStatus();
    return {
      selectedModel: settings.selectedModel ?? null,
      autoSelectModel: settings.autoSelectModel ?? null,
      provider: settings.provider ?? null,
      hasKey: Boolean(status?.hasKey)
    };
  });
  if (!before.hasKey) writeThroughAllowed = true;
  previous = before;
  console.log(`Baseline: provider=${before.provider} model=${before.selectedModel} omnirouteKeyStored=${before.hasKey}\n`);

  const pointed = await page.evaluate(async (wanted) => {
    const models = await window.latex.ai.models().catch(() => []);
    const stubModel = models.find((m) => String(m.name).includes(wanted));
    if (!stubModel) return { error: "stub model missing", count: models.length, providers: [...new Set(models.map((m) => m.provider))] };
    await window.latex.settings.save({ provider: "omniroute", selectedModel: stubModel.name, autoSelectModel: false });
    const confirmed = await window.latex.settings.get();
    return { name: stubModel.name, provider: stubModel.provider, confirmedModel: confirmed.selectedModel, confirmedProvider: confirmed.provider };
  }, MODEL_ID);
  if (pointed.error) throw new Error(`${pointed.error} (${pointed.count} models from ${pointed.providers})`);
  check("the stub OmniRoute model is discovered and selectable", pointed.provider === "omniroute" && pointed.confirmedModel === MODEL_NAME, `${pointed.provider} / ${pointed.confirmedModel}`);
  check("Latex is using OmniRoute as the active provider", pointed.confirmedProvider === "omniroute", String(pointed.confirmedProvider));

  // ── B. Running gateway, no key required ─────────────────────────────────
  console.log("\n── B. OmniRoute running and reachable ────────────────────");
  const usable = await page.evaluate(async () => {
    const status = await window.latex.omniroute.refresh();
    const settings = await window.latex.settings.get();
    return { status, hasApiKey: settings.hasApiKey, json: JSON.stringify(status) };
  });
  const status = usable.status;
  check("server is detected as RUNNING", status.running === true, JSON.stringify(status));
  check("state is an online one", status.state === "online_no_auth_required" || status.state === "online_authenticated", status.state);
  check("authenticated and needsKey are reported separately", status.authenticated === true && status.needsKey === false, `authenticated=${status.authenticated} needsKey=${status.needsKey}`);
  check("models were loaded from the gateway", status.modelCount >= 1, String(status.modelCount));
  check("the probed endpoint is the one Latex is configured for", String(status.baseUrl).includes(`127.0.0.1:${PORT}`), status.baseUrl);
  check("the provider is reported ready", usable.hasApiKey === true, String(usable.hasApiKey));
  check("hasKey is a boolean flag only, never the credential", typeof status.hasKey === "boolean" && /"hasKey":(true|false)/.test(usable.json), usable.json);

  await reloadAndWait(page);
  const bannerOk = await bannerState(page);
  check('no "Connect your OmniRoute API key" banner while the gateway is usable', bannerOk.present === false, bannerOk.text);
  check("the page never asks for an OmniRoute API key in this state", !/Connect your OmniRoute API key/i.test(bannerOk.body));

  // ── Real model request through the app's own composer ───────────────────
  console.log("\n── Real completion through the UI ────────────────────────");
  const sent = await page.evaluate(async (prompt) => {
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
    setter.call(textarea, prompt);
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
    const conversation = (await window.latex.conversation.list()).find((c) => c.messages.some((m) => String(m.content ?? "").includes("Reply with exactly")));
    return {
      types: events.map((event) => event?.type),
      streamed: events.filter((event) => event?.type === "message").map((event) => String(event.payload ?? "")).join(""),
      errorCards: Array.from(document.querySelectorAll(".errorCard")).map((node) => node.innerText.replace(/\s+/g, " ")),
      body: document.body.innerText,
      conversationId: conversation?.id ?? null,
      assistant: (conversation?.messages ?? []).filter((m) => m.role === "assistant").pop()?.content ?? null
    };
  }, PROMPT);
  if (sent.conversationId) createdConversationIds.push(sent.conversationId);
  check("the UI accepted the prompt and ran a turn", !sent.error && sent.types.includes("done"), sent.error ?? sent.types.join(","));
  check("the model's real reply arrived through /v1/chat/completions", /OMNIROUTE TEST OK/.test(sent.streamed), sent.streamed.slice(0, 160));
  check("the turn was persisted as a real conversation", Boolean(sent.conversationId), String(sent.conversationId));
  check("no connection error was shown while sending", sent.errorCards.length === 0, sent.errorCards.join(" | "));
  check("the composer is never told to connect a key in this state", !/Connect your OmniRoute API key/i.test(sent.body));

  const afterSend = await state();
  const firstCompletion = afterSend.log.completions[0];
  check("the gateway received a streaming completion request", afterSend.log.completions.length >= 1 && firstCompletion.stream !== false, JSON.stringify(firstCompletion));

  // Whatever credential was used must never leak into the UI or the status.
  const usedCredential = (firstCompletion.auth ?? "").replace(/^Bearer\s+/, "");
  realKey = usedCredential;
  if (usedCredential) {
    const leaked = await page.evaluate((credential) => {
      return { body: document.body.innerText.includes(credential), html: document.documentElement.innerHTML.includes(credential) };
    }, usedCredential);
    check("the credential never appears in the rendered UI", !leaked.body && !leaked.html, JSON.stringify(leaked));
    check("the credential never appears in the reported status", !usable.json.includes(usedCredential));
  } else {
    check("a keyless instance needs no credential at all", usable.status.authenticated === true);
  }

  // ── B2. No key stored at all, keyless gateway → still ready ─────────────
  // Requirements 4/7: a keyless OmniRoute instance must connect without any
  // stored key. That means removing the stored key for a moment and observing
  // the app connect anyway — then putting the key straight back.
  if (realKey && before.hasKey) {
    console.log("\n── B2. Keyless gateway with NO stored key ─────────────────");
    await clearOmniRouteKey(page);
    const noKey = await page.evaluate(async () => {
      const status = await window.latex.omniroute.refresh();
      const settings = await window.latex.settings.get();
      return { status, hasApiKey: settings.hasApiKey };
    });
    check("with no key stored the state is online_no_auth_required", noKey.status.state === "online_no_auth_required", noKey.status.state);
    check("a keyless gateway is authenticated without a credential", noKey.status.authenticated === true && noKey.status.hasKey === false, `authenticated=${noKey.status.authenticated} hasKey=${noKey.status.hasKey}`);
    check("the provider is ready with no key at all", noKey.hasApiKey === true, String(noKey.hasApiKey));

    await reloadAndWait(page);
    const noKeyBanner = await bannerState(page);
    check("no key prompt appears for a keyless gateway", noKeyBanner.present === false, noKeyBanner.text);

    const beforeKeylessSend = (await state()).log.completions.length;
    const keylessSend = await page.evaluate(async (prompt) => {
      const events = [];
      const unsubscribe = window.latex.agent.onEvent((event) => {
        events.push(event);
        if (event?.type === "approval" && event.payload?.requestId) {
          void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
        }
      });
      const textarea = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, prompt);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      document.querySelector(".sendButton")?.click();
      for (let i = 0; i < 90; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (events.some((event) => event?.type === "done")) break;
      }
      unsubscribe();
      const conversation = (await window.latex.conversation.list()).find((c) => c.messages.some((m) => String(m.content ?? "").includes("Reply with exactly")));
      return { streamed: events.filter((event) => event?.type === "message").map((event) => String(event.payload ?? "")).join(""), conversationId: conversation?.id ?? null };
    }, PROMPT);
    if (keylessSend.conversationId) createdConversationIds.push(keylessSend.conversationId);
    const keylessLog = (await state()).log.completions;
    check("a completion streams on a keyless instance with no stored key", /OMNIROUTE TEST OK/.test(keylessSend.streamed), keylessSend.streamed.slice(0, 140));
    check("no Authorization header is sent when no key is stored", keylessLog.length > beforeKeylessSend && keylessLog[keylessLog.length - 1].auth === null, String(keylessLog[keylessLog.length - 1]?.auth));

    await restoreOmniRouteKey(page);
    const restored = await page.evaluate(async () => {
      const status = await window.latex.omniroute.refresh();
      return { state: status.state, hasKey: status.hasKey };
    });
    check("the profile's key was put back exactly as it was", restored.hasKey === true && (restored.state === "online_authenticated" || restored.state === "online_no_auth_required"), JSON.stringify(restored));
  } else {
    console.log("\n── B2. skipped: the profile has no OmniRoute key to round-trip ──");
  }

  // ── C. The gateway now demands a key we do not have ─────────────────────
  console.log("\n── C. Gateway requires a key we do not have ──────────────");
  mode = "keyed";
  const credentialed = Boolean(realKey) && before.hasKey;
  if (credentialed) await clearOmniRouteKey(page);
  const blockedState = await page.evaluate(async () => {
    const status = await window.latex.omniroute.refresh();
    let testError = null;
    try { await window.latex.ai.test("omniroute"); } catch (err) { testError = String(err?.message ?? err); }
    const settings = await window.latex.settings.get();
    return { status, testError, hasApiKey: settings.hasApiKey };
  });
  const expectedState = credentialed ? "online_api_key_required" : "auth_failed";
  check("server is STILL reported as running", blockedState.status.running === true, JSON.stringify(blockedState.status));
  check(`state is ${expectedState} (a stored key that is rejected is not "offline")`, blockedState.status.state === expectedState, blockedState.status.state);
  check("needsKey true and authenticated false", blockedState.status.needsKey === true && blockedState.status.authenticated === false, `needsKey=${blockedState.status.needsKey} authenticated=${blockedState.status.authenticated}`);
  check("the message says the gateway is running", /running/i.test(blockedState.status.error ?? ""), blockedState.status.error);
  check("the message does NOT say offline / not running", !/offline|not running/i.test(blockedState.status.error ?? ""), blockedState.status.error);
  check("connection test fails for the credential reason, not an outage",
    /API key/i.test(blockedState.testError ?? "") && !/not running|offline/i.test(blockedState.testError ?? ""), blockedState.testError);
  // Regression: a stored-but-rejected key must not make the provider look ready.
  check("the provider is NOT reported ready", blockedState.hasApiKey === false, String(blockedState.hasApiKey));

  await reloadAndWait(page);
  const requiredBanner = await bannerState(page);
  check("a banner is shown when a key really is required", requiredBanner.present === true, requiredBanner.text);
  check("the banner explains that OmniRoute IS running",
    /OmniRoute is running, but/i.test(requiredBanner.text) && /API key/i.test(requiredBanner.text), requiredBanner.text);
  check("the banner replaces the old misleading wording", !/Connect your OmniRoute API key to start working/i.test(requiredBanner.text), requiredBanner.text);

  const beforeBlocked = (await state()).log.completions.length;
  const blocked = await page.evaluate(async (prompt) => {
    const textarea = document.querySelector(".composer textarea");
    if (!textarea) return { error: "composer textarea missing" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, prompt);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.querySelector(".sendButton")?.click();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const card = document.querySelector(".errorCard");
    return { errorText: card ? card.innerText.replace(/\s+/g, " ") : "", body: document.body.innerText };
  }, PROMPT);
  const afterBlocked = (await state()).log.completions.length;
  check("sending is refused with the real reason", /API key/i.test(blocked.errorText || blocked.body), (blocked.errorText || blocked.body).slice(0, 200));
  check("the refusal is not reported as offline", !/not running|offline/i.test(blocked.errorText), blocked.errorText);
  check("no completion request was sent to a gateway that would reject it", afterBlocked === beforeBlocked, `${beforeBlocked} → ${afterBlocked}`);

  // Put the profile's own key back before the rejected-key phase.
  if (keyCleared) {
    await restoreOmniRouteKey(page);
    const backAgain = await page.evaluate(async () => {
      const status = await window.latex.omniroute.refresh();
      return { state: status.state, hasKey: status.hasKey };
    });
    check("the stored key is back and rejected by this gateway (auth_failed)", backAgain.hasKey === true && backAgain.state === "auth_failed", JSON.stringify(backAgain));

    await reloadAndWait(page);
    const rejectedBanner2 = await bannerState(page);
    check("the rejected-key banner names the real problem to fix", /saved API key was rejected/i.test(rejectedBanner2.text), rejectedBanner2.text.slice(0, 200));
  }

  // ── D/E. Credential lifecycle (only when the profile has no key of its own)
  if (!writeThroughAllowed) {
    console.log("\n── D/E. skipped: this profile already stores an OmniRoute key ──");
  } else {
    console.log("\n── E. Saving the correct endpoint key ────────────────────");
    const saved = await page.evaluate(async (key) => {
      await window.latex.settings.saveApiKey(key, "omniroute");
      const status = await window.latex.omniroute.refresh();
      const settings = await window.latex.settings.get();
      return { status, hasApiKey: settings.hasApiKey };
    }, GATEWAY_KEY);
    wroteKey = true;
    check("a stored key is reported as stored", saved.status.hasKey === true, String(saved.status.hasKey));
    check("state becomes online_authenticated", saved.status.state === "online_authenticated", saved.status.state);
    check("the provider is ready again", saved.hasApiKey === true, String(saved.hasApiKey));
    check("the key value never appears in the reported status", !JSON.stringify(saved.status).includes(GATEWAY_KEY));

    const withKey = await page.evaluate(async (prompt) => {
      const events = [];
      const unsubscribe = window.latex.agent.onEvent((event) => {
        events.push(event);
        if (event?.type === "approval" && event.payload?.requestId) {
          void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
        }
      });
      const textarea = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, prompt);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      document.querySelector(".sendButton")?.click();
      for (let i = 0; i < 90; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (events.some((event) => event?.type === "done")) break;
      }
      unsubscribe();
      const conversation = (await window.latex.conversation.list()).find((c) => c.messages.some((m) => String(m.content ?? "").includes("Reply with exactly")));
      return { streamed: events.filter((event) => event?.type === "message").map((event) => String(event.payload ?? "")).join(""), conversationId: conversation?.id ?? null };
    }, PROMPT);
    if (withKey.conversationId) createdConversationIds.push(withKey.conversationId);
    check("a completion works with the stored key", /OMNIROUTE TEST OK/.test(withKey.streamed), withKey.streamed.slice(0, 140));
    const keyedState = await state();
    const lastCompletion = keyedState.log.completions[keyedState.log.completions.length - 1];
    check("the configured credential was sent with the request", lastCompletion?.auth === `Bearer ${GATEWAY_KEY}`, String(lastCompletion?.auth));

    console.log("\n── D. The stored key is rejected ─────────────────────────");
    const rejected = await page.evaluate(async () => {
      await window.latex.settings.saveApiKey("definitely-the-wrong-key", "omniroute");
      const status = await window.latex.omniroute.refresh();
      let testError = null;
      try { await window.latex.ai.test("omniroute"); } catch (err) { testError = String(err?.message ?? err); }
      const settings = await window.latex.settings.get();
      return { status, testError, hasApiKey: settings.hasApiKey };
    });
    check("a rejected key is reported as auth_failed", rejected.status.state === "auth_failed", rejected.status.state);
    check("the message says the saved key was rejected", /saved API key was rejected/i.test(rejected.status.error ?? ""), rejected.status.error);
    check("the rejected key is NOT silently erased", rejected.status.hasKey === true, String(rejected.status.hasKey));
    check("the provider is not ready with a bad key", rejected.hasApiKey === false, String(rejected.hasApiKey));
    check("the connection test explains the rejection", /rejected/i.test(rejected.testError ?? "") && !/not running|offline/i.test(rejected.testError ?? ""), rejected.testError);

    await reloadAndWait(page);
    const rejectedBanner = await bannerState(page);
    check("the UI asks for a corrected key", /saved API key was rejected/i.test(rejectedBanner.text), rejectedBanner.text.slice(0, 200));
  }

  // ── A/F. The gateway stops and comes back ───────────────────────────────
  console.log("\n── A/F. Gateway stops, then returns ──────────────────────");
  await stopStub();
  await sleep(600);  // let pooled keep-alive sockets to the dead gateway drain
  const down = await page.evaluate(async () => {
    const status = await window.latex.omniroute.refresh();
    const settings = await window.latex.settings.get();
    return { status, hasApiKey: settings.hasApiKey };
  });
  check("nothing listening → state offline", down.status.state === "offline", down.status.state);
  check("running is false when the gateway is gone", down.status.running === false);
  check("offline is explained as not running", /not running/i.test(down.status.error ?? ""), down.status.error);
  check("a stopped gateway is not reported as ready", down.hasApiKey === false, String(down.hasApiKey));

  mode = "keyless";  // the gateway comes back in its original configuration
  await startStub();
  let reconnected = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(2500);
    reconnected = await page.evaluate(async () => {
      const status = await window.latex.omniroute.getStatus();
      const settings = await window.latex.settings.get();
      return { state: status.state, running: status.running, hasApiKey: settings.hasApiKey };
    });
    if (reconnected.running) break;
  }
  check("a restarted gateway is detected without restarting Latex", reconnected?.running === true, JSON.stringify(reconnected));
  check("the restarted gateway reports a usable state again", reconnected?.state === "online_authenticated" || reconnected?.state === "online_no_auth_required", String(reconnected?.state));
  check("the provider becomes ready again automatically", reconnected?.hasApiKey === true, String(reconnected?.hasApiKey));
  check("the key was not lost across the outage", (await page.evaluate(async () => Boolean((await window.latex.omniroute.getStatus())?.hasKey))) === (before.hasKey || wroteKey));
} catch (err) {
  console.error("\nOmniRoute connection run threw:", err?.message ?? err);
  results.push({ name: "OmniRoute connection run completed", ok: false });
} finally {
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ ids, settings, clearKey, restoreKey }) => {
      for (const id of ids) {
        if (!id) continue;
        try { await window.latex.conversation.delete(id); } catch { /* ignore */ }
      }
      if (clearKey) {
        try { await window.latex.settings.clearApiKey("omniroute"); } catch { /* ignore */ }
      }
      if (restoreKey) {
        // Safety net: never leave the profile without the key it started with.
        try { await window.latex.settings.saveApiKey(restoreKey, "omniroute"); } catch { /* ignore */ }
      }
      if (settings) {
        await window.latex.settings.save({
          provider: settings.provider ?? undefined,
          selectedModel: settings.selectedModel ?? undefined,
          autoSelectModel: settings.autoSelectModel ?? undefined
        }).catch(() => undefined);
      }
    }, { ids: createdConversationIds, settings: previous, clearKey: writeThroughAllowed && wroteKey, restoreKey: keyCleared || wroteKey ? realKey : "" });
  } catch { /* ignore */ }
  await app.close().catch(() => undefined);
  if (listening) await stopStub().catch(() => undefined);
}

const failed = results.filter((result) => !result.ok);
console.log("─".repeat(64));
console.log(`${results.length - failed.length}/${results.length} OmniRoute connection checks passed`);
console.log("─".repeat(64));
process.exit(failed.length === 0 ? 0 : 1);
