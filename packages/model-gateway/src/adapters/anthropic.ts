/**
 * Anthropic Messages adapter. Claude Code speaks the Anthropic Messages API to
 * whatever `ANTHROPIC_BASE_URL` points at, so to back it with a local model we
 * translate `/v1/messages` (and `/v1/messages/count_tokens`, and the
 * `/v1/models` discovery probe) to and from the gateway's OpenAI Chat
 * Completions core. The pure translation functions are exported for testing;
 * the request handler wires them to a `Backend` and returns a `Response` the
 * server pipes straight to the client (JSON or SSE).
 */

import type { Backend, BackendRequestOptions } from "../backend.js";
import { estimateTokens, randomId } from "@routekit/runtime";
import { SseDecoder, SseParseError } from "../sse/parse.js";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  ANTHROPIC_REQUEST_METADATA,
  anthropicReasoningDetailsOf,
  type AnthropicNativeContentBlock,
  type AnthropicReasoningDetail,
  type AnthropicRequestMetadata,
  type AnthropicThinkingConfig,
  type OpenAiChoice
} from "./openai-chat-wire.js";
import { droppedField } from "./dropped.js";
import { unwrapUpstreamError } from "./upstream-error.js";
import { composeServerToolStream, runBufferedServerToolLoop, serverToolMarkerOf } from "./server-tool-loop.js";
import type {
  ExecutedSearch,
  ServerToolLoopEvent,
  ServerToolMarker
} from "./server-tool-loop.js";
import { resolveWebSearchExecutor } from "./web-search.js";

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

type AnthropicThinking = AnthropicThinkingConfig | null;
type AnthropicOutputConfig = {
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  [key: string]: unknown;
};

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

/**
 * Optional object fields tolerate an explicit JSON `null` (some clients encode
 * "unset" that way — Codex does on the Responses wire); reads must use
 * null-tolerant guards so a null never crashes the turn.
 */
export type AnthropicRequest = {
  model?: string;
  system?: string | AnthropicTextBlock[] | null;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: AnthropicThinking | null;
  output_config?: AnthropicOutputConfig | null;
  metadata?: Record<string, unknown> | null;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ type?: string; name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
    disable_parallel_tool_use?: boolean;
  } | null;
};

/**
 * Whether an Anthropic tool is *server-executed* (run by Anthropic's backend,
 * e.g. `web_search_20250305` / `code_execution_*`). Nothing behind this gateway
 * can execute those, so advertising them to the upstream model would only produce
 * calls nobody answers. Everything else — plain client tools (no `type` /
 * `custom`) and Anthropic-defined client tools (`bash_*`, `text_editor_*`,
 * `computer_*`), all of which the caller executes via ordinary `tool_use`
 * blocks — is projected through.
 */
function isAnthropicServerTool(tool: { type?: string }): boolean {
  const type = tool.type ?? "";
  return type.startsWith("web_search") || type.startsWith("code_execution");
}

/** A server web search tool declaration (`web_search_20250305` et al.) — the
 *  one server tool the gateway can honor via its own web-search executor. */
function isAnthropicWebSearchTool(tool: { type?: string }): boolean {
  return (tool.type ?? "").startsWith("web_search");
}

/** The name the gateway-executed web search tool is projected under chat-side. */
const WEB_SEARCH_TOOL_NAME = "web_search";

const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web for current, factual information. The search runs server-side and " +
  "returns result text with source URLs. Use it when the answer depends on information " +
  "that may have changed since your training data.";

const WEB_SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "The web search query." }
  },
  required: ["query"],
  additionalProperties: false
} as const;

/** Options gating server-executed tool projection (on iff an executor exists). */
export type AnthropicTranslationOptions = { serverTools?: boolean };

/** Render an echoed `web_search_tool_result`'s content as a chat tool message.
 *  Bulky opaque fields (`encrypted_content`) are stripped; the upstream model
 *  only needs the urls/titles to remember what the search found. */
function webSearchResultText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const results = content.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry as unknown;
    const { encrypted_content: _encrypted, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
  return JSON.stringify(results);
}

// ---- OpenAI shapes we read back ----

type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };
type OpenAiChunk = { choices?: OpenAiChoice[]; usage?: OpenAiUsage; error?: unknown };
type OpenAiResponse = { id?: string; choices?: OpenAiChoice[]; usage?: OpenAiUsage };

// ---- request translation ----

function systemText(system: AnthropicRequest["system"]): string {
  if (system == null) return "";
  if (typeof system === "string") return system;
  return system
    .map((block) =>
      block !== null && typeof block === "object" && typeof block.text === "string"
        ? block.text
        : ""
    )
    .join("\n");
}

function blockText(content: string | AnthropicContentBlock[] | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block !== null && typeof block === "object" && block.type === "text"
        ? (block as AnthropicTextBlock).text
        : ""
    )
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
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name ?? "" } };
    default: {
      const unreachable: never = choice.type;
      return unreachable;
    }
  }
}

type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

function mapThinking(
  thinking: NonNullable<AnthropicThinking>,
  outputConfig: AnthropicOutputConfig | null | undefined
): ReasoningEffort | undefined {
  if (thinking.type === "disabled") return undefined;
  const effort = outputConfig?.effort;
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }
  if (thinking.type === "adaptive") return "medium";
  const budget = thinking.budget_tokens;
  if (typeof budget === "number") {
    if (budget <= 1_024) return "low";
    if (budget <= 8_192) return "medium";
    if (budget <= 16_384) return "high";
    if (budget <= 32_768) return "xhigh";
    return "max";
  }
  droppedField("anthropic", "thinking");
  return undefined;
}

function thinkingValidationError(body: AnthropicRequest): string | undefined {
  const thinking = body.thinking;
  if (thinking == null || thinking.type !== "enabled") return undefined;
  const budget = thinking.budget_tokens;
  if (!Number.isInteger(budget) || budget < 1_024) {
    return "thinking.budget_tokens must be an integer greater than or equal to 1024";
  }
  if (typeof body.max_tokens === "number" && budget >= body.max_tokens) {
    return `thinking.budget_tokens must be less than max_tokens (${body.max_tokens})`;
  }
  return undefined;
}

function toolResultContent(result: AnthropicToolResultBlock): string {
  const text = blockText(result.content);
  return result.is_error === true ? `[tool_error]\n${text}` : text;
}

function attachAnthropicContent(
  message: Record<string, unknown>,
  content: readonly AnthropicNativeContentBlock[]
): void {
  Object.defineProperty(message, ANTHROPIC_MESSAGE_CONTENT, {
    value: [...content],
    enumerable: true
  });
}

/**
 * Translate an Anthropic Messages request to an OpenAI Chat Completions body.
 * The upstream model is always the backend's own model (Claude Code sends a
 * `claude-*` id the local server would not recognise); the requested id is
 * only echoed back in the response.
 */
export function anthropicToChat(
  body: AnthropicRequest,
  backendModel: string | undefined,
  options: AnthropicTranslationOptions = {}
): Record<string, unknown> {
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
    const nativeContent: AnthropicNativeContentBlock[] = [];
    let hasReplayableThinking = false;
    // Echoed gateway-executed (or genuinely provider-executed, in a resumed
    // session) web searches: `server_tool_use` + `web_search_tool_result`
    // blocks ride in the assistant message and round-trip losslessly.
    const serverToolUses: Record<string, unknown>[] = [];
    const serverToolResults: { id: string; content: string }[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          textParts.push((block as AnthropicTextBlock).text);
          nativeContent.push({ type: "text", text: (block as AnthropicTextBlock).text });
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
          nativeContent.push({
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: tool.input ?? {}
          });
          break;
        }
        case "tool_result": {
          const result = block as AnthropicToolResultBlock;
          toolResults.push({ id: result.tool_use_id, content: toolResultContent(result) });
          break;
        }
        case "server_tool_use": {
          const tool = block as unknown as AnthropicToolUseBlock;
          serverToolUses.push({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) }
          });
          break;
        }
        case "web_search_tool_result": {
          const result = block as { tool_use_id?: string; content?: unknown };
          serverToolResults.push({
            id: result.tool_use_id ?? "",
            content: webSearchResultText(result.content)
          });
          break;
        }
        case "thinking": {
          const thinking = block as {
            thinking?: unknown;
            signature?: unknown;
          };
          // Only provider-issued non-empty signatures are safe to replay to
          // Anthropic. Synthetic thinking emitted for another provider uses an
          // empty signature and remains display-only.
          if (
            typeof thinking.thinking === "string" &&
            typeof thinking.signature === "string" &&
            thinking.signature.length > 0
          ) {
            nativeContent.push({
              type: "thinking",
              thinking: thinking.thinking,
              signature: thinking.signature
            });
            hasReplayableThinking = true;
          } else {
            droppedField("anthropic", "thinking", "message");
          }
          break;
        }
        case "redacted_thinking": {
          const redacted = block as { data?: unknown };
          if (typeof redacted.data === "string" && redacted.data.length > 0) {
            nativeContent.push({ type: "redacted_thinking", data: redacted.data });
            hasReplayableThinking = true;
          } else {
            droppedField("anthropic", "redacted_thinking", "message");
          }
          break;
        }
        default:
          droppedField("anthropic", block.type, "message");
          break;
      }
    }

    if (message.role === "assistant") {
      const text = textParts.join("");
      if (imageParts.length > 0) {
        droppedField("anthropic", "image", "assistant_message");
      }
      // Replay echoed server web searches as a chat tool exchange preceding
      // the assistant's answer, so the upstream model remembers what was
      // searched and found rather than blindly repeating it.
      if (serverToolUses.length > 0) {
        messages.push({ role: "assistant", content: null, tool_calls: serverToolUses });
        for (const use of serverToolUses) {
          const result = serverToolResults.find((entry) => entry.id === use.id);
          messages.push({
            role: "tool",
            tool_call_id: (use.id as string | undefined) ?? "",
            content: result?.content ?? "[web search results not retained]"
          });
        }
      }
      if (text.length > 0 || toolCalls.length > 0 || serverToolUses.length === 0) {
        const assistant: Record<string, unknown> = { role: "assistant", content: text.length > 0 ? text : null };
        if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
        if (hasReplayableThinking) attachAnthropicContent(assistant, nativeContent);
        messages.push(assistant);
      }
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
  // `max_completion_tokens`, not legacy `max_tokens`: OpenAI reasoning models
  // reject the latter, and the other dialect adapters already emit the modern
  // field (Claude Code always sends `max_tokens`, so this path is always hit).
  if (typeof body.max_tokens === "number") chat.max_completion_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.top_k === "number") chat.top_k = body.top_k;
  // Explicit nulls mean "unset" (see AnthropicRequest).
  if (body.metadata != null) droppedField("anthropic", "metadata");
  // `thinking: null` means "no extended thinking" — skip, never dereference
  // (same failure class as the Responses adapter's `reasoning: null`).
  if (body.thinking != null) {
    const reasoningEffort = mapThinking(body.thinking, body.output_config);
    if (reasoningEffort !== undefined) chat.reasoning_effort = reasoningEffort;
  }
  const metadata: AnthropicRequestMetadata = {
    ...(body.thinking != null ? { thinking: body.thinking } : {}),
    ...(body.output_config !== undefined ? { output_config: body.output_config } : {})
  };
  if (Object.keys(metadata).length > 0) {
    Object.defineProperty(chat, ANTHROPIC_REQUEST_METADATA, {
      value: metadata,
      enumerable: true
    });
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    chat.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // Web search is honorable when an executor exists (the server-tool loop
    // runs it); other server tools (`code_execution_*`) stay excluded.
    const honorWebSearch = options.serverTools === true;
    const excluded = body.tools.filter(
      (tool) => isAnthropicServerTool(tool) && !(honorWebSearch && isAnthropicWebSearchTool(tool))
    );
    if (excluded.length > 0) {
      for (const tool of excluded) {
        droppedField("anthropic", tool.name ?? tool.type ?? "server_tool", "tools");
      }
      if (process.env.ROUTEKIT_DEBUG) {
        process.stderr.write(
          `[routekit-debug] anthropic: excluding ${excluded.length} server-executed tool(s) ` +
            `from the request: ${excluded.map((tool) => tool.name).join(", ")}\n`
        );
      }
    }
    const tools = body.tools
      .filter((tool) => !isAnthropicServerTool(tool) && typeof tool.name === "string" && tool.name.length > 0)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.input_schema ?? { type: "object", properties: {} }
        }
      }));
    if (
      honorWebSearch &&
      body.tools.some(isAnthropicWebSearchTool) &&
      !tools.some((tool) => tool.function.name === WEB_SEARCH_TOOL_NAME)
    ) {
      tools.push({
        type: "function",
        function: {
          name: WEB_SEARCH_TOOL_NAME,
          description: WEB_SEARCH_TOOL_DESCRIPTION,
          parameters: WEB_SEARCH_TOOL_PARAMETERS
        }
      });
    }
    if (tools.length > 0) chat.tools = tools;
  }
  if (body.tool_choice != null) {
    chat.tool_choice = mapToolChoice(body.tool_choice);
    if (body.tool_choice.disable_parallel_tool_use === true) chat.parallel_tool_calls = false;
  }
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
    case "content_filter":
      return "refusal";
    case "stop":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** The native Anthropic blocks for one gateway-executed web search: the
 *  `server_tool_use` and its `web_search_tool_result`. Anthropic-executor
 *  results pass through verbatim; other executors build result blocks
 *  from their citations. */
function executedSearchBlocks(search: ExecutedSearch): Record<string, unknown>[] {
  const resultContent: unknown =
    search.status !== "completed"
      ? { type: "web_search_tool_result_error", error_code: "unavailable" }
      : (search.outcome?.anthropicResultBlocks ??
        (search.outcome?.citations ?? []).map((citation) => ({
          type: "web_search_result",
          url: citation.url,
          ...(citation.title !== undefined ? { title: citation.title } : {})
        })));
  return [
    { type: "server_tool_use", id: search.itemId, name: WEB_SEARCH_TOOL_NAME, input: { query: search.query } },
    { type: "web_search_tool_result", tool_use_id: search.itemId, content: resultContent }
  ];
}

export function chatToAnthropicMessage(
  openai: OpenAiResponse,
  model: string,
  searches: readonly ExecutedSearch[] = [],
  events?: readonly ServerToolLoopEvent[]
): Record<string, unknown> {
  const choice = openai.choices?.[0];
  const message = choice?.message;
  const content: Record<string, unknown>[] = [];

  const nativeReasoning = anthropicReasoningDetailsOf(
    message?.reasoning_details,
    "message"
  ).sort((a, b) => a.index - b.index);
  const appendNativeReasoning = (
    details: readonly AnthropicReasoningDetail[]
  ): void => {
    for (const detail of details) {
      if (detail.type === "thinking") {
        content.push({
          type: "thinking",
          thinking: detail.thinking ?? "",
          signature: detail.signature ?? ""
        });
      } else {
        content.push({ type: "redacted_thinking", data: detail.data });
      }
    }
  };

  // Gateway-executed steps precede the terminal model step. Preserve their
  // signed/redacted reasoning in exact step order around search blocks.
  if (events !== undefined) {
    for (const event of events) {
      if (event.kind === "reasoning") {
        appendNativeReasoning(
          anthropicReasoningDetailsOf(event.details, "message")
        );
      } else {
        content.push(...executedSearchBlocks(event.search));
      }
    }
  } else {
    for (const search of searches) content.push(...executedSearchBlocks(search));
  }
  appendNativeReasoning(nativeReasoning);
  const rawReasoning =
    typeof message?.reasoning === "string" && message.reasoning.length > 0
      ? message.reasoning
      : "";
  const narration =
    typeof message?.reasoning_content === "string" &&
    message.reasoning_content.length > 0
      ? message.reasoning_content.replace(/\*\*/g, "")
      : "";
  if (nativeReasoning.length === 0 && rawReasoning.length > 0) {
    // Generic providers cannot produce an Anthropic-verifiable signature.
    // The empty marker makes the block displayable; ingress deliberately
    // refuses to replay it as native signed history.
    content.push({
      type: "thinking",
      thinking: rawReasoning,
      signature: ""
    });
  }
  if (narration.length > 0) {
    content.push({ type: "thinking", thinking: narration, signature: "" });
  }

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

  const response: Record<string, unknown> = {
    id: openai.id !== undefined ? `msg_${openai.id}` : `msg_${randomId()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason:
      typeof choice?.anthropic_stop_reason === "string"
        ? choice.anthropic_stop_reason
        : mapStopReason(choice?.finish_reason),
    stop_sequence:
      typeof choice?.anthropic_stop_sequence === "string"
        ? choice.anthropic_stop_sequence
        : null
  };
  if (openai.usage !== undefined) {
    response.usage = {
      ...(openai.usage.prompt_tokens !== undefined ? { input_tokens: openai.usage.prompt_tokens } : {}),
      ...(openai.usage.completion_tokens !== undefined ? { output_tokens: openai.usage.completion_tokens } : {})
    };
  }
  return response;
}

// ---- streaming translation (OpenAI chat SSE -> Anthropic Messages SSE) ----

function sse(type: string, data: unknown): Uint8Array {
  return ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

type StreamState = {
  started: boolean;
  textOpen: boolean;
  textIndex: number;
  thinkingOpen: boolean;
  thinkingIndex: number;
  thinkingSourceIndex: number | undefined;
  pendingNarration: string[];
  outputStarted: boolean;
  nextIndex: number;
  finished: boolean;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  keepaliveTimer: ReturnType<typeof setInterval> | undefined;
};

export function openAiSseToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const sseDecoder = new SseDecoder();
  // OpenAI tool-call fragments map onto Anthropic `tool_use` content blocks.
  // Fragments are keyed by `index` when present, else by `id`; an id/index-less
  // fragment (Anthropic/Responses translations omit `index`) appends to the last
  // open call. Keying everything to index 0 used to merge parallel index-less
  // calls into one block — the same bug the shared assembler now avoids.
  const toolBlockByIndex = new Map<number, number>();
  const toolBlockById = new Map<string, number>();
  const toolBlocks: number[] = [];
  let lastToolBlock: number | undefined;
  const messageId = `msg_${randomId()}`;
  const state: StreamState = {
    started: false,
    textOpen: false,
    textIndex: -1,
    thinkingOpen: false,
    thinkingIndex: -1,
    thinkingSourceIndex: undefined,
    pendingNarration: [],
    outputStarted: false,
    nextIndex: 0,
    finished: false,
    inputTokens: undefined,
    outputTokens: undefined,
    keepaliveTimer: undefined
  };

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
          ...(state.inputTokens !== undefined ? { usage: { input_tokens: state.inputTokens } } : {})
        }
      })
    );
  };

  // Generic reasoning has no provider-verifiable signature. Native Anthropic
  // metadata below carries its real block lifecycle and signature separately.
  const ensureThinking = (controller: Controller): void => {
    ensureStarted(controller);
    if (state.thinkingOpen || state.outputStarted) return;
    state.thinkingOpen = true;
    state.thinkingSourceIndex = undefined;
    state.thinkingIndex = state.nextIndex++;
    controller.enqueue(
      sse("content_block_start", {
        type: "content_block_start",
        index: state.thinkingIndex,
        content_block: { type: "thinking", thinking: "" }
      })
    );
  };

  const closeThinking = (controller: Controller, sourceIndex?: number): void => {
    if (!state.thinkingOpen) return;
    if (
      sourceIndex !== undefined &&
      state.thinkingSourceIndex !== undefined &&
      sourceIndex !== state.thinkingSourceIndex
    ) {
      return;
    }
    state.thinkingOpen = false;
    controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: state.thinkingIndex }));
    state.thinkingSourceIndex = undefined;
  };

  const emitNarration = (controller: Controller, text: string): void => {
    ensureThinking(controller);
    if (!state.thinkingOpen || state.thinkingSourceIndex !== undefined) return;
    controller.enqueue(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: state.thinkingIndex,
        delta: {
          type: "thinking_delta",
          thinking: text.replace(/\*\*/g, "")
        }
      })
    );
  };

  const flushPendingNarration = (controller: Controller): void => {
    if (state.pendingNarration.length === 0) return;
    const pending = state.pendingNarration.join("");
    state.pendingNarration = [];
    emitNarration(controller, pending);
  };

  const ensureText = (controller: Controller): void => {
    ensureStarted(controller);
    closeThinking(controller);
    flushPendingNarration(controller);
    closeThinking(controller);
    state.outputStarted = true;
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

  const closeOpenBlocks = (controller: Controller): void => {
    closeThinking(controller);
    flushPendingNarration(controller);
    closeThinking(controller);
    if (state.textOpen) {
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: state.textIndex }));
    }
    for (const index of toolBlocks) {
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
    }
  };

  const finalize = (
    controller: Controller,
    stopReason: string,
    stopSequence: string | null = null
  ): void => {
    if (state.finished) return;
    state.finished = true;
    if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
    closeOpenBlocks(controller);
    controller.enqueue(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: stopSequence },
        ...(state.inputTokens !== undefined || state.outputTokens !== undefined
          ? {
              usage: {
                ...(state.inputTokens !== undefined ? { input_tokens: state.inputTokens } : {}),
                ...(state.outputTokens !== undefined ? { output_tokens: state.outputTokens } : {})
              }
            }
          : {})
      })
    );
    controller.enqueue(sse("message_stop", { type: "message_stop" }));
  };

  /**
   * The upstream ended (reader closed or a `[DONE]` arrived) before any
   * `finish_reason`. Truncation is an error, not a clean stop (WS5.2): emit an
   * Anthropic `error` event rather than fabricating `stop_reason:"end_turn"`, so
   * the caller sees a failed turn instead of silently accepting a partial answer.
   */
  const finalizeTruncated = (controller: Controller, detail: string): void => {
    if (state.finished) return;
    state.finished = true;
    if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
    closeOpenBlocks(controller);
    controller.enqueue(
      sse("error", {
        type: "error",
        error: { type: "incomplete_stream", message: detail }
      })
    );
  };

  const finalizeUpstreamError = (controller: Controller, error: unknown): void => {
    if (state.finished) return;
    state.finished = true;
    if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
    closeOpenBlocks(controller);
    controller.enqueue(
      sse("error", {
        type: "error",
        error: unwrapUpstreamError(JSON.stringify({ error }))
      })
    );
  };

  // The server-tool loop injects marker chunks around each gateway-executed
  // web search; render them as native `server_tool_use` /
  // `web_search_tool_result` blocks (each opened and closed immediately —
  // their content is complete when the marker arrives).
  const handleServerToolMarker = (controller: Controller, marker: ServerToolMarker): void => {
    ensureStarted(controller);
    closeThinking(controller);
    flushPendingNarration(controller);
    closeThinking(controller);
    state.outputStarted = true;
    if (marker.phase === "start") {
      const index = state.nextIndex++;
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "server_tool_use", id: marker.item_id, name: "web_search", input: {} }
        })
      );
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: marker.query }) }
        })
      );
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
      return;
    }
    const index = state.nextIndex++;
    const content: unknown =
      marker.status === "failed"
        ? { type: "web_search_tool_result_error", error_code: "unavailable" }
        : (marker.result_blocks ?? []);
    controller.enqueue(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "web_search_tool_result", tool_use_id: marker.item_id, content }
      })
    );
    controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
    // A completed server-side tool step is an internal model boundary, not the
    // final answer. The continuation model may legitimately begin with another
    // signed thinking/redacted block.
    state.outputStarted = false;
  };

  const handleReasoningDetails = (
    controller: Controller,
    details: readonly AnthropicReasoningDetail[]
  ): boolean => {
    let carriedText = false;
    for (const detail of details) {
      if (detail.type === "redacted_thinking") {
        if (state.outputStarted) continue;
        ensureStarted(controller);
        closeThinking(controller);
        const index = state.nextIndex++;
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "redacted_thinking", data: detail.data }
          })
        );
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
        continue;
      }
      if (detail.phase === "start") {
        if (state.outputStarted) continue;
        ensureStarted(controller);
        closeThinking(controller);
        state.thinkingOpen = true;
        state.thinkingSourceIndex = detail.index;
        state.thinkingIndex = state.nextIndex++;
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index: state.thinkingIndex,
            content_block: {
              type: "thinking",
              thinking: "",
              signature: detail.signature ?? ""
            }
          })
        );
        continue;
      }
      if (
        state.thinkingSourceIndex !== detail.index ||
        !state.thinkingOpen ||
        state.outputStarted
      ) {
        continue;
      }
      if (detail.phase === "delta" && typeof detail.thinking === "string") {
        carriedText = true;
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: state.thinkingIndex,
            delta: { type: "thinking_delta", thinking: detail.thinking }
          })
        );
      } else if (detail.phase === "signature" && typeof detail.signature === "string") {
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: state.thinkingIndex,
            delta: { type: "signature_delta", signature: detail.signature }
          })
        );
      } else if (detail.phase === "stop") {
        closeThinking(controller, detail.index);
      }
    }
    return carriedText;
  };

  const process = (controller: Controller, chunk: OpenAiChunk): void => {
    if (chunk.error !== undefined && chunk.error !== null) {
      finalizeUpstreamError(controller, chunk.error);
      return;
    }
    const choice = chunk.choices?.[0];
    if (choice === undefined) {
      if (chunk.usage?.prompt_tokens !== undefined) state.inputTokens = chunk.usage.prompt_tokens;
      if (chunk.usage?.completion_tokens !== undefined) state.outputTokens = chunk.usage.completion_tokens;
      return;
    }
    const delta = choice.delta ?? {};
    const nativeDetails = anthropicReasoningDetailsOf(
      delta.reasoning_details,
      "stream"
    );
    const nativeCarriedText =
      nativeDetails.length > 0 &&
      handleReasoningDetails(controller, nativeDetails);
    if (
      state.pendingNarration.length > 0 &&
      (!state.thinkingOpen || state.thinkingSourceIndex === undefined)
    ) {
      flushPendingNarration(controller);
    }

    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content.length > 0 &&
      !state.outputStarted
    ) {
      if (state.thinkingOpen && state.thinkingSourceIndex !== undefined) {
        // Never contaminate provider-signed thinking with gateway narration:
        // the signature must continue to describe exactly the native text.
        state.pendingNarration.push(delta.reasoning_content);
      } else {
        emitNarration(controller, delta.reasoning_content);
      }
    }

    if (
      !nativeCarriedText &&
      typeof delta.reasoning === "string" &&
      delta.reasoning.length > 0 &&
      !state.outputStarted
    ) {
      // Raw model thinking tokens pass through verbatim: they are already
      // plain text, and Anthropic thinking blocks stream token deltas natively.
      ensureThinking(controller);
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: state.thinkingIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning }
        })
      );
    }

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
        const indexKey = typeof call.index === "number" ? call.index : undefined;
        const idKey = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
        let block =
          indexKey !== undefined
            ? toolBlockByIndex.get(indexKey)
            : idKey !== undefined
              ? toolBlockById.get(idKey)
              : lastToolBlock;
        if (block === undefined) {
          ensureStarted(controller);
          closeThinking(controller);
          flushPendingNarration(controller);
          closeThinking(controller);
          state.outputStarted = true;
          block = state.nextIndex++;
          toolBlocks.push(block);
          controller.enqueue(
            sse("content_block_start", {
              type: "content_block_start",
              index: block,
              content_block: {
                type: "tool_use",
                id: call.id ?? `toolu_${randomId()}`,
                name: call.function?.name ?? "",
                input: {}
              }
            })
          );
        }
        if (indexKey !== undefined && !toolBlockByIndex.has(indexKey)) toolBlockByIndex.set(indexKey, block);
        if (idKey !== undefined && !toolBlockById.has(idKey)) toolBlockById.set(idKey, block);
        lastToolBlock = block;
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          controller.enqueue(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: block,
              delta: { type: "input_json_delta", partial_json: args }
            })
          );
        }
      }
    }

    if (chunk.usage?.prompt_tokens !== undefined) state.inputTokens = chunk.usage.prompt_tokens;
    if (chunk.usage?.completion_tokens !== undefined) state.outputTokens = chunk.usage.completion_tokens;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finalize(
        controller,
        typeof choice.anthropic_stop_reason === "string"
          ? choice.anthropic_stop_reason
          : mapStopReason(choice.finish_reason),
        typeof choice.anthropic_stop_sequence === "string"
          ? choice.anthropic_stop_sequence
          : null
      );
    }
  };

  // Backpressure handshake: the pump awaits `resumePull` whenever the consumer's
  // desired size drops to zero, and `pull` resolves it. This replaces the old
  // "return when desiredSize changed" hack with an explicit pump that reads the
  // upstream reader to completion while honoring backpressure.
  let resumePull: (() => void) | undefined;
  const awaitPull = (): Promise<void> =>
    new Promise((resolve) => {
      resumePull = resolve;
    });

  const handleEvent = (controller: Controller, data: string): void => {
    if (data.length === 0) return;
    if (data === "[DONE]") {
      // A `[DONE]` without a prior finish_reason is truncation, not a clean stop.
      if (!state.finished) finalizeTruncated(controller, "upstream sent [DONE] before a finish reason");
      return;
    }
    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(data) as OpenAiChunk;
    } catch (error) {
      // The live upstream stream is authoritative: a malformed payload is a
      // stream error, never silently skipped (WS5). Surface it and stop.
      const detail = error instanceof Error ? error.message : String(error);
      throw new SseParseError(`malformed OpenAI SSE payload in Anthropic translation: ${detail}`, data.slice(0, 200));
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
          // Upstream closed with no finish_reason: incomplete, not `end_turn`.
          if (!state.finished) finalizeTruncated(controller, "upstream stream ended before a finish reason");
          controller.close();
          return;
        }
        if (value !== undefined) {
          for (const event of sseDecoder.feed(value)) handleEvent(controller, event.data);
        }
      }
    } catch (error) {
      if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
      controller.error(error);
      void reader.cancel(error).catch(() => undefined);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Start the message immediately and keep the connection alive with `ping`
      // events while the upstream is still producing its first token. Claude
      // Code times out if it sees nothing during a slow upstream phase (the
      // chat-layer keepalive comments are dropped by this translator, so this
      // ping is the single keepalive that reaches the client).
      ensureStarted(controller);
      state.keepaliveTimer = setInterval(() => {
        if (state.finished) return;
        // Honor backpressure: skip the ping if the consumer's queue is full.
        if ((controller.desiredSize ?? 1) <= 0) return;
        try {
          controller.enqueue(sse("ping", { type: "ping" }));
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
      if (state.keepaliveTimer !== undefined) clearInterval(state.keepaliveTimer);
      resumePull?.();
      resumePull = undefined;
      return reader.cancel(reason);
    }
  });
}

// ---- token counting + discovery ----

export function countTokensEstimate(body: AnthropicRequest): number {
  const parts: string[] = [systemText(body.system)];
  for (const message of body.messages) parts.push(blockText(message.content));
  return estimateTokens(...parts);
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
  signal?: AbortSignal,
  backendOptions: BackendRequestOptions = {}
): Promise<Response> {
  const invalidThinking = thinkingValidationError(body);
  if (invalidThinking !== undefined) {
    return jsonResponse(400, {
      type: "error",
      error: { type: "invalid_request_error", message: invalidThinking }
    });
  }
  const requestedModel = body.model ?? backend.defaultModel ?? "";
  const upstreamModel = backend.resolveModel?.(body.model) ?? backend.defaultModel;
  // Server-executed web search is honored when the caller declared the server
  // tool, an executor is available, and no *client* tool already owns the
  // projected name (a client `web_search` must keep round-tripping untouched).
  const declaresWebSearch = body.tools?.some(isAnthropicWebSearchTool) === true;
  const clientNameCollision =
    body.tools?.some((tool) => !isAnthropicServerTool(tool) && tool.name === WEB_SEARCH_TOOL_NAME) === true;
  const executor =
    declaresWebSearch && !clientNameCollision ? resolveWebSearchExecutor("anthropic") : undefined;
  const serverTools = executor !== undefined;
  const chat = anthropicToChat(body, upstreamModel, { serverTools });
  const requestOptions = {
    ...backendOptions,
    modelCallId,
    // The streamed response is translated to Anthropic SSE by
    // openAiSseToAnthropic, which emits its own `ping` keepalive.
    ...(body.stream === true ? { translated: true } : {})
  };
  const upstream = await backend.chat(chat, signal, requestOptions);

  if (!upstream.ok) {
    const detail = await upstream.text();
    return jsonResponse(upstream.status, { type: "error", error: unwrapUpstreamError(detail) });
  }

  if (executor !== undefined) {
    const loopOptions = {
      chat,
      runStep: (stepChat: Record<string, unknown>) => backend.chat(stepChat, signal, requestOptions),
      serverToolNames: new Set([WEB_SEARCH_TOOL_NAME]),
      executor,
      ...(signal !== undefined ? { signal } : {})
    };
    if (body.stream === true) {
      const source = upstream.body;
      if (source === null) return jsonResponse(502, { type: "error", error: { type: "api_error", message: "no upstream stream" } });
      const composed = composeServerToolStream({ ...loopOptions, firstStep: upstream });
      return new Response(openAiSseToAnthropic(composed, requestedModel), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      });
    }
    const outcome = await runBufferedServerToolLoop({ ...loopOptions, firstStep: upstream });
    if (outcome.kind === "upstream_error") {
      const detail = await outcome.response.text();
      return jsonResponse(outcome.response.status, {
        type: "error",
        error: { type: "api_error", message: detail.slice(0, 2000) }
      });
    }
    return jsonResponse(
      200,
      chatToAnthropicMessage(
        outcome.openai as OpenAiResponse,
        requestedModel,
        outcome.searches,
        outcome.events
      )
    );
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

export type ClaudePickerModelRoute = {
  publicId: string;
  nativeId: string;
  provider: string;
};

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

export function resolveClaudeModelAlias(
  requested: string | undefined,
  modelIds: readonly string[] = []
): string | undefined {
  if (requested === undefined || modelIds.includes(requested)) return requested;
  if (!requested.startsWith(CLAUDE_ALIAS_PREFIX)) return requested;
  const candidate = requested.slice(CLAUDE_ALIAS_PREFIX.length);
  return modelIds.includes(candidate) && claudeModelAlias(candidate) === requested
    ? candidate
    : requested;
}

/**
 * Anthropic-shaped `/v1/models` discovery response. Every advertised model is
 * listed so it appears in Claude Code's `/model` picker: Anthropic-family ids
 * as-is, others under a `claude-`prefixed alias with the real id as
 * `display_name`. `modelIds` is the full advertised set (default model first);
 * when absent we fall back to the single backend default.
 */
export function anthropicModelsResponse(
  backendModel: string | undefined,
  modelIds?: readonly string[],
  modelRoutes: readonly ClaudePickerModelRoute[] = []
): Response {
  const source =
    modelIds !== undefined && modelIds.length > 0
      ? modelIds
      : backendModel !== undefined
        ? [backendModel]
        : [];
  const seen = new Set<string>();
  const routes = new Map(modelRoutes.map((route) => [route.publicId, route]));
  const models: Array<{ type: "model"; id: string; display_name: string; created_at: string }> = [];
  for (const realId of source) {
    const route = routes.get(realId);
    const displayName =
      route?.provider === "claude-code" ? route.nativeId : realId;
    const id = claudeModelAlias(displayName);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      type: "model",
      id,
      display_name: displayName,
      created_at: new Date(0).toISOString()
    });
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
