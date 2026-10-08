/* Headless verification of message-scoped image inclusion.
 *
 * Reproduces the reported bug: a NORMAL text-only turn in a chat whose history
 * contains an image was sent as a multimodal request, so a non-vision Ollama
 * model failed with "this model does not support image input".
 *
 * Exercises the real compiled modules:
 *   dist/shared/vision.js        — the message-boundary gate
 *   dist/main/ollamaProvider.js  — the real Ollama adapter + stub server
 *
 * The stub SERVER rejects any request that carries an `images` field to a
 * non-vision model, exactly like a real Ollama runner. That makes the test
 * meaningful: if the image leaks into a text-only turn, the request fails.
 */
import http from "node:http";

const { currentTurnHasImage, toProviderMessage } = await import("./dist/shared/vision.js");
const { OllamaProvider } = await import("./dist/main/ollamaProvider.js");

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

// Valid base64 long enough to pass the image validator (>=16 chars).
const IMG_B64 = "aGVsbG8gd29ybGQhIQ==";
const IMG = { id: "a1", name: "shot.png", kind: "image", base64: IMG_B64, mimeType: "image/png" };
const FILE = { id: "f1", name: "notes.txt", kind: "text", content: "hello file", mimeType: "text/plain" };

const userMsg = (content, attachments = [], id = "u") => ({
  id, role: "user", content, createdAt: 0,
  ...(attachments.length ? { meta: { attachments } } : {})
});
const asstMsg = (content) => ({ id: "a", role: "assistant", content, createdAt: 0 });

// ── 1. Pure message-boundary gate ────────────────────────────────────
console.log("\n[1] currentTurnHasImage / toProviderMessage");
{
  const history = [userMsg("describe this", [IMG], "u1"), asstMsg("done"), userMsg("what is 2+2?", [], "u2")];
  ok("earlier image does NOT make a later text turn multimodal", currentTurnHasImage(history) === false);
  ok("current message with image IS multimodal", currentTurnHasImage([userMsg("hi", [IMG])]) === true);
  ok("fresh image attachment IS multimodal", currentTurnHasImage([userMsg("hi")], [IMG]) === true);
  ok("non-image attachment is NOT multimodal", currentTurnHasImage([userMsg("hi", [FILE])]) === false);

  const dropped = toProviderMessage(userMsg("describe this", [IMG]), false);
  ok("toProviderMessage(false) drops the image payload", dropped.attachments === undefined, JSON.stringify(dropped.attachments));
  const kept = toProviderMessage(userMsg("describe this", [IMG]), true);
  ok("toProviderMessage(true) keeps the image", kept.attachments?.some((a) => a.kind === "image"), JSON.stringify(kept.attachments));
  const files = toProviderMessage(userMsg("hi", [IMG, FILE]), false);
  ok("file content survives even when images are dropped", files.attachments?.some((a) => a.kind === "text"), JSON.stringify(files.attachments));
}

// ── 2. Stub Ollama server that rejects images on non-vision models ───
console.log("\n[2] Ollama payloads (stub server)");
const requests = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    requests.push({ url, body });
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (url === "/api/version") return json(200, { version: "0.5.0" });
    if (url === "/api/show") return json(200, { capabilities: ["completion"] });
    if (url === "/api/chat") {
      const parsed = JSON.parse(body || "{}");
      const hasImages = (parsed.messages ?? []).some((m) => Array.isArray(m.images) && m.images.length > 0);
      const visionModel = /vision|llava/i.test(parsed.model ?? "");
      if (hasImages && !visionModel) {
        // Exactly what a real Ollama runner returns for a text-only model.
        return json(400, { error: "this model does not support image input" });
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const reply = hasImages ? "I can see your image." : "Hello from stub";
      res.end(JSON.stringify({ message: { role: "assistant", content: reply }, done: true }) + "\n");
      return;
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
const provider = new OllamaProvider(stubUrl);

async function drain(model, messages, attachments) {
  let text = "";
  for await (const c of provider.generate({ model, system: "", messages, attachments, temperature: 0.4, maxOutputTokens: 64 })) {
    if (c.type === "text") text += c.text;
  }
  return text;
}

try {
  // ── Baseline: the stub really rejects a leaked image ──
  let baselineErr = null;
  try {
    await drain("ollama/qwen2.5-coder:7b", [{ role: "user", parts: [{ text: "hi" }], attachments: [IMG] }]);
  } catch (e) { baselineErr = e; }
  ok("baseline: a leaked image on a text model fails (proves the stub is strict)",
    Boolean(baselineErr) && /does not support image input/i.test(baselineErr.message), baselineErr?.message);

  // ── The fix: a TEXT turn in a chat whose history has an image ──
  requests.length = 0;
  const history = [userMsg("describe this", [IMG], "u1"), asstMsg("done"), userMsg("What is 2 + 2?", [], "u2")];
  const includeImages = currentTurnHasImage(history);
  const transcript = history.map((m) => toProviderMessage(m, includeImages));
  let text = "";
  let err = null;
  try { text = await drain("ollama/qwen2.5-coder:7b", transcript); } catch (e) { err = e; }
  const chatReq = requests.find((r) => r.url === "/api/chat");
  const body = chatReq ? JSON.parse(chatReq.body) : null;
  const anyImages = (body?.messages ?? []).some((m) => Array.isArray(m.images));
  ok("REGRESSION: text turn sends NO `images` field", !anyImages, JSON.stringify(body?.messages));
  ok("REGRESSION: no image-input error on a text turn", err === null, err?.message);
  ok("REGRESSION: text turn still gets a normal reply", /Hello from stub/.test(text), JSON.stringify(text));
  ok("requestMode is text", includeImages === false);

  // ── Regression §16-22: send an IMAGE turn, then a text turn ──
  requests.length = 0;
  const turn1 = [userMsg("describe this", [IMG], "u1")];
  const t1 = await drain("ollama/llava:latest", turn1.map((m) => toProviderMessage(m, currentTurnHasImage(turn1))), [IMG]);
  const t1body = JSON.parse(requests.find((r) => r.url === "/api/chat").body);
  ok("image turn DOES include the image (vision model)", t1body.messages.some((m) => Array.isArray(m.images) && m.images[0] === IMG_B64), JSON.stringify(t1body.messages));
  ok("image turn returns a vision reply", /I can see your image/.test(t1), JSON.stringify(t1));

  requests.length = 0;
  const turn2 = [userMsg("describe this", [IMG], "u1"), asstMsg("I can see your image."), userMsg("Explain recursion simply.", [], "u2")];
  let t2err = null, t2 = "";
  try { t2 = await drain("ollama/qwen2.5-coder:7b", turn2.map((m) => toProviderMessage(m, currentTurnHasImage(turn2)))); } catch (e) { t2err = e; }
  const t2body = JSON.parse(requests.find((r) => r.url === "/api/chat").body);
  ok("after an image turn, the next text turn carries no image", !t2body.messages.some((m) => Array.isArray(m.images)), JSON.stringify(t2body.messages));
  ok("after an image turn, the next text turn has no error", t2err === null, t2err?.message);

  // ── Plain text-only chat (no history image) ──
  requests.length = 0;
  const plain = [userMsg("Hello, how are you?", [], "u1")];
  const plainText = await drain("ollama/qwen2.5-coder:3b", plain.map((m) => toProviderMessage(m, currentTurnHasImage(plain))));
  const plainBody = JSON.parse(requests.find((r) => r.url === "/api/chat").body);
  ok("plain chat has no image field", !plainBody.messages.some((m) => "images" in m), JSON.stringify(plainBody.messages));
  ok("plain chat responds normally", /Hello from stub/.test(plainText), JSON.stringify(plainText));
} finally {
  stub.closeAllConnections?.();
  stub.close();
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
// Let keep-alive sockets drain so the process teardown is clean.
await new Promise((r) => setTimeout(r, 300));
process.exit(failed > 0 ? 1 : 0);
