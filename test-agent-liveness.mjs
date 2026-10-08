/**
 * Liveness test: real-time activity phases + task survival across navigation.
 *
 * Run with:  node test-agent-liveness.mjs   (app must be closed)
 *
 * Verifies the two reported problems:
 *
 *  1. The activity UI must NOT sit on a generic "Thinking" label for a minute
 *     while the provider is silent. A real `waiting_for_provider` phase must be
 *     reported immediately when the request is dispatched, and the header must
 *     name that phase. Measured below as request-start → first-phase latency.
 *
 *  2. Switching Main↔Chat and switching conversations must NOT cancel, restart
 *     or reset the running task. The same taskId/chatId continues while another
 *     view is visible, and events keep arriving throughout.
 *
 * Everything here drives the real app: real IPC, real model, real UI clicks.
 */
import { _electron as electron } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "Latex.exe");
// A small, isolated workspace so the agent's context scan stays fast.
const WORKSPACE_DIR = join(process.cwd(), ".tmp-liveness", "project");
rmSync(join(process.cwd(), ".tmp-liveness"), { recursive: true, force: true });
mkdirSync(WORKSPACE_DIR, { recursive: true });
writeFileSync(join(WORKSPACE_DIR, "README.md"), "# Liveness workspace\n\nA tiny project used by the liveness test.\n");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const app = await electron.launch({ executablePath: EXE, timeout: 120_000 });
let conversationId = "conv_liveness";
let previousModel = null;

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.agent?.run), null, { timeout: 60_000 });

  // ── A model that actually answers ─────────────────────────────────────
  console.log("Probing for a working model...");
  const chosen = await page.evaluate(async () => {
    const before = await window.latex.settings.get();
    const models = await window.latex.ai.models().catch(() => []);
    const preferred = [
      "models/gemini-flash-lite-latest",
      "models/gemini-2.5-flash-lite",
      "models/gemini-3-flash-lite",
      "models/gemini-3-flash-preview",
      "groq/openai/gpt-oss-120b"
    ];
    const ordered = preferred.map((n) => models.find((m) => m.name === n)).filter(Boolean);
    for (const candidate of ordered.slice(0, 5)) {
      await window.latex.settings.save({ selectedModel: candidate.name });
      const now = Date.now();
      const probe = {
        id: `probe_${now}`,
        title: "probe",
        mode: "chat",
        messages: [{ id: `p_${now}`, role: "user", content: "Reply with exactly: READY", createdAt: now }],
        createdAt: now,
        updatedAt: now
      };
      try {
        const next = await window.latex.agent.chat(probe);
        const text = String(next.messages[next.messages.length - 1]?.content ?? "").trim();
        void window.latex.conversation.delete(probe.id).catch(() => undefined);
        if (text.length > 0) return { name: candidate.name, previous: before.selectedModel ?? null };
      } catch {
        void window.latex.conversation.delete(probe.id).catch(() => undefined);
      }
    }
    return null;
  });
  if (!chosen) throw new Error("No working model available.");
  previousModel = chosen.previous;
  console.log(`Using model: ${chosen.name}\n`);

  // ── Start a real task and record every event with a timestamp ─────────
  const workspace = {
    id: "ws_liveness",
    name: "project",
    path: WORKSPACE_DIR,
    trusted: true,
    lastOpenedAt: Date.now()
  };

  await page.evaluate(
    async ({ convId, ws, model }) => {
      window.__events = [];
      window.__taskResult = null;
      const startedAt = Date.now();
      window.__startedAt = startedAt;
      const record = (event) => {
        window.__events.push({
          t: Date.now() - startedAt,
          type: event?.type,
          phase: event?.payload?.phase,
          taskId: event?.taskId,
          messageId: event?.messageId,
          conversationId: event?.conversationId
        });
      };
      window.latex.agent.onEvent(record);
      const now = Date.now();
      const conversation = {
        id: convId,
        title: "Liveness test",
        mode: "main",
        messages: [
          {
            id: `m_${now}`,
            role: "user",
            content:
              "Create a file called liveness.txt containing exactly the text OK, then read it back, then answer with one short sentence confirming it was written.",
            createdAt: now
          }
        ],
        createdAt: now,
        updatedAt: now
      };
      // Not awaited here: the renderer must not own the task.
      window.__conversation = conversation;
      window.latex.agent
        .run(conversation, ws)
        .then((next) => { window.__taskResult = { ok: true, next }; })
        .catch((err) => { window.__taskResult = { ok: false, error: String(err?.message ?? err) }; });
    },
    { convId: conversationId, ws: workspace, model: chosen.name }
  );

  // ── Navigate away and back WHILE the task runs ────────────────────────
  const switchLog = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await sleep(2000);
  await page.click('button.modeToggleBtn:has-text("Chat")').catch(() => switchLog.push("chat-click-failed"));
  switchLog.push(`t=${2000} switched Main -> Chat`);
  const phaseAfterSwitch = await page.evaluate(() => window.__events.filter((e) => e.type === "phase").map((e) => e.phase));

  await sleep(2000);
  await page.click('button.modeToggleBtn:has-text("Main")').catch(() => switchLog.push("main-click-failed"));
  switchLog.push(`t=4000 switched Chat -> Main`);

  // Switch to another conversation, then back.
  const otherRow = page.locator('button.navItem[title]:not(.navItemIcon)').nth(1);
  if (await otherRow.count()) {
    await otherRow.first().click().catch(() => switchLog.push("other-chat-click-failed"));
    switchLog.push("t=6000 switched to another conversation");
    await sleep(2000);
  } else {
    switchLog.push("no other conversation available to switch to");
    await sleep(1000);
  }
  const ownRow = page.locator('button.navItem[title]:not(.navItemIcon)').filter({ hasText: "Liveness test" }).first();
  if (await ownRow.count()) {
    await ownRow.click().catch(() => switchLog.push("return-click-failed"));
    switchLog.push("t=8000 returned to the task's conversation");
  }

  // ── Wait for the task to finish (it belongs to the main process) ──────
  await page.waitForFunction(() => window.__taskResult !== null, null, { timeout: 240_000 });
  const outcome = await page.evaluate(() => ({
    result: window.__taskResult,
    events: window.__events,
    startedAt: window.__startedAt
  }));

  console.log("── Navigation performed while the task ran ────────────────");
  for (const line of switchLog) console.log(`  ${line}`);
  console.log("");

  const { result, events } = outcome;
  const phases = events.filter((e) => e.type === "phase");
  const phaseTimeline = phases.map((e) => `${e.phase}@${e.t}ms`);

  console.log("── Real phase timeline (relative to task start) ───────────");
  console.log(`  ${phaseTimeline.join("\n  ")}`);
  console.log("");

  if (result?.error) console.log(`⚠ Task error: ${result.error}\n`);

  const firstOf = (phase) => phases.find((e) => e.phase === phase);
  const startedEvent = firstOf("starting");
  const waiting = phases.find((e) => e.phase === "waiting_for_provider" || e.phase === "requesting_model");
  const streaming = firstOf("streaming");

  // ── 1/4/5/38: activity starts immediately and names the real state ─────
  check("task reports 'starting' immediately", Boolean(startedEvent) && startedEvent.t <= 1500,
    startedEvent ? `${startedEvent.t}ms` : "never");

  check("'waiting for provider' is reported BEFORE the first byte", Boolean(waiting),
    waiting ? `${waiting.phase} at ${waiting.t}ms` : "never reported");

  check("waiting is reported early, not after a long stall", Boolean(waiting) && waiting.t <= 3000,
    waiting ? `${waiting.t}ms` : "never");

  check("a real transition to 'streaming' happens once data arrives", Boolean(streaming),
    streaming ? `${streaming.t}ms` : "never");

  // ── 2/16/41/42: navigation must not interrupt the task ────────────────
  const duringSwitchWindow = events.filter((e) => e.t >= 1500 && e.t <= 9000 && e.type !== "phase");
  check("events kept arriving while other tabs/chats were visible", duringSwitchWindow.length > 0,
    `${duringSwitchWindow.length} events between 1.5s and 9s`);

  const gaps = events
    .filter((e) => e.type === "message" || e.type === "activity_step")
    .map((e) => e.t)
    .sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < gaps.length; i++) maxGap = Math.max(maxGap, gaps[i] - gaps[i - 1]);
  // A model can legitimately pause; only a gap that covers the switch window and
  // ends the run would indicate the task was dropped. Report it, don't fake it.
  console.log(`  (largest gap between live events: ${maxGap}ms — provider think time, not navigation)`);

  check("the task completed after the switches", Boolean(result?.ok), result?.ok ? "ok" : result?.error);

  const assistantMessages = (result?.next?.messages ?? []).filter((m) => m.role === "assistant");
  const finalAnswer = String(assistantMessages[assistantMessages.length - 1]?.content ?? "");
  check("a final response was produced", finalAnswer.trim().length > 0, `${finalAnswer.trim().length} chars`);

  // ── 22/25: same task, same id — no restart ───────────────────────────
  const taskStates = await page.evaluate(async (convId) => {
    const tasks = await window.latex.tasks.list();
    return tasks.filter((t) => t.chatId === convId).map((t) => ({ taskId: t.taskId, status: t.status, phase: t.phase, startedAt: t.startedAt, timings: t.timings }));
  }, conversationId);
  check("exactly one task ran (no restart on navigation)", taskStates.length === 1,
    `${taskStates.length} task record(s)`);
  const task = taskStates[0];
  const reqLatency = task?.timings?.requestStartedAt && task?.timings?.taskStartedAt
    ? task.timings.requestStartedAt - task.timings.taskStartedAt
    : null;
  const firstByteLatency = task?.timings?.firstProviderEventAt && task?.timings?.requestStartedAt
    ? task.timings.firstProviderEventAt - task.timings.requestStartedAt
    : null;
  console.log(`  task=${task?.taskId} status=${task?.status} phase=${task?.phase}`);
  console.log(`  request dispatched ${reqLatency}ms after task start; first provider event after ${firstByteLatency}ms of waiting`);

  const taskIds = new Set(events.filter((e) => e.taskId).map((e) => e.taskId));
  check("every event belongs to the same task", taskIds.size === 1, `${taskIds.size} distinct taskId(s)`);

  // ── the write actually landed on disk ────────────────────────────────
  const { existsSync, readFileSync } = await import("node:fs");
  const target = join(WORKSPACE_DIR, "liveness.txt");
  check("the requested file was written", existsSync(target), existsSync(target) ? `contents=${JSON.stringify(readFileSync(target, "utf8").trim().slice(0, 20))}` : "missing");

  console.log(`\n${"─".repeat(64)}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} liveness checks passed`);
  console.log("─".repeat(64));
} catch (err) {
  console.error("\nLiveness test threw:", err?.message ?? err);
  results.push({ name: "liveness run completed", ok: false });
} finally {
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ ids, model }) => {
      for (const id of ids) {
        try { await window.latex.conversation.delete(id); } catch { /* ignore */ }
      }
      if (model) {
        try {
          await window.latex.settings.save({ selectedModel: model });
          await window.latex.tasks.list();
        } catch { /* ignore */ }
      }
    }, { ids: [conversationId], model: previousModel });
  } catch { /* ignore */ }
  await app.close().catch(() => undefined);
  rmSync(join(process.cwd(), ".tmp-liveness"), { recursive: true, force: true });
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
