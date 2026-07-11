/**
 * OpenAI-chat delta assembly, done once and correctly (WS5.1).
 *
 * Fed the {@link SseEvent}s of an OpenAI Chat Completions stream, this rebuilds
 * a single turn: content and reasoning text, tool calls (fragmented arguments
 * merged by `index`, falling back to `id`, with id/index-less fragments
 * appended to the last open call), the finish reason, and the top-level `usage`
 * / `fusion` metadata. It replaces several ad-hoc assemblers that variously
 * dropped parallel tool calls, mis-attributed argument fragments, or silently
 * swallowed malformed JSON.
 */
import { SseParseError, type SseEvent } from "./parse.js";

export type AssembledToolCall = { id?: string; name?: string; arguments: string };

export type AssembledTurn = {
  content: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
  finishReason?: string;
  usage?: unknown;
  fusion?: unknown;
};

const DONE_SENTINEL = "[DONE]";
const SNIPPET_LIMIT = 200;

type RawToolCall = {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type RawChunk = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }>;
  usage?: unknown;
  fusion?: unknown;
};

type OpenCall = { id?: string; name?: string; arguments: string };

export class ChatStreamAssembler {
  #content = "";
  #reasoning = "";
  readonly #toolCalls: OpenCall[] = [];
  readonly #byIndex = new Map<number, OpenCall>();
  readonly #byId = new Map<string, OpenCall>();
  #lastOpen: OpenCall | undefined;
  #finishReason: string | undefined;
  #usage: unknown;
  #fusion: unknown;
  #truncated = true;

  /**
   * Merge one event. Empty `data` (keepalive) is ignored; the `[DONE]` sentinel
   * marks stream end (it does not, on its own, clear truncation). Malformed JSON
   * surfaces as {@link SseParseError} rather than being swallowed.
   */
  push(event: SseEvent): void {
    const data = event.data;
    if (data.length === 0) return;
    if (data === DONE_SENTINEL) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SseParseError(`malformed chat SSE JSON: ${detail}`, data.slice(0, SNIPPET_LIMIT));
    }
    this.#merge(json as RawChunk);
  }

  /**
   * Merge an already-parsed chunk. Lets buffered-scan callers that decode + JSON
   * parse an event once (for both assembly and, say, provider-cost extraction)
   * reuse this assembler without a second parse.
   */
  pushParsed(json: unknown): void {
    this.#merge(json as RawChunk);
  }

  result(): AssembledTurn {
    return {
      content: this.#content,
      reasoning: this.#reasoning,
      toolCalls: this.#toolCalls.map((call) => ({
        ...(call.id !== undefined ? { id: call.id } : {}),
        ...(call.name !== undefined ? { name: call.name } : {}),
        arguments: call.arguments
      })),
      ...(this.#finishReason !== undefined ? { finishReason: this.#finishReason } : {}),
      ...(this.#usage !== undefined ? { usage: this.#usage } : {}),
      ...(this.#fusion !== undefined ? { fusion: this.#fusion } : {})
    };
  }

  /** True until a `finish_reason` is seen; a `[DONE]` without one stays truncated. */
  get truncated(): boolean {
    return this.#truncated;
  }

  #merge(chunk: RawChunk): void {
    if (chunk.usage !== undefined && chunk.usage !== null) this.#usage = chunk.usage;
    if (chunk.fusion !== undefined && chunk.fusion !== null) this.#fusion = chunk.fusion;
    const choice = chunk.choices?.[0];
    if (choice === undefined) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") this.#content += delta.content;
    // `reasoning` (raw model thinking) and `reasoning_content` (narration beats)
    // both count as reasoning for reconstruction purposes.
    if (typeof delta.reasoning === "string") this.#reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === "string") this.#reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) this.#mergeToolCall(call as RawToolCall);
    }
    if (typeof choice.finish_reason === "string") {
      this.#finishReason = choice.finish_reason;
      this.#truncated = false;
    }
  }

  #mergeToolCall(raw: RawToolCall): void {
    const index = typeof raw.index === "number" ? raw.index : undefined;
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    const name = typeof raw.function?.name === "string" ? raw.function.name : undefined;
    const args = typeof raw.function?.arguments === "string" ? raw.function.arguments : undefined;

    let target: OpenCall | undefined;
    if (index !== undefined) target = this.#byIndex.get(index);
    else if (id !== undefined) target = this.#byId.get(id);
    else target = this.#lastOpen; // id/index-less fragment appends to the last open call

    if (target === undefined) {
      target = { arguments: "" };
      this.#toolCalls.push(target);
    }
    if (index !== undefined && !this.#byIndex.has(index)) this.#byIndex.set(index, target);
    if (id !== undefined && !this.#byId.has(id)) this.#byId.set(id, target);

    if (id !== undefined && target.id === undefined) target.id = id;
    if (name !== undefined && name.length > 0 && (target.name === undefined || target.name.length === 0)) {
      target.name = name;
    }
    if (args !== undefined && args.length > 0) target.arguments += args;
    this.#lastOpen = target;
  }
}
