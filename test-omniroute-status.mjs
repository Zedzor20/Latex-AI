/**
 * OmniRoute connection/authentication state machine — end-to-end against a real
 * (stub) HTTP gateway.
 *
 * The bug being guarded against: `/v1/models` returning 401/403 was treated as
 * "OmniRoute is offline", so a RUNNING gateway that simply wants a key (or
 * needs no key at all) made Latex show "Connect your OmniRoute API key to start
 * working."
 *
 * Every case below is a real HTTP exchange on 127.0.0.1 — no mocks.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const OUT = ".tmp-omniroute";
rmSync(OUT, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/main/omnirouteProvider.ts",
    "--outDir", OUT,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck",
    "--noEmitOnError", "false"
  ],
  { stdio: "inherit" }
);

const providerUrl = new URL(`file://${path.resolve(OUT, "main/omnirouteProvider.js")}`).href;
const { checkOmniRouteStatus, fetchOmniRouteModels, OmniRouteProvider } = await import(providerUrl);

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
function section(title) {
  console.log(`\n${title}`);
}

/** A configurable stand-in for OmniRoute. */
async function gateway(options = {}) {
  const {
    apiKey = "omni-secret",
    mode = "keyed",            // "keyed" | "anonymous" | "anyKey"
    apiHealth = "ok",          // "ok" | "missing" | "hang"
    healthz = "ok",            // "ok" | "missing" | "hang"
    monitoring = "ok",         // "ok" | "missing" | "hang"
    models = true
  } = options;
  const seen = [];
  // Serve a liveness route by its configured behaviour: ok (200), missing
  // (404) or hang (never respond — simulates the heavy monitoring endpoint
  // aggregating provider health past the timeout).
  const respondLiveness = (res, kind, body) => {
    if (kind === "hang") return;
    if (kind === "missing") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    seen.push({ url: req.url, method: req.method, auth });
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/api/health") {
      respondLiveness(res, apiHealth, { ok: true });
      return;
    }

    if (url.pathname === "/healthz") {
      respondLiveness(res, healthz, { ok: true });
      return;
    }

    if (url.pathname === "/api/monitoring/health") {
      respondLiveness(res, monitoring, { status: "ok", version: "stub" });
      return;
    }

    if (url.pathname === "/v1/models") {
      if (!models) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      const allowed = mode === "anonymous"
        || (mode === "anyKey" && Boolean(auth))
        || auth === `Bearer ${apiKey}`;
      if (!allowed) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "gpt-4o-mini" }, { id: "claude-sonnet" }, { id: "nvidia/nemotron-3-super" }]
      }));
      return;
    }

    if (url.pathname === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OMNIROUTE TEST OK" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a" } }] } }]
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ".txt\"}" } }] } }]
      })}\n\n`);
      // [DONE] must not truncate accumulated tool calls.
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Root serves a UI page — proves the process is alive without /v1.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>OmniRoute</html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => {
      // Destroy hung sockets so a "hang" route cannot block teardown.
      server.closeAllConnections?.();
      server.close(resolve);
    }),
    paths: () => seen.map((entry) => entry.url)
  };
}

/** A port with nothing listening on it, for the "not running" case. */
async function closedPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// ── 1. Server DOWN (connection refused) → offline, and nothing else ────────
section("1. Nothing listening → OFFLINE");
{
  const url = await closedPort();
  const status = await checkOmniRouteStatus(url);
  check("state is offline", status.state === "offline", status.state);
  check("running is false", status.running === false);
  check("not authenticated", status.authenticated === false);
  check("no model count", status.modelCount === 0);
  check("error names the endpoint", /not running/i.test(status.error ?? ""), status.error);
}

// ── 2. Keyless gateway → ONLINE, no key needed ─────────────────────────────
section("2. Gateway allows anonymous /v1 → ONLINE_NO_AUTH_REQUIRED (no key anywhere)");
{
  const gw = await gateway({ mode: "anonymous" });
  const status = await checkOmniRouteStatus(gw.url);
  check("state is online_no_auth_required", status.state === "online_no_auth_required", status.state);
  check("running true", status.running === true);
  check("authenticated true", status.authenticated === true);
  check("needsKey false", status.needsKey === false);
  check("models discovered", status.modelCount === 3, String(status.modelCount));
  check("no error", status.error === undefined, status.error);
  check("baseUrl echoed", status.baseUrl === gw.url, status.baseUrl);
  const models = await fetchOmniRouteModels(gw.url);
  check("model list usable without a key", models.length === 3, String(models.length));
  check("models carry omniroute provider", models.every((m) => m.provider === "omniroute"));
  await gw.close();
}

// ── 3. Key required, none saved → ONLINE + key required ────────────────────
section("3. Running gateway with auth enabled and no saved key → ONLINE_API_KEY_REQUIRED");
{
  const gw = await gateway({ mode: "keyed", apiKey: "omni-secret" });
  const status = await checkOmniRouteStatus(gw.url); // no key argument = nothing saved
  check("state is online_api_key_required", status.state === "online_api_key_required", status.state);
  check("SERVER is reported as running", status.running === true);
  check("authenticated false", status.authenticated === false);
  check("needsKey true", status.needsKey === true);
  check("hasKey false", status.hasKey === false);
  check("liveness probed /api/health (fast path)", gw.paths().includes("/api/health"), gw.paths().join(","));
  check("heavy monitoring route was NOT needed for liveness", !gw.paths().includes("/api/monitoring/health"), gw.paths().join(","));
  check("liveness endpoint reported", status.healthEndpoint === "/api/health", String(status.healthEndpoint));
  check("message says running + needs key", /running, but this instance requires an API key/i.test(status.error ?? ""), status.error);
  check("message does NOT say offline", !/offline|not running/i.test(status.error ?? ""), status.error);
  await gw.close();
}

// ── 4. Key required, saved key valid → ONLINE_AUTHENTICATED ────────────────
section("4. Running gateway + valid saved key → ONLINE_AUTHENTICATED");
{
  const gw = await gateway({ mode: "keyed", apiKey: "omni-secret" });
  const status = await checkOmniRouteStatus(gw.url, "omni-secret");
  check("state is online_authenticated", status.state === "online_authenticated", status.state);
  check("authenticated true", status.authenticated === true);
  check("hasKey true", status.hasKey === true);
  check("models discovered", status.modelCount === 3, String(status.modelCount));
  check("the key itself is never echoed back", !JSON.stringify(status).includes("omni-secret"), JSON.stringify(status));
  const models = await fetchOmniRouteModels(gw.url, "omni-secret");
  check("model discovery succeeds with the key", models.length === 3);
  await gw.close();
}

// ── 5. Key saved but rejected → AUTH_FAILED (still running) ────────────────
section("5. Running gateway + rejected saved key → AUTH_FAILED (never OFFLINE)");
{
  const gw = await gateway({ mode: "keyed", apiKey: "omni-secret" });
  const status = await checkOmniRouteStatus(gw.url, "stale-wrong-key");
  check("state is auth_failed", status.state === "auth_failed", status.state);
  check("SERVER still reported as running", status.running === true);
  check("needsKey true", status.needsKey === true);
  check("message says the key was rejected", /saved API key was rejected/i.test(status.error ?? ""), status.error);
  check("message does NOT say offline", !/offline|not running/i.test(status.error ?? ""), status.error);
  await gw.close();
}

// ── 6. Server ignores Authorization → a stale key must not block us ────────
section("6. Anonymous gateway + a stored key → still connects (no forced key prompt)");
{
  const gw = await gateway({ mode: "anonymous" });
  const status = await checkOmniRouteStatus(gw.url, "leftover-key");
  // The stored key was accepted (the gateway ignores it), so this is an
  // authenticated connection either way — crucially it is NOT auth_failed and
  // does NOT ask the user for a key.
  check("state is a usable online state",
    status.state === "online_authenticated" || status.state === "online_no_auth_required", status.state);
  check("authenticated true", status.authenticated === true);
  check("needsKey false", status.needsKey === false);
  check("no error shown", status.error === undefined, status.error);
  check("models discovered", status.modelCount === 3, String(status.modelCount));
  await gw.close();
}

// ── 7. Monitoring route missing but /api/health answers → still ONLINE ───────
section("7. Gateway without a monitoring route → still reported ONLINE (via /api/health)");
{
  const gw = await gateway({ mode: "anonymous", monitoring: "missing" });
  const status = await checkOmniRouteStatus(gw.url);
  check("state is online_no_auth_required", status.state === "online_no_auth_required", status.state);
  check("running true", status.running === true);
  check("did not touch the monitoring route", !gw.paths().includes("/api/monitoring/health"), gw.paths().join(","));
  await gw.close();
}

// ── 7b. Monitoring TIMES OUT but /api/health is fast → still ONLINE ─────────
section("7b. Monitoring endpoint hangs/times out → /api/health still proves ONLINE");
{
  const gw = await gateway({ mode: "anonymous", monitoring: "hang" });
  const status = await checkOmniRouteStatus(gw.url);
  check("state is online_no_auth_required", status.state === "online_no_auth_required", status.state);
  check("running true", status.running === true);
  check("never waited on the monitoring route", !gw.paths().includes("/api/monitoring/health"), gw.paths().join(","));
  check("message does NOT say offline", !/offline|not running/i.test(status.error ?? ""), status.error);
  await gw.close();
}

// ── 7c. /api/health missing but /healthz answers → ONLINE via fallback ──────
section("7c. /api/health absent → /healthz establishes ONLINE");
{
  const gw = await gateway({ mode: "anonymous", apiHealth: "missing", healthz: "ok" });
  const status = await checkOmniRouteStatus(gw.url);
  check("running true", status.running === true);
  check("fallback endpoint reported", status.healthEndpoint === "/healthz", String(status.healthEndpoint));
  await gw.close();
}

// ── 7d. Both fast routes missing → monitoring is the last-resort proof ──────
section("7d. /api/health and /healthz absent → /api/monitoring/health still proves ONLINE");
{
  const gw = await gateway({ mode: "anonymous", apiHealth: "missing", healthz: "missing", monitoring: "ok" });
  const status = await checkOmniRouteStatus(gw.url);
  check("running true", status.running === true);
  check("reports the monitoring endpoint that answered", status.healthEndpoint === "/api/monitoring/health", String(status.healthEndpoint));
  await gw.close();
}

// ── 8. Base URL saved WITH /v1 → health must be probed at the origin ───────
section("8. Base URL http://…:PORT/v1 → /v1/models used, health probed at origin");
{
  const gw = await gateway({ mode: "keyed", apiKey: "k" });
  const status = await checkOmniRouteStatus(`${gw.url}/v1`, "k");
  check("state is online_authenticated", status.state === "online_authenticated", status.state);
  const paths = gw.paths();
  check("models requested at /v1/models (no double /v1)", paths.includes("/v1/models"), paths.join(","));
  check("liveness requested at /api/health (not /v1/api/…)", paths.includes("/api/health"), paths.join(","));
  check("no malformed /v1/api path", !paths.some((p) => p.startsWith("/v1/api")), paths.join(","));
  await gw.close();
}

// ── 9. HTTP error from /v1/models → running, but unknown ───────────────────
section("9. /v1/models fails with 500 → running, unknown_error (not offline)");
{
  const gw = await gateway({ models: false });
  const status = await checkOmniRouteStatus(gw.url);
  check("state is unknown_error", status.state === "unknown_error", status.state);
  check("running true", status.running === true);
  check("mentions HTTP 500", /500/.test(status.error ?? ""), status.error);
  await gw.close();
}

// ── 10. Wrong path on a live server → 404 explained, not "offline" ─────────
section("10. A live server that has no /v1 API on that path → unknown_error, not offline");
{
  // Only the root exists; /v1/models 404s.
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/monitoring/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no such route" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = await checkOmniRouteStatus(url);
  check("running true", status.running === true);
  check("state is unknown_error", status.state === "unknown_error", status.state);
  check("error explains the 404", /404/.test(status.error ?? ""), status.error);
  await new Promise((resolve) => server.close(resolve));
}

// ── 11. Real chat completion through the configured authentication ─────────
section("11. /v1/chat/completions streams with the saved key");
{
  const gw = await gateway({ mode: "keyed", apiKey: "omni-secret" });
  const provider = new OmniRouteProvider(gw.url, "omni-secret");
  await provider.testConnection(); // server up + key accepted
  const chunks = [];
  for await (const chunk of provider.generate({
    model: "omniroute/gpt-4o-mini",
    system: "You are Latex.",
    messages: [{ role: "user", parts: [{ text: "Reply with exactly: OMNIROUTE TEST OK" }] }],
    temperature: 0.2,
    maxOutputTokens: 64
  })) {
    chunks.push(chunk);
  }
  const text = chunks.filter((c) => c.type === "text").map((c) => c.text).join("");
  check("streamed the model response", text.includes("OMNIROUTE TEST OK"), JSON.stringify(text));
  const calls = chunks.filter((c) => c.type === "functionCall");
  check("native tool call survived [DONE]", calls.length === 1, JSON.stringify(chunks));
  check("tool call arguments were assembled", calls[0]?.args?.path === "a.txt", JSON.stringify(calls[0]));
  const completion = gw.seen.find((entry) => entry.url === "/v1/chat/completions");
  check("Authorization header sent on the completion", completion?.auth === "Bearer omni-secret", String(completion?.auth));
  await gw.close();
}

// ── 12. testConnection surfaces the right error per state ─────────────────
section("12. testConnection messages distinguish the states");
{
  const offline = await closedPort();
  const offlineProvider = new OmniRouteProvider(offline, undefined);
  const offlineErr = await offlineProvider.testConnection().then(() => null, (err) => err);
  check("offline → error", Boolean(offlineErr));
  check("offline message says not running", /not running/i.test(offlineErr?.message ?? ""), offlineErr?.message);

  const gw = await gateway({ mode: "keyed", apiKey: "right" });
  const needsKey = await new OmniRouteProvider(gw.url, undefined).testConnection().then(() => null, (err) => err);
  check("needs key → error", Boolean(needsKey));
  check("needs-key message mentions the key, not offline",
    /requires an API key/i.test(needsKey?.message ?? "") && !/not running/i.test(needsKey?.message ?? ""),
    needsKey?.message);

  const rejected = await new OmniRouteProvider(gw.url, "wrong").testConnection().then(() => null, (err) => err);
  check("rejected key → error", Boolean(rejected));
  check("rejected message says the key was rejected",
    /rejected/i.test(rejected?.message ?? ""), rejected?.message);

  const good = await new OmniRouteProvider(gw.url, "right").testConnection().then(() => "ok", (err) => err.message);
  check("valid key → connection succeeds", good === "ok", good);

  const anon = await gateway({ mode: "anonymous" });
  const keyless = await new OmniRouteProvider(anon.url, undefined).testConnection().then(() => "ok", (err) => err.message);
  check("keyless gateway → connection succeeds without a key", keyless === "ok", keyless);
  await gw.close();
  await anon.close();
}

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
