import type { GeminiModel, ModelProvider } from "./types.js";

/**
 * PROVIDER-EXPOSED THINKING / REASONING CAPABILITY (shared, one source of truth).
 *
 * Latex renders a Thinking box from reasoning text that a PROVIDER ACTUALLY
 * EXPOSES to the application. This module answers one question for every
 * adapter, the model list and the model picker:
 *
 *     "Can our adapter surface this model's own thinking/reasoning summary?"
 *
 * It is deliberately NOT "does the model name look smart": a model called
 * `…-reasoning` is not eligible unless its provider API returns reasoning to
 * us. Nothing here invents thinking, and a model that is eligible but returns
 * nothing simply leaves the Thinking box honest ("No provider thinking
 * available") — the request itself is never affected.
 *
 * How each adapter surfaces reasoning (the field it really reads):
 *   gemini      → `candidates[].content.parts[].thought === true`
 *                 (thought summaries; requires thinkingConfig.includeThoughts)
 *   openai-*    → streamed `delta.reasoning_content` / `delta.reasoning`
 *   openrouter  → streamed `delta.reasoning` (OpenRouter normalizes reasoning)
 *   omniroute   → streamed `delta.reasoning_content` / `delta.reasoning`
 *   puter       → streamed chunk type `reasoning`
 *   ollama      → message `thinking` / `reasoning_content`
 */

export type ThinkingMode =
  /** Provider returns a human-readable reasoning SUMMARY alongside the answer. */
  | "summary"
  /** Provider streams raw reasoning tokens/content. */
  | "tokens"
  /** Not exposed. */
  | "none";

export interface ThinkingCapability {
  /** True only when this model's provider API exposes reasoning we can render. */
  supportsThinking: boolean;
  /**
   * The same fact as `supportsThinking`, under a name that cannot be confused
   * with the UI question below. `supportsThinking` is kept because existing
   * adapters/pickers already read it; new code should read THIS.
   */
  supportsExposedReasoning: boolean;
  /**
   * The DELIBERATELY SEPARATE question, and the fix for "Thinking is restricted
   * to models with explicit reasoning": can Latex show its Thinking EXPERIENCE
   * (the labelled state plus timer) for this model at all?
   *
   * True for any real text-chat model — including GPT and Claude models whose
   * API returns no displayable reasoning. In that case the box shows ONLY the
   * genuine processing state; no reasoning text is ever invented to fill it.
   */
  supportsThinkingUI: boolean;
  mode: ThinkingMode;
  /** True when the reasoning arrives progressively while streaming. */
  streaming: boolean;
  /** True when Latex must SEND a control parameter to receive reasoning. */
  reasoningControl: boolean;
  /** The provider field/parameter this capability relies on (diagnostics). */
  format: string;
  /** Why this model is (not) eligible — surfaced in the picker tooltip. */
  reason: string;
  /** Why the Thinking UI is (not) available — separate from `reason`. */
  uiReason: string;
}

/** The exposed-reasoning half, before the UI half is attached. */
type ExposedReasoning = Omit<ThinkingCapability, "supportsExposedReasoning" | "supportsThinkingUI" | "uiReason">;

const NOT_SUPPORTED = (reason: string, format = "none"): ExposedReasoning => ({
  supportsThinking: false,
  mode: "none",
  streaming: false,
  reasoningControl: false,
  format,
  reason
});

/** Models that are not text chat models at all — never eligible. */
const NON_CHAT = /embedding|embed|rerank|moderation|whisper|tts|audio|speech|transcri|imagen|veo|lyria|image|vision-ocr|dall-e|flux|stable-diffusion|nano-banana|computer-use|codex-mini|guard|safety/i;

/** Gemini thought summaries: available from 2.5 onwards. */
const GEMINI_THINKING = /^gemini-(2\.5|3|4|5|6)/i;
/** Gemini variants we will not enable thoughts on (specialised agent/utility models). */
const GEMINI_NO_THOUGHTS = /deep-research|antigravity|robotics|computer-use|learnlm|gemma/i;

/** OpenAI reasoning families, only where the ENDPOINT exposes the reasoning text. */
const OPENAI_REASONING = /(?:^|\/)(o1|o3|o4|o4-mini|gpt-5|gpt-5\.\d|gpt-oss)(?:[-/:.]|$)/i;

/** Reasoning families that stream `reasoning`/`reasoning_content` to us. */
const OPEN_REASONING = new RegExp(
  [
    "deepseek[-/]?(?:r1|reasoner|v3\\.1|v3\\.2|v4)",
    "qwq",
    "qwen3(?:\\.\\d+)?(?=[-/:.]|$)",
    "glm[-/]?(?:z1|4\\.5|4\\.6|5)",
    "magistral",
    "kimi[-_]?(?:k2[-_])?thinking",
    "minimax[-_]?m[12]",
    "gpt-oss",
    "grok[-/]?(?:3[-_]?mini|4|code)",
    "phi[-_]?4[-_]?reasoning",
    "granite[-_]?3\\.\\d+[-_]?reasoning",
    "seed[-_]?oss",
    "step[-_]?3",
    // "nemotron-super", "nemotron-3-super-cloud", "nemotron-ultra".
    "nemotron[-_]?(?:\\d+(?:\\.\\d+)?[-_])?(?:super|ultra|reasoning)",
    "ernie[-_]?(?:x1|4\\.5)",
    // Claude extended thinking starts at 3.7: "claude-opus-4.8", "claude-haiku-4.5",
    // "claude-3.7-sonnet" — but NOT "claude-3.5-sonnet".
    "claude[-/]?(?:[a-z0-9.]+[-/])?(?:3\\.[7-9]|[4-9])"
  ].join("|"),
  "i"
);

/**
 * Gemini models proxied by another provider ("google/gemini-3.5-flash") still
 * expose reasoning, so the family match is allowed after a namespace slash.
 */
const PROXIED_GEMINI = /(?:^|\/)gemini-(?:2\.5|3|4|5|6)/i;
/**
 * Names that mean the variant does NOT expose thinking by default: explicit
 * non-thinking flags and plain `instruct` builds whose reasoning is off unless
 * a caller opts in. Latex never opts a model in silently, so they stay out of
 * the Thinking filter.
 */
const THINKING_DISABLED_BY_NAME = /non[-_]?thinking|no[-_]?think|think[-_]?false|[-_]instruct\b|instruct[-_]/i;

const PROVIDER_MATRIX: Record<ModelProvider, { format: string; mode: ThinkingMode; control: boolean; reason: string }> = {
  gemini: {
    format: "generationConfig.thinkingConfig.includeThoughts → parts[].thought",
    mode: "summary",
    control: true,
    reason: "Gemini returns thought summaries for 2.5+ models when includeThoughts is enabled."
  },
  openrouter: {
    format: "delta.reasoning",
    mode: "tokens",
    control: false,
    reason: "OpenRouter returns a normalized `reasoning` stream for models that support it."
  },
  omniroute: {
    format: "delta.reasoning_content | delta.reasoning",
    mode: "tokens",
    control: false,
    reason: "OmniRoute proxies reasoning-capable models through the OpenAI-compatible stream."
  },
  puter: {
    format: "chunk.type === \"reasoning\"",
    mode: "tokens",
    control: false,
    reason: "Puter forwards the upstream reasoning stream as a reasoning chunk."
  },
  groq: {
    format: "delta.reasoning",
    mode: "tokens",
    control: false,
    reason: "Groq returns a `reasoning` field for models that emit reasoning."
  },
  minimax: {
    format: "delta.reasoning_content | delta.reasoning_details",
    mode: "tokens",
    control: false,
    reason: "MiniMax returns reasoning_content / reasoning_details for its reasoning models (M2 interleaved thinking)."
  },
  ollama: {
    format: "message.thinking | message.reasoning_content",
    mode: "tokens",
    control: false,
    reason: "Ollama returns `thinking` for local models that support it."
  }
};

/**
 * Detect whether a model's provider API exposes reasoning we can render.
 *
 * `hints` lets a provider pass REAL metadata (a capability list from the
 * provider's own model endpoint). Only an exact reasoning/thinking capability
 * hint is honoured; keyword matches on a model name are never enough on their
 * own.
 */
/**
 * Can Latex legitimately show its Thinking experience for this model?
 *
 * This is the UI question ONLY — it says nothing about whether reasoning text
 * will arrive. Any real text-chat model qualifies, which is what puts GPT and
 * Claude into the Thinking experience instead of excluding them for lacking an
 * exposed reasoning channel.
 */
export function thinkingUiEligibility(
  provider: ModelProvider | undefined,
  modelId: string
): { eligible: boolean; reason: string } {
  const id = (modelId ?? "").trim();
  if (!id) return { eligible: false, reason: "No model selected." };
  if (!provider || !PROVIDER_MATRIX[provider]) {
    return { eligible: false, reason: "This provider does not serve text chat." };
  }
  const bare = id.replace(/^models\//, "");
  if (NON_CHAT.test(bare)) return { eligible: false, reason: "Not a text chat model." };
  return {
    eligible: true,
    reason: "Latex can show its Thinking state for any text model; provider reasoning is displayed only when the provider actually exposes it."
  };
}

/**
 * PROVIDER-EXPOSED reasoning capability, exactly as before this split.
 * Kept as its own function because the request-side logic ("should we ask the
 * provider for reasoning?") must keep using THIS and never the UI flag.
 */
function exposedReasoningCapability(
  provider: ModelProvider | undefined,
  modelId: string,
  hints?: { capabilities?: string[] }
): ExposedReasoning {
  const id = (modelId ?? "").trim();
  if (!id) return NOT_SUPPORTED("No model selected.");
  const entry = provider ? PROVIDER_MATRIX[provider] : undefined;
  if (!entry) return NOT_SUPPORTED("This provider does not report reasoning support.");

  const bare = id.replace(/^models\//, "");
  if (NON_CHAT.test(bare)) {
    return NOT_SUPPORTED("Not a text chat model.", entry.format);
  }
  if (THINKING_DISABLED_BY_NAME.test(bare)) {
    return NOT_SUPPORTED("This variant disables thinking.", entry.format);
  }

  const supported = (mode: ThinkingMode = entry.mode): ExposedReasoning => ({
    supportsThinking: true,
    mode,
    streaming: true,
    reasoningControl: entry.control,
    format: entry.format,
    reason: entry.reason
  });

  // Provider metadata that explicitly lists reasoning/thinking support.
  const explicit = (hints?.capabilities ?? []).some((cap) => /^(reasoning|thinking|hybrid[-_]thinking)$/i.test(cap.trim()));

  if (provider === "gemini") {
    if (GEMINI_THINKING.test(bare) && !GEMINI_NO_THOUGHTS.test(bare)) return supported("summary");
    if (explicit) return supported("summary");
    return NOT_SUPPORTED("This Gemini model does not return thought summaries.", entry.format);
  }

  if (provider === "ollama") {
    // Local models: Ollama exposes `thinking` for reasoning-capable families.
    if (OPEN_REASONING.test(bare) || /think/i.test(bare)) return supported("tokens");
    if (explicit) return supported("tokens");
    return NOT_SUPPORTED("This local model does not expose thinking.", entry.format);
  }

  // OpenAI-compatible endpoints: reasoning is only claimed for families whose
  // reasoning text the Chat Completions stream really carries for this provider.
  if (provider === "groq" || provider === "minimax") {
    if (OPEN_REASONING.test(bare)) return supported("tokens");
    if (explicit) return supported("tokens");
    return NOT_SUPPORTED("This model does not return reasoning in the chat stream.", entry.format);
  }

  // Proxies (OpenRouter / OmniRoute / Puter) also expose OpenAI/Gemini/Anthropic
  // reasoning, so those families are eligible here even though the direct
  // OpenAI chat-completions endpoint would not return their reasoning text.
  if (OPEN_REASONING.test(bare) || OPENAI_REASONING.test(bare) || PROXIED_GEMINI.test(bare)) return supported("tokens");
  if (explicit) return supported("tokens");
  return NOT_SUPPORTED("This model does not expose reasoning through this provider.", entry.format);
}

/**
 * The full thinking picture for one model: the two INDEPENDENT questions.
 *
 *   supportsThinkingUI          → may Latex show the Thinking experience?
 *   supportsExposedReasoning    → will the provider actually stream reasoning?
 *
 * Composing them here is what stops "does the provider expose reasoning" from
 * ever again standing in for "can the user see the Thinking experience".
 */
export function thinkingCapability(
  provider: ModelProvider | undefined,
  modelId: string,
  hints?: { capabilities?: string[] }
): ThinkingCapability {
  const exposed = exposedReasoningCapability(provider, modelId, hints);
  const ui = thinkingUiEligibility(provider, modelId);
  return {
    ...exposed,
    supportsExposedReasoning: exposed.supportsThinking,
    supportsThinkingUI: ui.eligible,
    uiReason: ui.reason
  };
}

/** Thinking capability for a model entry from any provider's model list. */
export function thinkingCapabilityOfModel(model: Pick<GeminiModel, "name" | "provider" | "capabilities">): ThinkingCapability {
  const provider = (model.provider ?? providerFromName(model.name)) as ModelProvider | undefined;
  return thinkingCapability(provider, model.name, { capabilities: model.capabilities });
}

/**
 * True when a model's provider API exposes reasoning to Latex.
 *
 * Capability only — this says nothing about which providers the Thinking
 * FILTER lists. The filter additionally restricts the provider set below.
 */
export function modelSupportsThinking(model: Pick<GeminiModel, "name" | "provider" | "capabilities">): boolean {
  return thinkingCapabilityOfModel(model).supportsThinking;
}

/**
 * True when Latex can show its Thinking EXPERIENCE for this model.
 *
 * Deliberately independent of `modelSupportsThinking`: a GPT or Claude model
 * with no exposed reasoning still gets the Thinking state and timer.
 */
export function modelSupportsThinkingUI(model: Pick<GeminiModel, "name" | "provider" | "capabilities">): boolean {
  return thinkingCapabilityOfModel(model).supportsThinkingUI;
}

/**
 * Providers allowed in the Thinking filter, in the REQUIRED display order:
 * Puter → Ollama → OmniRoute → MiniMax → Gemini. OpenRouter (and every other
 * provider) is deliberately excluded from the filter — its models remain fully
 * available in All Models and its own provider filter.
 */
export const THINKING_FILTER_ORDER: readonly ModelProvider[] = ["puter", "ollama", "omniroute", "minimax", "gemini"];

export function thinkingProviderAllowed(provider: ModelProvider | undefined): boolean {
  return Boolean(provider && THINKING_FILTER_ORDER.includes(provider));
}

/**
 * True when the model picker should list this exact provider+model under the
 * Thinking filter: the provider is one of the five allowed, AND that exact
 * model's provider API genuinely exposes reasoning to Latex. Never a
 * provider-wide or name-only assumption.
 */
export function modelEligibleForThinkingFilter(
  model: Pick<GeminiModel, "name" | "provider" | "capabilities">
): boolean {
  const provider = (model.provider ?? providerFromName(model.name)) as ModelProvider | undefined;
  if (!thinkingProviderAllowed(provider)) return false;
  // SEMANTICS (changed deliberately): the filter lists models for which Latex
  // can provide the Thinking EXPERIENCE — not only the models whose provider
  // exposes raw reasoning. GPT/Claude-class models now belong here, and the box
  // simply shows the honest processing state for the ones that expose nothing.
  return thinkingCapabilityOfModel(model).supportsThinkingUI;
}

/**
 * Stable, quality-oriented ordering for the Thinking filter (strongest →
 * lighter). Uses ONLY real model metadata and family tier — never an invented
 * benchmark score. Providers that report a context size or tool/vision support
 * are ranked higher; "lite/mini/nano" variants rank below their full siblings.
 */
export function thinkingQualityScore(
  model: Pick<GeminiModel, "name" | "displayName" | "contextLength" | "inputTokenLimit" | "supportsTools" | "supportsVision">
): number {
  const text = `${model.displayName ?? ""} ${model.name}`.toLowerCase();
  let score = 0;
  // Parameter-size signals (local + open models).
  const params = text.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (params) score += Math.min(60, Math.round(parseFloat(params[1]) / 2));
  // Tier words. Strongest first, then balanced, then light.
  if (/\b(pro|opus|ultra|max|super|large|thinking|premier|·)\b/.test(text)) score += 40;
  if (/\b(flash|sonnet|turbo|medium|balanced)\b/.test(text)) score += 20;
  if (/\b(lite|mini|nano|small|tiny|light|fast|1\.5b|3b)\b/.test(text)) score -= 30;
  const ctx = model.inputTokenLimit ?? model.contextLength ?? 0;
  score += Math.min(30, Math.round(ctx / 32_000));
  if (model.supportsTools) score += 8;
  if (model.supportsVision) score += 2;
  return score;
}

/** Sort comparator: strongest/most capable verified thinking model first. */
export function compareThinkingModels(
  a: Pick<GeminiModel, "name" | "displayName" | "contextLength" | "inputTokenLimit" | "supportsTools" | "supportsVision">,
  b: Pick<GeminiModel, "name" | "displayName" | "contextLength" | "inputTokenLimit" | "supportsTools" | "supportsVision">
): number {
  return thinkingQualityScore(b) - thinkingQualityScore(a);
}

/**
 * Stable key for a model's persisted Thinking preference.
 *
 * Names one EXACT provider+model, so an explicit preference for model A can
 * never leak onto model B — the requirement that switching models must not
 * carry an unsupported Thinking setting falls out of the key's shape.
 */
export function thinkingPreferenceKey(provider: ModelProvider | undefined, modelId: string | undefined): string | null {
  const id = (modelId ?? "").trim();
  if (!provider || !id) return null;
  return `${provider}:${id}`;
}

/**
 * Resolve whether provider-side thinking should be REQUESTED/SHOWN for a model.
 *
 * Default is the model's real capability (ON only when the provider API
 * genuinely exposes reasoning to Latex). An EXPLICIT user preference — stored
 * per provider+model — always wins, so a model the user turned off stays off,
 * and a model that cannot do thinking can never inherit an ON setting.
 */
export function resolveThinkingEnabled(
  preferences: Record<string, boolean> | undefined,
  provider: ModelProvider | undefined,
  modelId: string | undefined,
  hints?: { capabilities?: string[] }
): boolean {
  const supported = thinkingCapability(provider, modelId ?? "", hints).supportsThinking;
  const key = thinkingPreferenceKey(provider, modelId);
  // An explicit OFF always wins. An explicit ON is still clamped to the real
  // capability, so an unsupported Thinking setting can never be carried into a
  // model whose provider API cannot use it.
  if (key && preferences && key in preferences) return preferences[key] === true && supported;
  return supported;
}

/**
 * Resolve whether the Thinking EXPERIENCE is shown for a model.
 *
 * Default is ON for every text-chat model — including GPT and Claude, which is
 * exactly the point: the experience is NOT gated on the provider exposing
 * reasoning. An explicit per-model OFF still wins, and a model that cannot show
 * the experience at all (image / embedding / audio endpoints) is never eligible.
 *
 * This NEVER decides whether reasoning is requested from the provider — that
 * stays `resolveThinkingEnabled`'s job, so nothing here can change what is sent.
 */
export function resolveThinkingUIEnabled(
  preferences: Record<string, boolean> | undefined,
  provider: ModelProvider | undefined,
  modelId: string | undefined
): boolean {
  if (!thinkingUiEligibility(provider, modelId ?? "").eligible) return false;
  const key = thinkingPreferenceKey(provider, modelId);
  if (key && preferences && key in preferences) return preferences[key] === true;
  return true;
}

/** Short badge for model rows ("Thinking" summary models, "Reasoning" token streams). */
export function thinkingBadgeLabel(cap: ThinkingCapability): string | undefined {
  if (!cap.supportsThinking) return undefined;
  return cap.mode === "summary" ? "Thinking" : "Reasoning";
}

// ── Provider-exposed IMAGE GENERATION capability ─────────────────────────
/**
 * A model can only produce an image when its provider API really RETURNS image
 * data to us. This never claims an image was generated: the capability decides
 * whether we enable image output on the request, and the adapter only reports an
 * image when an actual inline image part arrived.
 *
 *   gemini → `generateContent` with `responseModalities: ["TEXT","IMAGE"]`,
 *            image data returned as `parts[].inlineData` (Nano Banana family).
 *
 * Text-only models stay text-only — a request that mentions an image must never
 * make a text model pretend it produced one.
 */
export interface ImageGenerationCapability {
  supportsImageGeneration: boolean;
  /** True when the model accepts an input image and returns an edited one. */
  supportsImageEditing: boolean;
  /** How the adapter requests image output (diagnostics). */
  method: "gemini-native" | "openai-image" | "none";
  /** Why this model is (not) eligible — surfaced in the picker tooltip. */
  reason: string;
}

const NO_IMAGE = (reason: string, method: ImageGenerationCapability["method"] = "none"): ImageGenerationCapability => ({
  supportsImageGeneration: false,
  supportsImageEditing: false,
  method,
  reason
});

/**
 * Gemini native image generation ("Nano Banana" / Gemini image family). The
 * model id always carries `image` (gemini-2.5-flash-image, gemini-3-pro-image,
 * …-image-preview); the older `nano-banana` alias is kept for compatibility.
 * Imagen-only ids are NOT included: Latex does not hardcode an Imagen-only path.
 */
export const GEMINI_IMAGE_MODEL = /(?:^|\/)gemini-[a-z0-9.\-]*image(?:[-a-z0-9.]*)?$|(?:^|\/)gemini-[a-z0-9.\-]*-image(?:[-a-z0-9.]*)?|nano-banana/i;

/**
 * Image-generation model ids on OpenAI-compatible providers (OpenRouter,
 * OmniRoute, Groq, MiniMax, Puter, Ollama). The adapter reads the generated
 * picture out of the response's inline image part, so a model only needs its
 * id to name image generation to be requestable. The pattern is used BOTH to
 * claim the capability and to find a routing target for an explicit image
 * request; the adapter still reports an image only when one really arrived.
 */
export const OPENAI_IMAGE_MODEL = /(?:^|[-/])(?:gpt-image|dall-e|dalle|flux|stable-diffusion|sd[0-9x]|nano-banana|seedream|qwen-image|imagen|image-gen|txt2img)[a-z0-9.\-_]*|(?:^|[-/])gemini-[a-z0-9.\-]*image(?:[-a-z0-9.]*)?/i;

/** Image-capable model pattern per provider (used to find a routing target). */
export function preferredImageModelPattern(provider: ModelProvider): RegExp | undefined {
  if (provider === "gemini") return GEMINI_IMAGE_MODEL;
  // OpenAI-compatible providers expose image models whose ids carry a
  // recognisable image keyword; use that to locate a routing target.
  return OPENAI_IMAGE_MODEL;
}

/**
 * Detect whether a model's provider API can return generated image data.
 * `hints.capabilities` lets a provider pass REAL metadata from its own model
 * endpoint; a capability list is never inferred from the model name alone.
 */
export function imageGenerationCapability(
  provider: ModelProvider | undefined,
  modelId: string,
  hints?: { capabilities?: string[] }
): ImageGenerationCapability {
  const id = (modelId ?? "").trim();
  if (!id) return NO_IMAGE("No model selected.");
  if (!provider) return NO_IMAGE("This provider does not report image generation support.");

  const bare = id.replace(/^models\//, "");
  const explicit = (hints?.capabilities ?? []).some((cap) => /^(image[-_]?generation|image[-_]?output|image[-_]?editing)$/i.test(cap.trim()));

  if (provider === "gemini") {
    if (GEMINI_IMAGE_MODEL.test(bare) || explicit) {
      return {
        supportsImageGeneration: true,
        // Gemini's image models accept input images, so text-and-image-to-image
        // editing works through the same request path.
        supportsImageEditing: true,
        method: "gemini-native",
        reason: "Gemini returns generated image data inline (parts[].inlineData) when responseModalities includes IMAGE."
      };
    }
    return NO_IMAGE("This Gemini model returns text only, not generated image data.");
  }

  // Other providers (OpenAI-compatible: OpenRouter, OmniRoute, Groq, MiniMax,
  // Puter, Ollama). The adapter now reads generated image data out of an inline
  // image part in the response, so a model whose id names image generation (or
  // which the provider explicitly marks) can really return a picture. The
  // capability only decides whether image output is REQUESTED — the adapter
  // reports an image only when an actual image part arrived.
  if (explicit || OPENAI_IMAGE_MODEL.test(bare)) {
    return {
      supportsImageGeneration: true,
      supportsImageEditing: false,
      method: "openai-image",
      reason: "This model returns generated image data as an inline image part in the OpenAI-compatible response."
    };
  }
  return NO_IMAGE("This provider does not return generated image data to Latex.");
}

/** Image capability for a model entry from any provider's model list. */
export function imageGenerationCapabilityOfModel(model: Pick<GeminiModel, "name" | "provider" | "capabilities">): ImageGenerationCapability {
  const provider = (model.provider ?? providerFromName(model.name)) as ModelProvider | undefined;
  return imageGenerationCapability(provider, model.name, { capabilities: model.capabilities });
}

/** True when the picker should mark this model as able to generate images. */
export function modelSupportsImageGeneration(model: Pick<GeminiModel, "name" | "provider" | "capabilities">): boolean {
  return imageGenerationCapabilityOfModel(model).supportsImageGeneration;
}

/** Short badge for model rows of image-capable models. */
export function imageGenerationBadgeLabel(cap: ImageGenerationCapability): string | undefined {
  return cap.supportsImageGeneration ? "Image" : undefined;
}

const NAME_PREFIXES: Array<[RegExp, ModelProvider]> = [
  [/^models\//, "gemini"],
  [/^openrouter\//, "openrouter"],
  [/^omniroute\//, "omniroute"],
  [/^minimax\//, "minimax"],
  [/^groq\//, "groq"],
  [/^puter\//, "puter"],
  [/^ollama\//, "ollama"]
];

/** Provider implied by a model id prefix (provider-qualified model names). */
export function providerFromName(modelId: string): ModelProvider | undefined {
  const id = (modelId ?? "").trim();
  for (const [pattern, provider] of NAME_PREFIXES) {
    if (pattern.test(id)) return provider;
  }
  return undefined;
}
