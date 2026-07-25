import { randomId } from "@velum-labs/routekit-runtime";

import { joinPath } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
import { droppedField } from "./adapters/dropped.js";
import { SseDecoder, SseParseError } from "./sse/parse.js";
import {
  anthropicMessageContentOf,
  anthropicReasoningDetailsOf,
  anthropicRequestMetadataOf,
  attachGoogleToolCallIndexes,
  googleThoughtDetailsOf,
  googleToolCallIndexesOf,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf,
  attachResponsesReasoningMetadata,
  responsesReasoningMetadataOf,
  type ResponsesReasoningItem,
  type AnthropicNativeContentBlock,
  type AnthropicReasoningDetail,
  type CanonicalReasoningDetail,
  type AnthropicRequestMetadata
} from "./adapters/openai-chat-wire.js";

function invalidReasoningControlResponse(message: string, metadata = false, path?: string): Response {
  return jsonResponse(
    { error: { type: "invalid_request_error", code: metadata ? "invalid_reasoning_metadata" : "invalid_reasoning_control", ...(path !== undefined ? { param: path } : {}), message } },
    400
  );
}

type ChatMessage = {
  role?: string;
  content?: unknown;
  reasoning?: string;
  reasoning_details?: CanonicalReasoningDetail[];
  tool_calls?: Array<{
    id?: string;
    index?: number;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
};

type ChatBody = {
  model?: string;
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: Record<string, unknown> }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  reasoning_effort?: string;
};

export type ProviderBackendOptions = {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  transport?: ProviderTransport;
  forceStream?: boolean;
  omitSampling?: boolean;
};

export type ProviderTransport = (
  url: string,
  init: RequestInit,
  options?: BackendRequestOptions
) => Promise<Response>;

abstract class HttpProviderBackend implements Backend {
  readonly defaultModel: string | undefined;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly extraHeaders: Record<string, string>;
  readonly transport: ProviderTransport;

  constructor(options: ProviderBackendOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.extraHeaders = options.headers ?? {};
    this.transport =
      options.transport ?? (async (url, init) => await fetch(url, init));
  }

  listModelIds(): readonly string[] {
    return this.defaultModel === undefined ? [] : [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return this.defaultModel === undefined || model === this.defaultModel;
  }

  models(): Promise<Response> {
    const data = this.listModelIds().map((id) => ({ id, object: "model", owned_by: "provider" }));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "embeddings are not supported" } }), {
        status: 501,
        headers: { "content-type": "application/json" }
      })
    );
  }

  abstract chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
}

function bodyRecord(body: unknown): ChatBody {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as ChatBody)
    : {};
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : []
    )
    .join("");
}

function jsonResponse(value: unknown, status = 200, headers?: Headers): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers?.get("x-request-id") !== null
        ? { "x-request-id": headers?.get("x-request-id") ?? "" }
        : {})
    }
  });
}

function copyFailure(response: Response, text: string): Response {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function chatCompletion(
  model: string,
  message: Record<string, unknown>,
  usage?: unknown,
  finishReason = "stop",
  choiceMetadata: Record<string, unknown> = {}
): unknown {
  return {
    id: randomId(18, "chatcmpl_"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, ...choiceMetadata }],
    ...(usage !== undefined ? { usage } : {})
  };
}

function normalizedOpenAiUsage(usage: unknown): unknown {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return usage;
  const value = usage as Record<string, unknown>;
  const promptTokens = value.prompt_tokens ?? value.input_tokens;
  const completionTokens = value.completion_tokens ?? value.output_tokens;
  const totalTokens =
    value.total_tokens ??
    (typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : undefined);
  return {
    ...value,
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens !== undefined ? { completion_tokens: completionTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {})
  };
}

function mapSse(
  response: Response,
  mapper: (event: string, data: unknown) => readonly unknown[]
): Response {
  if (response.body === null) return response;
  const decoder = new SseDecoder();
  const encoder = new TextEncoder();
  const mapEvents = (
    events: ReturnType<SseDecoder["feed"]>,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void => {
    for (const event of events) {
      const raw = event.data.trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new SseParseError(
          "provider SSE event contained malformed JSON",
          raw.slice(0, 200)
        );
      }
      for (const mapped of mapper(event.event ?? "message", data)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`));
      }
    }
  };
  const transformed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        mapEvents(decoder.feed(chunk), controller);
      },
      flush(controller) {
        mapEvents(decoder.flush(), controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    })
  );
  return new Response(transformed, {
    status: response.status,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

// Stands in for a closing turn that translated to nothing. Anthropic rejects
// empty and whitespace-only text, so the stand-in has to say something.
const BLANK_TURN_PLACEHOLDER = "(continue)";

function anthropicContentIsEmpty(message: Record<string, unknown> | undefined): boolean {
  return Array.isArray(message?.content) && message.content.length === 0;
}

function anthropicImageBlock(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const imageUrl = part.image_url;
  const url =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl === "object" &&
          imageUrl !== null &&
          typeof (imageUrl as { url?: unknown }).url === "string"
        ? (imageUrl as { url: string }).url
        : undefined;
  if (url === undefined) return undefined;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl !== null) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] }
    };
  }
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return undefined;
}

/**
 * Translate OpenAI chat content into Anthropic content blocks.
 *
 * Anthropic rejects text blocks that are empty or whitespace-only, so those are
 * skipped here rather than sent upstream. Callers must handle the resulting
 * empty block list; see {@link anthropicMessages}.
 */
function anthropicContentBlocks(
  content: unknown,
  context: string
): Record<string, unknown>[] {
  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "image_url") {
      const image = anthropicImageBlock(record);
      if (image !== undefined) blocks.push(image);
      else droppedField("anthropic", "image_url", context);
      continue;
    }
    if (typeof record.text === "string") {
      if (record.text.trim().length > 0) blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (typeof record.type === "string") droppedField("anthropic", record.type, context);
  }
  return blocks;
}

function anthropicNativeContent(message: ChatMessage): AnthropicNativeContentBlock[] | undefined {
  const content = anthropicMessageContentOf(message);
  if (Array.isArray(content)) return content;
  const details = anthropicReasoningDetailsOf(
    message.reasoning_details,
    "message"
  )
    .filter(
      (detail) =>
        detail.type === "redacted_thinking" ||
        (detail.type === "thinking" &&
          typeof detail.signature === "string" &&
          detail.signature.length > 0)
    )
    .sort((a, b) => a.index - b.index);
  if (details.length === 0) return undefined;
  const native: AnthropicNativeContentBlock[] = details.map(
    (detail): AnthropicNativeContentBlock =>
      detail.type === "redacted_thinking"
        ? { type: "redacted_thinking", data: detail.data }
        : {
            type: "thinking",
            thinking: detail.thinking ?? "",
            signature: detail.signature ?? ""
          }
  );
  const text = textContent(message.content);
  if (text.trim().length > 0) native.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      input = { raw: call.function?.arguments ?? "" };
    }
    native.push({
      type: "tool_use",
      id: call.id ?? randomId(12, "toolu_"),
      name: call.function?.name ?? "tool",
      input
    });
  }
  return native;
}

function anthropicMetadata(body: ChatBody): AnthropicRequestMetadata | undefined {
  return anthropicRequestMetadataOf(body);
}

function anthropicToolChoice(
  choice: unknown,
  parallelToolCalls: boolean | undefined
): Record<string, unknown> | undefined {
  const disableParallel =
    parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === "auto") return { type: "auto", ...disableParallel };
  if (choice === "required") return { type: "any", ...disableParallel };
  if (choice === "none") return { type: "none", ...disableParallel };
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
    return parallelToolCalls === false ? { type: "auto", ...disableParallel } : undefined;
  }
  const fn = (choice as { function?: { name?: unknown } }).function;
  return typeof fn?.name === "string"
    ? { type: "tool", name: fn.name, ...disableParallel }
    : undefined;
}

function anthropicMessages(body: ChatBody, model: string): Record<string, unknown> {
  const system = (body.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .join("\n\n");
  const messages = (body.messages ?? []).flatMap((message): Record<string, unknown>[] => {
    if (message.role === "system") return [];
    const nativeContent = anthropicNativeContent(message);
    if (message.role === "assistant" && nativeContent !== undefined) {
      return [{ role: "assistant", content: nativeContent }];
    }
    if (message.role === "tool") {
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id ?? "",
              content: textContent(message.content)
            }
          ]
        }
      ];
    }
    const content: unknown[] = anthropicContentBlocks(
      message.content,
      `${message.role ?? "user"}_message`
    );
    for (const call of message.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        input = { raw: call.function?.arguments ?? "" };
      }
      content.push({
        type: "tool_use",
        id: call.id ?? randomId(12, "toolu_"),
        name: call.function?.name ?? "tool",
        input
      });
    }
    return [{ role: message.role === "assistant" ? "assistant" : "user", content }];
  });
  // Anthropic rejects any user turn whose content list is empty, and OpenAI
  // clients legitimately send blank turns. Adjacent turns of the same role are
  // coalesced upstream, so dropping a blank turn loses nothing — except when it
  // was the closing turn, which models that forbid assistant prefill require.
  const kept = messages.filter((message) => !anthropicContentIsEmpty(message));
  if (anthropicContentIsEmpty(messages.at(-1)) && kept.at(-1)?.role !== "user") {
    kept.push({ role: "user", content: [{ type: "text", text: BLANK_TURN_PLACEHOLDER }] });
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  const metadata = anthropicMetadata(body);
  const selection = reasoningSelectionOf(body);
  const translatedThinking: AnthropicRequestMetadata["thinking"] | undefined =
    selection.mode === "budget"
      ? { type: "enabled", budget_tokens: selection.budgetTokens }
      : selection.mode === "adaptive" || selection.mode === "effort"
        ? { type: "adaptive" }
        : selection.mode === "disabled"
          ? { type: "disabled" }
          : undefined;
  const translatedOutput =
    selection.mode === "effort" ? { effort: selection.effort } : undefined;
  const thinking = metadata?.thinking ?? translatedThinking;
  const toolChoice = anthropicToolChoice(body.tool_choice, body.parallel_tool_calls);
  return {
    model,
    messages: kept,
    max_tokens: maxTokens,
    stream: body.stream === true,
    ...(system.trim().length > 0 ? { system } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.top_k !== undefined ? { top_k: body.top_k } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(metadata?.output_config != null
      ? { output_config: metadata.output_config }
      : translatedOutput !== undefined
        ? { output_config: translatedOutput }
        : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.tools !== undefined
      ? {
          tools: body.tools.flatMap((tool) =>
            tool.function === undefined
              ? []
              : [
                  {
                    name: tool.function.name,
                    description: tool.function.description,
                    input_schema: tool.function.parameters ?? { type: "object" }
                  }
                ]
          )
        }
      : {})
  };
}

function anthropicThinkingValidationError(body: ChatBody): string | undefined {
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  const exact = anthropicMetadata(body)?.thinking;
  const selection = reasoningSelectionOf(body);
  const budget =
    exact?.type === "enabled"
      ? exact.budget_tokens
      : selection.mode === "budget"
        ? selection.budgetTokens
        : undefined;
  if (budget !== undefined) {
    if (!Number.isInteger(budget) || budget < 1_024 || budget >= maxTokens) {
      return `thinking.budget_tokens must be an integer >= 1024 and less than max_tokens (${maxTokens})`;
    }
  }
  return undefined;
}

function openAiFinishReasonFromAnthropic(stopReason: unknown): string {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    return "length";
  }
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

export class AnthropicBackend extends HttpProviderBackend {
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    return this.#chat(bodyRecord(body), signal, options);
  }

  async #chat(
    body: ChatBody,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const model = body.model ?? this.defaultModel ?? "";
    const thinkingError = anthropicThinkingValidationError(body);
    if (thinkingError !== undefined) {
      return jsonResponse(
        { error: { type: "invalid_request_error", message: thinkingError } },
        400
      );
    }
    const response = await this.transport(
      joinPath(this.baseUrl, "/messages"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          ...this.extraHeaders
        },
        body: JSON.stringify(anthropicMessages(body, model)),
        ...(signal !== undefined ? { signal } : {})
      },
      options
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const blockTypes = new Map<number, string>();
      return mapSse(response, (event, data) => {
        const item = data as Record<string, unknown>;
        const delta = item.delta as Record<string, unknown> | undefined;
        if (event === "message_start") {
          const message = item.message as Record<string, unknown> | undefined;
          return message?.usage === undefined
            ? []
            : [
                {
                  id: randomId(18, "chatcmpl_"),
                  object: "chat.completion.chunk",
                  model,
                  choices: [],
                  usage: normalizedOpenAiUsage(message.usage)
                }
              ];
        }
        if (event === "content_block_start") {
          const block = item.content_block as Record<string, unknown> | undefined;
          const sourceIndex = typeof item.index === "number" ? item.index : 0;
          if (typeof block?.type === "string") blockTypes.set(sourceIndex, block.type);
          if (block?.type === "tool_use") {
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: item.index ?? 0,
                          id: block.id,
                          type: "function",
                          function: { name: block.name, arguments: "" }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
          if (block?.type === "thinking") {
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_details: [
                        {
                          type: "thinking",
                          index: sourceIndex,
                          phase: "start",
                          signature:
                            typeof block.signature === "string" ? block.signature : ""
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
          if (
            block?.type === "redacted_thinking" &&
            typeof block.data === "string"
          ) {
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_details: [
                        {
                          type: "redacted_thinking",
                          index: sourceIndex,
                          phase: "block",
                          data: block.data
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
        }
        if (event === "content_block_delta") {
          const sourceIndex = typeof item.index === "number" ? item.index : 0;
          const content = delta?.type === "text_delta" ? delta.text : undefined;
          const toolArguments = delta?.type === "input_json_delta" ? delta.partial_json : undefined;
          const reasoning = delta?.type === "thinking_delta" ? delta.thinking : undefined;
          const signature = delta?.type === "signature_delta" ? delta.signature : undefined;
          return [
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta:
                    toolArguments !== undefined
                      ? {
                          tool_calls: [
                            {
                              index: item.index ?? 0,
                              function: { arguments: toolArguments }
                            }
                          ]
                        }
                      : reasoning !== undefined
                        ? {
                            reasoning,
                            reasoning_details: [
                              {
                                type: "thinking",
                                index: sourceIndex,
                                phase: "delta",
                                thinking: reasoning
                              }
                            ]
                          }
                        : signature !== undefined
                          ? {
                              reasoning_details: [
                                {
                                  type: "thinking",
                                  index: sourceIndex,
                                  phase: "signature",
                                  signature
                                }
                              ]
                            }
                          : { content },
                  finish_reason: null
                }
              ]
            }
          ];
        }
        if (event === "content_block_stop") {
          const sourceIndex = typeof item.index === "number" ? item.index : 0;
          if (blockTypes.get(sourceIndex) === "thinking") {
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_details: [
                        {
                          type: "thinking",
                          index: sourceIndex,
                          phase: "stop"
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
          return [];
        }
        if (event === "message_delta") {
          const stopReason = delta?.stop_reason;
          return [
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: openAiFinishReasonFromAnthropic(stopReason),
                  ...(typeof stopReason === "string"
                    ? { anthropic_stop_reason: stopReason }
                    : {}),
                  ...(typeof delta?.stop_sequence === "string"
                    ? { anthropic_stop_sequence: delta.stop_sequence }
                    : {})
                }
              ],
              ...(item.usage !== undefined
                ? { usage: normalizedOpenAiUsage(item.usage) }
                : {})
            }
          ];
        }
        return [];
      });
    }
    const payload = (await response.json()) as {
      content?: Array<Record<string, unknown>>;
      usage?: unknown;
      stop_reason?: unknown;
      stop_sequence?: unknown;
    };
    const content = (payload.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
    const reasoning = (payload.content ?? [])
      .filter((block) => block.type === "thinking")
      .map((block) => String(block.thinking ?? ""))
      .join("");
    const reasoningDetails = (payload.content ?? []).flatMap(
      (block, index): AnthropicReasoningDetail[] => {
        if (block.type === "thinking") {
          return [
            {
              type: "thinking",
              index,
              thinking: String(block.thinking ?? ""),
              signature: typeof block.signature === "string" ? block.signature : ""
            }
          ];
        }
        if (block.type === "redacted_thinking" && typeof block.data === "string") {
          return [{ type: "redacted_thinking", index, data: block.data }];
        }
        return [];
      }
    );
    const toolCalls = (payload.content ?? []).flatMap((block, index) =>
      block.type === "tool_use"
        ? [
            {
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
              index
            }
          ]
        : []
    );
    return jsonResponse(
      chatCompletion(
        model,
        {
          role: "assistant",
          content: content.length > 0 ? content : null,
          ...(reasoning.length > 0 ? { reasoning } : {}),
          ...(reasoningDetails.length > 0
            ? { reasoning_details: reasoningDetails }
            : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        normalizedOpenAiUsage(payload.usage),
        openAiFinishReasonFromAnthropic(payload.stop_reason),
        {
          ...(typeof payload.stop_reason === "string"
            ? { anthropic_stop_reason: payload.stop_reason }
            : {}),
          ...(typeof payload.stop_sequence === "string"
            ? { anthropic_stop_sequence: payload.stop_sequence }
            : {})
        }
      ),
      200,
      response.headers
    );
  }
}

function googleThoughtDetail(
  part: Record<string, unknown>,
  index: number
): CanonicalReasoningDetail | undefined {
  if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length === 0) {
    return undefined;
  }
  return {
    type: "google_thought",
    index,
    ...(part.thought === true && typeof part.text === "string"
      ? { thought: part.text }
      : {}),
    thoughtSignature: part.thoughtSignature
  };
}

function googleAssistantParts(message: ChatMessage): Array<Record<string, unknown>> {
  const details = googleThoughtDetailsOf(message.reasoning_details);
  const detailsByIndex = new Map(details.map((detail) => [detail.index, detail]));
  const privateIndexes = googleToolCallIndexesOf(message);
  const callsByIndex = new Map(
    (message.tool_calls ?? []).flatMap((call, fallbackIndex) => {
      const index =
        typeof call.id === "string" && Number.isInteger(privateIndexes[call.id])
          ? (privateIndexes[call.id] as number)
          : Number.isInteger((call as { index?: unknown }).index)
            ? ((call as { index: number }).index)
            : fallbackIndex;
      return [[index, call] as const];
    })
  );
  if (details.length === 0) {
    const parts: Array<Record<string, unknown>> = [];
    const text = textContent(message.content);
    if (text.length > 0) parts.push({ text });
    for (const call of message.tool_calls ?? []) parts.push(googleFunctionCallPart(call));
    return parts;
  }

  const parts: Array<Record<string, unknown>> = [];
  const text = textContent(message.content);
  let textAdded = false;
  const addText = (): void => {
    if (!textAdded && text.length > 0) parts.push({ text });
    textAdded = true;
  };
  const consumedCalls = new Set<NonNullable<ChatMessage["tool_calls"]>[number]>();
  for (const index of [...new Set([...detailsByIndex.keys(), ...callsByIndex.keys()])].sort((a, b) => a - b)) {
    const detail = detailsByIndex.get(index);
    const call = callsByIndex.get(index);
    if (typeof detail?.thought === "string") {
      parts.push({ text: detail.thought, thought: true, thoughtSignature: detail.thoughtSignature });
    } else if (call !== undefined) {
      addText();
      parts.push({
        ...googleFunctionCallPart(call),
        ...(detail !== undefined ? { thoughtSignature: detail.thoughtSignature } : {})
      });
      consumedCalls.add(call);
    }
  }
  addText();
  for (const call of message.tool_calls ?? []) {
    if (!consumedCalls.has(call)) parts.push(googleFunctionCallPart(call));
  }
  return parts;
}

function googleFunctionCallPart(
  call: NonNullable<ChatMessage["tool_calls"]>[number]
): Record<string, unknown> {
  let args: unknown = {};
  try {
    args = JSON.parse(call.function?.arguments ?? "{}");
  } catch {
    args = { raw: call.function?.arguments ?? "" };
  }
  return { functionCall: { name: call.function?.name ?? "tool", args } };
}

function googleRequest(body: ChatBody): Record<string, unknown> {
  const systemText = (body.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .join("\n\n");
  const toolNames = new Map<string, string>();
  for (const message of body.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      if (call.id !== undefined && call.function?.name !== undefined) {
        toolNames.set(call.id, call.function.name);
      }
    }
  }
  const reasoning = reasoningSelectionOf(body);
  const thinkingConfig =
    reasoning.mode === "effort"
      ? { thinkingLevel: reasoning.effort }
      : reasoning.mode === "budget"
        ? { thinkingBudget: reasoning.budgetTokens }
        : reasoning.mode === "adaptive"
          ? { thinkingBudget: -1 }
          : reasoning.mode === "disabled"
            ? { thinkingBudget: 0 }
            : undefined;
  return {
    contents: (body.messages ?? []).flatMap((message) => {
      if (message.role === "system") return [];
      if (message.role === "tool") {
        return [{ role: "user", parts: [{ functionResponse: {
          name: toolNames.get(message.tool_call_id ?? "") ?? "tool",
          response: { output: textContent(message.content) }
        } }] }];
      }
      const parts = message.role === "assistant"
        ? googleAssistantParts(message)
        : textContent(message.content).length > 0
          ? [{ text: textContent(message.content) }]
          : [];
      return [{ role: message.role === "assistant" ? "model" : "user", parts }];
    }),
    ...(systemText.length > 0
      ? { systemInstruction: { role: "system", parts: [{ text: systemText }] } }
      : {}),
    generationConfig: {
      ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(thinkingConfig !== undefined ? { thinkingConfig } : {})
    },
    ...(body.tools !== undefined ? { tools: [{ functionDeclarations: body.tools.flatMap((tool) =>
      tool.function === undefined ? [] : [{
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      }]) }] } : {})
  };
}

type GoogleStreamToolPart = {
  providerIndex: number;
  toolIndex: number;
  id: string;
};

type GoogleStreamPartState = {
  nextProviderIndex: number;
  nextToolIndex: number;
  openThoughtIndex?: number;
  toolParts: Map<string, GoogleStreamToolPart>;
  thoughtText: Map<number, string>;
};

function googleFunctionIdentity(call: Record<string, unknown>): string | undefined {
  const providerId = call.id ?? call.callId ?? call.functionCallId;
  return typeof providerId === "string" && providerId.length > 0
    ? `id:${providerId}`
    : undefined;
}

function googleMessage(
  payload: Record<string, unknown>,
  streamState?: GoogleStreamPartState
): Record<string, unknown> {
  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts)
    ? (content.parts as Array<Record<string, unknown>>)
    : [];
  let bufferedToolIndex = 0;
  const indexedParts: Array<{
    part: Record<string, unknown>;
    detailPart: Record<string, unknown>;
    providerIndex: number;
    toolIndex?: number;
    id?: string;
  }> = parts.map((part, localIndex) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    if (streamState === undefined) {
      return {
        part,
        detailPart: part,
        providerIndex: localIndex,
        ...(call !== undefined ? { toolIndex: bufferedToolIndex++ } : {})
      };
    }
    if (call !== undefined) {
      streamState.openThoughtIndex = undefined;
      const identity = googleFunctionIdentity(call);
      let toolPart = identity === undefined ? undefined : streamState.toolParts.get(identity);
      if (toolPart === undefined) {
        toolPart = {
          providerIndex: streamState.nextProviderIndex++,
          toolIndex: streamState.nextToolIndex++,
          id: randomId(12, "call_")
        };
        if (identity !== undefined) streamState.toolParts.set(identity, toolPart);
      }
      return { part, detailPart: part, ...toolPart };
    }
    if (part.thought === true) {
      const signature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined;
      let providerIndex = streamState.openThoughtIndex;
      if (providerIndex === undefined) {
        providerIndex = streamState.nextProviderIndex++;
        streamState.openThoughtIndex = providerIndex;
      }
      const priorText = streamState.thoughtText.get(providerIndex) ?? "";
      const incomingText = typeof part.text === "string" ? part.text : "";
      const thought = `${priorText}${incomingText}`;
      streamState.thoughtText.set(providerIndex, thought);
      if (signature !== undefined) streamState.openThoughtIndex = undefined;
      return {
        part,
        detailPart:
          signature !== undefined
            ? { ...part, thought: true, text: thought, thoughtSignature: signature }
            : part,
        providerIndex
      };
    }
    streamState.openThoughtIndex = undefined;
    return { part, detailPart: part, providerIndex: streamState.nextProviderIndex++ };
  });
  const text = indexedParts
    .filter(({ part }) => part.thought === undefined || part.thought === false)
    .map(({ part }) => typeof part.text === "string" ? part.text : "")
    .join("");
  const reasoning = indexedParts
    .filter(({ part }) => part.thought === true)
    .map(({ part }) => typeof part.text === "string" ? part.text : "")
    .join("");
  const reasoningDetails = indexedParts.flatMap(({ detailPart, providerIndex }) => {
    const detail = googleThoughtDetail(detailPart, providerIndex);
    return detail === undefined ? [] : [detail];
  });
  const toolCalls = indexedParts.flatMap(({ part, providerIndex, toolIndex, id }) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    return call === undefined || toolIndex === undefined ? [] : [{
      id: id ?? randomId(12, "call_"),
      type: "function",
      index: toolIndex,
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      providerIndex
    }];
  });
  const message: Record<PropertyKey, unknown> = {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map(({ providerIndex: _providerIndex, ...call }) => call)
        }
      : {})
  };
  const providerIndexes = Object.fromEntries(
    toolCalls.map((call) => [call.id, call.providerIndex])
  );
  if (Object.keys(providerIndexes).length > 0) {
    attachGoogleToolCallIndexes(message, providerIndexes);
  }
  return message;
}

export class GoogleGenAiBackend extends HttpProviderBackend {
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    return this.#chat(bodyRecord(body), signal, options);
  }

  async #chat(
    body: ChatBody,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const model = body.model ?? this.defaultModel ?? "";
    const method = body.stream === true ? "streamGenerateContent" : "generateContent";
    const response = await this.transport(
      `${joinPath(this.baseUrl, `/models/${encodeURIComponent(model)}:${method}`)}${
        body.stream === true ? "?alt=sse" : ""
      }`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
          ...this.extraHeaders
        },
        body: JSON.stringify(googleRequest(body)),
        ...(signal !== undefined ? { signal } : {})
      },
      options
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const streamState: GoogleStreamPartState = {
        nextProviderIndex: 0,
        nextToolIndex: 0,
        toolParts: new Map(),
        thoughtText: new Map()
      };
      return mapSse(response, (_event, data) => {
        const payload = data as Record<string, unknown>;
        const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
        const finishReason = candidates?.[0]?.finishReason;
        const usage = payload.usageMetadata as Record<string, unknown> | undefined;
        return [
          {
            id: randomId(18, "chatcmpl_"),
            object: "chat.completion.chunk",
            model,
            choices: [
              {
                index: 0,
                delta: googleMessage(payload, streamState),
                finish_reason:
                  finishReason === undefined
                    ? null
                    : finishReason === "MAX_TOKENS"
                      ? "length"
                      : "stop"
              }
            ],
            ...(usage !== undefined
              ? {
                  usage: {
                    prompt_tokens: usage.promptTokenCount,
                    completion_tokens: usage.candidatesTokenCount,
                    total_tokens: usage.totalTokenCount
                  }
                }
              : {})
          }
        ];
      });
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const usage = payload.usageMetadata as Record<string, unknown> | undefined;
    return jsonResponse(
      chatCompletion(model, googleMessage(payload), {
        prompt_tokens: usage?.promptTokenCount,
        completion_tokens: usage?.candidatesTokenCount,
        total_tokens: usage?.totalTokenCount
      })
    );
  }
}

function responsesRequest(
  body: ChatBody,
  model: string,
  options: { forceStream: boolean; omitSampling: boolean }
): Record<string, unknown> {
  const reasoning = reasoningSelectionOf(body);
  const input = (body.messages ?? []).flatMap((message): Record<string, unknown>[] => {
    if (message.role === "tool") {
      return [
        {
          type: "function_call_output",
          call_id: message.tool_call_id ?? "",
          output: textContent(message.content)
        }
      ];
    }
    const items: Record<string, unknown>[] = [];
    const reasoningMetadata = responsesReasoningMetadataOf(message);
    for (const item of reasoningMetadata?.items ?? []) {
      items.push({
        type: "reasoning",
        ...(item.id !== undefined ? { id: item.id } : {}),
        ...(Object.hasOwn(item, "summary") ? { summary: item.summary } : {}),
        ...(Object.hasOwn(item, "content") ? { content: item.content } : {}),
        encrypted_content: item.encrypted_content
      });
    }
    const text = textContent(message.content);
    if (text.length > 0) {
      items.push({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text
          }
        ]
      });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id ?? randomId(12, "call_"),
        name: call.function?.name ?? "tool",
        arguments: call.function?.arguments ?? "{}"
      });
    }
    return items;
  });
  const includeEncryptedContent =
    responsesReasoningMetadataOf(body)?.includeEncryptedContent === true ||
    (body.messages ?? []).some(
      (message) => responsesReasoningMetadataOf(message)?.includeEncryptedContent === true
    );
  return {
    model,
    input,
    stream: options.forceStream || body.stream === true,
    store: false,
    ...(includeEncryptedContent ? { include: ["reasoning.encrypted_content"] } : {}),
    ...(reasoning.mode === "effort"
      ? { reasoning: { effort: reasoning.effort } }
      : {}),
    ...(!options.omitSampling && body.max_tokens !== undefined
      ? { max_output_tokens: body.max_tokens }
      : {}),
    ...(!options.omitSampling && body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.tools !== undefined
      ? {
          tools: body.tools.flatMap((tool) =>
            tool.function === undefined
              ? []
              : [
                  {
                    type: "function",
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters ?? { type: "object" }
                  }
                ]
          )
        }
      : {})
  };
}

function responsesOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const output = payload.output as Array<Record<string, unknown>> | undefined;
  const reasoning = (output ?? [])
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => {
      const summary = item.summary as Array<Record<string, unknown>> | undefined;
      return (summary ?? []).flatMap((part) =>
        typeof part.text === "string" ? [part.text] : []
      );
    })
    .join("");
  const text = (output ?? []).flatMap((item) => {
    const content = item.content as Array<Record<string, unknown>> | undefined;
    return (content ?? []).flatMap((part) =>
      typeof part.text === "string" ? [part.text] : []
    );
  }).join("");
  const reasoningItems = (output ?? []).filter(
    (item) => item.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0
  );
  const toolCalls = (output ?? []).flatMap((item, index) =>
    item.type === "function_call"
      ? [
          {
            id: item.call_id ?? item.id,
            type: "function",
            index,
            function: { name: item.name, arguments: item.arguments ?? "{}" }
          }
        ]
      : []
  );
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
  if (reasoningItems.length > 0) {
    attachResponsesReasoningMetadata(message, {
      items: reasoningItems as ResponsesReasoningItem[],
      includeEncryptedContent: false
    });
  }
  return message;
}

const CODEX_EMPTY_RESPONSE_ERROR = {
  message: "Codex completed without assistant content or tool calls",
  type: "upstream_empty_response"
} as const;

function responsesItemText(item: Record<string, unknown>): string {
  if (item.type !== "message") return "";
  const content = item.content as Array<Record<string, unknown>> | undefined;
  return (content ?? [])
    .flatMap((part) => typeof part.text === "string" ? [part.text] : [])
    .join("");
}

function codexCompletionResponse(
  model: string,
  payload: Record<string, unknown>
): Response {
  const message = responsesOutput(payload);
  const hasOutput =
    (typeof message.content === "string" && message.content.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  return hasOutput
    ? jsonResponse(
        chatCompletion(model, message, normalizedOpenAiUsage(payload.usage))
      )
    : jsonResponse({ error: CODEX_EMPTY_RESPONSE_ERROR }, 502);
}

export class CodexResponsesBackend extends HttpProviderBackend {
  readonly #accountId: string | undefined;
  readonly #forceStream: boolean;
  readonly #omitSampling: boolean;

  constructor(options: ProviderBackendOptions & { accountId?: string }) {
    super(options);
    this.#accountId = options.accountId;
    this.#forceStream = options.forceStream ?? false;
    this.#omitSampling = options.omitSampling ?? false;
  }

  reasoningWireShape(): string {
    return "openai-responses";
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    return this.#chat(bodyRecord(body), signal, options);
  }

  async #chat(
    body: ChatBody,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const model = body.model ?? this.defaultModel ?? "";
    const reasoning = reasoningSelectionOf(body);
    if (reasoning.mode === "budget" || reasoning.mode === "adaptive") {
      return jsonResponse(
        {
          error: {
            type: "invalid_request_error",
            message: `Codex Responses cannot represent reasoning mode "${reasoning.mode}"`
          }
        },
        400
      );
    }
    const response = await this.transport(
      joinPath(this.baseUrl, "/responses"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(this.#accountId !== undefined ? { "chatgpt-account-id": this.#accountId } : {}),
          ...this.extraHeaders
        },
        body: JSON.stringify(
          responsesRequest(body, model, {
            forceStream: this.#forceStream,
            omitSampling: this.#omitSampling
          })
        ),
        ...(signal !== undefined ? { signal } : {})
      },
      options
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      let hasToolCalls = false;
      let hasAssistantContent = false;
      const emittedText = new Map<number, string>();
      const contentChunk = (content: string): Record<string, unknown> => ({
        id: randomId(18, "chatcmpl_"),
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }]
      });
      const recoverMessage = (
        output: Record<string, unknown>,
        outputIndex: number
      ): Record<string, unknown>[] => {
        const complete = responsesItemText(output);
        const previous = emittedText.get(outputIndex) ?? "";
        const suffix = complete.startsWith(previous)
          ? complete.slice(previous.length)
          : "";
        if (suffix.length === 0) return [];
        emittedText.set(outputIndex, complete);
        hasAssistantContent = true;
        return [contentChunk(suffix)];
      };
      return mapSse(response, (event, data) => {
        const item = data as Record<string, unknown>;
        const eventType =
          event === "message" && typeof item.type === "string" ? item.type : event;
        if (
          eventType === "response.reasoning_summary_text.delta" ||
          eventType === "response.reasoning_text.delta"
        ) {
          return [
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning: item.delta },
                  finish_reason: null
                }
              ]
            }
          ];
        }
        if (eventType === "response.output_text.delta") {
          const outputIndex =
            typeof item.output_index === "number" ? item.output_index : 0;
          const delta = typeof item.delta === "string" ? item.delta : "";
          emittedText.set(outputIndex, `${emittedText.get(outputIndex) ?? ""}${delta}`);
          if (delta.length === 0) return [];
          hasAssistantContent = true;
          return [contentChunk(delta)];
        }
        if (eventType === "response.function_call_arguments.delta") {
          return [
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: item.output_index ?? 0,
                        function: { arguments: item.delta }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            }
          ];
        }
        if (eventType === "response.output_item.added") {
          const output = item.item as Record<string, unknown> | undefined;
          if (output?.type !== "function_call") return [];
          hasToolCalls = true;
          return [
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: item.output_index ?? 0,
                        id: output.call_id ?? output.id,
                        type: "function",
                        function: { name: output.name, arguments: "" }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            }
          ];
        }
        if (eventType === "response.output_item.done") {
          const output = item.item as Record<string, unknown> | undefined;
          if (
            output?.type === "reasoning" &&
            typeof output.encrypted_content === "string" &&
            output.encrypted_content.length > 0
          ) {
            const delta: Record<string, unknown> = {};
            attachResponsesReasoningMetadata(delta, {
              items: [output as ResponsesReasoningItem],
              includeEncryptedContent: false
            });
            return [{
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta, finish_reason: null }]
            }];
          }
          if (output?.type !== "message") return [];
          const outputIndex =
            typeof item.output_index === "number" ? item.output_index : 0;
          return recoverMessage(output, outputIndex);
        }
        if (eventType === "response.completed") {
          const completed = item.response as Record<string, unknown> | undefined;
          const recovered = Array.isArray(completed?.output)
            ? completed.output.flatMap((output, outputIndex) =>
                typeof output === "object" &&
                output !== null &&
                (output as Record<string, unknown>).type === "message"
                  ? recoverMessage(
                      output as Record<string, unknown>,
                      outputIndex
                    )
                  : []
              )
            : [];
          if (!hasAssistantContent && !hasToolCalls) {
            return [...recovered, { error: CODEX_EMPTY_RESPONSE_ERROR }];
          }
          return [
            ...recovered,
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: hasToolCalls ? "tool_calls" : "stop"
                }
              ],
              ...(completed?.usage !== undefined
                ? { usage: normalizedOpenAiUsage(completed.usage) }
                : {})
            }
          ];
        }
        if (
          eventType === "response.failed" ||
          eventType === "response.incomplete" ||
          eventType === "error"
        ) {
          return [
            {
              error: {
                message: "Codex response did not complete",
                type: "upstream_error"
              }
            }
          ];
        }
        return [];
      });
    }
    if (this.#forceStream) {
      const decoder = new SseDecoder();
      const events = [
        ...decoder.feed(await response.text()),
        ...decoder.flush()
      ];
      const completedOutput = new Map<number, Record<string, unknown>>();
      let completedResponse: Record<string, unknown> | undefined;
      for (const event of events) {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          if (
            event.event !== "response.output_item.done" &&
            event.event !== "response.completed"
          ) {
            continue;
          }
          throw new SseParseError(
            "provider SSE event contained malformed JSON",
            event.data.slice(0, 200)
          );
        }
        if (typeof payload !== "object" || payload === null) continue;
        const record = payload as Record<string, unknown>;
        const eventType = event.event ?? record.type;
        if (
          eventType === "response.output_item.done" &&
          typeof record.item === "object" &&
          record.item !== null
        ) {
          const outputIndex =
            typeof record.output_index === "number"
              ? record.output_index
              : completedOutput.size;
          completedOutput.set(
            outputIndex,
            record.item as Record<string, unknown>
          );
        }
        if (
          eventType === "response.completed" &&
          typeof record.response === "object" &&
          record.response !== null
        ) {
          completedResponse = record.response as Record<string, unknown>;
        }
      }
      if (completedResponse !== undefined) {
        const terminalOutput = Array.isArray(completedResponse.output)
          ? [...completedResponse.output]
          : [];
        for (const [outputIndex, output] of completedOutput) {
          if (terminalOutput[outputIndex] === undefined) {
            terminalOutput[outputIndex] = output;
          }
        }
        const payload = { ...completedResponse, output: terminalOutput };
        return codexCompletionResponse(model, payload);
      }
      throw new SseParseError(
        "provider SSE stream ended without response.completed"
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return codexCompletionResponse(model, payload);
  }
}
