/**
 * REAL-TIME THINKING STREAMING test.
 *
 * Run with:  node test-thinking-realtime.mjs   (app must be closed)
 *
 * Proves the Thinking box updates WHILE the model is still generating instead
 * of dumping the whole summary at the end. It drives the REAL UI with a model
 * that streams reasoning token-by-token (a local Ollama reasoning model, with
 * hosted reasoning and Gemini thought-summaries as fallbacks) and:
 *
 *   - records every `thinking` delta off the real main→renderer IPC channel;
 *   - samples the LIVE Thinking box while the turn is still running.
 *
 * PASS requires the box to appear during the turn, MANY deltas to arrive, the
 * visible content to GROW progressively over time, and the first delta to land
 * well before the turn ends — the opposite of a final-second copy/paste.
 *
 * Set THINKING_MODEL=<model id> to force a provider/model.
 * Set THINKING_MODE=main|chat (default chat) to pick the surface.
 */
import { _electron as electron } from "playwright";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join(here, "release", "win-unpacked", "Latex.exe");
const FORCED_MODEL = process.env.THINKING_MODEL ?? null;
const MODE = process.env.THINKING_MODE ?? "chat";

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

// Compile the real capability resolver so the test checks what the app checks.
const helperDir = join(here, ".tmp-thinking-realtime", "helpers");
rmSync(helperDir, { recursive: true, force: true });
mkdirSync(helperDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/shared/modelCapabilities.ts",
    "--outDir", helperDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);
const { thinkingCapability } = await import(pathToFileURL(join(helperDir, "modelCapabilities.js")).href);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const app = await electron.launch({ executablePath: EXE, timeout: 120_000 });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForTimeout(800);

  // ── Choose a model that GENUINELY exposes thinking AND really answers ──
  const inventory = await page.evaluate(async () => {
    const models = await window.latex.ai.models().catch(() => []);
    return models.map((m) => ({
      name: m.name,
      provider: m.provider ?? null,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : []
    }));
  });
  const preferOrder = [
    FORCED_MODEL,
    // Local models that stream reasoning token-by-token (strongest case).
    "ollama/deepseek-r1:1.5b",
    "ollama/qwen3:0.6b",
    "ollama/deepseek-r1:7b",
    "ollama/gpt-oss:20b",
    // Hosted reasoning streams.
    "groq/openai/gpt-oss-20b",
    "groq/openai/gpt-oss-120b",
    // Gemini fallback (thought summaries arrive as larger chunks).
    "models/gemini-3-flash-preview",
    "models/gemini-flash-latest"
  ].filter(Boolean);

  const entryOf = (name) => inventory.find((m) => m.name === name);
  const providerOf = (name) => entryOf(name)?.provider ?? "gemini";
  const supported = (name) => {
    const entry = entryOf(name);
    try { return thinkingCapability(providerOf(name), name, { capabilities: entry?.capabilities }).supportsThinking; } catch { return false; }
  };
  const byName = new Set(inventory.map((m) => m.name));
  const order = [
    ...preferOrder.filter((n) => byName.has(n)),
    ...inventory.filter((m) => !preferOrder.includes(m.name)).map((m) => m.name)
  ];
  const thinkingCapable = order.filter((n) => supported(n));

  console.log("Probing for a live thinking-capable model...");
  const previousModel = await page.evaluate(async () => (await window.latex.settings.get()).selectedModel ?? null);
  let candidate = null;
  let probeError = null;
  for (const name of thinkingCapable.slice(0, 8)) {
    const probe = await page.evaluate(async (modelName) => {
      await window.latex.settings.save({ selectedModel: modelName, autoSelectModel: false });
      const now = Date.now();
      const conversation = {
        id: `think_probe_${now}`,
        title: "probe",
        mode: "chat",
        messages: [{ id: `p_${now}`, role: "user", content: "Reply with exactly the word READY and nothing else.", createdAt: now }],
        createdAt: now,
        updatedAt: now
      };
      try {
        const next = await window.latex.agent.chat(conversation);
        const last = next.messages[next.messages.length - 1];
        void window.latex.conversation.delete(conversation.id).catch(() => undefined);
        return { ok: String(last?.content ?? "").trim().length > 0 };
      } catch (err) {
        void window.latex.conversation.delete(conversation.id).catch(() => undefined);
        return { ok: false, error: String(err?.message ?? err).slice(0, 160) };
      }
    }, name);
    if (probe.ok) { candidate = name; break; }
    probeError = probe.error;
    console.log(`  probe failed: ${name} — ${probe.error ?? "no text"}`);
  }

  if (!candidate) {
    console.log(`\nSKIPPED: no working thinking-capable model is available — cannot verify live thinking.${probeError ? ` (last: ${probeError})` : ""}`);
    await app.close().catch(() => undefined);
    process.exit(0);
  }
  const provider = providerOf(candidate);
  const capMode = (() => { try { return thinkingCapability(provider, candidate).mode; } catch { return "summary"; } })();
  const tokenStream = capMode === "tokens";
  console.log(`Thinking-capable model: ${candidate} (mode: ${capMode})\n`);

  await page.evaluate(async ({ model, key }) => {
    await window.latex.settings.save({ selectedModel: model, autoSelectModel: false });
    await window.latex.settings.save({ thinkingPreferences: { [key]: true } });
  }, { model: candidate, key: `${provider}:${candidate}` });
  await page.waitForTimeout(400);

  // Pick the surface.
  const modeBtn = page.locator(".modeToggleBtn", { hasText: new RegExp(`^${MODE === "main" ? "Main" : "Chat"}`, "i") }).first();
  if (await modeBtn.count()) { await modeBtn.click(); await page.waitForTimeout(500); }
  console.log(`Mode: ${MODE}`);

  // ── Recorder: real IPC thinking deltas + turn boundaries ──────────────
  await page.evaluate(() => {
    window.__think = { deltas: [], firstMessageAt: null, doneAt: null, activeConvId: null };
    window.__liveThinkingText = () => {
      const blocks = document.querySelectorAll(".thinkingBlock");
      const last = blocks[blocks.length - 1];
      return last?.querySelector(".thinkingContent")?.textContent ?? "";
    };
    window.__unsubThink = window.latex.agent.onEvent((event) => {
      if (event?.type === "approval" && event.payload?.requestId) {
        void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
      }
      if (event?.conversationId && !window.__think.activeConvId && event.conversationId !== "active") {
        window.__think.activeConvId = event.conversationId;
      }
      if (event?.type === "thinking") {
        window.__think.deltas.push({ t: Date.now(), len: String(event.payload ?? "").length });
      }
      if (event?.type === "message" && window.__think.firstMessageAt === null) {
        window.__think.firstMessageAt = Date.now();
      }
      if (event?.type === "done" && window.__think.doneAt === null) {
        window.__think.doneAt = Date.now();
      }
    });
  });

  // ── Drive the REAL UI: type a prompt and press Send ───────────────────
  const sendStartedAt = Date.now();
  const input = page.locator(".composer textarea").first();
  await input.waitFor({ timeout: 20_000 });
  await input.fill("A farmer has 17 sheep; all but 9 run away. Reason step by step about what 'all but 9' means, then give the final number.");
  await page.locator(".sendButton").first().click();

  // ── Sample the LIVE Thinking box while the turn runs ───────────────────
  const samples = [];
  const deadline = Date.now() + 150_000;
  let sawBox = false;
  let sawDone = false;
  let expandAttempts = 0;

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      box: document.querySelectorAll(".thinkingBlock").length,
      text: window.__liveThinkingText?.() ?? "",
      answerStarted: window.__think.firstMessageAt !== null,
      done: window.__think.doneAt !== null
    }));
    if (state.box > 0) sawBox = true;

    if (!state.text && state.box > 0 && expandAttempts < 4) {
      expandAttempts += 1;
      await page.evaluate(() => {
        const blocks = document.querySelectorAll(".thinkingBlock");
        const btn = blocks[blocks.length - 1]?.querySelector(".thinkingToggle");
        btn?.click();
      }).catch(() => undefined);
      await page.waitForTimeout(150);
      continue;
    }

    if (state.text) {
      const last = samples[samples.length - 1];
      if (!last || last.text !== state.text) samples.push({ t: Date.now(), len: state.text.length });
    }

    if (state.done) { sawDone = true; break; }
    await page.waitForTimeout(120);
  }

  const think = await page.evaluate(() => {
    window.__unsubThink?.();
    return window.__think;
  });

  // ── Evidence ─────────────────────────────────────────────────────────
  const deltas = think.deltas ?? [];
  if (deltas.length) {
    console.log("  thinking delta timeline (first 10):");
    const t0 = deltas[0].t;
    let prev = t0;
    for (const d of deltas.slice(0, 10)) {
      console.log(`    +${d.len} chars  +${d.t - t0}ms  (+${d.t - prev}ms since previous)`);
      prev = d.t;
    }
    if (deltas.length > 10) console.log(`    … ${deltas.length - 10} more delta(s)`);
  }

  const firstDelta = deltas[0]?.t ?? null;
  const lastDelta = deltas[deltas.length - 1]?.t ?? null;
  const doneAt = think.doneAt ?? null;
  const firstMessageAt = think.firstMessageAt ?? null;
  const growth = samples.filter((s) => s.len > 0);

  // ── Assertions ───────────────────────────────────────────────────────
  check("the Thinking box appeared during the turn", sawBox);

  check("real provider thinking deltas were received",
    tokenStream ? deltas.length >= 3 : deltas.length >= 1,
    `${deltas.length} delta(s)${deltas.length ? `, first +${deltas[0].len} chars` : ""}`);

  check("thinking arrives BEFORE the turn finishes (no end-of-turn dump)",
    firstDelta !== null && doneAt !== null && doneAt - firstDelta >= 300,
    firstDelta && doneAt ? `first delta ${doneAt - firstDelta}ms before the turn ended` : "missing timings");

  check("thinking streams before the assistant answer text begins",
    firstDelta !== null && firstMessageAt !== null && firstDelta <= firstMessageAt,
    firstDelta && firstMessageAt
      ? `first delta ${firstMessageAt - firstDelta}ms before first answer text`
      : `firstDelta=${firstDelta} firstMessage=${firstMessageAt}`);

  check("the visible Thinking content GROWS progressively while the turn runs",
    tokenStream
      ? growth.length >= 3 && growth[growth.length - 1].len > growth[0].len
      : growth.length >= 1,
    growth.length
      ? `${growth.length} live snapshot(s): ${growth.slice(0, 8).map((s) => s.len).join(" → ")}${growth.length > 8 ? " …" : ""}`
      : "no non-empty snapshots");

  check("thinking deltas are spread over time, not one final burst",
    deltas.length >= 2 && lastDelta !== null && firstDelta !== null && (lastDelta - firstDelta) > 150,
    deltas.length >= 2 ? `spread ${lastDelta - firstDelta}ms over ${deltas.length} deltas` : "not enough deltas");

  check("the turn actually ran to completion", sawDone && doneAt !== null,
    doneAt ? `${doneAt - sendStartedAt}ms` : "no done event");

  // Leave the user's model as we found it, and drop the test conversation.
  if (think.activeConvId) {
    await page.evaluate(async (id) => {
      await window.latex.conversation.delete(id).catch(() => undefined);
    }, think.activeConvId).catch(() => undefined);
  }
  if (previousModel && previousModel !== candidate) {
    await page.evaluate(async (model) => {
      await window.latex.settings.save({ selectedModel: model }).catch(() => undefined);
    }, previousModel).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("Failed checks:");
    for (const f of failed) console.log(`  - ${f.name}`);
  }
} finally {
  await app.close().catch(() => undefined);
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
