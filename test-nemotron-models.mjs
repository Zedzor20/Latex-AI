/**
 * Nemotron model visibility check.
 *
 * Run with:  node test-nemotron-models.mjs
 *
 * The model picker used to hide every NVIDIA/Nemotron entry in two places:
 * ProviderFactory.listAllModels() had an EXCLUDED_PATTERNS filter that dropped
 * anything matching /nemotron|nvidia/, and the renderer's weak-model filter
 * removed small variants. This test reads the real source of both layers,
 * checks the actual filters against real Nemotron model ids, and (when the
 * network allows) reports how many Nemotron models the live OpenRouter catalog
 * exposes — so "they show up" is verified against data, not against a claim.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── 1. Main-process discovery filter ─────────────────────────────────────
const providerSource = readFileSync(join(here, "src", "main", "providerService.ts"), "utf8");
const excludedMatch = providerSource.match(/const EXCLUDED_PATTERNS = (\/.*\/[a-z]*);/);
check("providerService declares EXCLUDED_PATTERNS", Boolean(excludedMatch));
const excluded = excludedMatch ? eval(excludedMatch[1]) : /$^/;

const REAL_MODELS = [
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/nemotron-nano-9b-v2",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nemotron-mini:latest",
  "nemotron:70b"
];
const wronglyExcluded = REAL_MODELS.filter((name) => excluded.test(name));
check("Nemotron models are not excluded from the picker", wronglyExcluded.length === 0, wronglyExcluded.join(", "));
check("exclusion filter still hides embeddings/audio", excluded.test("text-embedding-3-large") && excluded.test("whisper-large-v3"));

// ── 2. Renderer weak/small-model filter + automation scope ───────────────
const composerSource = readFileSync(join(here, "src", "renderer", "src", "components", "Composer.tsx"), "utf8");
check("weak-model filter exempts Nemotron", /if \(\/nemotron\|nvidia\/i\.test\(combined\)\) return false;/.test(composerSource));
check("automation scope accepts Nemotron tool models", /if \(\/nemotron\|nvidia\/i\.test\(lower \+ " " \+ id\) && model\.supportsTools\) return true;/.test(composerSource));

// ── 3. Live catalog (best effort — the catalog is public) ───────────────
try {
  const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    console.log(`SKIP  live OpenRouter catalog — HTTP ${response.status}`);
  } else {
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data : [];
    const nemotron = models.map((m) => String(m.id ?? "")).filter((id) => /nemotron|nvidia/i.test(id));
    const wouldBeHidden = nemotron.filter((id) => excluded.test(id));
    console.log(`INFO  live OpenRouter catalog: ${models.length} models, ${nemotron.length} Nemotron/NVIDIA entries`);
    console.log(`INFO  examples: ${nemotron.slice(0, 6).join(", ") || "none in this catalog snapshot"}`);
    check("live catalog Nemotron models survive the filter", wouldBeHidden.length === 0, wouldBeHidden.join(", "));
  }
} catch (error) {
  console.log(`SKIP  live OpenRouter catalog — ${error?.message ?? error}`);
}

console.log(failures === 0 ? "\nALL NEMOTRON MODEL TESTS PASSED" : `\n${failures} NEMOTRON MODEL TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
