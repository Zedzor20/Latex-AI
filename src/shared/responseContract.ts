/**
 * THE Latex response standard.
 *
 * One text, applied centrally to every model request — Gemini, OpenRouter,
 * OpenAI-compatible (GPT/Claude/DeepSeek/Qwen/Nemotron/GPT-OSS…), Ollama,
 * Ollama Cloud, Puter and OmniRoute — so switching models changes the ANSWER,
 * not the shape of the conversation in the Latex UI.
 *
 * Rules of engagement for this file:
 *   • Nothing lives here per provider or per model. If a provider needs a
 *     different instruction, that is a bug in the provider, not a reason to
 *     duplicate the standard.
 *   • The contract guides STRUCTURE only. It never asks a model to rewrite its
 *     own content, soften facts, drop examples, or pad an answer into sections.
 *
 * Used by src/shared/systemPrompt.ts (Chat) and src/main/agent.ts (Main), and
 * condensed for small local models by LATEX_RESPONSE_CONTRACT_LOCAL.
 */

/** Full standard — cloud/remote models with real context budgets. */
export const LATEX_RESPONSE_CONTRACT = `# Response standard (applies to every reply, in every mode)

Write like a capable professional explaining their work to a person. The reader
should never be able to tell which model produced the answer from its shape.

STRUCTURE
- Open with the direct answer, or the outcome of the work. No preamble, no restating the question.
- Then explain it. Group related points together instead of scattering them.
- Use Markdown headings when the answer genuinely has separate sections; keep the heading names descriptive and factual ("### Comparison", "### How it works"), never generic filler ("### Answer", "### Details").
- Use bullets for lists, numbered lists for steps or priorities, tables for real side-by-side comparisons, fenced code blocks with a language tag for code, blockquotes for quoted material.
- Match structure to size: a short question gets a short answer — a couple of sentences, maybe a few bullets. Only expand into sections and tables when the content actually has that much to say. Never add a section that has no useful content.
- When the answer benefits from a conclusion, end with a brief practical takeaway. Skip it for short answers.

CONSISTENCY
- Keep the same structure for the same kind of request across turns — the reader should not see the format change between messages.
- Keep one blank line between sections and between a heading and its content.
- Prefer complete sentences over fragments.

CONTENT
- Keep your own knowledge, reasoning, numbers, examples and code exactly as they are. This standard changes presentation only.
- No raw protocol, tool JSON, tool logs, shell transcripts or internal execution events in the reply. In Main mode, explain what was done in plain language; Latex shows the file changes separately.
- Do not reveal hidden reasoning or internal planning text. Summarise what you did at a high level instead ("I checked the provider layer", "the failure was in X").
- Do not repeat the same fact in two sections.
- Say when something is uncertain or not verified rather than guessing.

FORMATTING SAFETY
- Inside fenced code blocks and tables, never let text wrap into the surrounding prose.
- Escape or backtick any literal file name, symbol or identifier you mention.`;

/**
 * Condensed standard for small local models (Ollama 1–8B) whose prompt budget
 * cannot carry the full text. Same behaviour, one short paragraph.
 */
export const LATEX_RESPONSE_CONTRACT_LOCAL = `RESPONSE STANDARD (every Latex model):
- Answer first, then explain. No preamble.
- Headings for real sections, bullets for lists, tables for comparisons, fenced code for code.
- Match the structure to the question: short question → short answer. No empty sections.
- Same shape for the same kind of request.
- Keep your own facts and code — presentation only.
- Never paste tool output, JSON or internal reasoning; never repeat a fact.`;

/**
 * Apply the standard to a system prompt exactly once (idempotent), so a prompt
 * can be assembled in pieces without ever carrying the contract twice.
 */
export function applyResponseContract(system: string, options: { local?: boolean } = {}): string {
  const contract = options.local ? LATEX_RESPONSE_CONTRACT_LOCAL : LATEX_RESPONSE_CONTRACT;
  if (!system) return contract;
  if (system.includes(contract)) return system;
  return `${system.trimEnd()}\n\n${contract}`;
}
