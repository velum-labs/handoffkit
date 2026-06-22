/**
 * Anthropic Messages adapter. Claude Code speaks the Anthropic Messages API to
 * whatever `ANTHROPIC_BASE_URL` points at, so to back it with a local model we
 * translate `/v1/messages` (and `/v1/messages/count_tokens`, and the
 * `/v1/models` discovery probe) to and from the gateway's OpenAI Chat
 * Completions core. The pure translation functions are exported for testing;
 * the request handler wires them to a `Backend` and returns a `Response` the
 * server pipes straight to the client (JSON or SSE).
 */

import type { Backend } from "../backend.js";

const ENCODER = new TextEncoder();

// ---- Anthropic request types (the subset Claude Code sends) ----

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

export type AnthropicRequest = {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
};

// ---- OpenAI shapes we read back ----

type OpenAiToolCall = { id?: string; index?: number; function?: { name?: string; arguments?: string } };
type OpenAiDelta = { content?: string | null; tool_calls?: OpenAiToolCall[] };
type OpenAiChoice = {
  delta?: OpenAiDelta;
  message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  finish_reason?: string | null;
};
type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };
type OpenAiChunk = { choices?: OpenAiChoice[]; usage?: OpenAiUsage };
type OpenAiResponse = { id?: string; choices?: OpenAiChoice[]; usage?: OpenAiUsage };

// ---- request translation ----

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function systemText(system: AnthropicRequest["system"]): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n");
}

function blockText(content: string | AnthropicContentBlock[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block as AnthropicTextBlock).text : ""))
    .join("");
}

function mapToolChoice(
  choice: NonNullable<AnthropicRequest["tool_choice"]>
): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name ?? "" } };
    default: {
      const unreachable: never = choice.type;
      return unreachable;
    }
  }
}

/**
 * Translate an Anthropic Messages request to an OpenAI Chat Completions body.
 * The upstream model is always the backend's own model (Claude Code sends a
 * `claude-*` id the local server would not recognise); the requested id is
 * only echoed back in the response.
 */
export function anthropicToChat(body: AnthropicRequest, backendModel: string | undefined): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const system = systemText(body.system);
  if (system.length > 0) messages.push({ role: "system", content: system });

  for (const message of body.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const imageParts: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResults: { id: string; content: string }[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          textParts.push((block as AnthropicTextBlock).text);
          break;
        case "image": {
          const source = (block as AnthropicImageBlock).source;
          imageParts.push({
            type: "image_url",
            image_url: { url: `data:${source.media_type};base64,${source.data}` }
          });
          break;
        }
        case "tool_use": {
          const tool = block as AnthropicToolUseBlock;
          toolCalls.push({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) }
          });
          break;
        }
        case "tool_result": {
          const result = block as AnthropicToolResultBlock;
          toolResults.push({ id: result.tool_use_id, content: blockText(result.content) });
          break;
        }
        default:
          break;
      }
    }

    if (message.role === "assistant") {
      const text = textParts.join("");
      const assistant: Record<string, unknown> = { role: "assistant", content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }

    // user turn: tool results become standalone tool messages; remaining
    // text/images become a user message.
    for (const result of toolResults) {
      messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
    }
    const text = textParts.join("");
    if (imageParts.length > 0) {
      const parts: Record<string, unknown>[] = [];
      if (text.length > 0) parts.push({ type: "text", text });
      parts.push(...imageParts);
      messages.push({ role: "user", content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      messages.push({ role: "user", content: text });
    }
  }

  const chat: Record<string, unknown> = {
    model: backendModel ?? body.model ?? "",
    messages,
    stream: body.stream === true
  };
  if (typeof body.max_tokens === "number") chat.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    chat.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chat.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} }
      }
    }));
  }
  if (body.tool_choice !== undefined) chat.tool_choice = mapToolChoice(body.tool_choice);
  if (body.stream === true) chat.stream_options = { include_usage: true };
  return chat;
}

// ---- response translation ----

export function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop":
    case "content_filter":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function chatToAnthropicMessage(openai: OpenAiResponse, model: string): Record<string, unknown> {
  const choice = openai.choices?.[0];
  const message = choice?.message;
  const content: Record<string, unknown>[] = [];

  const text = typeof message?.content === "string" ? message.content : "";
  if (text.length > 0) content.push({ type: "text", text });

  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      let input: unknown = {};
      const args = call.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        try {
          input = JSON.parse(args);
        } catch {
          input = {};
        }
      }
      content.push({
        type: "tool_use",
        id: call.id ?? `toolu_${randomId()}`,
        name: call.function?.name ?? "",
        input
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: openai.id !== undefined ? `msg_${openai.id}` : `msg_${randomId()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0
    }
  };
}

// ---- streaming translation (OpenAI chat SSE -> Anthropic Messages SSE) ----

function sse(type: string, data: unknown): Uint8Array {
  return ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

type StreamState = {
  started: boolean;
  textOpen: boolean;
  textIndex: number;
  nextIndex: number;
  finished: boolean;
  outputTokens: number;
  keepaliveTimer: ReturnType<typeof setInterval> | undefined;
};

export function openAiSseToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const tools = new Map<number, number>();
  const messageId = `msg_${randomId()}`;
  const state: StreamState = {
    started: false,
    textOpen: false,
    textIndex: -1,
    nextIndex: 0,
    finished: false,
    outputTokens: 0,
    keepaliveTimer: undefined
  };
  let buffer = "";

  type Controller = ReadableStreamDefaultController<Uint8Array>;

  const ensureStarted = (controller: Controller): void => {
    if (state.started) return;
    state.started = true;
    controller.enqueue(
      sse("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })
    );
  };

  const ensureText = (controller: Controller): void => {
    ensureStarted(controller);
    if (state.textOpen) return;
    state.textOpen = true;
    state.textIndex = state.nextIndex++;
    controller.enqueue(
      sse("content_block_start", {
        type: "content_block_start",
        index: state.textIndex,
        content_block: { type: "text", text: "" }
      })
    );
  };

  const finalize = (controller: Controller, stopReason: string): void => {
    if (state.finished) return;
    state.finished = true;
    if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
    if (state.textOpen) {
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: state.textIndex }));
    }
    for (const index of tools.values()) {
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
    }
    controller.enqueue(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: state.outputTokens }
      })
    );
    controller.enqueue(sse("message_stop", { type: "message_stop" }));
  };

  const process = (controller: Controller, chunk: OpenAiChunk): void => {
    const choice = chunk.choices?.[0];
    if (choice === undefined) {
      if (chunk.usage?.completion_tokens !== undefined) state.outputTokens = chunk.usage.completion_tokens;
      return;
    }
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureText(controller);
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: state.textIndex,
          delta: { type: "text_delta", text: delta.content }
        })
      );
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const openAiIndex = typeof call.index === "number" ? call.index : 0;
        let index = tools.get(openAiIndex);
        if (index === undefined) {
          ensureStarted(controller);
          index = state.nextIndex++;
          tools.set(openAiIndex, index);
          controller.enqueue(
            sse("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: call.id ?? `toolu_${randomId()}`,
                name: call.function?.name ?? "",
                input: {}
              }
            })
          );
        }
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          controller.enqueue(
            sse("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: args }
            })
          );
        }
      }
    }

    if (chunk.usage?.completion_tokens !== undefined) state.outputTokens = chunk.usage.completion_tokens;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finalize(controller, mapStopReason(choice.finish_reason));
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Start the message immediately and keep the connection alive with `ping`
      // events while the upstream is still producing its first token. Claude
      // Code times out if it sees nothing during the fusion panel phase (the
      // chat-layer keepalive comments are dropped by this translator).
      ensureStarted(controller);
      state.keepaliveTimer = setInterval(() => {
        if (state.finished) return;
        try {
          controller.enqueue(sse("ping", { type: "ping" }));
        } catch {
          // controller closed
        }
      }, 3000);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (!state.finished) finalize(controller, "end_turn");
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
          if (!state.finished) finalize(controller, "end_turn");
          continue;
        }
        try {
          process(controller, JSON.parse(payload) as OpenAiChunk);
        } catch {
          // ignore malformed lines; the upstream stream is authoritative
        }
      }
    },
    cancel(reason) {
      if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
      return reader.cancel(reason);
    }
  });
}

// ---- token counting + discovery ----

export function countTokensEstimate(body: AnthropicRequest): number {
  let chars = systemText(body.system).length;
  for (const message of body.messages) chars += blockText(message.content).length;
  // A rough chars/4 heuristic; Claude Code uses this only for budgeting.
  return Math.max(1, Math.ceil(chars / 4));
}

// ---- handlers (return a Response the server pipes) ----

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function handleAnthropicMessages(
  backend: Backend,
  body: AnthropicRequest,
  modelCallId?: string,
  signal?: AbortSignal
): Promise<Response> {
  const requestedModel = body.model ?? backend.defaultModel ?? "";
  const upstreamModel = backend.resolveModel?.(body.model) ?? backend.defaultModel;
  const chat = anthropicToChat(body, upstreamModel);
  const upstream = await backend.chat(chat, signal, { modelCallId });

  if (!upstream.ok) {
    const detail = await upstream.text();
    return jsonResponse(upstream.status, {
      type: "error",
      error: { type: "api_error", message: detail.slice(0, 2000) }
    });
  }

  if (body.stream === true) {
    const source = upstream.body;
    if (source === null) return jsonResponse(502, { type: "error", error: { type: "api_error", message: "no upstream stream" } });
    return new Response(openAiSseToAnthropic(source, requestedModel), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }

  const openai = (await upstream.json()) as OpenAiResponse;
  return jsonResponse(200, chatToAnthropicMessage(openai, requestedModel));
}

export function handleCountTokens(body: AnthropicRequest): Response {
  return jsonResponse(200, { input_tokens: countTokensEstimate(body) });
}

/** Claude Code only lists models whose id begins with `claude` or `anthropic`. */
function isAnthropicFamilyId(id: string): boolean {
  return id.startsWith("claude") || id.startsWith("anthropic");
}

/** The `claude-` prefix used to alias non-Anthropic models past Claude's filter. */
export const CLAUDE_ALIAS_PREFIX = "claude-";

/**
 * The id a model is advertised under in Claude Code's `/model` picker. Claude
 * only lists ids beginning with `claude`/`anthropic`, so non-Anthropic models
 * are aliased with a `claude-` prefix; the gateway maps the alias back when
 * routing (see `resolveAlias`), and the picker shows the real id via
 * `display_name`. This is the claude-code-router trick: the `model` field is an
 * identifier we control end-to-end, so any model can be made selectable.
 */
export function claudeModelAlias(id: string): string {
  return isAnthropicFamilyId(id) ? id : `${CLAUDE_ALIAS_PREFIX}${id}`;
}

/**
 * Anthropic-shaped `/v1/models` discovery response. Every advertised model is
 * listed so it appears in Claude Code's `/model` picker: Anthropic-family ids
 * as-is, others under a `claude-`prefixed alias with the real id as
 * `display_name`. `modelIds` is the full advertised set (fused model first);
 * when absent we fall back to the single backend default.
 */
export function anthropicModelsResponse(
  backendModel: string | undefined,
  modelIds?: readonly string[]
): Response {
  const source =
    modelIds !== undefined && modelIds.length > 0
      ? modelIds
      : backendModel !== undefined
        ? [backendModel]
        : [];
  const seen = new Set<string>();
  const models: Array<{ type: "model"; id: string; display_name: string; created_at: string }> = [];
  for (const realId of source) {
    const id = claudeModelAlias(realId);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ type: "model", id, display_name: realId, created_at: new Date(0).toISOString() });
  }
  const ids = models.map((model) => model.id);
  return new Response(
    JSON.stringify({
      data: models,
      has_more: false,
      first_id: ids[0],
      last_id: ids[ids.length - 1]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
