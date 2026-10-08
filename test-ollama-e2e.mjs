/* E2E verification of Ollama in the live Latex app (CDP over WebSocket). */
const CDP_WS = "http://127.0.0.1:9242/json/list";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function main() {
  const targets = await (await fetch(CDP_WS)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log("No page target"); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for React to render
  for (let i = 0; i < 40; i++) {
    const len = await evalJs(`document.getElementById("root")?.innerHTML.length ?? 0`).catch(() => 0);
    if (len > 500) break;
    await wait(500);
  }

  // ── Skip auth if the Welcome screen is showing ──
  for (let i = 0; i < 10; i++) {
    const welcomeShown = await evalJs(`document.body.innerText.includes("Continue without account") || document.body.innerText.includes("Sign in to sync")`);
    if (!welcomeShown) break;
    const skipClicked = await evalJs(`(() => {
      const btns = [...document.querySelectorAll("button")];
      const skip = btns.find((b) => /continue without account/i.test(b.innerText));
      if (skip) { skip.click(); return true; }
      return false;
    })()`);
    if (skipClicked) { await wait(2000); break; }
    await wait(800);
  }
  const inApp = await evalJs(`!!document.querySelector(".composer textarea")`);
  ok("entered main app UI", inApp === true);

  // ── 1. Ollama status via preload bridge ──
  const status = await evalJs(`window.latex.ollama.getStatus()`);
  ok("ollama status connected", status?.state === "connected", JSON.stringify(status));
  ok("ollama status reports 2 local models", status?.localModelCount === 2, `got ${status?.localModelCount}`);

  // ── 2. Models include Ollama ──
  const models = await evalJs(`window.latex.ai.models()`);
  const ollamaModels = models.filter((m) => m.provider === "ollama");
  ok("models list contains Ollama provider", ollamaModels.length > 0, `${ollamaModels.length} models`);
  ok("qwen2.5-coder:3b discovered", ollamaModels.some((m) => m.name === "ollama/qwen2.5-coder:3b"), JSON.stringify(ollamaModels.map((m) => m.name)));
  const coder = ollamaModels.find((m) => m.name === "ollama/qwen2.5-coder:3b");
  ok("qwen2.5-coder flagged tools-capable", coder?.supportsTools === true, JSON.stringify(coder?.supportsTools));
  ok("models NOT marked as cloud", !coder?.capabilities?.includes("cloud"), JSON.stringify(coder?.capabilities));

  // ── 3. Model picker UI: Ollama scope chip + LOCAL tag ──
  let menuText = "";
  for (let i = 0; i < 10 && !menuText; i++) {
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.className.includes("modelButton"));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await wait(600);
    menuText = await evalJs(`document.querySelector(".modelMenu")?.innerText ?? ""`);
  }
  ok("model menu opened", menuText.length > 0);
  ok("picker shows Ollama scope chip", /Ollama/.test(menuText));
  const openedScope = await evalJs(`(() => {
    const chips = [...document.querySelectorAll(".modelScopeChip")];
    const ollama = chips.find((c) => c.innerText.trim().startsWith("Ollama"));
    if (ollama) { ollama.click(); return true; }
    return false;
  })()`);
  await wait(800);
  const ollamaScopeText = await evalJs(`document.querySelector(".modelMenu")?.innerText ?? ""`);
  ok("Ollama scope opens", openedScope === true);
  ok("Ollama scope shows LOCAL section", /LOCAL MODELS/.test(ollamaScopeText), ollamaScopeText.slice(0, 200));
  ok("Ollama scope shows qwen2.5-coder:3b", /qwen2.5-coder/.test(ollamaScopeText));
  ok("Ollama scope shows LOCAL tag", /LOCAL/.test(ollamaScopeText));
  await evalJs(`document.querySelector(".modelMenu")?.remove()`);

  // ── 4. Select the exact Ollama model and send a real message ──
  const saved = await evalJs(`window.latex.settings.save({ selectedModel: "ollama/qwen2.5-coder:3b", provider: "ollama", autoSelectModel: false })`);
  ok("settings saved with exact ollama model", saved?.selectedModel === "ollama/qwen2.5-coder:3b", JSON.stringify(saved));
  await evalJs(`location.reload()`);
  await wait(4000);
  const settings2 = await evalJs(`window.latex.settings.get()`);
  ok("exact model persisted after reload", settings2?.selectedModel === "ollama/qwen2.5-coder:3b", JSON.stringify(settings2?.selectedModel));
  const label = await evalJs(`document.querySelector(".modelButtonLabel")?.innerText ?? ""`);
  ok("composer shows selected Ollama model", label.includes("qwen2.5-coder"), label);

  // Send via the real UI
  const typed = await evalJs(`(() => {
    const ta = document.querySelector(".composer textarea");
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "Say hello in exactly five words");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  ok("composer text set", typed === true);
  await wait(500);
  const sent = await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".sendButton")].find((b) => !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  ok("send button clicked", sent === true);

  // Wait for the turn to complete (streaming + agent loop)
  let reply = null;
  for (let i = 0; i < 60; i++) {
    await wait(2000);
    const convs = await evalJs(`window.latex.conversation.list()`);
    const c = convs.find((x) => x.selectedModel === "ollama/qwen2.5-coder:3b" || x.messages.some((m) => m.role === "assistant" && m.model === "ollama/qwen2.5-coder:3b"));
    if (c) {
      const last = c.messages[c.messages.length - 1];
      if (last?.role === "assistant") { reply = last; break; }
    }
  }
  ok("assistant replied via Ollama", Boolean(reply?.content), JSON.stringify(reply?.content ?? null));
  ok("reply attributed to exact ollama model", reply?.model === "ollama/qwen2.5-coder:3b", JSON.stringify(reply?.model));
  ok("reply attributed to ollama provider", reply?.provider === "ollama", JSON.stringify(reply?.provider));
  if (reply?.content) console.log(`  reply: ${reply.content.slice(0, 140).replace(/\n/g, " ")}`);

  // ── 5. Activity timeline preserved (Main Tab) ──
  const steps = reply?.meta?.activitySteps;
  ok("activity timeline attached to message", Array.isArray(steps) && steps.length > 0, JSON.stringify(steps?.length));

  ws.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("E2E failed:", e.message); process.exit(1); });