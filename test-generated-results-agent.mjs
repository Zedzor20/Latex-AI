/**
 * Generated-results AGENT acceptance test (real Main Agent pipeline, stub model).
 *
 * Run with:  node test-generated-results-agent.mjs      (after "npm run build")
 *
 * Why this test exists: the reported bug was a Main Agent run that produced a
 * visualization and then answered "Done — nothing needed to change." — and the
 * result vanished. This drives the REAL packaged pipeline end to end through a
 * stub OpenAI-compatible gateway:
 *
 *   user prompt → model tool call → real tool execution → generated result
 *   → finalizer → persisted assistant message
 *
 * Scenarios:
 *   1. `take_screenshot` (a real tool that returns image data) then a silent
 *      final turn → the answer must name the generated result and the message
 *      must carry a completed generated result.
 *   2. A read-only tool then a silent final turn → NO generated result, and the
 *      honest "Nothing in the workspace needed to change." wording is kept.
 *
 * It restores the user's settings (model, auto-select, PC control) and deletes
 * the conversations it creates.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXE = existsSync(join("node_modules", "electron", "dist", "electron.exe"))
  ? join("node_modules", "electron", "dist", "electron.exe")
  : null;
if (!EXE) {
  console.error("Local electron binary not found — run npm install first.");
  process.exit(1);
}

const STUB_PORT = 20198;
const MODEL_ID = "stub-generated-results";
const MODEL = `omniroute/${MODEL_ID}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── Stub gateway ─────────────────────────────────────────────────────────
let scenario = "visual";
let modelCalls = 0;
const seenTools = [];

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
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

function silentEvents() {
  return [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];
}

const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
  if (url.pathname === "/api/monitoring/health" || url.pathname === "/healthz") {
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
  if (!url.pathname.endsWith("/chat/completions")) {
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
    console.log(`  [stub] call ${modelCalls}: scenario=${scenario} tools=${hasTools}`);
    if (!hasTools) { sse(res, silentEvents()); return; }
    if (modelCalls === 1) {
      if (scenario === "visual") {
        seenTools.push("take_screenshot");
        return sse(res, toolCallEvents("take_screenshot", {}));
      }
      seenTools.push("get_platform_info");
      return sse(res, toolCallEvents("get_platform_info", {}));
    }
    // Final turn: the model says nothing at all — the case the finalizer owns.
    sse(res, silentEvents());
  });
});
await new Promise((resolve) => stub.listen(STUB_PORT, "127.0.0.1", resolve));

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
  await page.waitForTimeout(400);
  return { app, page };
}

async function runScenario(page, name, prompt) {
  scenario = name;
  modelCalls = 0;
  const before = await page.evaluate(() => window.latex.settings.get());
  const saved = await page.evaluate(async ({ model }) => {
    await window.latex.settings.save({ selectedModel: model, autoSelectModel: false, pcControl: "on" });
    const confirmed = await window.latex.settings.get();
    return { selectedModel: confirmed.selectedModel, autoSelectModel: confirmed.autoSelectModel, pcControl: confirmed.pcControl };
  }, { model: MODEL });
  if (saved.autoSelectModel !== false || saved.selectedModel !== MODEL) {
    throw new Error(`could not pin the stub model (got ${saved.selectedModel}, auto=${saved.autoSelectModel})`);
  }
  await page.waitForTimeout(200);

  const conversation = {
    id: `conv_genres_${name}`,
    title: `Generated results ${name}`,
    mode: "main",
    messages: [{ id: `m_u_${name}`, role: "user", content: prompt, createdAt: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const updated = await page.evaluate((conv) => window.latex.agent.run(conv), conversation);
  await page.evaluate((id) => window.latex.conversation.delete(id).catch(() => undefined), conversation.id);
  await page.evaluate((s) => window.latex.settings.save(s), before);
  return updated;
}

let app = null;
try {
  const first = await launch();
  app = first.app;

  // ── 1. A real tool-produced visual ────────────────────────────────
  const visual = await runScenario(first.page, "visual", "take a screenshot of the screen");
  const visualMsg = visual.messages[visual.messages.length - 1];
  const visualResults = visualMsg?.meta?.generatedResults ?? [];
  console.log(`  [agent] final text: ${JSON.stringify(String(visualMsg?.content ?? "").slice(0, 200))}`);
  console.log(`  [agent] generated results: ${JSON.stringify(visualResults.map((r) => ({ kind: r.kind, hasBase64: Boolean(r.base64), status: r.status })))}`);
  check("visual: a real tool ran", seenTools.includes("take_screenshot"));
  check("visual: a completed generated result was persisted",
    visualResults.length >= 1 && visualResults[0].status === "completed", `${visualResults.length} result(s)`);
  check("visual: the result is an image with real bytes",
    visualResults[0]?.kind === "image" && Boolean(visualResults[0]?.base64));
  check("visual: the task result state is SUCCESS", visualMsg?.meta?.taskResult === "SUCCESS", String(visualMsg?.meta?.taskResult));
  check("visual: the answer names the generated result",
    /generated the image above/i.test(String(visualMsg?.content ?? "")), String(visualMsg?.content ?? "").slice(0, 120));
  check("visual: the answer does NOT say nothing needed to change",
    !/nothing needed to change/i.test(String(visualMsg?.content ?? "")));

  // ── 2. A read-only run keeps the honest wording ───────────────────
  const plain = await runScenario(first.page, "plain", "tell me about this machine");
  const plainMsg = plain.messages[plain.messages.length - 1];
  const plainResults = plainMsg?.meta?.generatedResults ?? [];
  console.log(`  [agent] plain final text: ${JSON.stringify(String(plainMsg?.content ?? "").slice(0, 200))}`);
  check("plain: no generated result is fabricated", plainResults.length === 0, `${plainResults.length} result(s)`);
  check("plain: honest 'nothing needed to change' wording is kept",
    /nothing needed to change/i.test(String(plainMsg?.content ?? "")), String(plainMsg?.content ?? "").slice(0, 120));
} catch (err) {
  check("run completed without throwing", false, err instanceof Error ? err.message : String(err));
} finally {
  await app?.close().catch(() => undefined);
  stub.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} generated-result agent checks passed`);
console.log("─".repeat(64));
process.exitCode = failed.length === 0 ? 0 : 1;
