/**
 * A {@link NarrationWriter} backed by any OpenAI-compatible chat function —
 * in practice a small local MLX model (the CLI wires `MlxBackend.chat` in),
 * but the shape (`Backend.chat`) works unchanged for any other endpoint.
 *
 * Prompting follows the settings that won the narration benchmark: a strict
 * one-sentence system prompt, thinking disabled (Qwen3's hybrid mode burns the
 * whole budget otherwise), temperature 0, and a small token cap. Everything is
 * advisory: any transport/shape problem returns `undefined`, which the beat
 * engine turns into the templated prose.
 */

import type { NarrationWriter } from "./narration.js";

/** The gateway `Backend.chat` shape: an OpenAI Chat Completions call. */
export type ChatFn = (body: unknown, signal?: AbortSignal) => Promise<Response>;

export type ChatNarrationWriterOptions = {
  chat: ChatFn;
  /** The model id sent in the request body. */
  model: string;
};

const SYSTEM_PROMPT =
  "You narrate a coding run for a status display. Reply with exactly ONE plain sentence, " +
  "max 18 words, present tense, no markdown, no quotes, no preamble, no explanation.";

/** Per-call output cap: one sentence, never a paragraph. */
const MAX_TOKENS = 48;
/** Input caps so a verbose candidate can't blow up the tiny model's context. */
const OUTPUT_SNIPPET_LIMIT = 400;
const DIFF_SNIPPET_LIMIT = 600;

function snippet(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Drop a leading `<think>…</think>` block (Qwen3 emits one when thinking sneaks on). */
function stripThinking(content: string): string {
  return content.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
}

async function ask(options: ChatNarrationWriterOptions, task: string, signal: AbortSignal): Promise<string | undefined> {
  const body = {
    model: options.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task }
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0,
    stream: false,
    // Qwen3 hybrid-thinking off (vLLM/SGLang-style kwarg); servers that don't
    // know the field ignore it, and stripThinking covers the rest.
    chat_template_kwargs: { enable_thinking: false }
  };
  try {
    const response = await options.chat(body, signal);
    if (!response.ok) return undefined;
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") return undefined;
    const cleaned = stripThinking(content);
    return cleaned.length > 0 ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

/** Build a chat-model-backed narration writer. */
export function createChatNarrationWriter(options: ChatNarrationWriterOptions): NarrationWriter {
  return {
    candidateGist: (input, signal) =>
      ask(
        options,
        `A coding model just finished a candidate solution. Its final message:\n` +
          `${snippet(input.finalOutput, OUTPUT_SNIPPET_LIMIT)}\n` +
          `One sentence: what did this candidate do?`,
        signal
      ),
    compareCandidates: (input, signal) => {
      const lines = input.candidates.map((candidate) => {
        const bits = [
          candidate.verificationStatus !== undefined ? `verification: ${candidate.verificationStatus}` : undefined,
          candidate.finalOutput !== undefined ? `says: ${snippet(candidate.finalOutput, OUTPUT_SNIPPET_LIMIT)}` : undefined,
          candidate.diff !== undefined ? `patch: ${snippet(candidate.diff, DIFF_SNIPPET_LIMIT)}` : undefined
        ].filter((bit): bit is string => bit !== undefined);
        return `- ${candidate.id}: ${bits.join(" | ") || "(no details)"}`;
      });
      return ask(
        options,
        `Candidate solutions from different models:\n${lines.join("\n")}\n` +
          `One sentence comparing them for the user.`,
        signal
      );
    }
  };
}
