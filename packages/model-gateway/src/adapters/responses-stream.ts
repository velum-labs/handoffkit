import { randomId } from "@fusionkit/runtime-utils";
import { SseDecoder, SseParseError } from "../sse/parse.js";
import type { OpenAiChoice } from "./openai-chat-wire.js";
import { serverToolMarkerOf } from "./server-tool-loop.js";
import type { ServerToolMarker } from "./server-tool-loop.js";

const ENCODER = new TextEncoder();

type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };
type OpenAiChunk = { choices?: OpenAiChoice[]; usage?: OpenAiUsage | null; provider_cost?: unknown };
type ResponsesToolKind = "function" | "custom" | "typed" | "server";
type ResponsesToolRegistry = ReadonlyMap<string, { kind: ResponsesToolKind; namespace?: string }>;

function typedToolArguments(args: string): unknown {
  if (args.trim().length === 0) return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}

function typedToolCallItem(input: {
  name: string;
  itemId: string;
  callId: string;
  args: string;
}): Record<string, unknown> {
  return {
    type: `${input.name}_call`,
    id: input.itemId,
    call_id: input.callId,
    status: "completed",
    execution: "client",
    arguments: typedToolArguments(input.args)
  };
}

function customToolInput(args: string): string {
  if (args.trim().length === 0) return "";
  try {
    const parsed = JSON.parse(args) as { input?: unknown };
    return typeof parsed.input === "string" ? parsed.input : args;
  } catch {
    return args;
  }
}

function sse(type: string, data: Record<string, unknown>, sequenceNumber: number): Uint8Array {
  return ENCODER.encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...data })}\n\n`
  );
}

type ToolAccumulator = {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  args: string;
  /**
   * How this call must be emitted (see {@link ResponsesToolKind}). Custom and
   * typed calls buffer their arguments — a custom tool's raw input and a typed
   * tool's JSON arguments value are only extractable once the arguments are
   * complete — so neither streams per-delta argument events.
   */
  kind: ResponsesToolKind;
  /** Namespace for discovered tools (routes the call alongside the name). */
  namespace?: string;
};

/** The completed output item for an accumulated streamed tool call. */
function streamedToolItem(tool: ToolAccumulator): Record<string, unknown> {
  switch (tool.kind) {
    case "custom":
      return {
        type: "custom_tool_call",
        id: tool.itemId,
        call_id: tool.callId,
        name: tool.name,
        input: customToolInput(tool.args),
        status: "completed"
      };
    case "typed":
      return typedToolCallItem({
        name: tool.name,
        itemId: tool.itemId,
        callId: tool.callId,
        args: tool.args
      });
    case "function":
      return {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.callId,
        name: tool.name,
        ...(tool.namespace !== undefined ? { namespace: tool.namespace } : {}),
        arguments: tool.args,
        status: "completed"
      };
    case "server":
      // Unreachable in practice: the server-tool loop intercepts these calls
      // before they reach the translator. Render the native item shape so a
      // stray call never surfaces as a function_call nobody dispatches.
      return {
        type: "web_search_call",
        id: tool.itemId,
        status: "completed",
        action: { type: "search", query: webSearchQueryOf(tool.args) }
      };
    default: {
      const exhaustive: never = tool.kind;
      throw new Error(`unknown tool kind: ${String(exhaustive)}`);
    }
  }
}

/** The `query` from a web_search call's JSON arguments (raw args as fallback). */
function webSearchQueryOf(args: string): string {
  try {
    const parsed = JSON.parse(args) as { query?: unknown };
    if (typeof parsed.query === "string") return parsed.query;
  } catch {
    // fall through to the raw argument string
  }
  return args;
}

export function openAiSseToResponses(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  toolRegistry: ResponsesToolRegistry = new Map()
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const sseDecoder = new SseDecoder();
  const responseId = `resp_${randomId()}`;
  const messageItemId = `msg_${randomId()}`;
  const reasoningItemId = `rs_${randomId()}`;
  // Tool fragments keyed by `index`, falling back to `id`, with id/index-less
  // fragments appended to the last open call (parallel index-less calls no
  // longer collapse into one — the same fix the shared assembler encodes).
  // `toolList` preserves open order for the finalize/assemble passes.
  const toolByIndex = new Map<number, ToolAccumulator>();
  const toolById = new Map<string, ToolAccumulator>();
  const toolList: ToolAccumulator[] = [];
  let lastTool: ToolAccumulator | undefined;
  let created = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let textOpen = false;
  let textValue = "";
  let reasoningOpen = false;
  let reasoningClosed = false;
  const reasoningParts: string[] = [];
  let reasoningOutputIndex = -1;
  /** Index into `reasoningParts` of the open token-accumulating part, or -1. */
  let tokenPartIndex = -1;
  let nextOutputIndex = 0;
  let messageOutputIndex = -1;
  let finished = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let providerCost: unknown;
  let sequenceNumber = 0;

  const emit = (type: string, data: Record<string, unknown>): Uint8Array => {
    const encoded = sse(type, data, sequenceNumber);
    sequenceNumber += 1;
    return encoded;
  };

  type Controller = ReadableStreamDefaultController<Uint8Array>;

  // Gateway-executed web searches (server-tool loop markers): open item per
  // search, completed items collected for the terminal response payload.
  const openSearches = new Map<string, { outputIndex: number }>();
  const completedSearchItems: Record<string, unknown>[] = [];

  const baseResponse = (status: string, output: Record<string, unknown>[]): Record<string, unknown> => ({
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage:
      status === "completed"
        ? inputTokens !== undefined || outputTokens !== undefined
          ? {
              ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
              ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
              ...(inputTokens !== undefined && outputTokens !== undefined
                ? { total_tokens: inputTokens + outputTokens }
                : {})
            }
          : null
        : null,
    ...(status === "completed" && providerCost !== undefined ? { provider_cost: providerCost } : {})
  });

  const ensureCreated = (controller: Controller): void => {
    if (created) return;
    created = true;
    controller.enqueue(emit("response.created", { response: baseResponse("in_progress", []) }));
  };

  // Reasoning summary item lifecycle. The item opens on the first reasoning
  // delta and closes as soon as the first real output (text or tool call)
  // begins. Two delta flavors share the item:
  // - `reasoning_content` (fusion narration): each delta is a complete beat,
  //   so each becomes its OWN summary part (added -> delta -> done). Codex
  //   flushes reasoning to the transcript on summary-part boundaries and
  //   promotes the newest part's bold header to its live status, so per-beat
  //   parts are what make the narration visible as it happens.
  // - `reasoning` (the model's raw thinking tokens): deltas are token
  //   fragments, so they accumulate into ONE summary part that stays open
  //   until a beat arrives or the reasoning item closes.
  const ensureReasoningItem = (controller: Controller): void => {
    ensureCreated(controller);
    if (reasoningOpen || reasoningClosed) return;
    reasoningOpen = true;
    reasoningOutputIndex = nextOutputIndex++;
    controller.enqueue(
      emit("response.output_item.added", {
        output_index: reasoningOutputIndex,
        item: { type: "reasoning", id: reasoningItemId, summary: [] }
      })
    );
  };

  const emitReasoningPart = (controller: Controller, text: string): void => {
    ensureReasoningItem(controller);
    if (reasoningClosed) return;
    closeTokenPart(controller);
    const summaryIndex = reasoningParts.length;
    reasoningParts.push(text);
    const base = { item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: summaryIndex };
    controller.enqueue(
      emit("response.reasoning_summary_part.added", { ...base, part: { type: "summary_text", text: "" } })
    );
    controller.enqueue(emit("response.reasoning_summary_text.delta", { ...base, delta: text }));
    controller.enqueue(emit("response.reasoning_summary_text.done", { ...base, text }));
    controller.enqueue(
      emit("response.reasoning_summary_part.done", { ...base, part: { type: "summary_text", text } })
    );
  };

  // The single accumulating part for raw thinking tokens (`delta.reasoning`).
  const emitReasoningTokenDelta = (controller: Controller, text: string): void => {
    ensureReasoningItem(controller);
    if (reasoningClosed) return;
    if (tokenPartIndex === -1) {
      tokenPartIndex = reasoningParts.length;
      reasoningParts.push("");
      controller.enqueue(
        emit("response.reasoning_summary_part.added", {
          item_id: reasoningItemId,
          output_index: reasoningOutputIndex,
          summary_index: tokenPartIndex,
          part: { type: "summary_text", text: "" }
        })
      );
    }
    reasoningParts[tokenPartIndex] += text;
    controller.enqueue(
      emit("response.reasoning_summary_text.delta", {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: tokenPartIndex,
        delta: text
      })
    );
  };

  const closeTokenPart = (controller: Controller): void => {
    if (tokenPartIndex === -1) return;
    const text = reasoningParts[tokenPartIndex] ?? "";
    const base = { item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: tokenPartIndex };
    tokenPartIndex = -1;
    controller.enqueue(emit("response.reasoning_summary_text.done", { ...base, text }));
    controller.enqueue(
      emit("response.reasoning_summary_part.done", { ...base, part: { type: "summary_text", text } })
    );
  };

  const reasoningSummary = (): Array<Record<string, unknown>> =>
    reasoningParts.map((text) => ({ type: "summary_text", text }));

  const closeReasoning = (controller: Controller): void => {
    if (!reasoningOpen || reasoningClosed) return;
    closeTokenPart(controller);
    reasoningClosed = true;
    controller.enqueue(
      emit("response.output_item.done", {
        output_index: reasoningOutputIndex,
        item: { type: "reasoning", id: reasoningItemId, summary: reasoningSummary() }
      })
    );
  };

  const ensureText = (controller: Controller): void => {
    ensureCreated(controller);
    closeReasoning(controller);
    if (textOpen) return;
    textOpen = true;
    messageOutputIndex = nextOutputIndex++;
    controller.enqueue(
      emit("response.output_item.added", {
        output_index: messageOutputIndex,
        item: { type: "message", id: messageItemId, status: "in_progress", role: "assistant", content: [] }
      })
    );
    controller.enqueue(
      emit("response.content_part.added", {
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      })
    );
  };

  // The server-tool loop injects marker chunks around each gateway-executed
  // web search; render them as the native web_search_call item lifecycle.
  const handleServerToolMarker = (controller: Controller, marker: ServerToolMarker): void => {
    if (marker.phase === "start") {
      ensureCreated(controller);
      closeReasoning(controller);
      const outputIndex = nextOutputIndex++;
      openSearches.set(marker.item_id, { outputIndex });
      controller.enqueue(
        emit("response.output_item.added", {
          output_index: outputIndex,
          item: {
            type: "web_search_call",
            id: marker.item_id,
            status: "in_progress",
            action: { type: "search", query: marker.query }
          }
        })
      );
      controller.enqueue(emit("response.web_search_call.in_progress", { output_index: outputIndex, item_id: marker.item_id }));
      controller.enqueue(emit("response.web_search_call.searching", { output_index: outputIndex, item_id: marker.item_id }));
      return;
    }
    const outputIndex = openSearches.get(marker.item_id)?.outputIndex ?? nextOutputIndex++;
    openSearches.delete(marker.item_id);
    const item = {
      type: "web_search_call",
      id: marker.item_id,
      status: marker.status === "failed" ? "failed" : "completed",
      action: { type: "search", query: marker.query }
    };
    completedSearchItems.push(item);
    controller.enqueue(emit("response.web_search_call.completed", { output_index: outputIndex, item_id: marker.item_id }));
    controller.enqueue(emit("response.output_item.done", { output_index: outputIndex, item }));
  };

  const assembleOutput = (): Record<string, unknown>[] => {
    const output: Record<string, unknown>[] = [];
    if (reasoningParts.length > 0) {
      output.push({ type: "reasoning", id: reasoningItemId, summary: reasoningSummary() });
    }
    output.push(...completedSearchItems);
    if (textOpen) {
      output.push({
        type: "message",
        id: messageItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: textValue, annotations: [] }]
      });
    }
    for (const tool of toolList) {
      output.push(streamedToolItem(tool));
    }
    return output;
  };

  const finalize = (controller: Controller, terminal: "completed" | "incomplete" = "completed"): void => {
    if (finished) return;
    finished = true;
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    closeReasoning(controller);
    if (textOpen) {
      controller.enqueue(
        emit("response.output_text.done", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          text: textValue
        })
      );
      controller.enqueue(
        emit("response.content_part.done", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: textValue, annotations: [] }
        })
      );
      controller.enqueue(
        emit("response.output_item.done", {
          output_index: messageOutputIndex,
          item: {
            type: "message",
            id: messageItemId,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: textValue, annotations: [] }]
          }
        })
      );
    }
    for (const tool of toolList) {
      if (tool.kind === "custom") {
        // The raw input is only extractable from the completed JSON arguments,
        // so a custom call flushes its whole input here in one delta + done.
        const input = customToolInput(tool.args);
        const base = { item_id: tool.itemId, output_index: tool.outputIndex };
        controller.enqueue(emit("response.custom_tool_call_input.delta", { ...base, delta: input }));
        controller.enqueue(emit("response.custom_tool_call_input.done", { ...base, input }));
        controller.enqueue(
          emit("response.output_item.done", { output_index: tool.outputIndex, item: streamedToolItem(tool) })
        );
        continue;
      }
      if (tool.kind === "typed" || tool.kind === "server") {
        // A typed/server tool's native item carries its arguments as a
        // completed JSON value, so it flushes whole in the item.done (no
        // argument deltas).
        controller.enqueue(
          emit("response.output_item.done", { output_index: tool.outputIndex, item: streamedToolItem(tool) })
        );
        continue;
      }
      controller.enqueue(
        emit("response.function_call_arguments.done", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          arguments: tool.args
        })
      );
      controller.enqueue(
        emit("response.output_item.done", { output_index: tool.outputIndex, item: streamedToolItem(tool) })
      );
    }
    // Truncation is an error, not a clean stop: an upstream that ended without a
    // finish_reason terminates as `response.incomplete`, never a fabricated
    // `response.completed` (WS5.2), so callers that meter/persist see the turn
    // as incomplete.
    controller.enqueue(
      terminal === "completed"
        ? emit("response.completed", { response: baseResponse("completed", assembleOutput()) })
        : emit("response.incomplete", { response: baseResponse("incomplete", assembleOutput()) })
    );
  };

  const process = (controller: Controller, chunk: OpenAiChunk): void => {
    // Real OpenAI streams carry `"usage": null` on every chunk except the
    // final usage chunk, so a null must read as "absent".
    inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
    outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
    if (chunk.provider_cost !== undefined) providerCost = chunk.provider_cost;
    const choice = chunk.choices?.[0];
    if (choice === undefined) return;
    const delta = choice.delta ?? {};

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0 && !reasoningClosed) {
      emitReasoningPart(controller, delta.reasoning_content);
    }

    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0 && !reasoningClosed) {
      emitReasoningTokenDelta(controller, delta.reasoning);
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureText(controller);
      textValue += delta.content;
      controller.enqueue(
        emit("response.output_text.delta", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: delta.content
        })
      );
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const indexKey = typeof call.index === "number" ? call.index : undefined;
        const idKey = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
        let tool =
          indexKey !== undefined
            ? toolByIndex.get(indexKey)
            : idKey !== undefined
              ? toolById.get(idKey)
              : lastTool;
        if (tool === undefined) {
          ensureCreated(controller);
          closeReasoning(controller);
          const name = call.function?.name ?? "";
          const entry = toolRegistry.get(name) ?? { kind: "function" as const };
          const kind = entry.kind;
          tool = {
            outputIndex: nextOutputIndex++,
            itemId:
              kind === "custom"
                ? `ctc_${randomId()}`
                : kind === "typed"
                  ? `ttc_${randomId()}`
                  : kind === "server"
                    ? `ws_${randomId()}`
                    : `fc_${randomId()}`,
            callId: call.id ?? `call_${randomId()}`,
            name,
            args: "",
            kind,
            ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {})
          };
          toolList.push(tool);
          controller.enqueue(
            emit("response.output_item.added", {
              output_index: tool.outputIndex,
              item:
                kind === "custom"
                  ? { type: "custom_tool_call", id: tool.itemId, call_id: tool.callId, name: tool.name, input: "" }
                  : kind === "typed"
                    ? { type: `${tool.name}_call`, id: tool.itemId, call_id: tool.callId, status: "in_progress", execution: "client", arguments: {} }
                    : kind === "server"
                      ? { type: "web_search_call", id: tool.itemId, status: "in_progress", action: { type: "search" } }
                      : {
                          type: "function_call",
                          id: tool.itemId,
                          call_id: tool.callId,
                          name: tool.name,
                          ...(tool.namespace !== undefined ? { namespace: tool.namespace } : {}),
                          arguments: ""
                        }
            })
          );
        }
        if (indexKey !== undefined && !toolByIndex.has(indexKey)) toolByIndex.set(indexKey, tool);
        if (idKey !== undefined && !toolById.has(idKey)) toolById.set(idKey, tool);
        lastTool = tool;
        if (call.function?.name !== undefined && tool.name.length === 0) tool.name = call.function.name;
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          tool.args += args;
          // Custom and typed calls buffer their arguments (extracted at finalize).
          if (tool.kind === "function") {
            controller.enqueue(
              emit("response.function_call_arguments.delta", {
                item_id: tool.itemId,
                output_index: tool.outputIndex,
                delta: args
              })
            );
          }
        }
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finalize(controller);
    }
  };

  // Backpressure handshake: the pump awaits `resumePull` while the consumer's
  // queue is full; `pull` resolves it. This replaces the "return when
  // desiredSize changed" hack with an explicit pump that drains the upstream
  // reader to completion while honoring backpressure.
  let resumePull: (() => void) | undefined;
  const awaitPull = (): Promise<void> =>
    new Promise((resolve) => {
      resumePull = resolve;
    });

  const handleEvent = (controller: Controller, data: string): void => {
    if (data.length === 0) return;
    if (data === "[DONE]") {
      // A `[DONE]` with no prior finish_reason is truncation, not a clean stop.
      if (!finished) finalize(controller, "incomplete");
      return;
    }
    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(data) as OpenAiChunk;
    } catch (error) {
      // The live upstream stream is authoritative: a malformed payload is a
      // stream error, never silently skipped (WS5).
      const detail = error instanceof Error ? error.message : String(error);
      throw new SseParseError(`malformed OpenAI SSE payload in Responses translation: ${detail}`, data.slice(0, 200));
    }
    const marker = serverToolMarkerOf(chunk);
    if (marker !== undefined) {
      handleServerToolMarker(controller, marker);
      return;
    }
    process(controller, chunk);
  };

  const pump = async (controller: Controller): Promise<void> => {
    try {
      for (;;) {
        if ((controller.desiredSize ?? 1) <= 0) await awaitPull();
        const { done, value } = await reader.read();
        if (done) {
          for (const event of sseDecoder.flush()) handleEvent(controller, event.data);
          // Upstream closed with no finish_reason: incomplete, not completed.
          if (!finished) finalize(controller, "incomplete");
          controller.close();
          return;
        }
        if (value !== undefined) {
          for (const event of sseDecoder.feed(value)) handleEvent(controller, event.data);
        }
      }
    } catch (error) {
      if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
      controller.error(error);
      void reader.cancel(error).catch(() => undefined);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit `response.created` immediately and keep the connection alive with
      // SSE comments while the upstream is still producing its first event. Real
      // CLIs (codex) reconnect if they see nothing for a while — which happens
      // during the fusion panel phase before the judge's first token.
      ensureCreated(controller);
      keepaliveTimer = setInterval(() => {
        if (finished) return;
        // Honor backpressure: skip the keepalive if the consumer's queue is full.
        if ((controller.desiredSize ?? 1) <= 0) return;
        try {
          controller.enqueue(ENCODER.encode(": keepalive\n\n"));
        } catch {
          // controller closed
        }
      }, 3000);
      void pump(controller);
    },
    pull() {
      resumePull?.();
      resumePull = undefined;
    },
    cancel(reason) {
      if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
      resumePull?.();
      resumePull = undefined;
      return reader.cancel(reason);
    }
  });
}

