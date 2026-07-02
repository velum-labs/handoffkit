/**
 * OpenAI Responses adapter. Codex speaks the Responses API exclusively
 * (`wire_api="responses"`; Chat Completions support was removed), so to back it
 * with a local model we translate `/v1/responses` to and from the gateway's
 * OpenAI Chat Completions core. The pure translation functions are exported for
 * testing; the handler returns a `Response` the server pipes (JSON or SSE).
 *
 * This is the highest-fidelity adapter: it maps Responses `input` items
 * (messages, function calls, function-call outputs) into chat messages, and
 * emits the Responses streaming event sequence (`response.created`,
 * `response.output_item.added`, `response.output_text.delta`,
 * `response.function_call_arguments.delta`, `response.completed`, …) from chat
 * completion chunks.
 */

import type { Backend } from "../backend.js";

const ENCODER = new TextEncoder();

// ---- Responses request types (the subset Codex sends) ----

type ResponsesContentPart = { type: string; text?: string; image_url?: string; [key: string]: unknown };
type ResponsesInputItem =
  | { type?: "message"; role: "user" | "assistant" | "system" | "developer"; content: string | ResponsesContentPart[] }
  | { type: "function_call"; call_id?: string; id?: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: unknown }
  | { type: string; [key: string]: unknown };

export type ResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: Array<{ type?: string; name: string; description?: string; parameters?: unknown; strict?: boolean }>;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
};

// ---- OpenAI chat shapes we read back ----

type OpenAiToolCall = { id?: string; index?: number; function?: { name?: string; arguments?: string } };
type OpenAiDelta = { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAiToolCall[] };
type OpenAiChoice = {
  delta?: OpenAiDelta;
  message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  finish_reason?: string | null;
};
type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };
type OpenAiChunk = { choices?: OpenAiChoice[]; usage?: OpenAiUsage };
type OpenAiResponse = { id?: string; choices?: OpenAiChoice[]; usage?: OpenAiUsage };

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function partText(part: ResponsesContentPart): string {
  if (typeof part.text === "string" && (part.type === "input_text" || part.type === "output_text" || part.type === "text")) {
    return part.text;
  }
  return "";
}

function contentToText(content: string | ResponsesContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(partText).join("");
}

function contentToParts(content: string | ResponsesContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    } else {
      const text = partText(part);
      if (text.length > 0) parts.push({ type: "text", text });
    }
  }
  if (parts.length === 1 && parts[0]?.type === "text") {
    return String((parts[0] as { text: string }).text);
  }
  return parts;
}

function mapToolChoice(choice: NonNullable<ResponsesRequest["tool_choice"]>): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

/** Translate a Responses request to an OpenAI Chat Completions body. */
export function responsesToChat(body: ResponsesRequest, backendModel: string | undefined): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // Coalesce consecutive function_call items into ONE assistant message.
    // Codex emits parallel tool calls as separate function_call items; the chat
    // API requires an assistant message's tool_calls to be answered by the
    // following tool messages before the next assistant message, so each call
    // must not become its own assistant turn.
    let pendingToolCalls: Array<Record<string, unknown>> = [];
    const flushToolCalls = (): void => {
      if (pendingToolCalls.length === 0) return;
      messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    };
    for (const item of input) {
      if (item.type === "function_call") {
        const call = item as Extract<ResponsesInputItem, { type: "function_call" }>;
        pendingToolCalls.push({
          id: call.call_id ?? call.id ?? `call_${randomId()}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        });
        continue;
      }
      flushToolCalls();
      if (item.type === "function_call_output") {
        const out = item as Extract<ResponsesInputItem, { type: "function_call_output" }>;
        const content = typeof out.output === "string" ? out.output : JSON.stringify(out.output);
        messages.push({ role: "tool", tool_call_id: out.call_id, content });
        continue;
      }
      // Reasoning items round-trip: Codex echoes the fusion narration item back
      // verbatim on the next request (with `summary`, and `content` that may be
      // null). Drop it — narration must never leak into the panel prompt
      // (mirrors the Anthropic adapter dropping thinking blocks).
      if (item.type === "reasoning") continue;
      // message item (explicit type "message" or a bare {role, content}); any
      // other item type without string/array content is skipped, never iterated.
      const message = item as { role?: string; content?: string | ResponsesContentPart[] | null };
      if (typeof message.content !== "string" && !Array.isArray(message.content)) continue;
      const role = message.role === "developer" ? "system" : message.role ?? "user";
      messages.push({ role, content: contentToParts(message.content) });
    }
    flushToolCalls();
  }

  const chat: Record<string, unknown> = {
    model: backendModel ?? body.model ?? "",
    messages,
    stream: body.stream === true
  };
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // Only forward function tools with a usable name. Codex advertises some
    // tools (e.g. custom/freeform shapes) that translate to an empty function
    // name, which OpenAI Chat Completions rejects outright.
    const named = body.tools.filter(
      (tool) => typeof tool.name === "string" && tool.name.length > 0
    );
    if (named.length > 0) {
      chat.tools = named.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters ?? { type: "object", properties: {} }
        }
      }));
    }
  }
  if (body.tool_choice !== undefined) chat.tool_choice = mapToolChoice(body.tool_choice);
  if (body.stream === true) chat.stream_options = { include_usage: true };
  return chat;
}

// ---- non-streaming response translation ----

function buildOutput(message: OpenAiChoice["message"]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const text = typeof message?.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: "message",
      id: `msg_${randomId()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${randomId()}`,
        call_id: call.id ?? `call_${randomId()}`,
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "",
        status: "completed"
      });
    }
  }
  return output;
}

export function chatToResponses(openai: OpenAiResponse, model: string): Record<string, unknown> {
  const message = openai.choices?.[0]?.message;
  const output = buildOutput(message);
  const inputTokens = openai.usage?.prompt_tokens ?? 0;
  const outputTokens = openai.usage?.completion_tokens ?? 0;
  return {
    id: `resp_${openai.id ?? randomId()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  };
}

// ---- streaming translation (OpenAI chat SSE -> Responses SSE) ----

function sse(type: string, data: Record<string, unknown>): Uint8Array {
  return ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

type ToolAccumulator = { outputIndex: number; itemId: string; callId: string; name: string; args: string };

export function openAiSseToResponses(
  upstream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const responseId = `resp_${randomId()}`;
  const messageItemId = `msg_${randomId()}`;
  const reasoningItemId = `rs_${randomId()}`;
  const tools = new Map<number, ToolAccumulator>();
  let buffer = "";
  let created = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let textOpen = false;
  let textValue = "";
  let reasoningOpen = false;
  let reasoningClosed = false;
  let reasoningValue = "";
  let reasoningOutputIndex = -1;
  let nextOutputIndex = 0;
  let messageOutputIndex = -1;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;

  type Controller = ReadableStreamDefaultController<Uint8Array>;

  const baseResponse = (status: string, output: Record<string, unknown>[]): Record<string, unknown> => ({
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage:
      status === "completed"
        ? { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
        : null
  });

  const ensureCreated = (controller: Controller): void => {
    if (created) return;
    created = true;
    controller.enqueue(sse("response.created", { response: baseResponse("in_progress", []) }));
  };

  // Reasoning summary item lifecycle (the fusion narration channel). Opened on
  // the first `reasoning_content` delta, closed as soon as the first real
  // output (text or tool call) begins — reasoning always precedes the answer.
  const ensureReasoning = (controller: Controller): void => {
    ensureCreated(controller);
    if (reasoningOpen || reasoningClosed) return;
    reasoningOpen = true;
    reasoningOutputIndex = nextOutputIndex++;
    controller.enqueue(
      sse("response.output_item.added", {
        output_index: reasoningOutputIndex,
        item: { type: "reasoning", id: reasoningItemId, summary: [] }
      })
    );
    controller.enqueue(
      sse("response.reasoning_summary_part.added", {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" }
      })
    );
  };

  const closeReasoning = (controller: Controller): void => {
    if (!reasoningOpen || reasoningClosed) return;
    reasoningClosed = true;
    controller.enqueue(
      sse("response.reasoning_summary_text.done", {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        text: reasoningValue
      })
    );
    controller.enqueue(
      sse("response.reasoning_summary_part.done", {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: reasoningValue }
      })
    );
    controller.enqueue(
      sse("response.output_item.done", {
        output_index: reasoningOutputIndex,
        item: {
          type: "reasoning",
          id: reasoningItemId,
          summary: [{ type: "summary_text", text: reasoningValue }]
        }
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
      sse("response.output_item.added", {
        output_index: messageOutputIndex,
        item: { type: "message", id: messageItemId, status: "in_progress", role: "assistant", content: [] }
      })
    );
    controller.enqueue(
      sse("response.content_part.added", {
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      })
    );
  };

  const assembleOutput = (): Record<string, unknown>[] => {
    const output: Record<string, unknown>[] = [];
    if (reasoningValue.length > 0) {
      output.push({
        type: "reasoning",
        id: reasoningItemId,
        summary: [{ type: "summary_text", text: reasoningValue }]
      });
    }
    if (textOpen) {
      output.push({
        type: "message",
        id: messageItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: textValue, annotations: [] }]
      });
    }
    for (const tool of tools.values()) {
      output.push({
        type: "function_call",
        id: tool.itemId,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.args,
        status: "completed"
      });
    }
    return output;
  };

  const finalize = (controller: Controller): void => {
    if (finished) return;
    finished = true;
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    closeReasoning(controller);
    if (textOpen) {
      controller.enqueue(
        sse("response.output_text.done", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          text: textValue
        })
      );
      controller.enqueue(
        sse("response.content_part.done", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: textValue, annotations: [] }
        })
      );
      controller.enqueue(
        sse("response.output_item.done", {
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
    for (const tool of tools.values()) {
      controller.enqueue(
        sse("response.function_call_arguments.done", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          arguments: tool.args
        })
      );
      controller.enqueue(
        sse("response.output_item.done", {
          output_index: tool.outputIndex,
          item: {
            type: "function_call",
            id: tool.itemId,
            call_id: tool.callId,
            name: tool.name,
            arguments: tool.args,
            status: "completed"
          }
        })
      );
    }
    controller.enqueue(sse("response.completed", { response: baseResponse("completed", assembleOutput()) }));
  };

  const process = (controller: Controller, chunk: OpenAiChunk): void => {
    if (chunk.usage !== undefined) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
    const choice = chunk.choices?.[0];
    if (choice === undefined) return;
    const delta = choice.delta ?? {};

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0 && !reasoningClosed) {
      ensureReasoning(controller);
      reasoningValue += delta.reasoning_content;
      controller.enqueue(
        sse("response.reasoning_summary_text.delta", {
          item_id: reasoningItemId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          delta: delta.reasoning_content
        })
      );
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureText(controller);
      textValue += delta.content;
      controller.enqueue(
        sse("response.output_text.delta", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: delta.content
        })
      );
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const openAiIndex = typeof call.index === "number" ? call.index : 0;
        let tool = tools.get(openAiIndex);
        if (tool === undefined) {
          ensureCreated(controller);
          closeReasoning(controller);
          tool = {
            outputIndex: nextOutputIndex++,
            itemId: `fc_${randomId()}`,
            callId: call.id ?? `call_${randomId()}`,
            name: call.function?.name ?? "",
            args: ""
          };
          tools.set(openAiIndex, tool);
          controller.enqueue(
            sse("response.output_item.added", {
              output_index: tool.outputIndex,
              item: { type: "function_call", id: tool.itemId, call_id: tool.callId, name: tool.name, arguments: "" }
            })
          );
        }
        if (call.function?.name !== undefined && tool.name.length === 0) tool.name = call.function.name;
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          tool.args += args;
          controller.enqueue(
            sse("response.function_call_arguments.delta", {
              item_id: tool.itemId,
              output_index: tool.outputIndex,
              delta: args
            })
          );
        }
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finalize(controller);
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
        try {
          controller.enqueue(ENCODER.encode(": keepalive\n\n"));
        } catch {
          // controller closed
        }
      }, 3000);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (!finished) finalize(controller);
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          if (!finished) finalize(controller);
          continue;
        }
        try {
          process(controller, JSON.parse(payload) as OpenAiChunk);
        } catch {
          // ignore malformed lines
        }
      }
    },
    cancel(reason) {
      if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
      return reader.cancel(reason);
    }
  });
}

// ---- handler ----

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export async function handleResponses(
  backend: Backend,
  body: ResponsesRequest,
  modelCallId?: string,
  signal?: AbortSignal
): Promise<Response> {
  const requestedModel = body.model ?? backend.defaultModel ?? "";
  const upstreamModel = backend.resolveModel?.(body.model) ?? backend.defaultModel;
  const chat = responsesToChat(body, upstreamModel);
  const upstream = await backend.chat(chat, signal, { modelCallId });

  if (!upstream.ok) {
    const detail = await upstream.text();
    return jsonResponse(upstream.status, { error: { type: "api_error", message: detail.slice(0, 2000) } });
  }

  if (body.stream === true) {
    const source = upstream.body;
    if (source === null) return jsonResponse(502, { error: { type: "api_error", message: "no upstream stream" } });
    return new Response(openAiSseToResponses(source, requestedModel), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }

  const openai = (await upstream.json()) as OpenAiResponse;
  return jsonResponse(200, chatToResponses(openai, requestedModel));
}
