/**
 * Generated-results UI acceptance test (real Electron renderer, no model needed).
 *
 * Run with:  node test-generated-results-ui.mjs      (after "npm run build")
 *
 * Why this test exists: a generated graph/image is an assistant RESULT, and it
 * must stay attached to the message — after the Thinking box collapses, after a
 * new message, after a tab/chat switch and after a full restart. This drives the
 * REAL renderer with a message that carries persisted `meta.generatedResults`
 * (exactly what the Main Agent now writes), then verifies the graph and image
 * render from that data, that they belong to the assistant message, that no raw
 * tool JSON leaks into the text, that no duplicate appears on navigation, and
 * that they are rebuilt from disk after the app is restarted.
 *
 * The ONLY thing it seeds is two conversations with unique ids; it deletes them
 * again, and it never changes the user's settings or model selection.
 */
import { _electron as electron } from "playwright";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXE = existsSync(join("node_modules", "electron", "dist", "electron.exe"))
  ? join("node_modules", "electron", "dist", "electron.exe")
  : null;
if (!EXE) {
  console.error("Local electron binary not found — run npm install first.");
  process.exit(1);
}

const CONV_GRAPH = "conv_genres_e2e_graph";
const CONV_PLAIN = "conv_genres_e2e_plain";
const GRAPH_TITLE = "Generated result E2E";
const PLAIN_TITLE = "Plain result E2E";

// A real 1x1 PNG so the image path is exercised with genuine image bytes.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function graphConversation() {
  const now = Date.now();
  return {
    id: CONV_GRAPH,
    title: GRAPH_TITLE,
    mode: "main",
    messages: [
      { id: "m_user_genres", role: "user", content: "show me the latency graph", createdAt: now },
      {
        id: "m_asst_genres",
        role: "assistant",
        content: "**Done — I generated the graph and the image above.**",
        createdAt: now,
        completedAt: now,
        meta: {
          taskResult: "SUCCESS",
          generatedResults: [
            {
              resultId: "gr_e2e_graph",
              kind: "graph",
              status: "completed",
              createdAt: now,
              tool: "make_graph",
              title: "Latency",
              data: { chart: { type: "bar", title: "Latency", labels: ["a", "b", "c"], values: [3, 7, 5] } }
            },
            {
              resultId: "gr_e2e_image",
              kind: "image",
              status: "completed",
              createdAt: now,
              title: "Generated image 1",
              mimeType: "image/png",
              base64: TINY_PNG
            }
          ]
        }
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function plainConversation() {
  const now = Date.now();
  return {
    id: CONV_PLAIN,
    title: PLAIN_TITLE,
    mode: "main",
    messages: [
      { id: "m_user_plain", role: "user", content: "hello", createdAt: now },
      {
        id: "m_asst_plain",
        role: "assistant",
        content: "**Done — nothing needed to change.**",
        createdAt: now,
        completedAt: now,
        meta: {}
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function launch() {
  const app = await electron.launch({
    executablePath: EXE,
    args: ["."],
    cwd: process.cwd(),
    timeout: 120_000
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.latex?.conversation?.save), null, { timeout: 60_000 });
  // A fresh version can open the What's New modal; it must not block the test.
  const close = page.locator('[aria-label="Close What\'s New"]').first();
  if (await close.count()) await close.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return { app, page };
}

async function selectChat(page, title) {
  const row = page.locator(".recentRow", { hasText: title }).first();
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.locator("button").first().click();
  await page.waitForTimeout(700);
}

async function counts(page) {
  return page.evaluate(() => ({
    blocks: document.querySelectorAll(".generatedResultsBlock").length,
    charts: document.querySelectorAll(".generatedChart").length,
    bars: document.querySelectorAll(".chartBar").length,
    images: document.querySelectorAll(".generatedResultsBlock .msgImageThumb").length,
    insideAssistant: document.querySelectorAll("article.message.assistant .generatedResultsBlock").length,
    text: (document.querySelector(".messageText")?.textContent ?? "")
  }));
}

const seeded = { graph: graphConversation(), plain: plainConversation() };
let app = null;
try {
  const first = await launch();
  app = first.app;
  const page = first.page;

  // Seed the two conversations through the SAME IPC the app uses.
  const saved = await page.evaluate(async ({ graph, plain }) => {
    await window.latex.conversation.save(graph);
    await window.latex.conversation.save(plain);
    const list = await window.latex.conversation.list();
    return list.map((c) => c.id);
  }, { graph: seeded.graph, plain: seeded.plain });
  check("seeded conversations were saved", saved.includes(CONV_GRAPH) && saved.includes(CONV_PLAIN));

  // Reload so the sidebar picks up the new conversations the way a real open would.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.latex?.conversation?.save), null, { timeout: 60_000 });
  const closeAgain = page.locator('[aria-label="Close What\'s New"]').first();
  if (await closeAgain.count()) await closeAgain.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(400);

  await selectChat(page, GRAPH_TITLE);
  const rendered = await counts(page);
  check("generated result block renders with the message", rendered.blocks === 1, `blocks=${rendered.blocks}`);
  check("it belongs to the ASSISTANT message", rendered.insideAssistant === 1, `insideAssistant=${rendered.insideAssistant}`);
  check("the persisted graph renders", rendered.charts === 1, `charts=${rendered.charts}`);
  check("the graph draws its real series", rendered.bars === 3, `bars=${rendered.bars}`);
  check("the persisted image renders", rendered.images === 1, `images=${rendered.images}`);
  check("no raw tool JSON leaks into the text",
    !/"values"|"labels"|"chart"/.test(rendered.text), rendered.text.slice(0, 120));

  // ── Switch away and back: the result must NOT be lost or duplicated ──
  await selectChat(page, PLAIN_TITLE);
  const away = await counts(page);
  check("a message with no result renders none", away.blocks === 0, `blocks=${away.blocks}`);
  await selectChat(page, GRAPH_TITLE);
  const back = await counts(page);
  check("after a chat switch the result is still there, exactly once",
    back.blocks === 1 && back.charts === 1 && back.images === 1 && back.bars === 3,
    JSON.stringify(back));

  // ── Full restart: rebuilt from persisted message data ────────────────
  await first.app.close().catch(() => undefined);
  app = null;
  const second = await launch();
  app = second.app;
  await selectChat(second.page, GRAPH_TITLE);
  const afterRestart = await counts(second.page);
  check("after a restart the result is rebuilt from disk",
    afterRestart.blocks === 1 && afterRestart.charts === 1 && afterRestart.images === 1,
    JSON.stringify(afterRestart));
} catch (err) {
  check("run completed without throwing", false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    if (app) {
      const page = await app.firstWindow();
      await page.evaluate(async ({ graph, plain }) => {
        await window.latex.conversation.delete(graph).catch(() => undefined);
        await window.latex.conversation.delete(plain).catch(() => undefined);
      }, { graph: CONV_GRAPH, plain: CONV_PLAIN });
    }
  } catch { /* cleanup is best-effort */ }
  await app?.close().catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} generated-result UI checks passed`);
console.log("─".repeat(64));
process.exitCode = failed.length === 0 ? 0 : 1;
