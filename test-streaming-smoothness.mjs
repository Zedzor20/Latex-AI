/**
 * Streaming smoothness — measured, not claimed.
 *
 * Run with:  node test-streaming-smoothness.mjs      (after "npm run dist")
 *
 * Drives the ACTUAL packaged app (release/win-unpacked/Latex.exe) against an
 * isolated stub gateway on port 20299 that streams a LONG, Markdown-heavy
 * response token by token. While it streams we record, from inside the page:
 *
 *   • main-thread stall cadence  (setTimeout(0) ticks — robust to throttling)
 *   • long tasks                 (PerformanceObserver('longtask'))
 *   • animation-frame cadence    (rAF — valid only when the window composites)
 *   • text-commit cadence        (MutationObserver on the assistant markdown)
 *   • typed-input latency mid-stream
 *   • final text integrity       (every sentinel chunk present)
 *   • JS heap growth across the turn
 *
 * The point is to prove the frame-aligned batching actually holds up as the
 * response grows (early vs late windows must not degrade) and that nothing is
 * dropped — the O(n^2) re-parse is gone.
 */
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
const PORT = 20299;
const MODEL_ID = "stub-deepseek-r1";
const SHOTS = ".freebuff/verify";

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── The long answer: headings, prose, a table, a code fence ─────────────────
// Every prose block ends with a unique sentinel so a dropped chunk is provable.
const SECTIONS = 60;
function buildAnswer() {
  const parts = ["# Streaming performance report", ""];
  for (let n = 1; n <= SECTIONS; n++) {
    const id = String(n).padStart(4, "0");
    parts.push(`### Section ${n}`, "");
    parts.push(
      `Paragraph ${n} explains the real-time pipeline with enough words that the ` +
        `renderer has genuine Markdown work to perform on every commit, and it ` +
        `closes with the sentinel MARK${id} so any lost chunk is detectable.`
    );
    parts.push("");
    if (n === 12) {
      parts.push("```js", "function stream(chunk) {", "  return batch(chunk);", "}", "```", "");
    }
    if (n % 10 === 0) {
      parts.push(`| col A | col B |`, `| --- | --- |`, `| a${n} | b${n} |`, "");
    }
  }
  return parts.join("\n");
}
const FULL_TEXT = buildAnswer();
const SENTINELS = Array.from({ length: SECTIONS }, (_, i) => `MARK${String(i + 1).padStart(4, "0")}`);

// ── Stub gateway: streams the long answer fast, no reasoning ────────────────
let plan = { streamMs: 9000 };
let streamRequests = 0;
let stubStreamMs = null;
let stubMaxGapMs = 0;

const requestPaths = [];
function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  requestPaths.push(`${req.method} ${url.pathname}`);
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
    streamRequests++;
    let closed = false;
    req.on("aborted", () => { closed = true; });
    res.on("close", () => { closed = true; });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const delta = (payload) => {
      if (!closed) res.write(`data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`);
    };
    delta({ role: "assistant" });
    const pieces = FULL_TEXT.split(/(?<=\s)/);
    // Pace against an ABSOLUTE schedule rather than sleeping per piece: a
    // per-piece setTimeout costs far more than its nominal delay here (timer
    // granularity plus the shared event loop), which stretched a 9s stream
    // into 40s and made the renderer look like the bottleneck when it was not.
    const t0 = Date.now();
    const total = pieces.length;
    let lastWrite = t0;
    for (let i = 0; i < total; i++) {
      delta({ content: pieces[i] });
      const now = Date.now();
      stubMaxGapMs = Math.max(stubMaxGapMs, now - lastWrite);
      lastWrite = now;
      const ahead = t0 + ((i + 1) / total) * plan.streamMs - now;
      await sleep(ahead > 0 ? Math.min(ahead, 12) : 0);
      if (closed) return;
    }
    stubStreamMs = Date.now() - t0;
    if (closed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

const stub = createServer(handle);
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
console.log(`Stub gateway on ${PORT} — ${FULL_TEXT.length} chars, ${FULL_TEXT.split(/\s+/).length} words\n`);

// Fast path for instrumentation cycles: LATEX_TEST_SOURCE=1 loads the freshly
// built dist/ with the local Electron binary instead of waiting on a full
// electron-builder repack. Same renderer bundle, same main entry.
const useSource = process.env.LATEX_TEST_SOURCE === "1";
const electronBinary = useSource ? (await import("electron")).default : EXE;
console.log(useSource ? `Launching local Electron against dist/ (source mode)\n` : `Launching packaged ${EXE}\n`);

// Chromium throttles animation frames AND timers to ~1Hz whenever it believes
// the window is backgrounded or occluded — which is exactly the state a
// headless test host reports. That would measure the throttled fallback path
// instead of what a user watching the window actually sees, so disable it.
const CHROMIUM_NO_THROTTLE = [
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows"
];

const app = await electron.launch({
  executablePath: electronBinary,
  args: useSource ? [process.cwd(), ...CHROMIUM_NO_THROTTLE] : CHROMIUM_NO_THROTTLE,
  timeout: 120_000,
  env: { ...process.env, LATEX_OMNIROUTE_BASE_URL: `http://127.0.0.1:${PORT}` }
});

// ── UI helpers ──────────────────────────────────────────────────────────────
async function shot(page, name) {
  try {
    await page.screenshot({ path: join(SHOTS, name), animations: "disabled", caret: "hide", timeout: 20_000 });
  } catch (err) {
    console.log(`  (screenshot ${name} skipped: ${err?.message?.split("\n")[0] ?? err})`);
  }
}

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

/** Install the in-page measurement rig. Returns nothing; reads via readPerf. */
const installPerf = (page) =>
  page.evaluate(() => {
    const perf = {
      t0: performance.now(),
      ticks: [],
      frames: [],
      texts: [],
      chunks: [],
      vis: [],
      longs: [],
      heapStart: null,
      heapEnd: null,
      running: true
    };
    window.__perf = perf;
    // The app's own guarded counters: no-op in production unless this exists.
    window.__latexPerf = {};
    try { perf.heapStart = performance.memory?.usedJSHeapSize ?? null; } catch { /* ignore */ }

    // Main-thread stall sampler: a 0ms timeout chain ticks several times per
    // frame when the thread is free, so a large gap is real blocking — and it
    // keeps ticking even when the window is occluded and rAF is throttled.
    let lastVis = "";
    const tick = () => {
      if (!perf.running) return;
      const t = performance.now();
      perf.ticks.push(t);
      const v = `${document.visibilityState}|${document.hasFocus() ? "focused" : "unfocused"}`;
      if (v !== lastVis) {
        lastVis = v;
        perf.vis.push({ t, v });
      }
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);

    // Frame cadence. Only meaningful when the window actually composites; the
    // report says so explicitly when the rate is far below 60.
    const frame = () => {
      if (!perf.running) return;
      perf.frames.push(performance.now());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) perf.longs.push({ start: entry.startTime, dur: entry.duration });
      });
      po.observe({ entryTypes: ["longtask"] });
      perf.po = po;
    } catch { /* longtask unsupported */ }

    // Text-commit cadence: only batches that touch the assistant Markdown body.
    // Stream-chunk arrival AT THE RENDERER: `type === "message"` is what
    // App.tsx turns into a queued stream chunk. This separates a stall in the
    // app's own flush from a stall upstream in the provider/main process.
    try {
      window.latex.agent.onEvent((ev) => {
        if (ev && ev.type === "message") perf.chunks.push(performance.now());
      });
    } catch { /* ignore */ }

    const mo = new MutationObserver((mutations) => {
      let touched = false;
      for (const m of mutations) {
        const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (node && node.closest && node.closest(".messageText.markdown")) { touched = true; break; }
      }
      if (!touched) return;
      const body = document.querySelectorAll(".messageText.markdown");
      const last = body[body.length - 1];
      perf.texts.push({ t: performance.now(), len: last ? last.innerText.length : 0 });
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    perf.mo = mo;
  });

const stopPerf = (page) =>
  page.evaluate(() => {
    const p = window.__perf;
    p.running = false;
    try { p.heapEnd = performance.memory?.usedJSHeapSize ?? null; } catch { /* ignore */ }
    p.po?.disconnect?.();
    p.mo?.disconnect?.();
    return {
      ticks: p.ticks,
      frames: p.frames,
      texts: p.texts,
      chunks: p.chunks,
      vis: p.vis,
      app: window.__latexPerf ?? null,
      longs: p.longs,
      heapStart: p.heapStart,
      heapEnd: p.heapEnd,
      t0: p.t0
    };
  });

/** Type + Send in ONE page task so latency reflects the app, not Playwright IPC. */
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

/** Poll until the assistant body stops growing and the status row is gone. */
const waitForStreamEnd = (page, timeoutMs = 90_000) =>
  page.evaluate(async (limit) => {
    const started = Date.now();
    let lastLen = -1;
    let stable = 0;
    while (Date.now() - started < limit) {
      const bodies = document.querySelectorAll(".messageText.markdown");
      const last = bodies[bodies.length - 1];
      const len = last ? last.innerText.length : 0;
      const streaming = Boolean(document.querySelector(".requestStatus")) || Boolean(document.querySelector(".stopButton"));
      if (len > 0 && len === lastLen && !streaming) {
        stable++;
        if (stable >= 4) return { ok: true, len, ms: Date.now() - started };
      } else {
        stable = 0;
      }
      lastLen = len;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, len: lastLen, ms: Date.now() - started };
  }, timeoutMs);

/** Typed-input latency WHILE the response is streaming. */
const probeInputLatency = (page) =>
  page.evaluate(async () => {
    const textarea = document.querySelector(".composer textarea");
    if (!textarea) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const original = textarea.value;
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      setter.call(textarea, `${original}!`);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      samples.push(performance.now() - t0);
    }
    setter.call(textarea, original);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    samples.sort((a, b) => a - b);
    return { median: samples[Math.floor(samples.length / 2)], max: samples[samples.length - 1] };
  });

// ── Statistics ──────────────────────────────────────────────────────────────
function gaps(times) {
  const out = [];
  for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1]);
  return out;
}
function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const r0 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n));
const over = (values, limit) => values.filter((v) => v > limit).length;

let previousSettings = null;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForTimeout(2500);

  // ── Point at the stub model ──────────────────────────────────────────────
  const modelInfo = await page.evaluate(async (wanted) => {
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const stub = models.find((m) => String(m.name).includes(wanted));
    if (!stub) return { error: "stub model missing", count: models.length };
    await window.latex.settings.save({ provider: "omniroute", selectedModel: stub.name, autoSelectModel: false });
    return { name: stub.name, previousProvider: before.provider ?? null, previousModel: before.selectedModel ?? null, previousAuto: before.autoSelectModel ?? null };
  }, MODEL_ID);
  if (modelInfo.error) throw new Error(`${modelInfo.error} (${modelInfo.count} models)`);
  previousSettings = modelInfo;
  check("stub model is selected", true, modelInfo.name);
  await page.waitForTimeout(1500);

  const mode = await switchMode(page, "chat");
  if (!/chat/i.test(mode ?? "")) console.log(`  (warning: could not enter Chat mode, active tab is "${mode ?? "none"}")`);

  // ── Is the window actually compositing? ──────────────────────────────────
  const idleRaf = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => {
          n++;
          if (performance.now() - t0 < 1000) requestAnimationFrame(f);
          else resolve({ n, ms: performance.now() - t0 });
        };
        requestAnimationFrame(f);
      })
  );
  const rafHz = Math.round((idleRaf.n / idleRaf.ms) * 1000);
  const compositing = rafHz >= 20;
  console.log(`  baseline animation frames: ${rafHz}/s  → ${compositing ? "window composites (frame cadence is meaningful)" : "THROTTLED — frame cadence not meaningful here"}\n`);

  // ── Keep the window in the FOREGROUND ────────────────────────────────────
  // Chromium throttles animation frames and timers in a background/occluded
  // window (rAF drops to ~1Hz), which would measure the fallback path instead
  // of what a user actually sees. Force it forward and hold it there.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.show();
    win.setAlwaysOnTop(true, "screen-saver");
    win.focus();
  });
  await page.waitForTimeout(800);

  // ── One streamed turn, measured ──────────────────────────────────────────
  await installPerf(page);
  const sent = await sendMessage(page, "Write the streaming performance report.");
  if (sent.error) throw new Error(sent.error);

  await page.waitForTimeout(2500);
  const latency = await probeInputLatency(page);

  const ended = await waitForStreamEnd(page);
  const perf = await stopPerf(page);
  const finalText = await page.evaluate(() => {
    const bodies = document.querySelectorAll(".messageText.markdown");
    const last = bodies[bodies.length - 1];
    return last ? last.innerText : "";
  });
  const msgCount = await page.evaluate(() => document.querySelectorAll("article.message").length);
  console.log(`\n  DIAG request paths seen by stub: ${JSON.stringify([...new Set(requestPaths)])}`);
  console.log(`  DIAG assistant messages in chat: ${msgCount}; final head: ${JSON.stringify(finalText.slice(0, 160))}\n`);
  await shot(page, "streaming-smoothness.png");

  // ── Analyse the streaming window only ───────────────────────────────────
  const textTimes = perf.texts.map((x) => x.t);
  const winStart = textTimes.length ? textTimes[0] : perf.t0;
  const winEnd = textTimes.length ? textTimes[textTimes.length - 1] : perf.t0;
  const winMs = Math.max(1, winEnd - winStart);
  const within = (arr) => arr.filter((t) => t >= winStart && t <= winEnd);

  const tickGaps = gaps(within(perf.ticks));
  const frameGaps = gaps(within(perf.frames));
  const textGaps = gaps(textTimes);
  const longs = perf.longs.filter((l) => l.start >= winStart && l.start <= winEnd).map((l) => l.dur);
  const chunkGaps = gaps(within(perf.chunks));
  const appCounters = perf.app ?? {};
  const topGaps = (times, n = 3) =>
    gaps(times)
      .map((g, i) => ({ g: Math.round(g), at: Math.round(times[i + 1] - winStart) }))
      .sort((a, b) => b.g - a.g)
      .slice(0, n)
      .map((x) => `${x.g}ms@+${x.at}ms`)
      .join(", ");

  const phases = (times) => {
    const a = winStart + winMs / 3;
    const b = winStart + (2 * winMs) / 3;
    return {
      early: gaps(times.filter((t) => t < a)),
      mid: gaps(times.filter((t) => t >= a && t < b)),
      late: gaps(times.filter((t) => t >= b))
    }
  };
  const tickPhases = phases(perf.ticks);

  const missing = SENTINELS.filter((s) => !finalText.includes(s));
  const heapDelta = perf.heapStart && perf.heapEnd ? perf.heapEnd - perf.heapStart : null;

  console.log("── Measured streaming window ────────────────────────────────────");
  console.log(`  window: ${Math.round(winMs)}ms   stub streamed in ${stubStreamMs}ms   chunks: ${FULL_TEXT.split(/(?<=\s)/).length}`);
  console.log(`  text commits (DOM): ${perf.texts.length}  (${(perf.texts.length / (winMs / 1000)).toFixed(1)}/s)`);
  console.log(`  stub's own max inter-write gap: ${stubMaxGapMs}ms  (the delivery floor — the app cannot commit faster than text arrives)`);
  console.log(`  chunks arriving at the RENDERER: ${within(perf.chunks).length}  p95 gap ${r0(pct(chunkGaps, 95))}ms  max gap ${r0(Math.max(0, ...chunkGaps))}ms`);
  const visSegments = (perf.vis ?? []).map((s) => `${Math.round(s.t - perf.t0)}ms ${s.v}`);
  console.log(`  biggest text gaps: ${topGaps(textTimes)}`);
  console.log(`  biggest chunk gaps: ${topGaps(within(perf.chunks))}`);
  if (appCounters.queue !== undefined) {
    console.log(`  APP PIPELINE: queued ${appCounters.queue ?? 0} chunks → flushes ${appCounters.flush ?? 0} (empty ${appCounters.flushEmpty ?? 0}) → setStream ${appCounters.setStream ?? 0}   [rAF fired ${appCounters.rafFire ?? 0}, watchdog fired ${appCounters.watchdogFire ?? 0}]`);
  }
  console.log(`  window visibility timeline: ${visSegments.length <= 12 ? visSegments.join("  →  ") : `${visSegments.length} changes; first ${visSegments.slice(0, 4).join(", ")}; last ${visSegments.slice(-4).join(", ")}`}`);
  console.log(`  main-thread tick gaps: p50 ${r0(pct(tickGaps, 50))}ms  p95 ${r0(pct(tickGaps, 95))}ms  max ${r0(Math.max(0, ...tickGaps))}ms  >50ms: ${over(tickGaps, 50)}`);
  console.log(`    early p95 ${r0(pct(tickPhases.early, 95))}ms | mid p95 ${r0(pct(tickPhases.mid, 95))}ms | late p95 ${r0(pct(tickPhases.late, 95))}ms`);
  console.log(`  animation frames in window: ${within(perf.frames).length}  p95 gap ${r0(pct(frameGaps, 95))}ms  >50ms: ${over(frameGaps, 50)}`);
  console.log(`  long tasks (>50ms): ${longs.length}  worst ${r0(Math.max(0, ...longs))}ms  total ${r0(longs.reduce((a, b) => a + b, 0))}ms`);
  console.log(`  typed-input latency mid-stream: median ${r0(latency?.median)}ms  max ${r0(latency?.max)}ms`);
  console.log(`  JS heap: ${r0(perf.heapStart)} → ${r0(perf.heapEnd)}  (Δ ${r0(heapDelta)} bytes)`);
  console.log(`  sentinels present: ${SECTIONS - missing.length}/${SECTIONS}${missing.length ? `  MISSING ${missing.join(",")}` : ""}`);
  console.log("─────────────────────────────────────────────────────────────────\n");

  check("the streamed response rendered to completion", ended.ok, `final length ${finalText.length}, settled in ${ended.ms}ms`);
  check("no text was dropped (every sentinel present)", missing.length === 0, missing.length ? `missing ${missing.join(",")}` : `${SECTIONS}/${SECTIONS}`);
  // Compare STEADY-STATE gaps only. The first commit is the message element
  // being created and the last is the stream completing — both are boundaries,
  // not stalls, and including them would flag the boundaries as regressions.
  // What matters is whether the renderer ever fell behind the delivery it was
  // given: an interior text gap must not exceed the interior delivery gap.
  const interiorText = gaps(textTimes.slice(2, -2));
  const interiorChunks = gaps(within(perf.chunks).slice(2, -2));
  const appGap = Math.max(0, ...interiorText);
  const chunkGap = Math.max(0, ...interiorChunks);
  check(
    "renderer never fell behind delivery (no interior stall)",
    appGap <= chunkGap + 400,
    `interior text max gap ${r0(appGap)}ms vs interior delivery max gap ${r0(chunkGap)}ms (stub itself ${stubMaxGapMs}ms)`
  );
  check("stream was actually incremental, not dumped at the end", perf.texts.length >= 120, `${perf.texts.length} commits`);
  check("no single long task above 400ms", longs.length === 0 || Math.max(...longs) < 400, longs.length ? `worst ${r0(Math.max(...longs))}ms` : "none");
  check("main thread never blocked for a whole frame-drop stretch", pct(tickGaps, 95) < 60, `p95 ${r0(pct(tickGaps, 95))}ms`);
  check("late streaming not slower than early (no O(n^2) blow-up)", pct(tickPhases.late, 95) <= Math.max(30, (pct(tickPhases.early, 95) ?? 0) * 2.5), `early ${r0(pct(tickPhases.early, 95))}ms vs late ${r0(pct(tickPhases.late, 95))}ms`);
  check("typed input stayed responsive while streaming", (latency?.median ?? 1e9) < 120, `median ${r0(latency?.median)}ms`);
  check("stub received exactly one streaming request", streamRequests === 1, `${streamRequests} request(s)`);

  // ── Restore the user's settings ─────────────────────────────────────────
  await page.evaluate(async (prev) => {
    if (!prev) return;
    await window.latex.settings.save({
      provider: prev.previousProvider,
      selectedModel: prev.previousModel,
      autoSelectModel: prev.previousAuto
    });
  }, previousSettings);
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err?.stack ?? err}`);
  results.push({ name: "harness completed", ok: false });
} finally {
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const lines = [];
  lines.push(`# Streaming smoothness — measured ${new Date().toISOString()}`);
  lines.push("");
  for (const r of results) lines.push(`- ${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  lines.push("");
  lines.push(`Result: ${passed}/${total} passing`);
  try { writeFileSync(join(SHOTS, "streaming-smoothness.log"), lines.join("\n") + "\n"); } catch { /* ignore */ }
  console.log(`\n${passed}/${total} passing — log: ${join(SHOTS, "streaming-smoothness.log")}`);
  try { await app.close(); } catch { /* ignore */ }
  try { stub.close(); } catch { /* ignore */ }
  process.exit(passed === total && total > 0 ? 0 : 1);
}
