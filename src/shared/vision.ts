/**
 * Centralized image-attachment normalization for the vision pipeline.
 *
 * Every provider request goes through these helpers so image handling is
 * consistent: raw base64 (never a renderer-only blob URL), a valid image
 * MIME type, and dev logging that proves the image is in the outgoing
 * payload — without ever logging image data or credentials.
 */
import type { Attachment, ChatMessage } from "./types.js";

/**
 * The provider-facing shape of one transcript message. `parts` carries the
 * visible text; `attachments` is the transport for images/file content that
 * must never appear in the chat UI.
 */
export interface ProviderMessage {
  role: "user" | "model";
  parts: Array<{ text: string }>;
  attachments?: Attachment[];
}

export interface NormalizedImage {
  mimeType: string;
  /** Raw base64 WITHOUT the `data:` prefix. */
  base64: string;
  /** Approximate decoded byte size (for logging/verification). */
  bytes: number;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif"
};

/**
 * Normalize an image attachment into provider-ready form.
 *  - strips an accidental `data:<mime>;base64,` prefix
 *  - resolves MIME from the attachment, data URL, or file extension
 *  - validates the base64 payload before it is ever sent
 * Returns null when the payload is unusable — callers must then FAIL the
 * image request (never silently downgrade to text-only).
 */
export function normalizeImageAttachment(
  att: Partial<Pick<Attachment, "base64" | "mimeType" | "name">>
): NormalizedImage | null {
  let data = (att.base64 ?? "").trim();
  if (!data) return null;
  let mime = (att.mimeType ?? "").trim().toLowerCase();

  // Strip data URL prefix if present (defensive — renderer/file picker
  // normally store raw base64 already).
  const dataUrlMatch = /^data:([^;,]*)(;base64)?,/i.exec(data);
  if (dataUrlMatch) {
    if (!mime) mime = (dataUrlMatch[1] || "").trim().toLowerCase();
    data = data.slice(dataUrlMatch[0].length);
  }

  if (!mime) {
    const ext = (att.name ?? "").split(".").pop()?.toLowerCase() ?? "";
    mime = MIME_BY_EXT[ext] ?? "image/png";
  } else if (!mime.includes("/")) {
    mime = `image/${mime}`;
  }

  data = data.replace(/\s+/g, "");
  if (data.length < 16) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;

  return { mimeType: mime, base64: data, bytes: Math.floor((data.length * 3) / 4) };
}

/** OpenAI-compatible `data:` URL for image_url parts. */
export function imageDataUrl(
  att: Partial<Pick<Attachment, "base64" | "mimeType" | "name">>
): string | null {
  const norm = normalizeImageAttachment(att);
  if (!norm) return null;
  return `data:${norm.mimeType};base64,${norm.base64}`;
}

/** The usable image attachments from a list (kind=image with base64 data). */
export function imagesOf(attachments?: Attachment[] | readonly Attachment[] | null): Attachment[] {
  if (!attachments) return [];
  return attachments.filter((a) => a.kind === "image" && Boolean(a.base64)) as Attachment[];
}

/** The attachments persisted on one message (meta.attachments). */
export function messageAttachments(message: Pick<ChatMessage, "meta">): Attachment[] {
  return (message.meta?.attachments as Attachment[] | undefined) ?? [];
}

/**
 * Does the message being sent RIGHT NOW carry an image?
 *
 * The modality of a request is decided by the CURRENT user message only — the
 * message the user is sending with this prompt. Images attached to an EARLIER
 * message in the same chat never make a later text-only turn multimodal, so a
 * text-only model can keep chatting in a conversation that once contained an
 * image. An image is sent only when it is attached to this exact message
 * (`meta.attachments` on the last user message) or passed as a fresh
 * attachment for this send.
 */
export function currentTurnHasImage(
  messages: readonly Pick<ChatMessage, "role" | "meta">[],
  fresh?: readonly Attachment[] | null
): boolean {
  if (imagesOf(fresh).length > 0) return true;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser ? imagesOf(messageAttachments(lastUser)).length > 0 : false;
}

/**
 * Build ONE provider message from a chat message.
 *
 * Images are included ONLY when `includeImages` is true — which the caller sets
 * from `currentTurnHasImage`. This is the single choke point that keeps an
 * image from an older message out of a later text-only request. FILE content
 * (text/workspace/conversation) is always carried, because it is text and can
 * never misclassify the request as multimodal.
 */
export function toProviderMessage(message: ChatMessage, includeImages: boolean): ProviderMessage {
  const meta = messageAttachments(message);
  const images = includeImages ? imagesOf(meta) : [];
  const files = meta.filter(
    (a) =>
      (a.kind === "text" || a.kind === "workspace" || a.kind === "conversation") && Boolean(a.content)
  );
  const carried = [...images, ...files];
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
    ...(carried.length > 0 ? { attachments: carried } : {})
  };
}

/**
 * The usable FILE attachments from a list — non-image kinds that carry
 * extracted text (text/workspace/conversation). File content travels only
 * through the provider request layer, never inside the visible message text.
 */
export function filesOf(attachments?: Attachment[] | readonly Attachment[] | null): Attachment[] {
  if (!attachments) return [];
  return attachments.filter(
    (a) =>
      (a.kind === "text" || a.kind === "workspace" || a.kind === "conversation") && Boolean(a.content)
  ) as Attachment[];
}

/** Provider-facing text block for a file attachment (`[Attachment: name]`). */
export function attachmentBlock(att: Attachment): string {
  const truncated = att.truncated
    ? `\n\n_(This file was truncated; showing the first ${att.content?.length ?? 0} characters.)_`
    : "";
  return `\n\n[Attachment: ${att.name}]${truncated}\n${att.content ?? ""}`;
}

/** Sum of approximate decoded bytes across normalized images. */
export function imageBytes(attachments: Attachment[]): number {
  let bytes = 0;
  for (const att of attachments) {
    const norm = normalizeImageAttachment(att);
    if (norm) bytes += norm.bytes;
  }
  return bytes;
}

/**
 * Dev log proving the image entered the outgoing provider payload.
 * Logs counts/sizes only — never image data, keys, or prompts.
 */
export function logVision(provider: string, imageCount: number, bytes: number, messageCount?: number): void {
  if (imageCount <= 0) return;
  console.log(
    `[Vision] provider=${provider} images=${imageCount} bytes≈${bytes}${messageCount !== undefined ? ` messages=${messageCount}` : ""}`
  );
}
