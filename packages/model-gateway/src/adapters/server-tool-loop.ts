/**
 * The server-tool inner loop (gateway-executed web search).
 *
 * When the upstream model calls a *server-executed* tool (today: `web_search`),
 * nobody on the caller's side can answer it — the caller declared the tool
 * expecting the "server" to run it. This loop makes the gateway that server:
 * it intercepts server-tool calls from a model step, executes them via a
 * {@link WebSearchExecutor}, appends the exchange to the chat transcript, and
 * runs another model step — repeating until a step commits to something the
 * caller can actually handle (text, client tool calls, or a clean stop).
 *
 * The loop operates at the chat-completions layer, around `backend.chat`:
 * each inner step is an ordinary backend turn, exactly as
 * if the caller had executed a client tool and come back. The dialect egress
 * translators stay single-stream: in streaming mode the loop composes the
 * steps' chat SSE into one continuous stream, suppressing the server-tool
 * fragments and injecting {@link ServerToolMarker} chunks (an in-process
 * convention) that the translators render as their dialect's native search
 * items (`web_search_call` / `server_tool_use` + `web_search_tool_result`).
 *
 * Mixed batches (server + client calls in one step) terminate the turn: the
 * client calls surface and the server calls are dropped un-executed — results
 * could not be fed back into a turn that just ended, and the upstream model can
 * simply re-issue the search next turn.
 */

import { randomId } from "@routekit/runtime";

import { SseDecoder } from "../sse/parse.js";
import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import type { AssembledToolCall } from "../sse/chat-assembler.js";
import { MAX_WEB_SEARCHES_PER_TURN } from "./web-search.js";
import type { WebSearchExecutor, WebSearchOutcome } from "./web-search.js";

const ENCODER = new TextEncoder();

/** Absolute bound on model steps per caller turn (defense against a model that
 *  keeps searching after being told the search budget is exhausted). */
const MAX_LOOP_STEPS = 16;

/** In-process marker chunk field the loop injects between composed steps. */
export const SERVER_TOOL_MARKER_FIELD = "routekit_server_tool";

export type ServerToolMarker = {
  kind: "web_search";
  phase: "start" | "done";
  item_id: string;
  query: string;
  status?: "completed" | "failed";
  /** Anthropic-native result blocks for the Anthropic egress (done phase). */
  result_blocks?: unknown[];
};

/** The marker on a parsed chat chunk, if present. */
export function serverToolMarkerOf(chunk: unknown): ServerToolMarker | undefined {
  if (chunk === null || typeof chunk !== "object") return undefined;
  const marker = (chunk as Record<string, unknown>)[SERVER_TOOL_MARKER_FIELD];
  return marker !== null && typeof marker === "object" ? (marker as ServerToolMarker) : undefined;
}

export type ExecutedSearch = {
  itemId: string;
  query: string;
  status: "completed" | "failed";
  outcome?: WebSearchOutcome;
};

export type ServerToolLoopOptions = {
  /** The translated chat body; the loop appends search exchanges to `messages`. */
  chat: Record<string, unknown>;
  runStep: (chat: Record<string, unknown>) => Promise<Response>;
  serverToolNames: ReadonlySet<string>;
  executor: WebSearchExecutor;
  maxSearches?: number;
  signal?: AbortSignal;
};

type RawToolCall = {
  index?: unknown;
  id?: string;
  function?: { name?: string; arguments?: string };
};

function callName(call: { name?: string } | RawToolCall): string {
  return "function" in call && call.function !== undefined ? (call.function.name ?? "") : ((call as { name?: string }).name ?? "");
}

function queryOf(args: string | undefined): string {
  if (args === undefined || args.trim().length === 0) return "";
  try {
    const parsed = JSON.parse(args) as { query?: unknown };
    return typeof parsed.query === "string" ? parsed.query : args;
  } catch {
    return args;
  }
}

function renderSearchResult(search: ExecutedSearch): string {
  if (search.status === "failed" || search.outcome === undefined) {
    return `[web_search_error] the search could not be executed${
      search.outcome?.text !== undefined && search.outcome.text.length > 0 ? `: ${search.outcome.text}` : ""
    }. Answer from what you already know, or try a different query.`;
  }
  const sources = search.outcome.citations.map(
    (citation) => `- ${citation.url}${citation.title !== undefined ? ` (${citation.title})` : ""}`
  );
  return sources.length > 0 ? `${search.outcome.text}\n\nSources:\n${sources.join("\n")}` : search.outcome.text;
}

const LIMIT_MESSAGE =
  "[web_search_limit] the web search budget for this turn is exhausted; answer with the information you already have.";

function chatMessages(chat: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(chat.messages)) chat.messages = [];
  return chat.messages as Record<string, unknown>[];
}

/**
 * Execute one pure-server step's calls (respecting the remaining budget) and
 * append the assistant tool-call message + tool results to the transcript.
 * Emits `onSearch` start/done callbacks around each execution so the streaming
 * composer can inject markers live.
 */
async function executeServerCalls(input: {
  options: ServerToolLoopOptions;
  calls: readonly { id?: string; name?: string; arguments?: string }[];
  stepContent: string | undefined;
  searches: ExecutedSearch[];
  onSearchStart?: (search: { itemId: string; query: string }) => void;
  onSearchDone?: (search: ExecutedSearch) => void;
}): Promise<void> {
  const { options, calls, searches } = input;
  const max = options.maxSearches ?? MAX_WEB_SEARCHES_PER_TURN;
  const messages = chatMessages(options.chat);
  const toolCalls = calls.map((call) => ({
    id: call.id ?? `call_${randomId()}`,
    type: "function",
    function: { name: call.name ?? "web_search", arguments: call.arguments ?? "" }
  }));
  messages.push({
    role: "assistant",
    content: typeof input.stepContent === "string" && input.stepContent.length > 0 ? input.stepContent : null,
    tool_calls: toolCalls
  });
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    if (call === undefined) continue;
    const query = queryOf(call.arguments);
    const callId = toolCalls[i]?.id ?? `call_${randomId()}`;
    if (searches.length >= max) {
      messages.push({ role: "tool", tool_call_id: callId, content: LIMIT_MESSAGE });
      continue;
    }
    const itemId = `ws_${randomId()}`;
    input.onSearchStart?.({ itemId, query });
    let search: ExecutedSearch;
    try {
      const outcome = await options.executor.search(query, options.signal);
      search = { itemId, query, status: "completed", outcome };
    } catch (error) {
      search = {
        itemId,
        query,
        status: "failed",
        outcome: { text: error instanceof Error ? error.message : String(error), citations: [] }
      };
    }
    searches.push(search);
    input.onSearchDone?.(search);
    messages.push({ role: "tool", tool_call_id: callId, content: renderSearchResult(search) });
  }
}

// ---- buffered mode ----

export type BufferedLoopOutcome =
  | { kind: "openai"; openai: Record<string, unknown>; searches: ExecutedSearch[] }
  | { kind: "upstream_error"; response: Response };

/**
 * Run the loop over buffered (non-streaming) model steps. `firstStep` is the
 * already-awaited first model step (the handler surfaces its HTTP errors
 * before entering the loop). Returns the terminal step's OpenAI payload (with
 * any un-executable mixed-batch server calls stripped) plus the searches
 * executed along the way, for the dialect egress to render as native items.
 */
export async function runBufferedServerToolLoop(
  options: ServerToolLoopOptions & { firstStep: Response }
): Promise<BufferedLoopOutcome> {
  const searches: ExecutedSearch[] = [];
  for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
    const upstream = step === 0 ? options.firstStep : await options.runStep(options.chat);
    if (!upstream.ok) return { kind: "upstream_error", response: upstream };
    const openai = (await upstream.json()) as Record<string, unknown>;
    const choice = (Array.isArray(openai.choices) ? openai.choices[0] : undefined) as
      | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
      | undefined;
    const message = choice?.message;
    const calls = (Array.isArray(message?.tool_calls) ? message.tool_calls : []) as RawToolCall[];
    const server = calls.filter((call) => options.serverToolNames.has(callName(call)));
    const client = calls.filter((call) => !options.serverToolNames.has(callName(call)));
    if (server.length === 0) return { kind: "openai", openai, searches };
    if (client.length > 0 || typeof choice?.finish_reason !== "string") {
      // Mixed batch (or truncated step): surface what the caller can handle;
      // the un-executable server calls are dropped, the model can re-search
      // next turn.
      if (message !== undefined) message.tool_calls = client;
      return { kind: "openai", openai, searches };
    }
    // Past the search budget, executeServerCalls answers each call with a
    // limit notice instead of executing — the model gets one more step to
    // answer from what it has (MAX_LOOP_STEPS bounds a model that will not).
    await executeServerCalls({
      options,
      calls: server.map((call) => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments })),
      stepContent: typeof message?.content === "string" ? message.content : undefined,
      searches
    });
  }
  return {
    kind: "openai",
    openai: {
      choices: [
        { index: 0, message: { role: "assistant", content: LIMIT_MESSAGE }, finish_reason: "stop" }
      ]
    },
    searches
  };
}

// ---- streaming mode ----

type StepForwardState = {
  /** Suppressed (server-tool) fragment keys within the current step. */
  suppressedIndexes: Set<number>;
  suppressedIds: Set<string>;
  lastFragmentSuppressed: boolean;
  /** The step's finish chunk, held until the loop decides it is terminal. */
  heldFinishChunk: Record<string, unknown> | undefined;
};

function isFragmentSuppressed(state: StepForwardState, call: RawToolCall, serverToolNames: ReadonlySet<string>): boolean {
  const index = typeof call.index === "number" ? call.index : undefined;
  const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
  const name = call.function?.name;
  if (typeof name === "string" && name.length > 0) {
    const suppressed = serverToolNames.has(name);
    if (suppressed) {
      if (index !== undefined) state.suppressedIndexes.add(index);
      if (id !== undefined) state.suppressedIds.add(id);
    }
    state.lastFragmentSuppressed = suppressed;
    return suppressed;
  }
  const suppressed =
    index !== undefined
      ? state.suppressedIndexes.has(index)
      : id !== undefined
        ? state.suppressedIds.has(id)
        : state.lastFragmentSuppressed;
  state.lastFragmentSuppressed = suppressed;
  return suppressed;
}

function encodeChunk(chunk: Record<string, unknown>): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function markerChunk(marker: ServerToolMarker): Uint8Array {
  return encodeChunk({ [SERVER_TOOL_MARKER_FIELD]: marker });
}

type UsageTotals = { prompt: number; completion: number; seen: boolean };

function accumulateUsage(totals: UsageTotals, usage: unknown): void {
  if (usage === null || typeof usage !== "object") return;
  const source = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  if (typeof source.prompt_tokens === "number") totals.prompt += source.prompt_tokens;
  if (typeof source.completion_tokens === "number") totals.completion += source.completion_tokens;
  totals.seen = true;
}

/**
 * Compose the loop's model steps into one continuous chat SSE stream.
 *
 * `firstStep` is the already-awaited first model step (the handler surfaces
 * its HTTP errors exactly as the single-step path does). Server-tool call
 * fragments are suppressed from the forwarded stream; each executed search is
 * injected as a pair of {@link ServerToolMarker} chunks for the dialect
 * translator. Per-step usage is withheld and re-emitted summed before the
 * terminal finish chunk, so the client-visible usage covers the whole loop.
 */
export function composeServerToolStream(
  options: ServerToolLoopOptions & { firstStep: Response }
): ReadableStream<Uint8Array> {
  const searches: ExecutedSearch[] = [];
  const totals: UsageTotals = { prompt: 0, completion: 0, seen: false };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          let upstream: Response = options.firstStep;
          for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
            if (step > 0) {
              upstream = await options.runStep(options.chat);
              if (!upstream.ok) {
                throw new Error(
                  `model step failed mid web-search loop (${upstream.status}): ${(await upstream.text()).slice(0, 500)}`
                );
              }
            }
            const source = upstream.body;
            if (source === null) throw new Error("model step produced no stream mid web-search loop");
            const terminal = await forwardStep(controller, source);
            if (terminal) {
              controller.close();
              return;
            }
          }
          // Step bound exhausted: close the turn rather than looping forever.
          finalize(controller, "stop");
        } catch (error) {
          controller.error(error);
          return;
        }
        controller.close();
      })();
    }
  });

  /** Emit summed usage + a finish chunk + [DONE], ending the composed stream. */
  function finalize(
    controller: ReadableStreamDefaultController<Uint8Array>,
    finishReason: string,
    heldFinishChunk?: Record<string, unknown>
  ): void {
    if (totals.seen) {
      controller.enqueue(
        encodeChunk({
          choices: [],
          usage: {
            prompt_tokens: totals.prompt,
            completion_tokens: totals.completion,
            total_tokens: totals.prompt + totals.completion
          }
        })
      );
    }
    controller.enqueue(
      encodeChunk(heldFinishChunk ?? { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
    );
    controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
  }

  /**
   * Forward one step's SSE into the composed stream. Returns true when the
   * step was terminal (stream finished); false when the loop must run another
   * model step (a pure server-tool step whose searches were executed).
   */
  async function forwardStep(
    controller: ReadableStreamDefaultController<Uint8Array>,
    source: ReadableStream<Uint8Array>
  ): Promise<boolean> {
    const reader = source.getReader();
    const decoder = new SseDecoder();
    const assembler = new ChatStreamAssembler();
    const state: StepForwardState = {
      suppressedIndexes: new Set(),
      suppressedIds: new Set(),
      lastFragmentSuppressed: false,
      heldFinishChunk: undefined
    };
    let stepContent = "";

    const handleData = (data: string): void => {
      if (data.length === 0 || data === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        // Forward unparseable payloads untouched; the dialect translator owns
        // strictness (it raises SseParseError on malformed chunks).
        controller.enqueue(ENCODER.encode(`data: ${data}\n\n`));
        return;
      }
      assembler.pushParsed(chunk);
      let rewritten = chunk;
      if (chunk.usage !== undefined && chunk.usage !== null) {
        accumulateUsage(totals, chunk.usage);
        rewritten = { ...rewritten };
        delete rewritten.usage;
      }
      const choice = (Array.isArray(rewritten.choices) ? rewritten.choices[0] : undefined) as
        | { delta?: Record<string, unknown>; finish_reason?: unknown }
        | undefined;
      const delta = choice?.delta;
      if (typeof delta?.content === "string") stepContent += delta.content;
      if (choice !== undefined && Array.isArray(delta?.tool_calls)) {
        const kept = (delta.tool_calls as RawToolCall[]).filter(
          (call) => !isFragmentSuppressed(state, call, options.serverToolNames)
        );
        if (kept.length !== delta.tool_calls.length) {
          rewritten = {
            ...rewritten,
            choices: [{ ...choice, delta: { ...delta, tool_calls: kept } }]
          };
          const rewrittenChoice = (rewritten.choices as Array<{ delta: Record<string, unknown> }>)[0];
          if (kept.length === 0 && rewrittenChoice !== undefined) delete rewrittenChoice.delta.tool_calls;
        }
      }
      const finishReason = choice?.finish_reason;
      if (typeof finishReason === "string") {
        // Hold the finish: whether it surfaces depends on what the step
        // committed to (decided once the step's stream ends).
        state.heldFinishChunk = rewritten;
        return;
      }
      const survivingChoice = (Array.isArray(rewritten.choices) ? rewritten.choices[0] : undefined) as
        | { delta?: Record<string, unknown> }
        | undefined;
      const emptyDelta =
        survivingChoice?.delta !== undefined && Object.keys(survivingChoice.delta).length === 0;
      const bareUsageChunk =
        chunk.usage !== undefined && (rewritten.choices === undefined || (rewritten.choices as unknown[]).length === 0);
      if (emptyDelta || bareUsageChunk) return;
      controller.enqueue(encodeChunk(rewritten));
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        for (const event of decoder.flush()) handleData(event.data);
        break;
      }
      if (value !== undefined) {
        for (const event of decoder.feed(value)) handleData(event.data);
      }
    }

    const turn = assembler.result();
    const server = turn.toolCalls.filter((call: AssembledToolCall) => options.serverToolNames.has(call.name ?? ""));
    const client = turn.toolCalls.filter((call: AssembledToolCall) => !options.serverToolNames.has(call.name ?? ""));
    const pureServerStep = server.length > 0 && client.length === 0 && turn.finishReason !== undefined;

    if (!pureServerStep) {
      if (state.heldFinishChunk !== undefined) {
        finalize(controller, "stop", state.heldFinishChunk);
      } else if (turn.finishReason === undefined) {
        // Truncated upstream: end without a finish chunk so the translator
        // reports the turn as incomplete rather than fabricating completion.
        controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
      } else {
        finalize(controller, turn.finishReason);
      }
      return true;
    }

    await executeServerCalls({
      options,
      calls: server.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      stepContent: stepContent.length > 0 ? stepContent : undefined,
      searches,
      onSearchStart: (search) => {
        controller.enqueue(
          markerChunk({ kind: "web_search", phase: "start", item_id: search.itemId, query: search.query })
        );
      },
      onSearchDone: (search) => {
        controller.enqueue(
          markerChunk({
            kind: "web_search",
            phase: "done",
            item_id: search.itemId,
            query: search.query,
            status: search.status,
            ...(search.outcome?.anthropicResultBlocks !== undefined
              ? { result_blocks: search.outcome.anthropicResultBlocks }
              : search.outcome !== undefined && search.status === "completed"
                ? {
                    result_blocks: search.outcome.citations.map((citation) => ({
                      type: "web_search_result",
                      url: citation.url,
                      ...(citation.title !== undefined ? { title: citation.title } : {})
                    }))
                  }
                : {})
          })
        );
      }
    });
    return false;
  }
}
