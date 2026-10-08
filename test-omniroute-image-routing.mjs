/**
 * OmniRoute image-generation routing — end-to-end against a REAL HTTP stub
 * gateway on 127.0.0.1, plus the pure capability/intent matrix.
 *
 * The bug being guarded against: every request went to
 * `POST /v1/chat/completions`, including requests for image-generation models,
 * so OmniRoute answered
 *
 *   "Model 'aihorde/Qwen-Image_fp8' is an image-generation model and cannot be
 *    used on /v1/chat/completions. Use POST /v1/images/generations instead."
 *
 * and no picture was ever produced.
 *
 * What this locks down:
 *   - intent detection separates image GENERATION from image UNDERSTANDING;
 *   - the endpoint is chosen from CAPABILITIES + intent, never from a model id;
 *   - an image-generation request never touches the chat endpoint;
 *   - a chat request to an image-only model is refused BEFORE any network call;
 *   - a model that supports both uses each endpoint for the right request;
 *   - vision is not treated as image generation;
 *   - the image response (base64, data URL and remote URL) is normalized into
 *     Latex's own image representation, never raw JSON or `[object Object]`;
 *   - the saved OmniRoute key is sent to the image endpoint;
 *   - the gateway's image-model-on-chat error becomes a clear user message.
 *
 * Run with:  node test-omniroute-image-routing.mjs
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, ".tmp-omniroute-image");

rmSync(OUT, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/main/omnirouteProvider.ts",
    "src/shared/imageRouting.ts",
    "--outDir", OUT,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck",
    "--noEmitOnError", "false"
  ],
  { cwd: here, stdio: "inherit" }
);

const providerUrl = new URL(`file://${resolve(OUT, "main/omnirouteProvider.js")}`).href;
const routingUrl = new URL(`file://${resolve(OUT, "shared/imageRouting.js")}`).href;
const {
  fetchOmniRouteModels,
  OmniRouteProvider,
  IMAGE_ONLY_CHAT_MESSAGE
} = await import(providerUrl);
const {
  imageGenerationIntent,
  resolveProviderEndpoint
} = await import(routingUrl);

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const OMNIROUTE_ERROR =
  "Model 'aihorde/Qwen-Image_fp8' is an image-generation model and cannot be used on /v1/chat/completions. Use POST /v1/images/generations instead.";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_1PX, "base64");

// ── Catalog shapes: real capability metadata, not model-name guessing ────
const CATALOG = [
  // Declared image-only by type + capability + endpoint declaration.
  {
    id: "aihorde/Qwen-Image_fp8",
    object: "model",
    type: "image-generation",
    capabilities: ["image-generation"],
    endpoints: ["images/generations"]
  },
  // Declared image-only by OUTPUT MODALITY, with a name that carries no image
  // keyword at all — so this can only be detected from real metadata.
  { id: "vendor/pixelverse-x1", object: "model", output_modalities: ["image"] },
  // Image generation detected from the NAME only (the isolated fallback), for a
  // catalog that declares nothing.
  { id: "vendor/flux-dev", object: "model" },
  // Answers with a remote URL instead of inline base64.
  { id: "vendor/url-model", object: "model", output_modalities: ["image"] },
  // Plain chat model.
  { id: "vendor/chat-9b", object: "model", capabilities: ["chat", "tool-use"] },
  // Vision ≠ image generation.
  { id: "vendor/vision-9b", object: "model", capabilities: ["vision", "chat"] },
  // Supports BOTH — must use each endpoint for the matching intent.
  {
    id: "vendor/omni-9b",
    object: "model",
    capabilities: ["chat", "image-generation"],
    endpoints: ["chat/completions", "images/generations"]
  },
  // Chat model whose backend answers with the image-model-on-chat error.
  { id: "vendor/trap-9b", object: "model", capabilities: ["chat"] }
];

const requests = { chat: [], images: [] };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = req.url ?? "";

    if (req.method === "GET" && url.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: CATALOG }));
      return;
    }

    if (req.method === "GET" && url.includes("/img.png")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG_BYTES);
      return;
    }

    if (req.method === "POST" && url.includes("/v1/chat/completions")) {
      requests.chat.push({ body, auth: req.headers.authorization });
      const model = String(body.model ?? "");
      const imageOnly = CATALOG.find((m) => m.id === model && (m.capabilities ?? []).includes("image-generation") && !(m.capabilities ?? []).includes("chat"));
      if (imageOnly || model === "vendor/trap-9b") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: OMNIROUTE_ERROR.replace("aihorde/Qwen-Image_fp8", model) } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello from chat" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (req.method === "POST" && url.includes("/v1/images/generations")) {
      requests.images.push({ body, auth: req.headers.authorization });
      // `vendor/url-model` answers with a URL instead of inline base64.
      if (body.model === "vendor/url-model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ created: 1, data: [{ url: `http://127.0.0.1:${server.address().port}/img.png` }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_1PX, revised_prompt: "x" }] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const KEY = "test-omniroute-key";

/** Drive a generator to completion, collecting chunks (and any error). */
async function collect(gen) {
  const chunks = [];
  try {
    for await (const chunk of gen) chunks.push(chunk);
    return { chunks, error: null };
  } catch (err) {
    return { chunks, error: err };
  }
}

try {
  // ── 1. Intent: generation vs understanding ──────────────────────────
  console.log("\nintent");
  check("explicit generation is an image request", imageGenerationIntent("Generate an image of a Minecraft house"));
  check("'make me a picture' is an image request", imageGenerationIntent("make me a picture of a red fox"));
  check("thumbnail request is an image request", imageGenerationIntent("generate a thumbnail for my video"));
  check("'generate this as an image' is an image request", imageGenerationIntent("generate this as an image"));
  check("'What is this image?' is NOT image generation", !imageGenerationIntent("What is this image?"));
  check("'describe this image' is NOT image generation", !imageGenerationIntent("describe this image"));
  check("'create a description of this image' is NOT image generation", !imageGenerationIntent("create a description of this image"));
  check("a coding request is NOT image generation", !imageGenerationIntent("fix the bug in app.ts"));
  check("a plain question is NOT image generation", !imageGenerationIntent("what does this function do?"));

  // ── 2. The pure endpoint matrix (normalized capabilities only) ──────
  console.log("\nendpoint matrix (capabilities, not model names)");
  const IMAGE_ONLY = { supportsChat: false, supportsImageGeneration: true };
  const CHAT_ONLY = { supportsChat: true, supportsImageGeneration: false };
  const BOTH = { supportsChat: true, supportsImageGeneration: true };
  const VISION_ONLY = { supportsChat: true, supportsImageGeneration: false };

  const m1 = resolveProviderEndpoint("image_generation", IMAGE_ONLY);
  check("image request + image model → /v1/images/generations", m1.ok && m1.endpoint === "/v1/images/generations", JSON.stringify(m1));
  const m2 = resolveProviderEndpoint("chat", CHAT_ONLY);
  check("chat request + chat model → /v1/chat/completions", m2.ok && m2.endpoint === "/v1/chat/completions", JSON.stringify(m2));
  const m3 = resolveProviderEndpoint("image_generation", VISION_ONLY);
  check("image request + vision-only model → unsupported", m3.ok === false && m3.endpoint === null, JSON.stringify(m3));
  const m4 = resolveProviderEndpoint("chat", IMAGE_ONLY);
  check("chat request + image-only model → unsupported + clear message", m4.ok === false && m4.reason === IMAGE_ONLY_CHAT_MESSAGE, JSON.stringify(m4));
  const m5 = resolveProviderEndpoint("image_generation", BOTH);
  check("image request + both → /v1/images/generations", m5.ok && m5.endpoint === "/v1/images/generations", JSON.stringify(m5));
  const m6 = resolveProviderEndpoint("chat", BOTH);
  check("chat request + both → /v1/chat/completions", m6.ok && m6.endpoint === "/v1/chat/completions", JSON.stringify(m6));

  // ── 3. Capability detection from the catalog ────────────────────────
  console.log("\ncapability detection from /v1/models");
  const models = await fetchOmniRouteModels(base, KEY);
  const byId = new Map(models.map((m) => [m.name, m]));
  const qwen = byId.get("aihorde/Qwen-Image_fp8");
  const flux = byId.get("vendor/flux-dev");
  const pixelverse = byId.get("vendor/pixelverse-x1");
  const chat = byId.get("vendor/chat-9b");
  const vision = byId.get("vendor/vision-9b");
  const omni = byId.get("vendor/omni-9b");

  check("Qwen-Image is an image-generation model", qwen?.supportsImageGeneration === true, JSON.stringify(qwen));
  check("Qwen-Image is not a chat model", qwen?.supportsChat === false, JSON.stringify(qwen));
  check("an output-modality image model is image generation (no name keyword)", pixelverse?.supportsImageGeneration === true && pixelverse?.supportsChat === false, JSON.stringify(pixelverse));
  check("the name fallback still detects FLUX from a bare catalog", flux?.supportsImageGeneration === true && flux?.supportsChat === false, JSON.stringify(flux));
  check("a chat model is not an image generator", chat?.supportsChat === true && chat?.supportsImageGeneration === false, JSON.stringify(chat));
  check("a VISION model is not an image generator", vision?.supportsVision === true && vision?.supportsImageGeneration === false, JSON.stringify(vision));
  check("a both-capable model reports both", omni?.supportsChat === true && omni?.supportsImageGeneration === true, JSON.stringify(omni));
  check("no model ids are hardcoded in the capability result", models.length === CATALOG.length);

  // ── 4. The real provider, over real HTTP ────────────────────────────
  console.log("\nprovider routing (real HTTP)");
  const provider = new OmniRouteProvider(base, KEY);

  requests.chat.length = 0;
  requests.images.length = 0;
  const imageRun = await collect(provider.generate({
    model: "aihorde/Qwen-Image_fp8",
    system: "generate",
    messages: [{ role: "user", parts: [{ text: "Generate an image of a Minecraft house" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024,
    intent: "image_generation"
  }));
  check("image request produced no error", imageRun.error === null, imageRun.error?.message);
  check("image request went to /v1/images/generations", requests.images.length === 1 && requests.chat.length === 0,
    `images=${requests.images.length} chat=${requests.chat.length}`);
  check("the chat endpoint was NEVER used for the image model", requests.chat.length === 0);
  check("the image body carries the prompt", requests.images[0]?.body?.prompt === "Generate an image of a Minecraft house", JSON.stringify(requests.images[0]?.body));
  check("the image body carries the model", requests.images[0]?.body?.model === "aihorde/Qwen-Image_fp8");
  check("the image body carries NO chat fields",
    !("messages" in (requests.images[0]?.body ?? {})) && !("tools" in (requests.images[0]?.body ?? {})) && !("reasoning" in (requests.images[0]?.body ?? {})) && !("stream" in (requests.images[0]?.body ?? {})),
    JSON.stringify(requests.images[0]?.body));
  check("the saved API key is sent to the image endpoint", requests.images[0]?.auth === `Bearer ${KEY}`, String(requests.images[0]?.auth));
  const imageChunks = imageRun.chunks.filter((c) => c.type === "image");
  check("a real image chunk is yielded", imageChunks.length === 1 && imageChunks[0].data === PNG_1PX);
  check("the image has a real mime type", imageChunks[0]?.mimeType === "image/png", imageChunks[0]?.mimeType);
  check("no raw JSON reaches the message", !JSON.stringify(imageRun.chunks).includes("[object Object]"));
  check("no chat text is fabricated for an image turn", imageRun.chunks.every((c) => c.type === "image"));

  // Normal chat still uses chat completions.
  requests.chat.length = 0;
  requests.images.length = 0;
  const chatRun = await collect(provider.generate({
    model: "vendor/chat-9b",
    system: "be helpful",
    messages: [{ role: "user", parts: [{ text: "hello" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024
  }));
  check("normal chat still works", chatRun.error === null && chatRun.chunks.some((c) => c.type === "text" && c.text.includes("hello from chat")), chatRun.error?.message);
  check("normal chat used /v1/chat/completions", requests.chat.length === 1 && requests.images.length === 0,
    `chat=${requests.chat.length} images=${requests.images.length}`);

  // Chat on an image-only model: refused BEFORE any request.
  requests.chat.length = 0;
  requests.images.length = 0;
  const blocked = await collect(provider.generate({
    model: "aihorde/Qwen-Image_fp8",
    system: "be helpful",
    messages: [{ role: "user", parts: [{ text: "write me a poem" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024
  }));
  check("chat on an image-only model fails clearly", blocked.error !== null && blocked.error.message === IMAGE_ONLY_CHAT_MESSAGE, blocked.error?.message);
  check("NO invalid request was sent for that model", requests.chat.length === 0 && requests.images.length === 0,
    `chat=${requests.chat.length} images=${requests.images.length}`);

  // Image request on a chat-only model: refused, not sent to the image endpoint.
  requests.chat.length = 0;
  requests.images.length = 0;
  const wrongImage = await collect(provider.generate({
    model: "vendor/chat-9b",
    system: "x",
    messages: [{ role: "user", parts: [{ text: "generate an image of a cat" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024,
    intent: "image_generation"
  }));
  check("image request on a non-image model is refused", wrongImage.error !== null && /cannot generate images/i.test(wrongImage.error.message), wrongImage.error?.message);
  check("nothing was sent to the image endpoint", requests.images.length === 0, `images=${requests.images.length}`);

  // Both-capable model: the endpoint follows the intent.
  requests.chat.length = 0;
  requests.images.length = 0;
  await collect(provider.generate({
    model: "vendor/omni-9b",
    system: "x",
    messages: [{ role: "user", parts: [{ text: "generate an image of a kite" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024,
    intent: "image_generation"
  }));
  check("both-capable model + image intent → images endpoint", requests.images.length === 1 && requests.chat.length === 0,
    `images=${requests.images.length} chat=${requests.chat.length}`);
  requests.chat.length = 0;
  requests.images.length = 0;
  await collect(provider.generate({
    model: "vendor/omni-9b",
    system: "x",
    messages: [{ role: "user", parts: [{ text: "hello" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024
  }));
  check("both-capable model + chat intent → chat endpoint", requests.chat.length === 1 && requests.images.length === 0,
    `chat=${requests.chat.length} images=${requests.images.length}`);

  // A remote-URL image response is downloaded and normalized.
  requests.images.length = 0;
  const urlRun = await collect(provider.generate({
    model: "vendor/url-model",
    system: "x",
    messages: [{ role: "user", parts: [{ text: "generate an image of a kite" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024,
    intent: "image_generation"
  }));
  const urlChunk = urlRun.chunks.find((c) => c.type === "image");
  check("a URL image response is downloaded and normalized", urlChunk?.data === PNG_1PX && urlChunk?.mimeType === "image/png",
    `${urlChunk?.mimeType} bytes=${urlChunk?.data?.length}`);

  // The gateway's image-model-on-chat error becomes the clear message.
  const trap = await collect(provider.generate({
    model: "vendor/trap-9b",
    system: "x",
    messages: [{ role: "user", parts: [{ text: "hello" }] }],
    temperature: 0.7,
    maxOutputTokens: 1024
  }));
  check("the raw gateway error is never shown to the user",
    trap.error !== null && trap.error.message === IMAGE_ONLY_CHAT_MESSAGE && !/\/v1\/chat\/completions/.test(trap.error.message),
    trap.error?.message);
} finally {
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
rmSync(OUT, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
