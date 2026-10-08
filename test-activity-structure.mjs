/**
 * End-to-end test for the STRUCTURED Main Agent activity pipeline.
 *
 * Run with:  node test-activity-structure.mjs      (app must be closed)
 *
 * Launches the PACKAGED app and runs three real Main Agent tasks against a real
 * model, then inspects the exact activity channel the renderer consumes:
 *
 *   T1 create-file task  → plan → planning → file step → verification → receipt
 *   T2 command task      → real command step with exit code + captured output
 *   T3 failing command   → the activity reports the failure, the answer does not
 *                          claim success
 *
 * What it locks down (the information architecture, not the UI):
 *  - the FIRST activity row is a task-derived plan that states intent and is
 *    emitted immediately (no dead "Thinking for 30 seconds" screen);
 *  - real operations are named by phase, numbered in order, and every tool step
 *    carries its kind/tool/path;
 *  - command steps carry the real command, exit code and output — and that
 *    output is never dumped into the assistant answer;
 *  - the closing receipt counts UNIQUE files, matching the change recorder;
 *  - credentials never appear in a command or its output;
 *  - the parsed plan comes from the request, and private reasoning never leaks.
 *
 * The model the user had selected is restored afterwards and the test
 * conversations are deleted.
 *
 * Set ACTIVITY_MODEL=<model id> to force a specific provider/model — the
 * activity pipeline is provider-independent, so the same checks must hold for
 * any model that can call tools.
 */
const FORCED_MODEL = process.env.ACTIVITY_MODEL ?? null;
import { _electron as electron } from "playwright";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join("release", "win-unpacked", "Latex.exe");
const PROJECT_DIR = join(process.cwd(), ".tmp-activity-structure", "project");

if (!existsSync(EXE)) {
  console.error(`Packaged app not found at ${EXE} — run "npm run dist" first.`);
  process.exit(1);
}

// Compile the shared activity helpers so the test counts exactly what the app counts.
const helperDir = join(here, ".tmp-activity-structure", "helpers");
execFileSync(
  process.execPath,
  [
    join(here, "node_modules", "typescript", "bin", "tsc"),
    "src/shared/taskActivity.ts",
    "--outDir", helperDir,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck"
  ],
  { cwd: here, stdio: "inherit" }
);
const { activityCounts, activityCountLabel, activityPhase, planIntentForRequest } =
  await import(`./.tmp-activity-structure/helpers/taskActivity.js`);

rmSync(join(process.cwd(), ".tmp-activity-structure", "project"), { recursive: true, force: true });
mkdirSync(PROJECT_DIR, { recursive: true });
writeFileSync(join(PROJECT_DIR, "README.md"), "# Activity structure workspace\n\nA tiny project used by the activity test.\n");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const TASKS = [
  {
    id: "conv_activity_create",
    label: "create file",
    prompt: "Create a file called activity-check.txt in the workspace root containing the single line: hello from latex. Then confirm it exists on disk."
  },
  {
    id: "conv_activity_command",
    label: "run command",
    prompt: "Run the command `node --version` in the workspace and tell me which Node version is installed."
  },
  {
    id: "conv_activity_failing",
    label: "failing command",
    prompt: "Run this exact command in the workspace: node --definitely-not-a-real-flag . Then tell me whether it succeeded."
  }
];

const app = await electron.launch({ executablePath: EXE, timeout: 120_000 });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });

  // ── Pick a model that really answers ─────────────────────────────────────
  console.log("Probing for a working model...");
  const modelInfo = await page.evaluate(async (forced) => {
    globalThis.__forcedModel = forced;
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const preferred = [
      globalThis.__forcedModel ?? null,
      "models/gemini-flash-lite-latest",
      "models/gemini-2.5-flash-lite",
      "models/gemini-3-flash-lite",
      "groq/openai/gpt-oss-120b"
    ].filter(Boolean);
    const ordered = preferred.map((n) => models.find((m) => m.name === n)).filter(Boolean);
    if (globalThis.__forcedModel && !ordered.some((m) => m.name === globalThis.__forcedModel)) {
      return { previousModel: before.selectedModel ?? null, chosen: null, error: `forced model not available: ${globalThis.__forcedModel}` };
    }
    for (const m of models) {
      if ((m.provider === "gemini" || m.provider === "groq" || m.provider === "puter") && !ordered.some((o) => o.name === m.name)) {
        ordered.push(m);
      }
    }
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
        void window.latex.conversation.delete(conversation.id).catch(() => undefined);
        return { ok: String(last?.content ?? "").trim().length > 0 };
      } catch (err) {
        void window.latex.conversation.delete(conversation.id).catch(() => undefined);
        return { ok: false, error: String(err?.message ?? err).slice(0, 120) };
      }
    };
    let chosen = null;
    for (const candidate of ordered.slice(0, 8)) {
      const result = await probe(candidate.name);
      if (result.ok) { chosen = { name: candidate.name, provider: candidate.provider }; break; }
      console.log(`  probe failed: ${candidate.name} — ${result.error ?? "no text"}`);
    }
    if (chosen) await window.latex.settings.save({ selectedModel: chosen.name });
    return { previousModel: before.selectedModel ?? null, chosen };
  }, FORCED_MODEL);
  if (!modelInfo.chosen) throw new Error(`No usable model — cannot run the activity tasks.${modelInfo.error ? ` (${modelInfo.error})` : ""}`);
  console.log(`Using model: ${modelInfo.chosen.name}\n`);

  // ── Run the real tasks, capturing the activity channel ──────────────────
  const outcome = await page.evaluate(
    async ({ wsPath, tasks }) => {
      const events = [];
      const unsubscribe = window.latex.agent.onEvent((event) => {
        events.push({ at: Date.now(), event });
        if (event?.type === "approval" && event.payload?.requestId) {
          void window.latex.agent.resolveApproval(event.payload.requestId, true).catch(() => undefined);
        }
      });
      const workspace = { id: "ws_activity", name: "project", path: wsPath, trusted: true, lastOpenedAt: Date.now() };
      const runs = [];
      for (const task of tasks) {
        const startedAt = Date.now();
        const now = Date.now();
        const conversation = {
          id: task.id,
          title: `Activity structure — ${task.label}`,
          mode: "main",
          messages: [{ id: `m_${task.id}`, role: "user", content: task.prompt, createdAt: now }],
          createdAt: now,
          updatedAt: now
        };
        try {
          const next = await window.latex.agent.run(conversation, workspace);
          runs.push({ id: task.id, label: task.label, startedAt, next, error: null });
        } catch (err) {
          runs.push({ id: task.id, label: task.label, startedAt, next: null, error: String(err?.message ?? err) });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      unsubscribe();
      return { events, runs };
    },
    { wsPath: PROJECT_DIR, tasks: TASKS.map((t) => ({ id: t.id, label: t.label, prompt: t.prompt })) }
  );

  const restore = await page.evaluate(async ({ previous, chosen }) => {
    const models = await window.latex.ai.models().catch(() => []);
    const stillAvailable = previous && models.some((m) => m.name === previous);
    if (stillAvailable) {
      await window.latex.settings.save({ selectedModel: previous }).catch(() => undefined);
      return "restored the previous model";
    }
    if (chosen) {
      await window.latex.settings.save({ selectedModel: chosen.name }).catch(() => undefined);
      return `previous model unavailable — kept ${chosen.name}`;
    }
    return "nothing to restore";
  }, { previous: modelInfo.previousModel, chosen: modelInfo.chosen });
  console.log(`Model selection: ${restore}\n`);

  const summarize = (run) => {
    const last = [...(run.next?.messages ?? [])].reverse().find((m) => m.role === "assistant");
    return { answer: last?.content ?? "", steps: last?.meta?.activitySteps ?? [] };
  };
  const runs = outcome.runs.map((run) => ({ ...run, ...summarize(run) }));

  for (const run of runs) {
    console.log(`── ${run.label}: activity ─────────────────────────────`);
    for (const step of run.steps) {
      console.log(`  [${step.status}] (${step.kind ?? "-"}) ${step.label}${step.detail ? ` — ${step.detail.slice(0, 90)}` : ""}`);
    }
    const counts = activityCounts(run.steps);
    console.log(`  counts: ${activityCountLabel(counts) || "(none)"}`);
    if (run.error) console.log(`  ⚠ run error: ${run.error}`);
    console.log(`  answer: ${run.answer.replace(/\s+/g, " ").slice(0, 260)}\n`);
  }

  check("all three tasks ran without an IPC error", runs.every((r) => !r.error), runs.map((r) => r.error).filter(Boolean).join(" | "));

  const createRun = runs[0];
  const commandRun = runs[1];
  const failRun = runs[2];

  // ── 1. Real-time plan arrives before any real work ──────────────────────
  const planEvent = outcome.events.find((e) => e.event?.type === "activity_step" && e.event?.payload?.kind === "thinking");
  const firstToolEvent = outcome.events.find((e) => e.event?.type === "activity_step" && e.event?.payload?.tool);
  const planPayload = planEvent?.event?.payload;
  check("the task plan is announced as an activity row",
    planPayload?.label === "Thinking" && planPayload?.kind === "thinking",
    `label=${planPayload?.label} kind=${planPayload?.kind}`);
  check("the plan states intent (\"I'll …\")", String(planPayload?.detail ?? "").startsWith("I'll"),
    String(planPayload?.detail ?? "").slice(0, 120));
  check("the plan is emitted immediately, before any model round-trip",
    Boolean(planEvent) && planEvent.at - createRun.startedAt < 2000,
    `${planEvent ? planEvent.at - createRun.startedAt : "n/a"}ms`);
  check("the plan is announced BEFORE the first real tool call",
    Boolean(planEvent && firstToolEvent) && planEvent.at <= firstToolEvent.at,
    planEvent && firstToolEvent ? `${planEvent.at - createRun.startedAt}ms vs tool at ${firstToolEvent.at - createRun.startedAt}ms` : "missing event");
  check("the plan is derived from the request, not a template",
    String(planPayload?.detail ?? "").startsWith(planIntentForRequest(TASKS[0].prompt).slice(0, 40)),
    String(planPayload?.detail ?? "").slice(0, 120));
  const preWorkRows = outcome.events
    .filter((e) => e.event?.type === "activity_step" && e.at < (firstToolEvent?.at ?? Infinity))
    .map((e) => `${e.event.payload?.label ?? ""} ${e.event.payload?.detail ?? ""}`)
    .join(" | ");
  check("no fabricated work row before the first real tool call",
    !/\b(editing|creating|deleting|running command|testing|build passed|tests passed)\b/i.test(preWorkRows),
    preWorkRows.slice(0, 200));

  for (const run of [createRun, commandRun]) {
    const steps = run.steps;
    const plan = steps[0];
    check(`${run.label}: plan row is first in the persisted timeline`, plan?.kind === "thinking" && String(plan?.detail ?? "").startsWith("I'll"),
      `${plan?.label} — ${String(plan?.detail ?? "").slice(0, 60)}`);
    check(`${run.label}: plan row is completed (no stuck spinner)`, plan?.status === "done", plan?.status);
    const toolSteps = steps.filter((s) => s.tool);
    check(`${run.label}: real tool work was recorded`, toolSteps.length > 0, `${toolSteps.length} tool step(s)`);
    check(`${run.label}: planning step summarises the real operations`,
      steps.some((s) => s.kind === "planning" && /\d+ (native )?operation/i.test(String(s.detail ?? ""))),
      steps.filter((s) => s.kind === "planning").map((s) => s.detail).join(" | ").slice(0, 120));
    check(`${run.label}: verification step exists`, steps.some((s) => /^Verifying/i.test(s.label)),
      steps.map((s) => s.label).join(" | ").slice(0, 160));
    check(`${run.label}: every tool step names its kind and tool`,
      toolSteps.every((s) => Boolean(s.kind) && Boolean(s.tool)),
      toolSteps.map((s) => `${s.label}/${s.kind ?? "-"}`).join(", ").slice(0, 160));
    check(`${run.label}: file/command steps expose a usable phase`,
      toolSteps.every((s) => activityPhase(s) !== null),
      toolSteps.map((s) => `${s.label}→${activityPhase(s)}`).join(", ").slice(0, 200));
    const receipt = steps[steps.length - 1];
    check(`${run.label}: closing receipt counts real files/commands`,
      /^\d+ (created|edited|deleted|renamed|command|folder)/.test(String(receipt?.label ?? "")) || /^\d+ (created|edited)/.test(String(receipt?.label ?? "")),
      String(receipt?.label ?? ""));
    check(`${run.label}: timeline order is plan → work → receipt`,
      steps.length >= 3 && steps[0].kind === "thinking" && receipt !== steps[0]);
  }

  // ── 2. The create task really created one file, counted once ────────────
  const createdCounts = activityCounts(createRun.steps);
  check("create task: exactly one created file recorded", createdCounts.created.includes("activity-check.txt"),
    JSON.stringify(createdCounts.created));
  check("create task: the file really exists on disk", existsSync(join(PROJECT_DIR, "activity-check.txt")));
  if (existsSync(join(PROJECT_DIR, "activity-check.txt"))) {
    const body = readFileSync(join(PROJECT_DIR, "activity-check.txt"), "utf8");
    check("create task: the written content matches the request", /hello from latex/i.test(body), JSON.stringify(body.slice(0, 60)));
  }
  check("create task: no operation is double-counted",
    createdCounts.created.filter((p) => p === "activity-check.txt").length === 1);
  check("create task: final answer is prose about the change",
    createRun.answer.trim().length > 30 && !/^\s*[{[]/.test(createRun.answer.trim()));

  // ── 3. Command task: real command, real exit code, output kept out of chat ──
  const commandSteps = commandRun.steps.filter((s) => s.kind === "command");
  check("command task: a command step was recorded", commandSteps.length > 0, `${commandSteps.length}`);
  const nodeStep = commandSteps.find((s) => /node --version/.test(String(s.command ?? "")));
  check("command task: the real command is shown", Boolean(nodeStep), commandSteps.map((s) => s.command).join(" | ").slice(0, 120));
  check("command task: exit code captured", nodeStep?.exitCode === 0, String(nodeStep?.exitCode));
  check("command task: output captured in the activity channel", Boolean(nodeStep?.output && nodeStep.output.trim()), `${nodeStep?.output?.length ?? 0} chars`);
  check("command task: activity phase is a plain command run", activityPhase(nodeStep ?? {}) === "Running command", String(activityPhase(nodeStep ?? {})));
  // The command's REAL output stays in the activity channel; the answer only
  // has to reflect that the command ran (the model's own prose reports it).
  check("command task: the real output stays in the activity channel",
    /v?\d+\.\d+\.\d+/.test(String(nodeStep?.output ?? "")),
    JSON.stringify(String(nodeStep?.output ?? "").slice(0, 60)));
  check("command task: the answer reports the command it ran",
    /node --version/.test(commandRun.answer),
    commandRun.answer.replace(/\s+/g, " ").slice(0, 120));
  check("command task: stdout for the whole run is not dumped into the chat",
    !/stderr:/i.test(commandRun.answer) && commandRun.answer.length < 4000, `${commandRun.answer.length} chars`);
  check("command task: the chat does not repeat the activity rows",
    !/^Run node --version/m.test(commandRun.answer) && !/^\[done\]/m.test(commandRun.answer));

  // ── 4. Failing command: honest failure, no false success ────────────────
  const failSteps = failRun.steps;
  const failingStep = failSteps.find((s) => s.kind === "command" && s.status === "failed");
  check("failing command: the activity reports the failure", Boolean(failingStep),
    failSteps.filter((s) => s.kind === "command").map((s) => `${s.status}/${s.exitCode}`).join(" | "));
  check("failing command: the real non-zero exit code is preserved",
    typeof failingStep?.exitCode === "number" && failingStep.exitCode !== 0, String(failingStep?.exitCode));
  check("failing command: no command step claims success with a non-zero exit",
    failSteps.filter((s) => s.kind === "command").every((s) => (typeof s.exitCode === "number" && s.exitCode !== 0) === (s.status === "failed")),
    failSteps.filter((s) => s.kind === "command").map((s) => `${s.status}/${s.exitCode}`).join(" | "));
  check("failing command: the answer does not claim the command succeeded",
    !/\b(succeeded|completed successfully|worked fine|no errors)\b/i.test(failRun.answer) || /\b(fail(ed|ure)?|non-?zero|exit(ed)? (code )?3|error)\b/i.test(failRun.answer),
    failRun.answer.replace(/\s+/g, " ").slice(0, 200));
  check("failing command: the answer mentions the failure", /\b(fail(ed|ure|s)?|error|non-?zero|exit)\b/i.test(failRun.answer),
    failRun.answer.replace(/\s+/g, " ").slice(0, 160));
  check("failing command: the failed step is not counted as a success",
    activityCounts(failSteps).failed > 0, JSON.stringify(activityCounts(failSteps)));

  // ── 5. Channels never cross ─────────────────────────────────────────────
  const allAnswers = runs.map((r) => r.answer).join("\n");
  const allActivityText = runs
    .flatMap((r) => r.steps)
    .map((s) => `${s.label} ${s.detail ?? ""} ${s.command ?? ""} ${s.output ?? ""}`)
    .join("\n");
  const secretPatterns = [
    [/\bsk-[A-Za-z0-9_-]{8,}/, "vendor sk- key"],
    [/Bearer\s+[A-Za-z0-9._-]{12,}/i, "bearer token"],
    [/(?:api[_-]?key|token|password)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i, "assigned credential"]
  ];
  for (const [pattern, label] of secretPatterns) {
    check(`activity channel hides ${label}`, !pattern.test(allActivityText), String(pattern));
  }
  check("no tool-protocol JSON in any answer",
    !/"name"\s*:\s*"(read_file|write_file|create_file|edit_file|run_command|list_directory)"/.test(allAnswers)
      && !/<tool_call|function_calls|"arguments"\s*:/.test(allAnswers));
  check("no raw reasoning markers in any answer", !/<\/?thought>|<\/?analysis>/.test(allAnswers));
  check("activity rows never fabricate a phase they did not run",
    runs.flatMap((r) => r.steps).every((s) => s.kind || !s.tool));

  // ── 6. The rows really render in the EXISTING activity UI ───────────────
  console.log("\n── Renderer: persisted activity rows ──────────────────────");
  await page.reload();
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });
  await page.waitForSelector(".recentRow", { timeout: 20_000 }).catch(() => null);
  await page.locator(".modeToggleBtn", { hasText: "Main" }).first().click().catch(() => null);
  await page.waitForTimeout(500);
  const recentCount = await page.locator(".recentRow").count();
  const titles = [];
  for (let i = 0; i < recentCount; i += 1) {
    titles.push(await page.locator(".recentRow").nth(i).locator(".recentTitle").innerText().catch(() => ""));
  }
  // Prefer the create-file run: it is the one with file work AND a command-free
  // operation mix, so the counters row has something real to show.
  let openedIndex = titles.findIndex((t) => /Activity structure/.test(t) && /create/i.test(t));
  if (openedIndex < 0) openedIndex = titles.findIndex((t) => /Activity structure/.test(t));
  check("a finished run is listed in Recents", openedIndex >= 0, titles.join(" | ").slice(0, 160));
  if (openedIndex >= 0) {
    await page.locator(".recentRow").nth(openedIndex).locator("button").first().click();
    await page.waitForSelector(".message.assistant", { timeout: 20_000 }).catch(() => null);
    const activityHeader = page.locator(".msgActivityHeader").first();
    const hasPanel = (await activityHeader.count()) > 0;
    check("the persisted activity panel is rendered on the assistant message", hasPanel);
    if (hasPanel) {
      await activityHeader.click();
      await page.waitForTimeout(300);
      const stepsText = await page.locator(".msgActivitySteps").first().innerText().catch(() => "");
      const rowLabels = await page.locator(".msgActivitySteps .msgActivityStepLabel").allInnerTexts().catch(() => []);
      check("activity rows are numbered in order",
        rowLabels.length >= 2 && rowLabels.every((text, i) => text.trim().startsWith(`${i + 1}. `)),
        rowLabels.join(" | ").slice(0, 200));
      check("the rows name the real operations",
        /(Creating|Editing|Writing|Reading|Checking|Run node --version)/.test(stepsText),
        stepsText.replace(/\s+/g, " ").slice(0, 160));
      const chipsText = await page.locator(".msgActivitySteps .activityCounts").first().innerText().catch(() => "");
      check("live file/command counters are rendered",
        /(created|edited|command run|inspected)/i.test(chipsText),
        chipsText.replace(/\s+/g, " ").slice(0, 160));
      const panelText = await page.locator(".msgActivity").first().innerText().catch(() => "");
      check("the panel is a receipt, not a dump of command output",
        !/stderr:/i.test(panelText) && panelText.length < 4000,
        `${panelText.length} chars`);
    }
  }

  // ── Cleanup: remove the test conversations ──────────────────────────────
  await page.evaluate(async (ids) => {
    for (const id of ids) await window.latex.conversation.delete(id).catch(() => undefined);
  }, TASKS.map((t) => t.id));

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
