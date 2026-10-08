/**
 * Offline test for PROVIDER-EXPOSED IMAGE GENERATION.
 *
 * Run with:  node test-image-generation.mjs
 *
 * What it locks down:
 *  - image capability comes from the model/provider, never from a name guess;
 *  - a request for an image model asks for IMAGE output, a text model does not;
 *  - a real inline image part becomes an `image` chunk, and a text part still
 *    becomes a `text` chunk — the two channels never mix;
 *  - a model that returns NO image part yields NO image event (never faked).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".tmp-image-gen");

execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/shared/types.ts",
    "src/shared/safeMessage.ts",
    "src/shared/vision.ts",
    "src/shared/modelCapabilities.ts",
    "src/main/geminiProvider.ts",
    "--outDir", outDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);

const {
  imageGenerationCapability,
  imageGenerationCapabilityOfModel,
  modelSupportsImageGeneration,
  imageGenerationBadgeLabel,
  preferredImageModelPattern
} = await import(`./.tmp-image-gen/shared/modelCapabilities.js`);
const { GeminiProvider } = await import(`./.tmp-image-gen/main/geminiProvider.js`);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// ─── Capability table ──────────────────────────────────────────────────────
console.log("\n── image capability (provider metadata, not name guessing) ──");
const capable = [
  ["gemini", "models/gemini-2.5-flash-image"],
  ["gemini", "models/gemini-2.5-flash-image-preview"],
  ["gemini", "models/gemini-3-pro-image-preview"],
  ["gemini", "models/nano-banana-pro"]
];
for (const [provider, id] of capable) {
  check(`${provider} ${id} → supports image generation`, imageGenerationCapability(provider, id).supportsImageGeneration, true);
}

const notCapable = [
  ["gemini", "models/gemini-2.5-pro"],
  ["gemini", "models/gemini-2.5-flash"],
  ["gemini", "models/imagen-3.0-generate-002"],
  ["openrouter", "openrouter/google/gemini-2.5-flash-image"],
  ["omniroute", "omniroute/openai/gpt-5.2"],
  ["groq", "groq/openai/gpt-oss-120b"],
  ["puter", "puter/infron:anthropic/claude-haiku-4.5"],
  ["ollama", "ollama/llama3.2"]
];
for (const [provider, id] of notCapable) {
  check(`${provider} ${id} → NO image generation`, imageGenerationCapability(provider, id).supportsImageGeneration, false);
}

check("badge label for an image model", imageGenerationBadgeLabel(imageGenerationCapability("gemini", "models/gemini-2.5-flash-image")), "Image");
check("badge label for a text model", imageGenerationBadgeLabel(imageGenerationCapability("gemini", "models/gemini-2.5-pro")), undefined);
check("modelSupportsImageGeneration on a model entry", modelSupportsImageGeneration({ name: "models/gemini-2.5-flash-image", provider: "gemini" }), true);
check("capabilityOfModel on a text model entry", imageGenerationCapabilityOfModel({ name: "models/gemini-2.5-pro", provider: "gemini" }).supportsImageGeneration, false);
check("preferred image pattern finds a Nano Banana id", preferredImageModelPattern("gemini").test("gemini-2.5-flash-image"), true);
check("preferred image pattern finds gemini-3-pro-image", /gemini-3-pro-image/.test("gemini-3-pro-image-preview") && preferredImageModelPattern("gemini").test("gemini-3-pro-image-preview"), true);

// ─── Gemini stream: real inline image vs text ──────────────────────────────
console.log("\n── Gemini stream parsing (real inline data only) ──");

function sseResponse(payloads) {
  const body = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
  // The provider reads res.body as a web ReadableStream (getReader()).
  return { ok: true, status: 200, body: stream, json: async () => ({}), text: async () => "" };
}

const capturedBodies = [];
function stubFetch(payloads) {
  globalThis.fetch = async (url, init) => {
    capturedBodies.push(JSON.parse(String(init.body)));
    return sseResponse(payloads);
  };
}

const imagePayload = {
  candidates: [{
    content: {
      parts: [
        { text: "Here is the image you asked for." },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } }
      ]
    }
  }]
};
const textPayload = { candidates: [{ content: { parts: [{ text: "No image here." }] } }] };

const provider = new GeminiProvider("test-key");

stubFetch([imagePayload]);
let chunks = [];
for await (const chunk of provider.generate({
  model: "models/gemini-2.5-flash-image", system: "s", messages: [{ role: "user", parts: [{ text: "draw a cat" }] }],
  temperature: 1, maxOutputTokens: 100
})) chunks.push(chunk);

check("image model yields a text chunk", chunks.filter((c) => c.type === "text").map((c) => c.text), ["Here is the image you asked for."]);
check("image model yields exactly one image chunk", chunks.filter((c) => c.type === "image").length, 1);
check("image chunk carries the real mime + data", (() => {
  const img = chunks.find((c) => c.type === "image");
  return img ? [img.mimeType, img.data] : null;
})(), ["image/png", "iVBORw0KGgoAAAANSUhEUg=="]);
check("image request asks for IMAGE output", capturedBodies.at(-1)?.generationConfig?.responseModalities, ["TEXT", "IMAGE"]);

stubFetch([textPayload]);
chunks = [];
for await (const chunk of provider.generate({
  model: "models/gemini-2.5-pro", system: "s", messages: [{ role: "user", parts: [{ text: "hello" }] }],
  temperature: 1, maxOutputTokens: 100
})) chunks.push(chunk);

check("text model yields NO image chunk", chunks.filter((c) => c.type === "image").length, 0);
check("text model does NOT ask for IMAGE output", capturedBodies.at(-1)?.generationConfig?.responseModalities, undefined);
check("text model still returns its prose", chunks.map((c) => c.text), ["No image here."]);

console.log(failures === 0 ? "\nALL IMAGE-GENERATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
