import type { GeminiModel, ModelProvider } from "../../../shared/types";
import { modelShortName } from "./errors";

export type TaskKind = "chat" | "code" | "analysis" | "fast" | "multimodal";

export interface ModelChoice {
  model?: string;
  reason: string;
  task: TaskKind;
  /** Models excluded from selection (already failed this request). */
  excludedModels?: string[];
}

const TASK_REASONS: Record<TaskKind, string> = {
  chat: "Simple conversational request",
  code: "Complex coding task",
  analysis: "Large project analysis",
  fast: "Fast lightweight task",
  multimodal: "Multimodal request"
};

/** Create a unique key for a model that includes its provider. */
export function modelKey(model: GeminiModel): string {
  const provider = model.provider ?? providerOfModel(model.name);
  return `${provider}:${model.name}`;
}

/** Deterministic intent classification — no extra LLM call. */
export function classifyRequest(text: string): TaskKind {
  const t = text.toLowerCase();
  if (/(image|photo|screenshot|picture|draw|diagram)/.test(t)) return "multimodal";
  if (/^(\s|\b(hi|hey|hello|yo|sup|howdy|good (morning|afternoon|evening))\b|\?)/i.test(text) && text.length < 80) {
    return "chat";
  }
  if (/(summarize this (short )?text|quickly|briefly|in one (line|sentence))/.test(t) && text.length < 120) return "fast";
  if (
    /(fix (this |the )?(bug|error|issue)|debug|refactor|implement|build (a |the )?(feature|app|component|function|class|test)|write (a |some )?(function|component|class|file|test|code)|create a (file|component|function)|run |npm |npx |git |yarn |pnpm |typescript|javascript|python|react|compile|test |the code|code review|explain this code|delete (this |the )?|remove (this |the )?|rename (this |the )?|move (this |the )?|copy (this |the )?|create (a |the )?(folder|directory)|make a (folder|directory)|delete directory)/.test(t)
  ) {
    return "code";
  }
  if (/(analy(z|s)e (this |the )?(project|codebase|workspace|architecture)|architecture|large project|review this project|explain this project|understand this project|list (the )?files|what files|files in (this|the) (project|folder|workspace)|what['\u2019]s in (this|the) (folder|workspace|project))/.test(t)) {
    return "analysis";
  }
  return "chat";
}

/** Provider of a qualified model name (prefix scheme: puter/\u2026, openrouter/\u2026, minimax/\u2026, groq/\u2026). */
export function providerOfModel(modelName: string): ModelProvider {
  const lower = modelName.toLowerCase();
  if (lower.startsWith("puter/")) return "puter";
  if (lower.startsWith("openrouter/")) return "openrouter";
  if (lower.startsWith("minimax/")) return "minimax";
  if (lower.startsWith("groq/")) return "groq";
  if (lower.startsWith("ollama/")) return "ollama";
  return "gemini";
}

function familyScore(model: GeminiModel, task: TaskKind): number {
  const name = model.name.toLowerCase();
  const provider = model.provider ?? providerOfModel(model.name);
  const isPro = /pro|thinking|premium|3\.6|3\.5-flash-preview/.test(name);
  const isFlash = /flash/.test(name);
  const isLite = /lite|mini|light/.test(name);
  const limit = model.inputTokenLimit ?? model.contextLength ?? 0;
  const hasLongContext = limit >= 1_000_000;
  // Only assume tool support for Gemini native models — other providers
  // need explicit metadata to be treated as tool-capable.
  const supportsTools = model.supportsTools ?? (provider === "gemini" && !model.name.includes("/"));
  const isFree = Boolean(model.isFree);

  switch (task) {
    case "fast":
      return (isLite ? 30 : 0) + (isFlash ? 20 : 0) - (isPro ? 25 : 0) - (hasLongContext ? 10 : 0) + (isFree ? 5 : 0);
    case "code":
      // Strong coding/automation: prefer pro, long context, tool support
      return (isPro ? 30 : 0) + (hasLongContext ? 10 : 0) + (isFlash ? 8 : 0) - (isLite ? 30 : 0) + (supportsTools ? 15 : -40) + (isFree ? 5 : 0);
    case "analysis":
      return (isPro ? 35 : 0) + (hasLongContext ? 15 : 0) - (isLite ? 30 : 0) + (supportsTools ? 5 : 0);
    case "multimodal":
      return (/vision|image/.test(name) || model.supportsVision ? 30 : 0) + (isPro ? 10 : 0);
    default:
      // Simple conversation -> fastest capable model.
      return (isFlash ? 15 : 0) - (isPro ? 8 : 0) - (isLite ? 5 : 0) + (supportsTools ? 3 : -20) + (isFree ? 3 : 0);
  }
}

/**
 * Pick the best available model for a task using model metadata only.
 * `exclude` is a set of model keys (provider:modelName) that already failed
 * and must NOT be selected again within the same request.
 * Never returns a model not present in `models`.
 */
export function pickModel(models: GeminiModel[], task: TaskKind, exclude?: Set<string>): ModelChoice {
  if (models.length === 0) return { model: undefined, reason: TASK_REASONS[task], task };
  // A model the provider says cannot hold a text conversation (an
  // image-generation-only route, for example) must never be chosen to answer a
  // request: it would fail at the API instead of answering. Only an EXPLICIT
  // `false` disqualifies a model — unknown (`undefined`) never does, so a
  // catalog with thin metadata keeps every model it has. The fallback keeps a
  // mislabelled catalog from leaving Auto with nothing to pick.
  const chatCapable = models.filter((model) => model.supportsChat !== false);
  const candidates = chatCapable.length > 0 ? chatCapable : models;
  const ranked = [...candidates].sort((a, b) => familyScore(b, task) - familyScore(a, task));
  // Skip models that already failed this request
  if (exclude && exclude.size > 0) {
    for (const m of ranked) {
      if (!exclude.has(modelKey(m))) {
        return { model: m.name, reason: TASK_REASONS[task], task, excludedModels: Array.from(exclude) };
      }
    }
    // All models exhausted
    return { model: ranked[0].name, reason: `All available models failed — retrying ${modelShortName(ranked[0].name)}`, task, excludedModels: Array.from(exclude) };
  }
  return { model: ranked[0].name, reason: TASK_REASONS[task], task };
}

export function modelDisplayLabel(model?: GeminiModel): string {
  if (!model) return "Auto";
  return model.displayName ?? modelShortName(model.name);
}

/**
 * True when the user is asking for an actual local filesystem/workspace
 * operation (create/write/edit/delete/rename/move files or folders, list or
 * read project files). Used to refuse such requests deterministically when no
 * workspace is open, so Gemini never gets the chance to pretend it acted.
 */
export function isWorkspaceOperation(text: string): boolean {
  const t = text.toLowerCase();
  return /(create|write|make|add|edit|modify|update|change|delete|remove|rename|move|copy|open|read|show|list|find|search)\s+(a |the |this )?(file|folder|directory|project|workspace|src|package\.json|app\.tsx|readme)|create (a |the )?(react|next|node|electron|typescript|python) (project|app|app)|(make|create) a folder|list (the )?files|what files|files in (this|the)|delete (this |the )?file|create a file|write .* in (it|the file|test\.txt)|put .* in (it|the file)/.test(t);
}

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  groq: "Groq",
  puter: "Puter",
  ollama: "Ollama",
  omniroute: "OmniRoute"
};
