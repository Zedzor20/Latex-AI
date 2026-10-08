/**
 * WHAT DID THE USER ASK FOR, and WHERE DOES THAT REQUEST GO?
 *
 * These are the two halves of one decision, which is why they live together:
 *
 *   1. INTENT — is this turn an image-generation request, or a normal chat /
 *      coding / vision request? The user asking "what is this image?" wants an
 *      ANSWER ABOUT a picture; "generate an image of a Minecraft house" wants a
 *      picture PRODUCED. Those must never collapse into one another.
 *
 *   2. ENDPOINT — given the intent and the model's REAL capabilities, which
 *      endpoint serves it? A gateway like OmniRoute is OpenAI-compatible but
 *      exposes image generation on `/v1/images/generations`, and it REJECTS an
 *      image-generation model posted to `/v1/chat/completions`:
 *
 *        "Model 'aihorde/Qwen-Image_fp8' is an image-generation model and
 *         cannot be used on /v1/chat/completions. Use POST
 *         /v1/images/generations instead."
 *
 *      That request must never be sent. The decision is made here, from
 *      CAPABILITIES — never from a hardcoded model id — so every present and
 *      future image model routes correctly.
 *
 * The two capabilities are deliberately independent, and neither is a synonym
 * for the other:
 *
 *   supportsImageGeneration  → the model can CREATE an image
 *   supportsChat             → the model can hold a text conversation
 *   supportsVision           → the model can RECEIVE an image
 *
 * A vision model is not an image generator; an image generator need not be able
 * to chat; and a model may be able to do both. `resolveProviderEndpoint` is the
 * only place that maps those facts to an endpoint, so the rule cannot drift
 * between callers.
 */

/** What the user's turn is actually asking for. */
export type RequestIntent = "chat" | "image_generation";

/** Endpoints an OpenAI-compatible gateway can be asked to serve. */
export type ProviderEndpoint = "/v1/chat/completions" | "/v1/images/generations";

/**
 * The capability facts the routing decision is allowed to depend on.
 *
 * Both are required booleans on purpose: a caller must state what it knows
 * rather than let `undefined` silently mean "yes" and route an image model into
 * the chat endpoint.
 */
export interface RouteableCapabilities {
  supportsChat: boolean;
  supportsImageGeneration: boolean;
}

export interface RouteDecision {
  /** False when no endpoint can serve this intent for this model. */
  ok: boolean;
  /** The endpoint to use, or null when the combination is unsupported. */
  endpoint: ProviderEndpoint | null;
  /** Why — surfaced to the user when `ok` is false. */
  reason: string;
}

/**
 * An EXPLICIT image-generation request: a production verb acting on an image
 * noun ("generate an image", "create a thumbnail", "draw a logo"), or the
 * model being told to return the picture itself.
 *
 * Deliberately verb-anchored. "image" on its own is not a request to make one,
 * which is what keeps "what is this image?" out of this path.
 */
export const IMAGE_GENERATION_INTENT_PATTERN =
  /\b(?:generate|create|make|draw|design|render|produce|paint|sketch|illustrate|give me)\b[^.!?]{0,60}\b(?:image|picture|photo|illustration|logo|artwork|poster|thumbnail|icon|avatar|wallpaper|sprite|render)\b|\b(?:edit|modify|change|alter|retouch)\b[^.!?]{0,60}\b(?:image|picture|photo)\b|\b(?:image|picture|photo|illustration|logo|artwork|poster|thumbnail|avatar)\s+(?:generation|creation)\b|\b(?:text|txt)\s*2\s*(?:image|img)\b|\bgenerate\s+(?:this|it|that)\s+as\s+an\s+image\b/i;

/**
 * A request to UNDERSTAND an existing image. These are vision turns: the model
 * receives the picture and answers about it, and no image is created.
 *
 * "create a description of this image" satisfies the generation pattern's verb
 * and noun, so this guard is what keeps it a vision turn.
 */
export const IMAGE_UNDERSTANDING_INTENT_PATTERN =
  /\b(?:what|which|who|where|when|why|how)\b[^.!?]{0,40}\b(?:image|picture|photo|screenshot|this)\b|\b(?:describ\w*|explanation|explain|analy[sz]\w*|read|interpret\w*|identif\w*|recogni[sz]\w*|extract|transcri\w*|summari[sz]\w*|caption\w*|review|critique|compare)\b[^.!?]{0,40}\b(?:image|picture|photo|screenshot|diagram|chart|logo|attachment)\b|\b(?:image|picture|photo|screenshot)\s+(?:understanding|analysis|description|recognition|captioning)\b|\bwhat(?:'s| is)\s+(?:in|on)\s+(?:this|the|that)\s+(?:image|picture|photo|screenshot)\b/i;

/**
 * True only for an explicit image-GENERATION request.
 *
 * A prompt that asks about an image is never one, even when it happens to
 * contain a production verb: the understanding pattern wins.
 */
export function imageGenerationIntent(text: string): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  if (IMAGE_UNDERSTANDING_INTENT_PATTERN.test(value)) return false;
  return IMAGE_GENERATION_INTENT_PATTERN.test(value);
}

/** The request intent for a user prompt. Anything that is not image generation is chat. */
export function imageRequestIntent(text: string): RequestIntent {
  return imageGenerationIntent(text) ? "image_generation" : "chat";
}

/**
 * The single endpoint rule for an OpenAI-compatible gateway.
 *
 * Intent decides what is wanted; capabilities decide what is possible. Neither
 * alone is enough — which is exactly the bug this replaces, where every request
 * went to `/v1/chat/completions` regardless of either.
 */
export function resolveProviderEndpoint(
  intent: RequestIntent,
  capabilities: RouteableCapabilities
): RouteDecision {
  if (intent === "image_generation") {
    if (capabilities.supportsImageGeneration) {
      return {
        ok: true,
        endpoint: "/v1/images/generations",
        reason: "The model can create images, so the request goes to the image-generation endpoint."
      };
    }
    return {
      ok: false,
      endpoint: null,
      reason: capabilities.supportsChat
        ? "This model cannot generate images. Select an image-generation model, or ask it a normal question."
        : "This model cannot generate images."
    };
  }

  if (capabilities.supportsChat) {
    return {
      ok: true,
      endpoint: "/v1/chat/completions",
      reason: "The model holds a text conversation, so the request goes to the chat-completions endpoint."
    };
  }
  return {
    ok: false,
    endpoint: null,
    reason: capabilities.supportsImageGeneration
      ? "This model is an image-generation model. Use an image-generation request or select a chat model for normal conversation."
      : "This model does not support chat requests."
  };
}
