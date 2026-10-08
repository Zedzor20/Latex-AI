/**
 * In-app updates + What's New — real integration test against the PACKAGED app.
 *
 * Runs the actual `release/win-unpacked/Latex.exe` (so `app.isPackaged` is true,
 * i.e. the real auto-show path) inside an ISOLATED `--user-data-dir`. That is
 * important for two reasons:
 *   • the test never writes the developer's/user's real `lastSeenWhatsNewVersion`
 *     (so the first genuine launch still shows What's New exactly once), and
 *   • the profile can be re-launched with a hand-set seen-version to prove the
 *     "seen once, never again" and version-jump behaviour.
 *
 * What it verifies:
 *   1. current version is reported from the app, not hardcoded
 *   2. What's New opens automatically on the first launch of an unacknowledged version
 *   3. "Got it" persists the seen version and closes the modal
 *   4. a second launch of the SAME version does NOT re-open the modal
 *   5. a version jump (seen 1.0.0 → running 1.1.0) DOES re-open it
 *   6. Settings → Updates + What's New history render, latest highlighted
 *   7. the manual "Check for Updates" button runs against the REAL updater and
 *      reports the honest state (this build has no feed → unsupported/not-configured)
 *
 * The updater feed is intentionally unconfigured in this build, so "update
 * available / download / install" cannot be exercised here — the test asserts
 * the honest unsupported state instead of pretending an update exists.
 */
import { _electron as electron } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const EXE = join(ROOT, "release", "win-unpacked", "Latex.exe");
const SHOTS = join(ROOT, ".freebuff", "verify");
const PROFILE = resolve(join(ROOT, ".freebuff", "verify", "whatsnew-profile"));
const CONFIG = join(PROFILE, "config.json");

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npx electron-builder --win nsis" first.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function launch() {
  return electron.launch({
    executablePath: EXE,
    args: [
      `--user-data-dir=${PROFILE}`,
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows"
    ],
    timeout: 120_000
  });
}

async function boot() {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => Boolean(window.latex?.updates && window.latex?.whatsnew),
    null,
    { timeout: 30_000 }
  );
  return { app, page };
}

/** A visibility check that works for fixed-position backdrops too. */
const MODAL_VISIBLE = `(() => {
  const el = document.querySelector(".whatsNewModal");
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
})()`;

async function modalVisible(page) {
  return page.evaluate(MODAL_VISIBLE);
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: join(SHOTS, name), animations: "disabled", caret: "hide", timeout: 20_000 });
  } catch (err) {
    console.log(`  (screenshot ${name} skipped: ${err?.message?.split("\n")[0] ?? err})`);
  }
}

/** Force the isolated profile's seen-version to `version` (all scopes). */
function setSeenVersion(version) {
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  cfg.lastSeenWhatsNewVersion = version;
  if (cfg.accountScopes && typeof cfg.accountScopes === "object") {
    for (const key of Object.keys(cfg.accountScopes)) {
      const scope = cfg.accountScopes[key];
      if (scope && typeof scope === "object") scope.lastSeenWhatsNewVersion = version;
    }
  }
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

// ── Run 1: fresh profile → What's New must open ───────────────────────────────
rmSync(PROFILE, { recursive: true, force: true });
console.log("\n▶ Run 1 — fresh profile\n");
{
  const { app, page } = await boot();
  const state = await page.evaluate(() => window.latex.whatsnew.getState());
  check("currentVersion is reported", typeof state?.currentVersion === "string" && state.currentVersion.length > 0, state?.currentVersion);
  check("currentVersion matches the build", state?.currentVersion === "1.1.0", state?.currentVersion);
  check("fresh profile: shouldShow is true", state?.shouldShow === true, `lastSeen=${state?.lastSeen}`);
  check("fresh profile: only the installed release is unseen", JSON.stringify((state?.unseen ?? []).map((r) => r.version)) === JSON.stringify(["1.1.0"]), JSON.stringify(state?.unseen?.map((r) => r.version)));

  let visible = false;
  try {
    await page.waitForFunction(MODAL_VISIBLE, null, { timeout: 15_000 });
    visible = true;
  } catch { /* reported below */ }
  check("What's New opened automatically", visible, visible ? "modal visible" : "modal did not appear");

  if (visible) {
    const info = await page.evaluate(() => {
      const panel = document.querySelector(".whatsNewModal");
      return {
        title: panel?.querySelector(".whatsNewVersion")?.textContent ?? null,
        body: panel?.querySelector(".whatsNewBody")?.innerText ?? "",
        gotIt: Boolean(panel?.querySelector(".whatsNewFoot .btn.primary")),
        seeAll: Boolean(panel?.querySelector(".whatsNewFoot .btn.ghost"))
      };
    });
    check("modal shows the installed version", info.title === "Latex 1.1.0", info.title);
    check("modal shows release notes", info.body.trim().length > 0, `${info.body.trim().length} chars`);
    check("modal has a Got it button", info.gotIt, "");
    check("modal has a See-all-releases button", info.seeAll, "");
    await shot(page, "whatsnew-open.png");

    await page.evaluate(() => document.querySelector(".whatsNewModal .whatsNewFoot .btn.primary")?.click());
    await page.waitForFunction(() => !document.querySelector(".whatsNewModal"), null, { timeout: 8_000 }).catch(() => undefined);
    const after = await page.evaluate(() => window.latex.whatsnew.getState());
    check("modal closes after Got it", !(await modalVisible(page)), "");
    check("seen version persisted", after?.lastSeen === "1.1.0", `lastSeen=${after?.lastSeen}`);
    check("shouldShow is false after dismissal", after?.shouldShow === false, `shouldShow=${after?.shouldShow}`);
    await shot(page, "whatsnew-dismissed.png");
  }

  await app.close().catch(() => undefined);
}

// ── Run 2: same profile → must NOT re-open; Settings must render ──────────────
console.log("\n▶ Run 2 — same profile (already acknowledged)\n");
{
  const { app, page } = await boot();
  const state = await page.evaluate(() => window.latex.whatsnew.getState());
  check("second launch: shouldShow is false", state?.shouldShow === false, `lastSeen=${state?.lastSeen}`);
  check("second launch: seen version survived restart", state?.lastSeen === "1.1.0", state?.lastSeen);

  await page.waitForTimeout(2_500);
  check("second launch: modal does NOT re-open", !(await modalVisible(page)), "");

  // Settings → About / Updates / What's New
  await page.evaluate(() => document.querySelector('button[title="Settings"]')?.click());
  await page.waitForFunction(() => Boolean(document.querySelector(".settingsPage")), null, { timeout: 10_000 }).catch(() => undefined);
  // About is not the default page; select it from the settings nav.
  await page.evaluate(() => {
    const nav = Array.from(document.querySelectorAll(".settingsNav button, .settingsNav a"));
    const about = nav.find((el) => (el.textContent ?? "").trim().toLowerCase() === "about");
    if (about) about.click();
  });
  await page.waitForTimeout(700);

  const panel = await page.evaluate(() => {
    const settings = document.querySelector(".settingsPage");
    if (!settings) return { present: false };
    const text = settings.innerText;
    const statusRow = settings.querySelector(".updateStatusRow");
    return {
      present: true,
      versionShown: text.includes("Version 1.1.0"),
      hasUpdates: text.includes("Updates"),
      statusClass: statusRow?.className ?? null,
      statusText: statusRow?.innerText?.trim() ?? null,
      hasCheckButton: Array.from(settings.querySelectorAll("button")).some((b) => b.textContent?.includes("Check for Updates")),
      whatsNewEntries: settings.querySelectorAll(".releaseEntry").length,
      latestHighlighted: Boolean(settings.querySelector(".releaseEntry.latest")),
      latestHasBadge: Boolean(settings.querySelector(".releaseLatestBadge"))
    };
  });
  check("Settings page reachable", panel.present, "");
  check("Settings shows the current version", panel.versionShown, "");
  check("Settings has an Updates section", panel.hasUpdates, "");
  check("Settings has a Check for Updates button", panel.hasCheckButton, "");
  check("update status row is a real updater state", Boolean(panel.statusClass), `${panel.statusClass} · ${panel.statusText}`);
  check("unconfigured feed reported honestly", /unsupported|up-to-date|idle/.test(panel.statusClass ?? ""), panel.statusText);
  check("What's New history lists releases", panel.whatsNewEntries >= 2, `${panel.whatsNewEntries} entries`);
  check("latest release is highlighted", panel.latestHighlighted && panel.latestHasBadge, "");
  await shot(page, "settings-updates.png");

  // Manual check must run against the real updater and answer with a real state.
  const before = await page.evaluate(() => window.latex.updates.status());
  check("updates.status().currentVersion is real", typeof before?.currentVersion === "string" && before.currentVersion === "1.1.0", before?.currentVersion);
  check("feedConfigured reflects the build", before?.feedConfigured === false, `feedConfigured=${before?.feedConfigured}`);

  // Observe the REAL event stream: the click must produce a genuine
  // `checking` transition, then settle on an honest terminal state.
  await page.evaluate(() => {
    window.__updateStates = [];
    window.__offUpdates = window.latex.updates.onEvent((event) => window.__updateStates.push(event.status.state));
  });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".settingsPage button")).find((b) => b.textContent?.includes("Check for Updates"));
    btn?.click();
  });
  await page.waitForTimeout(2_000);
  const seen = await page.evaluate(() => { window.__offUpdates?.(); return window.__updateStates; });
  const after = await page.evaluate(() => window.latex.updates.status());
  check("clicking Check emits a real checking state", seen.includes("checking"), JSON.stringify(seen));
  check("check settles on a real terminal state", ["unsupported", "idle", "up-to-date"].includes(after?.state), `state=${after?.state} · ${JSON.stringify(seen)}`);
  check("check does not pretend an update exists", !seen.includes("available") && !seen.includes("downloading"), JSON.stringify(seen));
  await shot(page, "settings-check.png");

  await app.close().catch(() => undefined);
}

// ── Run 3: version jump — seen 1.0.0, running 1.1.0 → must open ───────────────
console.log("\n▶ Run 3 — version jump (seen 1.0.0 → running 1.1.0)\n");
{
  setSeenVersion("1.0.0");
  const { app, page } = await boot();
  const state = await page.evaluate(() => window.latex.whatsnew.getState());
  check("version jump: shouldShow is true", state?.shouldShow === true, `lastSeen=${state?.lastSeen}`);
  const unseen = (state?.unseen ?? []).map((r) => r.version);
  check("version jump: the new release is listed", unseen.includes("1.1.0"), JSON.stringify(unseen));
  check("version jump: the already-seen release is NOT re-listed", !unseen.includes("1.0.0"), JSON.stringify(unseen));
  let visible = false;
  try {
    await page.waitForFunction(MODAL_VISIBLE, null, { timeout: 15_000 });
    visible = true;
  } catch { /* reported below */ }
  check("version jump: What's New re-opened", visible, "");
  await shot(page, "whatsnew-jump.png");
  await app.close().catch(() => undefined);
}

rmSync(PROFILE, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log("\n" + "-".repeat(64));
console.log(`${results.length - failed.length}/${results.length} update / What's New checks passed`);
if (failed.length) console.log("failed:\n" + failed.map((f) => `  - ${f.name}`).join("\n"));
console.log("-".repeat(64));
process.exit(failed.length ? 1 : 0);
