/**
 * Generated results — the durable, normalized record of what the agent
 * PRODUCED, whether or not it touched the filesystem.
 *
 * A file change is not the only meaningful outcome. A generated image, a graph,
 * a chart or a tool-produced artifact is a real assistant result, and it must be
 * attached to the assistant message so a recreated renderer can rebuild it —
 * after the Thinking box collapses, after the final response replaces the live
 * turn, after a new message, a tab switch, a chat switch and a full restart.
 *
 * Everything here is pure and provider-independent so the same rules run in the
 * main process, the renderer and a unit test:
 *  - a result is only ever created from a REAL provider image chunk or a REAL
 *    successful tool result (never from model prose, never fabricated);
 *  - identity is a stable `resultId`, so the same result arriving twice (a
 *    duplicated stream event, an IPC reconnect, a restored task, a rerender)
 *    stays ONE persisted result;
 *  - only normalized data is stored (bounded chart series), never a React
 *    instance, a DOM node or the tool's raw JSON.
 */

import type { GeneratedResult, GeneratedResultKind, TaskResultState } from "./types.js";

/** Upper bound on how many generated results one message may persist. */
export const MAX_GENERATED_RESULTS = 12;

/** A single visual payload cannot exceed this many bytes of base64. */
export const MAX_VISUAL_BASE64_CHARS = 8 * 1024 * 1024;

/** A normalized, bounded chart the renderer can draw. */
export interface ChartData {
  title?: string;
  type?: "bar" | "line" | "pie";
  labels: string[];
  values: number[];
}

/** Text keys that name a structured visual, most specific first. */
const STRUCTURED_VISUAL_KEYS: Array<{ keys: string[]; kind: GeneratedResultKind }> = [
  { keys: ["generatedGraph", "generated_graph", "graphData", "graph"], kind: "graph" },
  { keys: ["generatedChart", "chartData", "chart", "plot", "series"], kind: "chart" },
  { keys: ["generatedArtifact", "generated_artifact", "artifact", "artifacts"], kind: "artifact" },
  { keys: ["generatedVisual", "generated_visual", "visualization", "visualisation", "visual"], kind: "visual" }
];

/** Object keys that can carry an inline base64/`data:` image payload. */
const IMAGE_PAYLOAD_KEYS = ["previewBase64", "base64", "imageBase64", "pngBase64", "dataUrl", "dataURL", "image", "svg"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shortText(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** True when a base64 string is plausibly real image data (never a path). */
export function looksLikeBase64Image(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length > MAX_VISUAL_BASE64_CHARS) return false;
  // A real payload has no whitespace and is base64 (or a data: URL).
  const body = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  if (body.length < 16) return false;
  if (/[^A-Za-z0-9+/=]/.test(body)) return false;
  if (body.length % 4 !== 0) return false;
  return true;
}

/** Split a `data:<mime>;base64,<body>` URL into its parts. */
export function parseDataUrl(value: string): { mimeType?: string; base64?: string } {
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(value.trim());
  if (!match) return {};
  return { mimeType: match[1] || undefined, base64: match[2] };
}

function mimeFor(key: string, value: string): string {
  if (/svg/i.test(key) || /<svg[\s>]/i.test(value.slice(0, 200))) return "image/svg+xml";
  return key === "previewBase64" ? "image/jpeg" : "image/png";
}

/** Find an inline image payload anywhere in a tool result (bounded search). */
export function findImagePayload(
  result: unknown,
  depth = 0
): { base64: string; mimeType: string } | null {
  if (depth > 3) return null;
  if (!isRecord(result)) return null;
  for (const key of IMAGE_PAYLOAD_KEYS) {
    const value = result[key];
    if (typeof value !== "string" || !looksLikeBase64Image(value)) continue;
    // Never mistake a filesystem path / plain text for an image. A path is
    // recognised by a drive letter or an image EXTENSION — never by a leading
    // "/", because a real JPEG payload starts with "/9j/…".
    if (/^[A-Za-z]:[\\/]|\.(?:png|jpe?g|webp|gif|bmp|svg)$/i.test(value.trim())) continue;
    const parsed = value.trim().startsWith("data:") ? parseDataUrl(value) : { base64: value.trim(), mimeType: undefined };
    if (!parsed.base64) continue;
    return { base64: parsed.base64, mimeType: parsed.mimeType ?? mimeFor(key, value) };
  }
  for (const nested of Object.values(result)) {
    if (!isRecord(nested)) continue;
    const found = findImagePayload(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

const CHART_TYPE_ALIASES: Record<string, ChartData["type"]> = {
  bar: "bar", column: "bar", histogram: "bar",
  line: "line", area: "line", spline: "line",
  pie: "pie", doughnut: "pie", donut: "pie"
};

function normalizeChartType(value: unknown): ChartData["type"] | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CHART_TYPE_ALIASES[text];
}

/**
 * Turn the common structured shapes a visualization tool returns into one
 * bounded `{ labels, values }` series. Returns null when the payload is not a
 * recognizable chart — an unrecognized shape is never stored as raw JSON.
 *
 * Recognized shapes:
 *   { labels: [...], values: [...] }            | { labels, data: [...] }
 *   { data: [{ label, value }, ...] }           | { points: [{ x, y }, ...] }
 *   { x: [...], y: [...] }                      | { series: [{ name, values }] }
 *   a bare array of numbers or {label,value} entries
 */
export function normalizeChartData(payload: unknown): ChartData | null {
  const source = isRecord(payload) ? payload : Array.isArray(payload) ? { data: payload } : null;
  if (!source) return null;
  const type = normalizeChartType(source.type ?? source.chartType ?? source.kind);
  const title = shortText(source.title ?? source.name ?? source.label, 80);

  const toSeries = (labelsRaw: unknown, valuesRaw: unknown): ChartData | null => {
    const labels = Array.isArray(labelsRaw) ? labelsRaw.map((l) => String(l ?? "").slice(0, 40)) : [];
    const values = Array.isArray(valuesRaw) ? valuesRaw.map(toNumber) : [];
    if (values.length === 0 || values.some((v) => v === null)) return null;
    const nums = (values as number[]).slice(0, 64);
    const sized = labels.length === nums.length ? labels.slice(0, 64) : nums.map((_, i) => labels[i] ?? String(i + 1));
    return { labels: sized, values: nums, ...(type ? { type } : {}), ...(title ? { title } : {}) };
  };

  const direct = toSeries(source.labels ?? source.categories ?? source.x, source.values ?? source.y ?? source.data);
  if (direct) return direct;

  const rows = Array.isArray(source.data)
    ? source.data
    : Array.isArray(source.points)
      ? source.points
      : Array.isArray(source.series) && isRecord(source.series[0])
        ? (source.series[0] as Record<string, unknown>).values
        : null;
  if (Array.isArray(rows) && rows.every((r) => isRecord(r) || Array.isArray(r))) {
    const labels: string[] = [];
    const values: number[] = [];
    for (const row of rows.slice(0, 64)) {
      if (Array.isArray(row)) {
        labels.push(String(row[0] ?? labels.length + 1).slice(0, 40));
        const num = toNumber(row[1]);
        if (num === null) return null;
        values.push(num);
        continue;
      }
      const rec = row as Record<string, unknown>;
      const num = toNumber(rec.value ?? rec.y ?? rec.count ?? rec.total);
      if (num === null) return null;
      labels.push(String(rec.label ?? rec.x ?? rec.name ?? labels.length + 1).slice(0, 40));
      values.push(num);
    }
    if (values.length === 0) return null;
    return { labels, values, ...(type ? { type } : {}), ...(title ? { title } : {}) };
  }

  if (Array.isArray(payload) && payload.every((v) => toNumber(v) !== null)) {
    const nums = (payload as unknown[]).map(toNumber) as number[];
    return { labels: nums.map((_, i) => String(i + 1)), values: nums.slice(0, 64), ...(title ? { title } : {}) };
  }
  return null;
}

/** The structured visual a tool result carries, if any (kind + normalized data). */
function structuredVisualFromResult(
  result: Record<string, unknown>
): { kind: GeneratedResultKind; data?: Record<string, unknown>; title?: string } | null {
  for (const candidate of STRUCTURED_VISUAL_KEYS) {
    for (const key of candidate.keys) {
      const value = result[key];
      if (value === undefined || value === null) continue;
      const chart = normalizeChartData(value);
      const title = shortText(
        isRecord(value) ? value.title ?? value.name : undefined,
        80
      );
      if (chart) {
        return {
          kind: candidate.kind,
          data: { chart: chart as unknown as Record<string, unknown> },
          ...(chart.title ?? title ? { title: chart.title ?? title } : {})
        };
      }
      // A structured visual we cannot draw still counts as a real result — we
      // record its KIND and a title, never the raw payload.
      if (Array.isArray(value) || isRecord(value)) {
        return { kind: candidate.kind, ...(title ? { title } : {}) };
      }
    }
  }
  return null;
}

/** Nothing fabricated: a failed / cancelled / rejected result is never visual. */
function toolResultSucceeded(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === "string") return result.trim().length > 0;
  if (!isRecord(result)) return false;
  if (result.success === false) return false;
  if (result.cancelled === true) return false;
  if (typeof result.error === "string" && result.error.trim().length > 0) return false;
  return true;
}

export interface GeneratedResultIdentity {
  taskId?: string;
  messageId?: string;
  toolCallId?: string;
  /** Explicit id, when the caller has a better stable key. */
  resultId?: string;
}

function buildResult(
  base: Omit<GeneratedResult, "resultId" | "status" | "createdAt">,
  identity: GeneratedResultIdentity,
  at = Date.now()
): GeneratedResult {
  const resultId =
    identity.resultId
    ?? (identity.toolCallId ? `gr_${identity.toolCallId}` : undefined)
    ?? (base.base64 ? `gr_img_${identity.taskId ?? "task"}_${at.toString(36)}` : undefined)
    ?? `gr_${identity.taskId ?? "task"}_${at.toString(36)}`;
  return { resultId, createdAt: at, status: "completed", ...base };
}

/** A provider image chunk is a real, completed generated result (kind image). */
export function generatedResultFromImage(
  image: { mimeType: string; data: string },
  identity: GeneratedResultIdentity,
  index: number,
  at = Date.now()
): GeneratedResult {
  return {
    resultId: identity.resultId ?? `gr_image_${identity.taskId ?? "task"}_${index}`,
    kind: "image",
    status: "completed",
    createdAt: at,
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
    ...(identity.messageId ? { messageId: identity.messageId } : {}),
    ...(identity.toolCallId ? { toolCallId: identity.toolCallId } : {}),
    title: `Generated image ${index + 1}`,
    base64: image.data,
    mimeType: image.mimeType || "image/png"
  };
}

/**
 * The generated result a successful TOOL produced, if any.
 *
 * Detects an inline image payload (a screenshot preview, a rendered chart) or a
 * structured graph/chart/artifact payload. Returns null for an ordinary
 * text/JSON tool result, so a read/list/search never becomes a "result".
 */
export function generatedResultFromToolResult(
  tool: string,
  result: unknown,
  identity: GeneratedResultIdentity,
  at = Date.now()
): GeneratedResult | null {
  if (!toolResultSucceeded(result)) return null;
  const image = findImagePayload(result);
  if (image) {
    return buildResult(
      { kind: "image", tool, title: `${tool.replace(/_/g, " ")} result`, base64: image.base64, mimeType: image.mimeType },
      identity,
      at
    );
  }
  if (!isRecord(result)) return null;
  const structured = structuredVisualFromResult(result);
  if (!structured) return null;
  return buildResult(
    {
      kind: structured.kind,
      tool,
      ...(structured.title ? { title: structured.title } : {}),
      ...(structured.data ? { data: structured.data } : {})
    },
    identity,
    at
  );
}

/**
 * Fold one generated result into the list, keyed by `resultId`.
 *
 * The same result arriving twice (a duplicated event, an IPC reconnect, a
 * restored task) replaces its own entry instead of stacking a duplicate, and a
 * `completed` entry is never downgraded by a later failure notice for the same
 * id. Newest results are kept within `limit`.
 */
export function mergeGeneratedResults(
  results: GeneratedResult[],
  incoming: GeneratedResult | null | undefined,
  limit = MAX_GENERATED_RESULTS
): GeneratedResult[] {
  if (!incoming || !incoming.resultId) return results;
  const idx = results.findIndex((item) => item.resultId === incoming.resultId);
  if (idx >= 0) {
    const existing = results[idx];
    // A real completed result is never replaced by a failure for the same id.
    if (existing.status === "completed" && incoming.status !== "completed") return results;
    const next = [...results];
    next[idx] = { ...existing, ...incoming };
    return next;
  }
  return [...results, incoming].slice(-limit);
}

/** Counts by kind, for the finalizer and the activity receipt. */
export function generatedResultCounts(results: GeneratedResult[] | undefined): {
  total: number;
  images: number;
  graphs: number;
  charts: number;
  artifacts: number;
  visuals: number;
} {
  const counts = { total: 0, images: 0, graphs: 0, charts: 0, artifacts: 0, visuals: 0 };
  for (const result of results ?? []) {
    if (!result || result.status !== "completed") continue;
    counts.total += 1;
    if (result.kind === "image") counts.images += 1;
    else if (result.kind === "graph") counts.graphs += 1;
    else if (result.kind === "chart") counts.charts += 1;
    else if (result.kind === "artifact") counts.artifacts += 1;
    else counts.visuals += 1;
  }
  return counts;
}

const KIND_NOUN: Record<GeneratedResultKind, { one: string; many: string }> = {
  image: { one: "image", many: "images" },
  graph: { one: "graph", many: "graphs" },
  chart: { one: "chart", many: "charts" },
  artifact: { one: "artifact", many: "artifacts" },
  visual: { one: "visual result", many: "visual results" }
};

/**
 * A natural clause naming what was generated, WITHOUT the leading "I":
 *   "generated the graph above"
 *   "generated 2 charts and an image above"
 * Empty string when nothing was generated.
 */
export function generatedResultClause(results: GeneratedResult[] | undefined): string {
  const counts = generatedResultCounts(results);
  if (counts.total === 0) return "";
  const parts: Array<{ count: number; kind: GeneratedResultKind }> = [];
  for (const kind of ["graph", "chart", "artifact", "image", "visual"] as GeneratedResultKind[]) {
    const count = kind === "image" ? counts.images
      : kind === "graph" ? counts.graphs
        : kind === "chart" ? counts.charts
          : kind === "artifact" ? counts.artifacts
            : counts.visuals;
    if (count > 0) parts.push({ count, kind });
  }
  const named = parts.map(({ count, kind }) => {
    const noun = count === 1 ? KIND_NOUN[kind].one : KIND_NOUN[kind].many;
    return count === 1 ? `the ${noun}` : `${count} ${noun}`;
  });
  const listed = named.length === 1
    ? named[0]
    : named.length === 2
      ? `${named[0]} and ${named[1]}`
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const verb = counts.total === 1 ? "generated" : "generated";
  return `${verb} ${listed} above`;
}

/** The full sentence form: "I generated the graph above." */
export function generatedResultSentence(results: GeneratedResult[] | undefined): string {
  const clause = generatedResultClause(results);
  return clause ? `I ${clause}.` : "";
}

/**
 * The REAL outcome state of a task, from the whole verified result.
 *
 * `filesChanged === 0` is never the success test on its own: a generated graph,
 * a generated image or any other verified result is a success too. A run that
 * genuinely produced nothing is `NO_RESULT`.
 */
export function resolveTaskResultState(input: {
  stopped?: boolean;
  failed?: boolean;
  filesChanged?: number;
  successfulOperations?: number;
  failedOperations?: number;
  generatedResults?: number;
  hasAnswer?: boolean;
}): TaskResultState {
  const filesChanged = input.filesChanged ?? 0;
  const successfulOperations = input.successfulOperations ?? 0;
  const failedOperations = input.failedOperations ?? 0;
  const generated = input.generatedResults ?? 0;
  const produced = filesChanged > 0 || generated > 0 || successfulOperations > 0;
  if (input.stopped) return produced ? "PARTIAL_SUCCESS" : "CANCELLED";
  if (input.failed) return produced ? "PARTIAL_SUCCESS" : "FAILED";
  if (produced) return "SUCCESS";
  if (failedOperations > 0) return "FAILED";
  // No tool work at all: a genuine text answer is still a result; nothing at
  // all (no answer, no tool result) is NO_RESULT.
  return input.hasAnswer ? "SUCCESS" : "NO_RESULT";
}
