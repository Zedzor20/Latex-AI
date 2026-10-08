import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import type { GeminiModel, OllamaStatus } from "../shared/types.js";
import { thinkingCapability } from "../shared/modelCapabilities.js";

/**
 * Ollama service — talks to the local Ollama server over its HTTP API
 * (http://localhost:11434).
 *
 * Architecture:
 *   Latex → HTTP API → localhost:11434 → selected model
 *
 * Latex NEVER launches the Ollama Desktop GUI.
 * For development/testing, Latex opens a visible CMD window running:
 *   ollama serve
 */

export const OLLAMA_DEFAULT_BASE = "http://localhost:11434";
const VERSION_TIMEOUT_MS = 3000;
const TAGS_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 700;

/**
 * ── WHY THE CLI LOOKUP IS CACHED ─────────────────────────────────────────────
 * `checkOllamaStatus()` asks for this path whenever the server does not answer,
 * which is the normal state on a machine that has no Ollama server running.
 * The lookup ends in `execFileSync("where", ["ollama"])` — a SYNCHRONOUS child
 * process that blocks the Electron main thread (and therefore every IPC reply,
 * every window resize and the renderer's next paint) until `where.exe` exits.
 *
 * Latex polls Ollama every 15 seconds, so a machine without Ollama running was
 * spawning `where.exe` over and over, forever: a recurring stall of tens to
 * hundreds of milliseconds that had nothing to do with what the user was doing.
 *
 * The resolved path is a static fact about the machine, so it is remembered.
 * A positive result is kept for the life of the process; a negative result is
 * rechecked after `OLLAMA_CLI_MISS_TTL_MS` so that installing Ollama while
 * Latex is open is still picked up within a minute — without paying for a child
 * process on every poll in the meantime.
 */
const OLLAMA_CLI_MISS_TTL_MS = 60_000;
let cliLookup: { at: number; path: string | undefined } | null = null;

function findOllamaCliUncached(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  const home = os.homedir();
  const candidates = [
    path.join(localAppData ?? "", "Programs", "Ollama", "ollama.exe"),
    path.join(home, "AppData", "Local", "Programs", "Ollama", "ollama.exe"),
    "C:\\Program Files\\Ollama\\ollama.exe",
    "C:\\Program Files (x86)\\Ollama\\ollama.exe"
  ];
  const found = candidates.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  });
  if (found) {
    console.log(`[OLLAMA] CLI found at: ${found}`);
    return found;
  }
  // Fallback: check if `ollama` is on the system PATH
  try {
    const pathResult = execFileSync("where", ["ollama"], { encoding: "utf8", timeout: 3000 });
    const cliPath = pathResult.trim().split("\n")[0];
    if (cliPath && fs.existsSync(cliPath)) {
      console.log(`[OLLAMA] CLI found on PATH: ${cliPath}`);
      return cliPath;
    }
  } catch {
    // `where ollama` failed — not on PATH
  }
  console.log("[OLLAMA] CLI not found.");
  return undefined;
}

/**
 * Cached `findOllamaCli`. Never spawns a child process more than once per
 * minute, and never at all while a previously found path is still valid.
 */
function findOllamaCli(): string | undefined {
  const now = Date.now();
  if (cliLookup) {
    // Found once → keep it: an installed CLI does not move during a session.
    if (cliLookup.path) return cliLookup.path;
    if (now - cliLookup.at < OLLAMA_CLI_MISS_TTL_MS) return undefined;
  }
  const found = findOllamaCliUncached();
  if (found) console.log(`[OLLAMA] CLI cached at: ${found}`);
  cliLookup = { at: now, path: found };
  return found;
}

/**
 * Ensure the Ollama server is running. Does NOT launch the Desktop app.
 *
 * Flow:
 *   1. Check http://localhost:11434 — if reachable, reuse it.
 *   2. If startup is already in progress, wait for the same Promise.
 *   3. Otherwise, open a visible CMD window running: `ollama serve`
 *   4. Poll until the server responds.
 *
 * Multiple callers share the same Promise so only ONE server is started.
 */
let serveProcess: import("node:child_process").ChildProcess | null = null;
let startupPromise: Promise<{ ok: boolean; error?: string }> | null = null;

export async function ensureOllamaServer(baseUrl: string = OLLAMA_DEFAULT_BASE): Promise<{ ok: boolean; error?: string }> {
  // 1. Check if server is already running
  console.log("[OLLAMA] Checking for existing server...");
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    if (res.ok) {
      console.log("[OLLAMA] Existing server detected — reusing it.");
      return { ok: true };
    }
  } catch {
    // not running
  }

  // 2. If startup is already in progress, wait for it
  if (startupPromise) {
    console.log("[OLLAMA] Startup already in progress — waiting.");
    return startupPromise;
  }

  // 3. Start a new server via visible CMD
  startupPromise = (async () => {
    // Explicit user action: re-resolve the CLI for real, so someone who just
    // installed Ollama does not have to wait out the negative-cache TTL. One
    // synchronous lookup here is fine — the user is waiting for this by choice.
    cliLookup = null;
    const cliPath = findOllamaCli();
    if (!cliPath) {
      const msg = "Ollama CLI was not found. Please install Ollama and make sure `ollama` is available.";
      console.log(`[OLLAMA] ${msg}`);
      return { ok: false, error: msg };
    }

    console.log("[OLLAMA] No server detected. Starting visible CMD...");
    console.log("[OLLAMA] Command: ollama serve");

    try {
      // Open a visible CMD window running `ollama serve`
      // windowsHide: false ensures the CMD window is visible for dev/testing
      serveProcess = spawn(
        "cmd.exe",
        ["/d", "/s", "/c", "ollama serve"],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false, // VISIBLE CMD WINDOW
          env: { ...process.env }
        }
      );

      serveProcess.on("error", (err) => {
        console.error(`[OLLAMA] Server process error: ${err.message}`);
        serveProcess = null;
      });

      serveProcess.on("exit", (code) => {
        console.log(`[OLLAMA] Server process exited with code ${code}`);
        serveProcess = null;
      });

      serveProcess.unref();
      console.log(`[OLLAMA] CMD window opened (PID: ${serveProcess.pid})`);
      console.log("[OLLAMA] Waiting for server to become ready...");

      // 4. Poll until server responds
      const ready = await waitForOllama(baseUrl, 30_000);
      if (ready) {
        console.log("[OLLAMA] Server ready at " + baseUrl);
        return { ok: true };
      }

      return { ok: false, error: "Ollama server could not be started. Check the CMD window for errors." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start Ollama.";
      console.error(`[OLLAMA] Failed to start server: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      startupPromise = null;
    }
  })();

  return startupPromise;
}

/** Detect whether the Ollama CLI is installed on this machine. */
export function findOllamaApp(): string | undefined {
  return findOllamaCli();
}

/**
 * Start the Ollama server. Does NOT launch the Desktop app.
 * Opens a visible CMD window running `ollama serve`.
 */
export async function openOllamaApp(): Promise<{ ok: boolean; error?: string }> {
  return ensureOllamaServer();
}

/** Poll the server until it responds (used after launching the server). */
export async function waitForOllama(
  baseUrl: string = OLLAMA_DEFAULT_BASE,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
      if (res.ok) {
        console.log("[OLLAMA] Server responded.");
        return true;
      }
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(`[OLLAMA] Server did not respond within ${timeoutMs}ms.`);
  return false;
}

/**
 * Check whether a specific model is available in the running Ollama server.
 * Returns the model name if found, or null if not installed.
 */
export async function checkModelAvailable(
  modelName: string,
  baseUrl: string = OLLAMA_DEFAULT_BASE
): Promise<{ available: boolean; model?: string; error?: string }> {
  // Strip provider prefix if present
  const cleanName = modelName.replace(/^ollama\//, "");
  try {
    const models = await fetchOllamaModels(baseUrl);
    const found = models.find((m) => m.model.name === cleanName);
    if (found) {
      console.log(`[OLLAMA] Model found: ${cleanName}`);
      return { available: true, model: cleanName };
    }
    // Check partial matches (e.g. user selects "deepseek-r1" but installed is "deepseek-r1:latest")
    const partial = models.find((m) => m.model.name.startsWith(cleanName + ":"));
    if (partial) {
      console.log(`[OLLAMA] Model found (partial): ${partial.model.name}`);
      return { available: true, model: partial.model.name };
    }
    console.log(`[OLLAMA] Model not found: ${cleanName}`);
    return { available: false, error: `Model \`${cleanName}\` is not installed in Ollama.` };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : "Could not check model availability." };
  }
}

/** Raw entry returned by GET /api/tags. */
interface OllamaTagEntry {
  name: string;
  model?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
    family?: string;
    families?: string[];
  };
  capabilities?: string[];
  size?: number;
  [key: string]: unknown;
}

/** True when the tag refers to an Ollama Cloud model (e.g. qwen3-coder:480b-cloud). */
export function isCloudModel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("-cloud") || lower.includes(":cloud") || /cloud/i.test(lower);
}

/**
 * Infer capabilities from a model name when Ollama does not report them.
 * Used only as a fallback for servers that omit `capabilities`.
 */
export function inferOllamaCapabilities(name: string): { supportsTools: boolean; supportsVision: boolean; supportsReasoning: boolean } {
  const lower = name.toLowerCase();
  const supportsVision = /vision|llava|bakllava|moondream|minicpm|qwen2\.5?-?vl|qwen2-vl|gemma3|llama3\.2-vision|llama3\.3|granite3\.2-vision|phi-?3\.5?-?vision|x-?lam|-vl\b|understand.*image/.test(lower);
  // Known tool-capable families; everything else is assumed chat-capable but
  // we stay conservative and require a chat/instruction indicator.
  const knownToolCapable = /qwen|llama3|llama-?3|mistral|codestral|gemma|phi|deepseek|glm|command-?r|granite|nemotron|yi|internlm|gpt-oss|olmo/.test(lower);
  const chatIndicator = /chat|instruct|coder|code|assistant|agent|thinking|reason/.test(lower) || /\d+(\.\d+)?b/.test(lower);
  const excluded = /embedding|nomic-embed|all-minilm|snowflake|bge-|clip|whisper|tts|image-gen|stable-diffusion/.test(lower);
  const supportsTools = !excluded && knownToolCapable && chatIndicator;
  // Thinking capability comes from the shared, provider-aware layer so the
  // model list, the picker filter and the adapters can never disagree.
  const supportsReasoning = thinkingCapability("ollama", name).supportsThinking;
  return { supportsTools, supportsVision, supportsReasoning };
}

/** A discovered Ollama model with normalized Latex metadata. */
export interface OllamaDiscoveredModel {
  model: GeminiModel;
  cloud: boolean;
}

/** Fetch and normalize the model list from the local Ollama server. */
export async function fetchOllamaModels(baseUrl: string = OLLAMA_DEFAULT_BASE): Promise<OllamaDiscoveredModel[]> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Ollama model discovery failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { models?: OllamaTagEntry[] };
  const out: OllamaDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of data.models ?? []) {
    const name = String(entry.name ?? entry.model ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const cloud = isCloudModel(name);
    const rawCaps = Array.isArray(entry.capabilities) ? entry.capabilities.map(String) : [];
    const capsLower = rawCaps.join(" ").toLowerCase();
    const inferred = inferOllamaCapabilities(name);
    const supportsTools = capsLower.includes("tools") ? true : inferred.supportsTools;
    const supportsVision = capsLower.includes("vision") ? true : inferred.supportsVision;
    const supportsReasoning = capsLower.includes("reasoning") ? true : inferred.supportsReasoning;
    const supportsCompletion = capsLower.includes("completion") || capsLower.length === 0;
    if (!supportsCompletion) continue;
    const capabilities: string[] = ["ollama"];
    if (cloud) capabilities.push("cloud");
    else capabilities.push("local");
    if (supportsTools) capabilities.push("tool-calling");
    if (supportsVision) capabilities.push("vision");
    if (supportsReasoning) capabilities.push("reasoning");
    const contextLength = typeof entry.details?.context_length === "number" ? entry.details.context_length : undefined;
    const paramSize = entry.details?.parameter_size;
    const model: GeminiModel = {
      name,
      provider: "ollama",
      displayName: displayNameFor(name, cloud),
      description: `${cloud ? "Ollama Cloud model" : "Ollama local model"}${paramSize ? ` — ${paramSize}` : ""}${contextLength ? ` — ${contextLength.toLocaleString()} token context` : ""}`,
      contextLength,
      supportsTools,
      supportsVision,
      supportsReasoning,
      supportsStreaming: true,
      isFree: !cloud,
      capabilities
    };
    out.push({ model, cloud });
  }
  out.sort((a, b) => {
    if (a.cloud !== b.cloud) return a.cloud ? 1 : -1;
    return a.model.name.localeCompare(b.model.name);
  });
  return out;
}

/** Human-friendly display name for an Ollama model tag. */
function displayNameFor(name: string, cloud: boolean): string {
  const base = name.split(":")[0] ?? name;
  return `${base}${cloud ? " (Cloud)" : ""}`;
}

/**
 * Single status check against the local Ollama server. Never throws — returns
 * a friendly state object suitable for the UI.
 */
export async function checkOllamaStatus(baseUrl: string = OLLAMA_DEFAULT_BASE): Promise<OllamaStatus> {
  const started = Date.now();
  // Version probe — if the server is down we classify as not installed vs not running.
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
  } catch {
    // Server unreachable — determine whether Ollama is at least installed.
    const appPath = findOllamaApp();
    const state = appPath ? "not_running" : "not_installed";
    console.log(`[OLLAMA] Status check: ${state}${appPath ? ` (CLI at: ${appPath})` : ""}`);
    return {
      state,
      appPath,
      error: appPath
        ? "Ollama isn't running. Latex can start it automatically."
        : "Ollama is not installed. Download it from https://ollama.com",
      checkedAt: Date.now()
    };
  }
  if (!res.ok) {
    return {
      state: "error",
      error: `Ollama server responded with HTTP ${res.status}.`,
      checkedAt: Date.now()
    };
  }
  let version = "";
  try {
    const data = (await res.json()) as { version?: string };
    version = String(data.version ?? "");
  } catch {
    // version body unreadable — still connected
  }
  // Model counts (best-effort — failure here should not flip us to "error").
  let localModelCount = 0;
  let cloudModelCount = 0;
  let cloudAvailable = false;
  try {
    const models = await fetchOllamaModels(baseUrl);
    for (const m of models) {
      if (m.cloud) cloudModelCount++;
      else localModelCount++;
    }
    cloudAvailable = cloudModelCount > 0;
  } catch {
    // keep counts at 0
  }
  return {
    state: "connected",
    version,
    localModelCount,
    cloudModelCount,
    cloudAvailable,
    appPath: findOllamaApp(),
    checkedAt: Date.now() > started ? Date.now() : started
  };
}