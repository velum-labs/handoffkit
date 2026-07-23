import { randomId } from "@velum-labs/routekit-runtime";

import { joinPath } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
import { SseDecoder, SseParseError } from "./sse/parse.js";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  ANTHROPIC_REQUEST_METADATA,
  anthropicReasoningDetailsOf,
  reasoningSelectionOf,
  type AnthropicNativeContentBlock,
  type AnthropicReasoningDetail,
  type AnthropicRequestMetadata
} from "./adapters/openai-chat-wire.js";

type ChatMessage = {
  role?: string;
  content?: unknown;
  reasoning?: string;
  reasoning_details?: AnthropicReasoningDetail[];
  tool_calls?: Array<{
    id?: string;
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

function anthropicNativeContent(message: ChatMessage): AnthropicNativeContentBlock[] | undefined {
  const content = (message as ChatMessage & {
    [ANTHROPIC_MESSAGE_CONTENT]?: AnthropicNativeContentBlock[];
  })[ANTHROPIC_MESSAGE_CONTENT];
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
  if (text.length > 0) native.push({ type: "text", text });
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
  return (body as ChatBody & {
    [ANTHROPIC_REQUEST_METADATA]?: AnthropicRequestMetadata;
  })[ANTHROPIC_REQUEST_METADATA];
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
    const content: unknown[] = [];
    const text = textContent(message.content);
    if (text.length > 0) content.push({ type: "text", text });
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
    messages,
    max_tokens: maxTokens,
    stream: body.stream === true,
    ...(system.length > 0 ? { system } : {}),
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
        return [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: toolNames.get(message.tool_call_id ?? "") ?? "tool",
                  response: { output: textContent(message.content) }
                }
              }
            ]
          }
        ];
      }
      const parts: Array<Record<string, unknown>> = [];
      const text = textContent(message.content);
      if (text.length > 0) parts.push({ text });
      for (const call of message.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          args = { raw: call.function?.arguments ?? "" };
        }
        parts.push({
          functionCall: {
            name: call.function?.name ?? "tool",
            args
          }
        });
      }
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
    ...(body.tools !== undefined
      ? {
          tools: [
            {
              functionDeclarations: body.tools.flatMap((tool) =>
                tool.function === undefined
                  ? []
                  : [
                      {
                        name: tool.function.name,
                        description: tool.function.description,
                        parameters: tool.function.parameters
                      }
                    ]
              )
            }
          ]
        }
      : {})
  };
}

function googleMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  const text = (parts ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  const toolCalls = (parts ?? []).flatMap((part, index) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    return call === undefined
      ? []
      : [
          {
            id: randomId(12, "call_"),
            type: "function",
            index,
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
          }
        ];
  });
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

export class GoogleGenAiBackend extends HttpProviderBackend {
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
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
                delta: googleMessage(payload),
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
  return {
    model,
    input,
    stream: options.forceStream || body.stream === true,
    store: false,
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
  return {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
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

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
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
      return mapSse(response, (event, data) => {
        const item = data as Record<string, unknown>;
        if (
          event === "response.reasoning_summary_text.delta" ||
          event === "response.reasoning_text.delta"
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
        if (event === "response.output_text.delta") {
          return [
            {
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { content: item.delta }, finish_reason: null }]
            }
          ];
        }
        if (event === "response.function_call_arguments.delta") {
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
        if (event === "response.output_item.added") {
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
        if (event === "response.completed") {
          const completed = item.response as Record<string, unknown> | undefined;
          return [
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
        return [];
      });
    }
    if (this.#forceStream) {
      const decoder = new SseDecoder();
      const events = [
        ...decoder.feed(await response.text()),
        ...decoder.flush()
      ];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.event !== "response.completed") continue;
        let completed: unknown;
        try {
          completed = JSON.parse(event.data);
        } catch {
          throw new SseParseError(
            "provider SSE event contained malformed JSON",
            event.data.slice(0, 200)
          );
        }
        if (
          typeof completed === "object" &&
          completed !== null &&
          typeof (completed as Record<string, unknown>).response === "object" &&
          (completed as Record<string, unknown>).response !== null
        ) {
          const payload = (completed as { response: Record<string, unknown> })
            .response;
          return jsonResponse(
            chatCompletion(
              model,
              responsesOutput(payload),
              normalizedOpenAiUsage(payload.usage)
            )
          );
        }
      }
      throw new SseParseError(
        "provider SSE stream ended without response.completed"
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return jsonResponse(
      chatCompletion(model, responsesOutput(payload), normalizedOpenAiUsage(payload.usage))
    );
  }
}
