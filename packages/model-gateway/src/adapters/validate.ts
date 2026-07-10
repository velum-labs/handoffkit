/**
 * Structural request validation at the gateway's wire doors.
 *
 * Hostile-input fuzzing showed that malformed bodies (a `model` array, a
 * `messages` string, an empty body) sailed past the doors, hit deep code, and
 * surfaced as 502 `upstream_error`s carrying raw TypeError text
 * ("requested.startsWith is not a function", "body.messages is not iterable")
 * or internal fusion jargon ("proposal mode (k=1) needs the caller's
 * `messages`"). A caller error must be a 400 in the door's native error
 * envelope, and it must never reach the panel (no provider fanout, no spend).
 *
 * Validation here is *structural only* — field presence and JSON types
 * matching what the real providers enforce. Semantic rules (role enums,
 * schema shapes) stay with the providers, so the doors never reject a shape a
 * real provider would accept.
 */

export type WireRejection = { status: number; body: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openAiError(message: string): WireRejection {
  return {
    status: 400,
    body: { error: { message, type: "invalid_request_error", code: "invalid_request" } }
  };
}

function anthropicError(message: string): WireRejection {
  return {
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message } }
  };
}

type ErrorShape = (message: string) => WireRejection;

/** Validate the common message-array shape without imposing a dialect's role enum. */
function checkMessages(
  body: Record<string, unknown>,
  shape: ErrorShape,
  options: { allowEmpty?: boolean; allowNullContent?: boolean } = {}
): WireRejection | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return shape("`messages` is required and must be an array of message objects");
  }
  if (messages.length === 0 && options.allowEmpty !== true) {
    return shape("`messages` must contain at least one message");
  }
  for (const message of messages) {
    if (!isObject(message) || typeof message.role !== "string") {
      return shape("every message must be an object with a string `role`");
    }
    if (
      message.role === "tool" &&
      (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0)
    ) {
      return shape("tool messages require a non-empty `tool_call_id`");
    }
    const content = message.content;
    if (content === null && options.allowNullContent === false) {
      return shape("message `content` must not be null");
    }
    if (content !== undefined && content !== null && typeof content !== "string" && !Array.isArray(content)) {
      return shape("message `content` must be a string, an array of content parts, or null");
    }
    if (Array.isArray(content) && content.some((part) => !isObject(part))) {
      return shape("every message content part must be an object");
    }
    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined && toolCalls !== null) {
      if (!Array.isArray(toolCalls)) {
        return shape("message `tool_calls` must be an array");
      }
      if (message.role !== "assistant") {
        return shape("message `tool_calls` are only valid on assistant messages");
      }
      for (const call of toolCalls) {
        if (!isObject(call)) return shape("every tool call must be an object");
        const functionCall = isObject(call.function) ? call.function : call;
        if (typeof functionCall.name !== "string" || functionCall.name.length === 0) {
          return shape("every tool call requires a function name");
        }
        if (typeof functionCall.arguments !== "string") {
          return shape("tool-call `arguments` must be a JSON string");
        }
        try {
          const parsed = JSON.parse(functionCall.arguments) as unknown;
          if (!isObject(parsed)) {
            return shape("tool-call `arguments` must encode a JSON object");
          }
        } catch {
          return shape("tool-call `arguments` must be valid JSON");
        }
      }
    }
  }
  return undefined;
}

function checkModel(body: Record<string, unknown>, shape: ErrorShape): WireRejection | undefined {
  if (body.model !== undefined && typeof body.model !== "string") {
    return shape("`model` must be a string");
  }
  return undefined;
}

function checkStream(body: Record<string, unknown>, shape: ErrorShape): WireRejection | undefined {
  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== "boolean") {
    return shape("`stream` must be a boolean");
  }
  return undefined;
}

function checkPositiveInteger(
  body: Record<string, unknown>,
  field: string,
  shape: ErrorShape
): WireRejection | undefined {
  const value = body[field];
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1)
  ) {
    return shape(`\`${field}\` must be a positive integer`);
  }
  return undefined;
}

function checkTools(
  body: Record<string, unknown>,
  shape: ErrorShape
): WireRejection | undefined {
  const tools = body.tools;
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) {
    return shape("`tools` must be an array of tool definitions");
  }
  if (tools.some((tool) => !isObject(tool))) {
    return shape("every tool definition must be an object");
  }
  return undefined;
}

/** OpenAI Chat Completions door (`/v1/chat/completions`). */
export function validateChatRequest(body: unknown): WireRejection | undefined {
  if (!isObject(body)) return openAiError("request body must be a JSON object");
  return (
    checkModel(body, openAiError) ??
    checkStream(body, openAiError) ??
    checkPositiveInteger(body, "max_tokens", openAiError) ??
    checkPositiveInteger(body, "max_completion_tokens", openAiError) ??
    checkMessages(body, openAiError) ??
    checkTools(body, openAiError)
  );
}

/** Anthropic Messages door (`/v1/messages`). */
export function validateAnthropicRequest(body: unknown): WireRejection | undefined {
  if (!isObject(body)) return anthropicError("request body must be a JSON object");
  const system = body.system;
  return (
    checkModel(body, anthropicError) ??
    checkStream(body, anthropicError) ??
    checkPositiveInteger(body, "max_tokens", anthropicError) ??
    checkMessages(body, anthropicError, { allowNullContent: false }) ??
    checkTools(body, anthropicError) ??
    (system !== undefined && system !== null && typeof system !== "string" && !Array.isArray(system)
      ? anthropicError("`system` must be a string or an array of text blocks")
      : undefined)
  );
}

/** Anthropic `count_tokens` door: same message-shape contract, no minimum length. */
export function validateCountTokensRequest(body: unknown): WireRejection | undefined {
  if (!isObject(body)) return anthropicError("request body must be a JSON object");
  return checkMessages(body, anthropicError, {
    allowEmpty: true,
    allowNullContent: false
  });
}

/** OpenAI Responses door (`/v1/responses`). */
export function validateResponsesRequest(body: unknown): WireRejection | undefined {
  if (!isObject(body)) return openAiError("request body must be a JSON object");
  const model =
    checkModel(body, openAiError) ??
    checkStream(body, openAiError) ??
    checkPositiveInteger(body, "max_output_tokens", openAiError) ??
    checkTools(body, openAiError);
  if (model !== undefined) return model;
  const input = body.input;
  if (typeof input === "string") return undefined;
  if (Array.isArray(input)) {
    if (input.length === 0) return openAiError("`input` must not be an empty array");
    for (const item of input) {
      if (!isObject(item)) return openAiError("every `input` item must be an object");
    }
    return undefined;
  }
  return openAiError("`input` is required and must be a string or an array of input items");
}
