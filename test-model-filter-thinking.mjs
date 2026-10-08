/**
 * Model-filter single-select + Chat/Main Thinking-mode gating.
 *
 * Run with:  node test-model-filter-thinking.mjs   (app must be closed)
 *
 * Locks down two reported bugs:
 *
 *  1. The model picker's filter chips (All / Recommended / Automation /
 *     Thinking / each provider) are a SINGLE-SELECT group. Clicking one must
 *     clear the previous selection — Thinking must never stay selected next to
 *     a provider chip, and exactly one chip may carry `.active` at any time.
 *
 *  2. Thinking is a MAIN-agent concept. The Chat composer must not render the
 *     Thinking control (`.thinkingPill`), and Chat must show no agent activity
 *     panel (`.activityCodex`) or Thinking box (`.thinkingBlock`).
 *
 * Everything here drives the real packaged app: real clicks, real DOM.
 */
import { _electron as electron } from "playwright";
import { join } from "node:path";
import { existsSync } from "node:fs";

const here = process.cwd();
const EXE = join(here, "release", "win-unpacked", "Latex.exe");
if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

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

  const openPicker = async () => {
    // The model pill toggles the dropdown. Re-click only if it is closed.
    const openNow = await page.locator(".modelMenu").count();
    if (!openNow) await page.locator(".modelButton").first().click();
    await page.waitForSelector(".modelScopeRow", { timeout: 10_000 });
  };
  const closePicker = async () => {
    if (await page.locator(".modelMenu").count()) await page.locator(".modelButton").first().click();
    await page.waitForTimeout(150);
  };
  const activeChips = async () => page.locator(".modelScopeChip.active").allInnerTexts();
  const clickChip = async (label) => {
    const chip = page.locator(".modelScopeChip", { hasText: new RegExp(`^${label}`) }).first();
    await chip.click();
    await page.waitForTimeout(200);
  };

  // ── 1. Single-select filter ──────────────────────────────────────────
  await openPicker();

  await clickChip("Thinking");
  let active = (await activeChips()).map((t) => t.replace(/[✓✗—].*$/, "").trim());
  check("Thinking chip selects only Thinking",
    active.length === 1 && /Thinking/.test(active[0]),
    active.join(" | "));

  await clickChip("Gemini");
  active = (await activeChips()).map((t) => t.replace(/[✓✗—].*$/, "").trim());
  check("clicking Gemini clears Thinking (single-select)",
    active.length === 1 && /Gemini/.test(active[0]) && !active.some((t) => /Thinking/.test(t)),
    active.join(" | "));

  // ── 2. Bounce across every kind — exactly one active at each step ──────
  const sequence = ["Puter", "Ollama", "OmniRoute", "All", "Thinking", "Gemini"];
  let oneAtATime = true;
  const trace = [];
  for (const label of sequence) {
    await clickChip(label);
    const chips = await activeChips();
    trace.push(`${label}=>${chips.length}`);
    if (chips.length !== 1) oneAtATime = false;
    // The clicked chip must be the active one.
    const expected = label === "All" ? /All/ : new RegExp(label);
    if (!chips.some((t) => expected.test(t))) oneAtATime = false;
  }
  check("exactly one filter is active through the whole sequence", oneAtATime, trace.join(" "));

  // ── 3. Search must not create a second selection ──────────────────────
  await clickChip("Thinking");
  const search = page.locator(".modelSearchWrap input").first();
  if (await search.count()) {
    await search.fill("Claude");
    await page.waitForTimeout(250);
    const chips = await activeChips();
    check("searching does not change or duplicate the active filter",
      chips.length === 1 && /Thinking/.test(chips[0]),
      chips.join(" | "));
    await search.fill("");
    await page.waitForTimeout(150);
  } else {
    check("searching does not change or duplicate the active filter", true, "no search field");
  }

  // ── 4. Reopening the picker keeps a single, non-stale selection ────────
  await closePicker();
  await openPicker();
  await clickChip("Gemini");
  const afterReopen = await activeChips();
  check("reopened picker keeps a single active filter",
    afterReopen.length === 1 && /Gemini/.test(afterReopen[0]) && !afterReopen.some((t) => /Thinking/.test(t)),
    afterReopen.join(" | "));
  await closePicker();

  // ── 5. Thinking control is MAIN-only ─────────────────────────────────
  const goMode = async (label) => {
    const btn = page.locator(".modeToggleBtn", { hasText: new RegExp(`^${label}`) }).first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(400); }
  };

  await goMode("Main");
  const mainPill = await page.locator(".thinkingPill").count();

  await goMode("Chat");
  const chatPill = await page.locator(".thinkingPill").count();
  check("Chat composer shows no Thinking control", chatPill === 0, `${chatPill} pill(s)`);

  const chatActivity = await page.locator(".activityCodex").count();
  const chatThinkingBox = await page.locator(".thinkingBlock").count();
  check("Chat shows no agent activity panel", chatActivity === 0, `${chatActivity} panel(s)`);
  check("Chat shows no Thinking box", chatThinkingBox === 0, `${chatThinkingBox} box(es)`);

  // Going back to Main must restore the Main Thinking experience when the
  // selected model genuinely supports it.
  await goMode("Main");
  await page.waitForTimeout(300);
  const mainPillAgain = await page.locator(".thinkingPill").count();
  check("returning to Main preserves the Main Thinking control",
    mainPillAgain === mainPill,
    `main=${mainPill} mainAgain=${mainPillAgain}`);

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
