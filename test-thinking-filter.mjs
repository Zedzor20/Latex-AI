/**
 * Thinking filter — provider scope + per-model capability verification.
 *
 * Guards two rules:
 *   1. The Thinking filter only spans PUTER, OLLAMA, OMNIROUTE, MINIMAX, GEMINI
 *      (never OpenRouter, never alphabetical, fixed order).
 *   2. A model is eligible ONLY when its exact provider+model genuinely exposes
 *      reasoning to Latex — never by provider, never by a name keyword alone.
 *
 * Compiles the real shared module (no mocks) and exercises the real functions.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const OUT = ".tmp-thinking";
rmSync(OUT, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/shared/modelCapabilities.ts",
    "--outDir", OUT,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck",
    "--noEmitOnError", "false"
  ],
  { stdio: "inherit" }
);

const modUrl = new URL(`file://${path.resolve(OUT, "modelCapabilities.js")}`).href;
const {
  THINKING_FILTER_ORDER,
  thinkingProviderAllowed,
  modelEligibleForThinkingFilter,
  modelSupportsThinking,
  thinkingQualityScore,
  compareThinkingModels
} = await import(modUrl);

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const M = (provider, name, extra = {}) => ({ provider, name, capabilities: [], ...extra });

console.log("\n[1] Provider order + allowlist");
ok("order is exactly Puter → Ollama → OmniRoute → MiniMax → Gemini",
  JSON.stringify(THINKING_FILTER_ORDER) === JSON.stringify(["puter", "ollama", "omniroute", "minimax", "gemini"]),
  JSON.stringify(THINKING_FILTER_ORDER));
ok("puter allowed", thinkingProviderAllowed("puter"));
ok("ollama allowed", thinkingProviderAllowed("ollama"));
ok("omniroute allowed", thinkingProviderAllowed("omniroute"));
ok("minimax allowed", thinkingProviderAllowed("minimax"));
ok("gemini allowed", thinkingProviderAllowed("gemini"));
ok("openrouter NOT allowed", thinkingProviderAllowed("openrouter") === false);
ok("groq NOT allowed", thinkingProviderAllowed("groq") === false);

console.log("\n[2] Verified per-model eligibility");
ok("Puter DeepSeek-R1 is eligible", modelEligibleForThinkingFilter(M("puter", "puter/deepseek-r1")) === true);
ok("Puter model with explicit reasoning capability is eligible",
  modelEligibleForThinkingFilter(M("puter", "puter/custom-model", { capabilities: ["reasoning"] })) === true);
ok("Puter ordinary chat model is NOT eligible",
  modelEligibleForThinkingFilter(M("puter", "puter/gpt-4o-mini")) === false);
ok("OpenRouter reasoning model is EXCLUDED from the filter (provider rule)",
  modelEligibleForThinkingFilter(M("openrouter", "openrouter/deepseek/deepseek-r1")) === false);
ok("...but OpenRouter still reports reasoning capability (All Models keeps it)",
  modelSupportsThinking(M("openrouter", "openrouter/deepseek/deepseek-r1")) === true);
ok("Groq reasoning model is EXCLUDED from the filter",
  modelEligibleForThinkingFilter(M("groq", "groq/deepseek-r1-distill-llama-70b")) === false);
ok("MiniMax M2 is eligible", modelEligibleForThinkingFilter(M("minimax", "minimax/MiniMax-M2")) === true);
ok("MiniMax non-reasoning model is NOT eligible",
  modelEligibleForThinkingFilter(M("minimax", "minimax/abab6.5s-chat")) === false);
ok("Ollama reasoning model (family) is eligible",
  modelEligibleForThinkingFilter(M("ollama", "ollama/deepseek-r1:7b")) === true);
ok("Ollama model with reported reasoning capability is eligible",
  modelEligibleForThinkingFilter(M("ollama", "ollama/some-local:latest", { capabilities: ["reasoning", "ollama"] })) === true);
ok("Ollama plain chat model is NOT eligible",
  modelEligibleForThinkingFilter(M("ollama", "ollama/qwen2.5-coder:7b")) === false);
ok("Gemini 2.5 Flash is eligible", modelEligibleForThinkingFilter(M("gemini", "models/gemini-2.5-flash")) === true);
ok("Gemini 2.0 is NOT eligible", modelEligibleForThinkingFilter(M("gemini", "models/gemini-2.0-flash")) === false);
ok("Gemini 1.5 is NOT eligible", modelEligibleForThinkingFilter(M("gemini", "models/gemini-1.5-pro")) === false);
ok("Gemini imagen is NOT eligible", modelEligibleForThinkingFilter(M("gemini", "models/imagen-3.0")) === false);

console.log("\n[3] Name keyword alone is never enough");
ok("\"thinking\" in the name alone does not qualify (Puter)",
  modelEligibleForThinkingFilter(M("puter", "puter/random-thinking-model")) === false);
ok("\"reasoning\" in the name alone does not qualify (Ollama)",
  modelEligibleForThinkingFilter(M("ollama", "ollama/totally-reasoning-llama")) === false);
ok("OpenRouter model named \"-reasoning\" stays out of the filter",
  modelEligibleForThinkingFilter(M("openrouter", "openrouter/vendor/model-reasoning")) === false);

console.log("\n[4] Quality-oriented ordering (strongest → lighter)");
const pro = M("gemini", "models/gemini-2.5-pro", { contextLength: 1_000_000, supportsTools: true });
const flash = M("gemini", "models/gemini-2.5-flash", { contextLength: 1_000_000, supportsTools: true });
const lite = M("gemini", "models/gemini-2.5-flash-lite", { contextLength: 1_000_000, supportsTools: true });
ok("pro ranks above flash", thinkingQualityScore(pro) > thinkingQualityScore(flash), `${thinkingQualityScore(pro)} vs ${thinkingQualityScore(flash)}`);
ok("flash ranks above lite", thinkingQualityScore(flash) > thinkingQualityScore(lite), `${thinkingQualityScore(flash)} vs ${thinkingQualityScore(lite)}`);
const sorted = [lite, pro, flash].sort(compareThinkingModels).map((m) => m.name);
ok("sort puts strongest first", JSON.stringify(sorted) === JSON.stringify([pro.name, flash.name, lite.name]), JSON.stringify(sorted));
const big = M("ollama", "ollama/llama-3.3:70b", { contextLength: 128_000 });
const small = M("ollama", "ollama/llama-3.2:3b", { contextLength: 8_000 });
ok("larger parameter model ranks above a small one", thinkingQualityScore(big) > thinkingQualityScore(small), `${thinkingQualityScore(big)} vs ${thinkingQualityScore(small)}`);

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
