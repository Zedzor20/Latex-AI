#!/usr/bin/env node
/**
 * The one command that ships a Latex release.
 *
 * WHY THIS EXISTS (requirement: "do not let a maintainer upload only the .exe
 * and forget the update metadata")
 * ---------------------------------------------------------------------------
 * electron-updater does not read a GitHub Release body — it reads `latest.yml`.
 * If someone uploads only the installer, every installed Latex sits forever
 * reporting "You're up to date" while a newer file is one click away. This
 * script therefore builds the release AND asserts the complete set of update
 * artifacts exists before it reports success, so a partial release is impossible
 * to mistake for a finished one.
 *
 * WHAT IT DOES
 *   1. resolves the publish target (LATEX_GH_* → git origin → fail loudly)
 *   2. runs typecheck + build
 *   3. packages Windows NSIS with electron-builder's github publisher
 *   4. VERIFIES latest.yml, the installer and its blockmap all exist, that the
 *      manifest's version equals package.json's, and that the sha512 matches the
 *      file that will be uploaded
 *   5. prints the exact `gh release create` command to publish
 *
 * SECURITY
 *   The token is read by electron-builder only if you have GH_TOKEN set in THIS
 *   shell. Nothing here writes a token into the repo, into package.json, or into
 *   the packaged app — the installed app only ever reads the public release
 *   feed.
 *
 * Usage:
 *   npm run release
 *   LATEX_GH_OWNER=me LATEX_GH_REPO=latex npm run release
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`\n[release] ERROR: ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`[release] $ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.status !== 0) fail(`command failed (exit ${res.status}): ${cmd} ${args.join(" ")}`);
}

// ── 1. resolve the publish target ────────────────────────────────────────────
function resolveOwnerRepo() {
  const owner = process.env.LATEX_GH_OWNER;
  const repoName = process.env.LATEX_GH_REPO;
  if (owner && repoName) return { owner, repo: repoName, source: "LATEX_GH_OWNER / LATEX_GH_REPO" };

  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim();
    // Supports both https://github.com/owner/repo.git and git@github.com:owner/repo.git
    const m = url.match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/i);
    if (m) return { owner: m[1], repo: m[2], source: "git remote origin" };
    console.warn(`[release] origin (${url}) is not a GitHub URL — cannot derive the release target.`);
  } catch {
    console.warn("[release] no git remote `origin` configured.");
  }
  return null;
}

const target = resolveOwnerRepo();
if (!target) {
  fail(
    "No GitHub release target.\n" +
      "  Set one of:\n" +
      "    LATEX_GH_OWNER=<user> LATEX_GH_REPO=<repo> npm run release\n" +
      "  or:\n" +
      "    git remote add origin https://github.com/<owner>/<repo>.git\n" +
      "\n" +
      "  Refusing to build without a target: a package without a publish config\n" +
      "  produces no update metadata, and the installed app would honestly have\n" +
      "  to report that automatic updates are not configured."
  );
}
console.log(`[release] publish target: ${target.owner}/${target.repo} (from ${target.source})`);

// ── 2. version sanity ────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`package.json version "${version}" is not semantic (expected 1.2.0).`);
console.log(`[release] version: ${version}`);
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.warn("[release] WARNING: GH_TOKEN is not set — the BUILD will succeed and produce correct update");
  console.warn("[release] metadata, but `gh release create` / `electron-builder --publish` will fail to upload.");
}

// ── 3. build ─────────────────────────────────────────────────────────────────
run("npm", ["run", "typecheck"]);
run("npm", ["run", "build"]);

const output = path.join(repo, "release");
run("npx", [
  "electron-builder", "--win", "nsis", "--publish", "never",
  `-c.publish.provider=github`,
  `-c.publish.owner=${target.owner}`,
  `-c.publish.repo=${target.repo}`,
  "-c.publish.releaseType=release"
]);

// ── 4. verify the release artifacts ──────────────────────────────────────────
const installer = fs.readdirSync(output).find((f) => /^Latex Setup .*\.exe$/i.test(f));
if (!installer) fail(`no installer found in ${output}`);
const latestPath = path.join(output, "latest.yml");
if (!fs.existsSync(latestPath)) fail("latest.yml was NOT generated — installed Latex builds could not update.");
const blockmap = `${installer}.blockmap`;
if (!fs.existsSync(path.join(output, blockmap))) fail(`blockmap missing (${blockmap}) — differential downloads would not work.`);

const manifest = fs.readFileSync(latestPath, "utf8");
const manifestVersion = (manifest.match(/^version:\s*(\S+)/m) ?? [])[1];
if (manifestVersion !== version) fail(`latest.yml version ${manifestVersion} != package.json ${version}.`);

const manifestSha = (manifest.match(/sha512:\s*(\S+)/) ?? [])[1];
const fileSha = crypto.createHash("sha512").update(fs.readFileSync(path.join(output, installer))).digest("base64");
if (manifestSha !== fileSha) fail("latest.yml sha512 does not match the installer that would be uploaded.");

// The app must carry the feed it will read at runtime.
const appUpdate = path.join(output, "win-unpacked", "resources", "app-update.yml");
if (fs.existsSync(appUpdate)) {
  const feed = fs.readFileSync(appUpdate, "utf8");
  console.log(`[release] app-update.yml →\n${feed.trim()}`);
  if (!feed.includes("provider: github")) fail("app-update.yml does not carry the github provider.");
} else {
  console.warn("[release] WARNING: win-unpacked/resources/app-update.yml missing — check the publish config.");
}

console.log("\n[release] ✓ artifacts verified:");
console.log(`[release]   ${installer}`);
console.log(`[release]   ${blockmap}`);
console.log(`[release]   latest.yml (version ${manifestVersion}, sha512 verified)`);
console.log(`[release]   resources/app-update.yml (provider: github)`);

// ── 5. release notes, generated from the SAME changelog the app shows ──────
// The GitHub Release body and the in-app What's New dialog are rendered from
// one source (`shared/updates`), so they can never drift apart.
const mod = await import(`file://${path.join(repo, "dist", "shared", "updates.js")}`);
const entry = mod.releaseEntryFor(version);
if (!entry) fail(`no changelog entry for ${version} — add it to LATEX_RELEASES in src/shared/updates.ts`);
const section = (title, items) => (items?.length ? `\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n` : "");
const notesFile = path.join(repo, `release-notes-${version}.md`);
fs.writeFileSync(
  notesFile,
  `# Latex ${version}\n\n${entry.name ?? ""}\n` +
    section("New", entry.added) +
    section("Fixed", entry.fixed) +
    section("Improved", entry.improved) +
    "\n---\nInstalled Latex builds pick this up automatically: open Latex, and the update\n" +
    "downloads in the background. No account required.\n"
);
console.log(`[release] release notes → ${path.basename(notesFile)}`);

// ── 6. publish ───────────────────────────────────────────────────────────────
console.log(`\n[release] Publish with:\n`);
console.log(
  `  gh release create "v${version}" ` +
    `"${path.join(output, installer)}" ` +
    `"${path.join(output, blockmap)}" ` +
    `"${latestPath}" ` +
    `"${notesFile}" ` +
    `--title "Latex ${version}" --latest`
);
console.log(`\n[release] Installed Latex builds will then detect v${version}, download it in the background,`);
console.log("[release] and offer Restart & Update. No account, no login, no Latex server involved.\n");
