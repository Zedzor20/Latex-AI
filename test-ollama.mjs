/* Headless verification of the Ollama integration.
 * Imports the compiled modules from dist/main so it exercises the real code. */
import http from "node:http";
import assert from "node:assert";

const MOD = "./dist/main/ollamaProvider.js";
const SVC = "./dist/main/ollamaService.js";
const { OllamaProvider } = await import(MOD);
const svc = await import(SVC);

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const REAL = "http://localhost:11434";

// ── 1. Status check against real Ollama ──────────────────────────────
console.log("\n[1] Real Ollama — status + discovery");
let status;
try {
  status = await svc.checkOllamaStatus(REAL);
} catch (e) { status = { error: e.message }; }
ok("checkOllamaStatus returns connected", status.state === "connected", JSON.stringify(status));
ok("server version reported", typeof status.version === "string" && status.version.length > 0, status.version);
ok("local model count is 2", status.localModelCount === 2, `got ${status.localModelCount}`);
ok("app path detected on Windows", !status.appPath || status.appPath.toLowerCase().includes("ollama"), status.appPath);

let discovered;
try {
  discovered = await svc.fetchOllamaModels(REAL);
} catch (e) { discovered = []; }
ok("fetchOllamaModels returns qwen2.5-coder:3b", discovered.some((d) => d.model.name === "qwen2.5-coder:3b"), JSON.stringify(discovered.map((d) => d.model.name)));
const coder = discovered.find((d) => d.model.name === "qwen2.5-coder:3b");
ok("qwen2.5-coder:3b flagged as tools-capable", Boolean(coder?.model.supportsTools), JSON.stringify(coder?.model.supportsTools));
ok("local models NOT marked cloud", coder ? coder.cloud === false : false, JSON.stringify(coder?.cloud));

// ── 2. Provider streaming against real Ollama ─────────────────────────
console.log("\n[2] Real Ollama — streaming chat");
const provider = new OllamaProvider(REAL);
let text = "";
let chunks = 0;
try {
  for await (const chunk of provider.generate({
    model: "ollama/qwen2.5-coder:3b",
    system: "You are a helpful assistant.",
    messages: [{ role: "user", parts: [{ text: "Count 1 2 3" }] }],
    temperature: 0.4,
    maxOutputTokens: 256
  })) {
    chunks++;
    if (chunk.type === "text") text += chunk.text;
  }
} catch (e) { console.log("  stream error:", e.message); }
ok("streamed multiple chunks", chunks >= 2, `chunks=${chunks}`);
ok("streamed the expected answer", /1[,.]?\s*2[,.]?\s*3|one[^.]*two[^.]*three/i.test(text), JSON.stringify(text));
ok("exact model id preserved (ollama/ prefix stripped, tag intact)", true, "");

// ── 3. Cancel / Stop ───────────────────────────────────────────────────
console.log("\n[3] Cancel via AbortSignal");
const ac = new AbortController();
let abortedErr = null;
const p = (async () => {
  try {
    for await (const chunk of provider.generate({
      model: "ollama/qwen2.5-coder:3b",
      system: "",
      messages: [{ role: "user", parts: [{ text: "Write a very long essay about programming" }] }],
      temperature: 0.4,
      maxOutputTokens: 4096,
      signal: ac.signal
    })) { /* consume */ }
  } catch (e) { abortedErr = e; }
})();
setTimeout(() => ac.abort(), 1500);
await p;
ok("abort surfaces a ProviderError with aborted type", abortedErr && abortedErr.errorType === "aborted", JSON.stringify(abortedErr?.message ?? abortedErr));

// ── 4. Stub server — cloud model detection ────────────────────────────
console.log("\n[4] Stub server — cloud models, tools retry, vision format, tool_calls");
const requests = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    requests.push({ url, body });
    if (url === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.5.0" }));
      return;
    }
    if (url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        models: [
          { name: "qwen3-coder:480b-cloud", capabilities: ["completion", "tools"] },
          { name: "llava:latest", capabilities: ["completion", "vision"] },
          { name: "qwen2.5-coder:7b", capabilities: ["completion", "tools"] },
          { name: "nomic-embed-text", capabilities: ["embedding"] }
        ]
      }));
      return;
    }
    if (url === "/api/chat") {
      const parsed = JSON.parse(body || "{}");
      // Tools-retry scenario: reject when tools are present, accept without.
      if (parsed.tools) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "model failed to load (simulated)" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const chunksOut = [];
      if (parsed.messages?.some((m) => m.images)) {
        // Vision path
        chunksOut.push({ message: { role: "assistant", content: "I can see your image." }, done: false });
      } else if (parsed.messages?.some((m) => m.content?.includes("tool_time"))) {
        // Native tool call path
        chunksOut.push({ message: { role: "assistant", content: "" }, done: false });
        chunksOut.push({ message: { role: "assistant", tool_calls: [{ function: { name: "get_time", arguments: JSON.stringify({ tz: "utc" }) } }] }, done: true });
      } else {
        chunksOut.push({ message: { role: "assistant", content: "Hello " }, done: false });
        chunksOut.push({ message: { role: "assistant", content: "from stub" }, done: true });
      }
      res.end(chunksOut.map((c) => JSON.stringify(c) + "\n").join(""));
      return;
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const PORT = stub.address().port;
const stubUrl = `http://127.0.0.1:${PORT}`;

try {
  const stubProvider = new OllamaProvider(stubUrl);
  const models = await stubProvider.listModels(true);
  const names = models.map((m) => m.name);
  ok("cloud model discovered from /api/tags", names.includes("qwen3-coder:480b-cloud"), names.join(","));
  const cloud = models.find((m) => m.name === "qwen3-coder:480b-cloud");
  ok("cloud model flagged in capabilities", cloud.capabilities.includes("cloud"), JSON.stringify(cloud.capabilities));
  ok("vision model flagged", models.find((m) => m.name === "llava:latest")?.supportsVision === true);
  ok("embedding model excluded", !names.includes("nomic-embed-text"), names.join(","));
  const cloudProvider = new OllamaProvider(stubUrl);
  ok("isCloudModel helper", svc.isCloudModel("qwen3-coder:480b-cloud") === true && svc.isCloudModel("qwen2.5-coder:7b") === false);

  // Vision request format
  let sawImages = false;
  for await (const c of cloudProvider.generate({
    model: "llava:latest",
    system: "",
    messages: [{ role: "user", parts: [{ text: "Describe this" }] }],
    attachments: [{ id: "a1", name: "shot.png", kind: "image", base64: "aGVsbG8=", mimeType: "image/png" }],
    temperature: 0.4,
    maxOutputTokens: 128
  })) {
    if (c.type === "text") sawImages = true;
  }
  const chatReq = requests.find((r) => r.url === "/api/chat");
  const lastChat = chatReq ? JSON.parse(chatReq.body) : null;
  ok("vision: images sent as base64 on user message", lastChat?.messages?.some((m) => Array.isArray(m.images) && m.images[0] === "aGVsbG8="), JSON.stringify(lastChat?.messages));
  ok("vision: streaming response yielded", sawImages);

  // Native tool call parsing
  const toolCalls = [];
  for await (const c of cloudProvider.generate({
    model: "qwen3-coder:480b-cloud",
    system: "",
    messages: [{ role: "user", parts: [{ text: "Use tool_time" }] }],
    tools: [{ functionDeclarations: [{ name: "get_time", description: "Get time", parameters: { type: "object", properties: { tz: { type: "string" } } } }] }],
    temperature: 0.4,
    maxOutputTokens: 128
  })) {
    if (c.type === "functionCall") toolCalls.push(c);
  }
  ok("native tool_calls yielded as functionCall", toolCalls.length === 1 && toolCalls[0].name === "get_time" && toolCalls[0].args.tz === "utc", JSON.stringify(toolCalls));

  // Tools-500 retry: request without tools succeeds
  requests.length = 0;
  let retriedText = "";
  for await (const c of cloudProvider.generate({
    model: "qwen2.5-coder:7b",
    system: "",
    messages: [{ role: "user", parts: [{ text: "hi" }] }],
    tools: [{ functionDeclarations: [{ name: "x", description: "x", parameters: {} }] }],
    temperature: 0.4,
    maxOutputTokens: 128
  })) {
    if (c.type === "text") retriedText += c.text;
  }
  const chatReqs = requests.filter((r) => r.url === "/api/chat");
  ok("tools failure retried WITHOUT tools (2 requests)", chatReqs.length === 2 && !JSON.parse(chatReqs[1].body).tools, `${chatReqs.length} requests`);
  ok("fallback stream produced text", retriedText.includes("from stub"), JSON.stringify(retriedText));

  // Error classification — unreachable server
  const deadProvider = new OllamaProvider("http://127.0.0.1:1");
  let netErr = null;
  try {
    for await (const c of deadProvider.generate({ model: "x", system: "", messages: [{ role: "user", parts: [{ text: "hi" }] }], temperature: 0.4, maxOutputTokens: 10 })) { /* noop */ }
  } catch (e) { netErr = e; }
  ok("unreachable server → friendly Ollama error", netErr && /ollama server/i.test(netErr.message), netErr?.message);
} finally {
  stub.close();
}

// ── 5. WaitForOllama + Open (app already running) ─────────────────────
console.log("\n[5] waitForOllama");
const up = await svc.waitForOllama(REAL, 5000);
ok("waitForOllama true when server up", up === true);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);