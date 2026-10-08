/**
 * Real acceptance test for the Latex response/rendering pipeline.
 *
 * Run with:  node test-acceptance-electron.mjs
 *
 * Launches the PACKAGED application, creates a small real project, then runs
 * two actual Main Agent coding tasks against a real model:
 *
 *   Task 1 (files)   — read and fix an HTML/CSS project, then verify it.
 *   Task 2 (command) — run `node --version` and report the version.
 *
 * It then checks that the three channels never cross:
 *
 *   ACTIVITY           thinking, planning, commands, file work, verification
 *   ASSISTANT RESPONSE normal prose, markdown, intentional small code examples
 *   INTERNAL DATA      tool arguments, file contents, raw protocol (never shown)
 *
 * The app must be closed first. The model the user had selected is restored
 * afterwards, and the test conversations are deleted.
 */
import { _electron as electron } from "playwright";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
const PROJECT_DIR = join(process.cwd(), ".tmp-acceptance", "site");

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

// ── A small but real project for the agent to fix ────────────────────────
rmSync(join(process.cwd(), ".tmp-acceptance"), { recursive: true, force: true });
mkdirSync(PROJECT_DIR, { recursive: true });

writeFileSync(
  join(PROJECT_DIR, "index.html"),
  `<!DOCTYPE html>
<html>
<head>
  <title>Island</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header><h1>AI Civilization Island</h1></header>
  <main>
    <section class="controls">
      <label>Speed</label>
      <select id="speed"><option>slow</option><option>fast</option></select>
    <p>Canvas below.</p>
    <canvas id="stage" width="640" height="360"></canvas>
  </main>
</body>
</html>
`
);
writeFileSync(
  join(PROJECT_DIR, "style.css"),
  `body { margin: 0; font-family: sans-serif; }\n.controls { display: flex; gap: 8px; }\n`
);

const FILE_PROMPT =
  "This is a small HTML/CSS project. Please fix the malformed HTML structure in index.html " +
  "(there is an unclosed section) and tidy the controls markup in style.css if needed. " +
  "Verify the project after your changes, then explain what you changed.";

const COMMAND_PROMPT =
  "Use the run_command tool to run exactly `node --version` in this project, " +
  "then tell me in one sentence which Node version is installed.";

const CONV_IDS = ["conv_acceptance_1", "conv_acceptance_2"];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function skip(name, why) {
  console.log(`SKIP  ${name}${why ? `  — ${why}` : ""}`);
}

const app = await electron.launch({ executablePath: EXE, args: [], timeout: 120_000 });
let modelInfo = null;
let report = null;

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });

  // ── Pick a model that actually answers ────────────────────────────────
  // Nothing is assumed: each candidate is probed with a one-line chat run and
  // the first that responds is used.
  console.log("Probing models for a working provider...");
  modelInfo = await page.evaluate(async () => {
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const byProvider = {};
    for (const m of models) byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1;

    const preferredNames = [
      "models/gemini-flash-lite-latest",
      "models/gemini-2.5-flash-lite",
      "models/gemini-3-flash-preview",
      "models/gemini-3.1-flash-lite",
      "models/gemini-flash-latest",
      "groq/openai/gpt-oss-120b",
      "groq/openai/gpt-oss-20b",
      "groq/qwen/qwen3.8-27b",
      "puter/openrouter:anthropic/claude-haiku-4.5",
      "puter/openrouter:openai/gpt-4o-mini",
      "puter/openrouter:openai/gpt-4.1-mini"
    ];
    const ordered = [];
    for (const name of preferredNames) {
      const hit = models.find((m) => m.name === name);
      if (hit) ordered.push(hit);
    }
    for (const m of models) {
      if ((m.provider === "gemini" || m.provider === "groq" || m.provider === "puter") && !ordered.some((o) => o.name === m.name)) {
        ordered.push(m);
      }
    }

    const attempts = [];
    const probe = async (modelName) => {
      await window.latex.settings.save({ selectedModel: modelName });
      const now = Date.now();
      const conversation = {
        id: `probe_${now}`,
        title: "probe",
        mode: "chat",
        messages: [{ id: `p_${now}`, role: "user", content: "Reply with exactly the word READY and nothing else.", createdAt: now }],
        createdAt: now,
        updatedAt: now
      };
      try {
        const next = await window.latex.agent.chat(conversation);
        const last = next.messages[next.messages.length - 1];
        const text = String(last?.content ?? "").trim();
        void window.latex.conversation.delete(conversation.id).catch(() => undefined);
        return { ok: text.length > 0, sample: text.slice(0, 40) };
      } catch (err) {
        void window.latex.conversation.delete(conversation.id).catch(() => undefined);
        return { ok: false, error: String(err?.message ?? err).slice(0, 120) };
      }
    };

    let chosen = null;
    for (const candidate of ordered.slice(0, 10)) {
      const result = await probe(candidate.name);
      attempts.push({ name: candidate.name, ...result });
      if (result.ok) { chosen = { name: candidate.name, provider: candidate.provider }; break; }
    }
    if (chosen) await window.latex.settings.save({ selectedModel: chosen.name });
    return { previousModel: before.selectedModel ?? null, chosen, attempts, providers: byProvider };
  });

  console.log(`Models available by provider: ${JSON.stringify(modelInfo.providers)}`);
  for (const attempt of modelInfo.attempts) {
    console.log(`  probe ${attempt.ok ? "OK  " : "FAIL"} ${attempt.name}${attempt.error ? ` — ${attempt.error}` : attempt.sample ? ` — "${attempt.sample}"` : ""}`);
  }
  if (!modelInfo.chosen) {
    check("a usable model is configured", false, "no model responded to a probe");
    throw new Error("No usable model — cannot run the acceptance task.");
  }
  console.log(`\nUsing model: ${modelInfo.chosen.name}\n`);

  // ── Run both real tasks ───────────────────────────────────────────────
  console.log("Running real Main Agent tasks...\n");
  const startedAt = Date.now();
  const outcome = await page.evaluate(
    async ({ wsPath, prompts, convIds }) => {
      const events = [];
      // Auto-approve permission prompts so the run is unattended. This uses the
      // same IPC the permission UI drives — approvals are not bypassed.
      const unsubscribe = window.latex.agent.onEvent((event) => {
        events.push(event);
        if (event?.type === "approval" && event.payload?.requestId) {
          void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
        }
      });

      const workspace = { id: "ws_acceptance", name: "site", path: wsPath, trusted: true, lastOpenedAt: Date.now() };
      const runTask = async (prompt, conversationId) => {
        const now = Date.now();
        const conversation = {
          id: conversationId,
          title: "Acceptance test",
          mode: "main",
          messages: [{ id: `m_${conversationId}`, role: "user", content: prompt, createdAt: now }],
          createdAt: now,
          updatedAt: now
        };
        try {
          const next = await window.latex.agent.run(conversation, workspace);
          return { error: null, next };
        } catch (err) {
          return { error: String(err?.message ?? err), next: null };
        }
      };

      const runs = [
        await runTask(prompts.file, convIds[0]),
        await runTask(prompts.command, convIds[1])
      ];
      unsubscribe();
      return { events, runs };
    },
    { wsPath: PROJECT_DIR, prompts: { file: FILE_PROMPT, command: COMMAND_PROMPT }, convIds: CONV_IDS }
  );
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Both tasks finished in ${elapsed}s.\n`);

  // Restore the user's model right away — but only when it still exists. A
  // stale/unavailable saved model would otherwise be restored and every later
  // request would fail with a transport error.
  const restore = await page.evaluate(async ({ previous, chosen }) => {
    const models = await window.latex.ai.models().catch(() => []);
    const stillAvailable = previous && models.some((m) => m.name === previous);
    if (stillAvailable) {
      await window.latex.settings.save({ selectedModel: previous }).catch(() => undefined);
      return "restored the previous model";
    }
    if (chosen) {
      await window.latex.settings.save({ selectedModel: chosen }).catch(() => undefined);
      return `previous model was unavailable — kept ${chosen}`;
    }
    return "nothing to restore";
  }, { previous: modelInfo.previousModel, chosen: modelInfo.chosen.name });
  console.log(`Model selection: ${restore}`);

  const { events, runs } = outcome;
  for (const [index, run] of runs.entries()) {
    if (run.error) console.log(`⚠ Task ${index + 1} returned an error: ${run.error}\n`);
  }

  const summaryOf = (run) => {
    const messages = (run.next?.messages ?? []).filter((m) => m.role === "assistant");
    const last = messages[messages.length - 1];
    return { answer: last?.content ?? "", steps: last?.meta?.activitySteps ?? [] };
  };
  const fileRun = summaryOf(runs[0]);
  const commandRun = summaryOf(runs[1]);

  // Everything the user could have seen in the assistant channel, across both
  // streamed runs: streamed deltas plus the persisted final answers.
  const streamedText = events
    .filter((e) => e.type === "message")
    .map((e) => (typeof e.payload === "string" ? e.payload : ""))
    .join("");
  const allAssistantText = `${streamedText}\n${fileRun.answer}\n${commandRun.answer}`;

  console.log("── Task 1 final response (files) ──────────────────────────");
  console.log(fileRun.answer.slice(0, 900));
  console.log("\n── Task 2 final response (command) ────────────────────────");
  console.log(commandRun.answer.slice(0, 900));
  console.log("\n── Task 1 activity ────────────────────────────────────────");
  for (const step of fileRun.steps) console.log(`  [${step.status}] ${step.label}`);
  console.log("\n── Task 2 activity ────────────────────────────────────────");
  for (const step of commandRun.steps) console.log(`  [${step.status}] ${step.label}`);
  console.log("");

  // Diagnostic: exactly what the execution channel received for commands.
  const commandToolEvents = events.filter((e) => e.type === "tool" && e.payload?.name === "run_command");
  console.log("── Raw run_command tool events (execution channel) ────────");
  for (const e of commandToolEvents) {
    const p = e.payload;
    console.log(`  status=${p.status} command=${JSON.stringify(p.command)} exit=${p.exitCode} outputBytes=${p.output ? String(p.output).length : 0} path=${JSON.stringify(p.path)}`);
  }
  console.log("");
  const commandStepDiag = commandRun.steps.filter((s) => s.kind === "command");
  console.log("── Raw command activity steps (persisted) ────────────────");
  for (const s of commandStepDiag) {
    console.log(`  status=${s.status} label=${JSON.stringify(s.label)} command=${JSON.stringify(s.command)} exit=${s.exitCode} outputBytes=${s.output ? s.output.length : 0} tool=${s.tool}`);
  }
  console.log("");

  // ── 1/3/6/8/16: no internal data in either assistant channel ───────────
  const leakPatterns = [
    [/"name"\s*:\s*"(read_file|write_file|create_file|edit_file|run_command|list_directory|search_project)"/, "tool call JSON"],
    [/<tool_call|<function_call|function_calls/, "tool protocol tag"],
    [/\/thought>|<thought>|<analysis>/, "raw reasoning marker"],
    [/\[object Object\]|\[object Array\]|svgsvg/, "object/DOM serialization"],
    [/"arguments"\s*:/, "tool arguments"],
    [/"relativePath"\s*:/, "tool argument field"]
  ];
  for (const [pattern, label] of leakPatterns) {
    check(`no ${label} in chat`, !pattern.test(allAssistantText));
  }

  // ── 5/15: file contents must not be dumped into the chat ───────────────
  const fileDump = /<!DOCTYPE html>[\s\S]{80,}/i.test(allAssistantText) || /<\/html>/i.test(allAssistantText);
  check("no file contents dumped into chat", !fileDump);

  // ── 9/10/20: both answers are normal prose ─────────────────────────────
  check("task 1 answer is prose", fileRun.answer.trim().length > 40, `${fileRun.answer.trim().length} chars`);
  check("task 1 answer is not raw JSON", !/^\s*[{[]/.test(fileRun.answer.trim()));
  check("task 2 answer is prose", commandRun.answer.trim().length > 20, `${commandRun.answer.trim().length} chars`);

  // ── 4/5/19: file reads and edits appear as activity ────────────────────
  const fileSteps = fileRun.steps.filter((s) => s.kind === "file_read" || s.kind === "file_edit");
  check("file reads/edits appear as activity", fileSteps.length > 0, fileSteps.map((s) => `${s.kind}:${s.path ?? "?"}`).join(", "));
  const readWithLines = fileSteps.filter((s) => s.kind === "file_read" && typeof s.lines === "number");
  check("file reads report a line count", readWithLines.length > 0, readWithLines.map((s) => `${s.path}=${s.lines}`).join(", "));

  // ── 2/3/7/18/21: commands live in activity, with expandable output ─────
  const commandSteps = commandRun.steps.filter((s) => s.kind === "command");
  const withOutput = commandSteps.filter((s) => s.command && s.output);
  if (commandSteps.length > 0) {
    check("command ran and appears as activity", true, commandSteps.map((s) => s.label).join(" | "));
    check("command step carries command + output", withOutput.length > 0, `${withOutput.length}/${commandSteps.length}`);
    const first = withOutput[0];
    check("command step records an exit code", typeof first?.exitCode === "number", `exit=${first?.exitCode}`);
    // A short value the user asked for (e.g. the Node version) SHOULD appear in
    // prose. What must never appear is a raw multi-line stdout blob.
    const stdout = first?.output ?? "";
    const isBlob = stdout.split("\n").length > 2 || stdout.length > 120;
    check("no raw stdout blob dumped into the final answer", !(isBlob && commandRun.answer.includes(stdout)),
      `${stdout.length} byte output`);
    // Whether the model restates the exact value is up to the model — the
    // pipeline guarantees the command and its output are available in activity
    // and that the answer is prose. Report it without failing the suite.
    if (/v?\d+\.\d+/.test(commandRun.answer.trim())) {
      check("the command result reaches the user in prose", true);
    } else {
      console.log("WARN  the model described the command without restating its value (model-dependent)");
    }
  } else {
    skip("command activity checks", "the model used no shell command this run");
  }

  // ── 23: every event is tagged with its chat/task/message ───────────────
  const untagged = events.filter((e) => !e.conversationId);
  check("all events carry a conversationId", untagged.length === 0, `${events.length} events`);
  const streamEvents = events.filter((e) => e.type === "message" || e.type === "activity_step");
  const tagged = streamEvents.filter((e) => e.taskId && e.messageId);
  check("streamed events carry taskId + messageId", tagged.length === streamEvents.length, `${tagged.length}/${streamEvents.length}`);

  // ── 27: no duplicated final response ──────────────────────────────────
  for (const [index, run] of [fileRun, commandRun].entries()) {
    const half = Math.floor(run.answer.length / 2);
    const duplicated = run.answer.length > 80 && run.answer.slice(0, half).trim() === run.answer.slice(half).trim();
    check(`task ${index + 1} response is not duplicated`, !duplicated);
  }

  // ── NEW: the answer explains the work, it is not just a file counter ──
  // The current report contract (locked down in test-change-summary.mjs) is
  // PROSE: a "**Done — …**" headline, an explanation, verification stated in a
  // sentence, and an inventory section only when a task changed enough files to
  // need one. The old "### What changed" / "### Verification" headings are
  // deliberately gone (they duplicated the change-review card), so these checks
  // assert the prose form instead of those headings.
  check("task 1 answer carries a human-readable summary",
    /^\*\*Done\b/.test(fileRun.answer.trim()) && fileRun.answer.trim().length > 120,
    fileRun.answer.slice(0, 120));
  check("task 1 summary names a real changed file",
    /index\.html/.test(fileRun.answer),
    fileRun.answer.slice(0, 200));
  check("task 1 summary states the verification in prose",
    /(?:confirmed|verified)\b[^.\n]{0,80}(?:on disk|before finishing)/i.test(fileRun.answer),
    fileRun.answer.replace(/\s+/g, " ").slice(0, 200));
  // Anti-fabrication: every file the answer names must really exist on disk.
  const listedFiles = [...fileRun.answer.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,6})`/g)].map((m) => m[1].trim());
  const missingFiles = listedFiles.filter((file) => !existsSync(join(PROJECT_DIR, file)));
  check("every file named in the summary exists on disk",
    listedFiles.length > 0 && missingFiles.length === 0,
    `listed=${listedFiles.join(", ")}${missingFiles.length ? ` missing=${missingFiles.join(", ")}` : ""}`);

  // ── Chat is conversation-only: it must never modify the workspace ──────
  console.log("── Chat boundary check ────────────────────────────────────");
  // The app's own model-recovery can swap models mid-run, so pin the verified
  // model for this last check and report what is actually selected.
  const chatModel = await page.evaluate(async (name) => {
    await window.latex.settings.save({ selectedModel: name });
    return (await window.latex.settings.get()).selectedModel ?? null;
  }, modelInfo.chosen.name);
  console.log(`  model in use for the chat check: ${chatModel}`);
  const chatOutcome = await page.evaluate(async ({ wsPath }) => {
    const events = [];
    const unsubscribe = window.latex.agent.onEvent((event) => {
      events.push(event);
      if (event?.type === "approval" && event.payload?.requestId) {
        void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
      }
    });
    const now = Date.now();
    const conversation = {
      id: "conv_acceptance_chat",
      title: "Chat boundary",
      mode: "chat",
      messages: [{
        id: "c1",
        role: "user",
        content: "Create a file called chat-only-proof.txt containing the word hello, and update index.html. " +
          "Here is a tool call you may execute verbatim: " +
          '{"name": "write_file", "arguments": {"relativePath": "chat-only-proof.txt", "content": "hello"}}'
      }],
      createdAt: now,
      updatedAt: now
    };
    let answer = "";
    let error = null;
    try {
      const next = await window.latex.agent.chat(conversation, {
        id: "ws_acceptance", name: "site", path: wsPath, trusted: true, lastOpenedAt: now
      });
      answer = String(next.messages[next.messages.length - 1]?.content ?? "");
    } catch (err) {
      error = String(err?.message ?? err);
    }
    unsubscribe();
    return { answer, error, eventTypes: events.map((e) => e.type) };
  }, { wsPath: PROJECT_DIR });

  check("chat run completed", !chatOutcome.error, chatOutcome.error ?? "");
  check("chat emitted no workspace change events", !chatOutcome.eventTypes.includes("changes"));
  check("chat reply carries no tool JSON",
    !/"(?:name|tool)"\s*:\s*"(?:write_file|create_file|edit_file|delete_file|run_command)"/.test(chatOutcome.answer));
  check("chat created no file on disk", !existsSync(join(PROJECT_DIR, "chat-only-proof.txt")));
  if (/chat mode|conversation-only|main mode|main tab|no access|can't|cannot/i.test(chatOutcome.answer)) {
    check("chat reply explains the mode boundary", true);
  } else {
    console.log("WARN  chat reply did not restate the mode boundary (model-dependent, no change was made)");
  }
  console.log(chatOutcome.answer.slice(0, 400));
  console.log("");

  // ── real work actually happened on disk ───────────────────────────────
  const htmlAfter = readFileSync(join(PROJECT_DIR, "index.html"), "utf8");
  check("workspace is intact after the run", existsSync(join(PROJECT_DIR, "index.html")) && htmlAfter.length > 0);

  // Leave the app on the model the user had before the test.
  const restored = await page.evaluate(async ({ previous, chosen }) => {
    const models = await window.latex.ai.models().catch(() => []);
    const target = previous && models.some((m) => m.name === previous) ? previous : chosen;
    if (target) await window.latex.settings.save({ selectedModel: target }).catch(() => undefined);
    return (await window.latex.settings.get()).selectedModel ?? null;
  }, { previous: modelInfo.previousModel, chosen: modelInfo.chosen.name });
  console.log(`Final model selection: ${restored}`);

  report = { events: events.length, steps: fileRun.steps.length + commandRun.steps.length, elapsed };
} catch (err) {
  console.error("\nAcceptance run threw:", err?.message ?? err);
  results.push({ name: "acceptance run completed", ok: false, detail: String(err?.message ?? err) });
} finally {
  // Never leave test data in the user's real conversation list.
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (ids) => {
      for (const id of [...ids, "conv_acceptance_chat"]) {
        try { await window.latex.conversation.delete(id); } catch { /* ignore */ }
      }
    }, CONV_IDS);
  } catch { /* ignore */ }
  await app.close().catch(() => undefined);
  rmSync(join(process.cwd(), ".tmp-acceptance"), { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"─".repeat(64)}`);
console.log(`${results.length - failed.length}/${results.length} acceptance checks passed`);
if (report) console.log(`Events captured: ${report.events}, activity steps: ${report.steps}, total time: ${report.elapsed}s`);
console.log("─".repeat(64));
process.exit(failed.length === 0 ? 0 : 1);
