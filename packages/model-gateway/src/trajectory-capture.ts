/**
 * Dynamic trajectory discovery at the gateway wire boundary.
 *
 * Instead of parsing each coding CLI's bespoke stdout, we observe the normalized
 * provider traffic the gateway already proxies (the harness's model-driven tool
 * loop) and reconstruct a uniform agent trajectory from it. There are only three
 * provider dialects, so this is three small parsers against stable wire shapes,
 * harness-agnostic. fusionkit owns no verification, so reconstructed steps carry
 * raw observations only — never a computed verdict.
 */
import type { ProvenanceSink, ModelGatewayCallContext, ModelGatewayCallResult } from "./provenance.js";

/** A normalized trajectory step (mirrors harness-trajectory.v1 / TrajectoryStep). */
export type CapturedStep = {
  index: number;
  type: "reasoning" | "tool_call" | "observation" | "output";
  text?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_input?: string;
};

export type CapturedTrajectory = {
  steps: CapturedStep[];
  finalOutput: string;
};

type RawCall = {
  dialect: ModelGatewayCallContext["dialect"];
  requestBody: unknown;
  responseText: string;
  statusCode: number;
};

const MAX_TEXT = 4000;
const MAX_TOOL_INPUT = 600;

function truncate(text: string, limit = 2000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** OpenAI/Anthropic message `content` can be a string or an array of parts. */
function contentText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) return direct;
  const parts = asArray(content)
    .map((part) => {
      const obj = asObject(part);
      if (obj === undefined) return "";
      // Anthropic text block / OpenAI content part.
      if (obj.type === "text" || obj.type === "output_text") return asString(obj.text) ?? "";
      return "";
    })
    .filter((text) => text.length > 0);
  return parts.join("");
}

/**
 * Reconstruct steps from an OpenAI chat-completions conversation: assistant
 * messages (text + tool_calls) interleaved with tool-result messages. The final
 * assistant message with no tool calls is the answer.
 */
function fromOpenAiChat(messages: unknown[]): CapturedStep[] {
  const steps: CapturedStep[] = [];
  let index = 0;
  const push = (step: Omit<CapturedStep, "index">): void => {
    steps.push({ index: index++, ...step });
  };
  for (const message of messages) {
    const obj = asObject(message);
    if (obj === undefined) continue;
    const role = asString(obj.role);
    if (role === "assistant") {
      const text = contentText(obj.content);
      const toolCalls = asArray(obj.tool_calls);
      if (text.length > 0 && toolCalls.length > 0) {
        push({ type: "reasoning", text: truncate(text, MAX_TEXT) });
      } else if (text.length > 0) {
        push({ type: "output", text: truncate(text, MAX_TEXT) });
      }
      for (const call of toolCalls) {
        const callObj = asObject(call);
        const fn = asObject(callObj?.function);
        push({
          type: "tool_call",
          ...(asString(fn?.name) !== undefined ? { tool_name: asString(fn?.name) } : {}),
          ...(asString(callObj?.id) !== undefined ? { tool_call_id: asString(callObj?.id) } : {}),
          tool_input: truncate(stringify(fn?.arguments ?? {}), MAX_TOOL_INPUT)
        });
      }
    } else if (role === "tool") {
      push({
        type: "observation",
        ...(asString(obj.tool_call_id) !== undefined
          ? { tool_call_id: asString(obj.tool_call_id) }
          : {}),
        text: truncate(contentText(obj.content), MAX_TEXT)
      });
    }
  }
  return steps;
}

/**
 * Reconstruct steps from an OpenAI Responses `input` item list (what Codex sends
 * with `wire_api = "responses"`): message items, function_call items, and
 * function_call_output items.
 */
function fromResponses(input: unknown[]): CapturedStep[] {
  const steps: CapturedStep[] = [];
  let index = 0;
  const push = (step: Omit<CapturedStep, "index">): void => {
    steps.push({ index: index++, ...step });
  };
  for (const item of input) {
    const obj = asObject(item);
    if (obj === undefined) continue;
    const type = asString(obj.type);
    if (type === "function_call") {
      push({
        type: "tool_call",
        ...(asString(obj.name) !== undefined ? { tool_name: asString(obj.name) } : {}),
        ...(asString(obj.call_id) !== undefined ? { tool_call_id: asString(obj.call_id) } : {}),
        tool_input: truncate(stringify(obj.arguments ?? {}), MAX_TOOL_INPUT)
      });
    } else if (type === "function_call_output") {
      push({
        type: "observation",
        ...(asString(obj.call_id) !== undefined ? { tool_call_id: asString(obj.call_id) } : {}),
        text: truncate(contentText(obj.output ?? obj.content), MAX_TEXT)
      });
    } else {
      // message item (role + content) or reasoning item.
      const role = asString(obj.role);
      const text = contentText(obj.content);
      if (text.length === 0) continue;
      if (role === "assistant") push({ type: "output", text: truncate(text, MAX_TEXT) });
      else if (role !== "user" && role !== "system") {
        push({ type: "reasoning", text: truncate(text, MAX_TEXT) });
      }
    }
  }
  return steps;
}

/**
 * Reconstruct steps from an Anthropic Messages conversation: assistant messages
 * carry `text`, `thinking`, and `tool_use` content blocks; user messages carry
 * `tool_result` blocks.
 */
function fromAnthropic(messages: unknown[]): CapturedStep[] {
  const steps: CapturedStep[] = [];
  let index = 0;
  const push = (step: Omit<CapturedStep, "index">): void => {
    steps.push({ index: index++, ...step });
  };
  for (const message of messages) {
    const obj = asObject(message);
    if (obj === undefined) continue;
    const role = asString(obj.role);
    for (const block of asArray(obj.content)) {
      const b = asObject(block);
      if (b === undefined) continue;
      const type = asString(b.type);
      if (type === "thinking" && role === "assistant") {
        push({ type: "reasoning", text: truncate(asString(b.thinking) ?? "", MAX_TEXT) });
      } else if (type === "text" && role === "assistant") {
        // User/system text is the prompt, not a trajectory step; skip it.
        const text = asString(b.text) ?? "";
        if (text.length > 0) push({ type: "output", text: truncate(text, MAX_TEXT) });
      } else if (type === "tool_use") {
        push({
          type: "tool_call",
          ...(asString(b.name) !== undefined ? { tool_name: asString(b.name) } : {}),
          ...(asString(b.id) !== undefined ? { tool_call_id: asString(b.id) } : {}),
          tool_input: truncate(stringify(b.input ?? {}), MAX_TOOL_INPUT)
        });
      } else if (type === "tool_result") {
        push({
          type: "observation",
          ...(asString(b.tool_use_id) !== undefined ? { tool_call_id: asString(b.tool_use_id) } : {}),
          text: truncate(contentText(b.content), MAX_TEXT)
        });
      }
    }
  }
  return steps;
}

function stepsForCall(call: RawCall): CapturedStep[] {
  const body = asObject(call.requestBody);
  if (body === undefined) return [];
  switch (call.dialect) {
    case "openai-chat":
      return fromOpenAiChat(asArray(body.messages));
    case "openai-responses":
      return fromResponses(typeof body.input === "string" ? [] : asArray(body.input));
    case "anthropic-messages":
      return fromAnthropic(asArray(body.messages));
    default: {
      const exhaustive: never = call.dialect;
      throw new Error(`unsupported gateway dialect: ${String(exhaustive)}`);
    }
  }
}

/** Parse a single JSON document; undefined when the text is not one (e.g. SSE). */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Decode the JSON payloads of an SSE event stream (`data: {...}` lines). Used to
 * reconstruct the final answer from a streamed response: coding CLIs (codex)
 * request `stream: true`, so the captured response body is an event stream, not
 * a single JSON object. Comment lines, the `[DONE]` sentinel, and unparseable
 * lines are skipped.
 */
function parseSseEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    const obj = asObject(tryParseJson(payload));
    if (obj !== undefined) events.push(obj);
  }
  return events;
}

/** Final assistant text from an OpenAI Responses event stream. */
function finalOutputFromResponsesSse(events: Record<string, unknown>[]): string {
  const assistantTextFromOutput = (output: unknown[]): string => {
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const obj = asObject(output[i]);
      if (obj?.type === "message" || obj?.role === "assistant") {
        const text = contentText(obj.content);
        if (text.length > 0) return text;
      }
    }
    return "";
  };
  // Prefer the terminal response object (carries the full assembled output).
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = asString(events[i]?.type);
    if (type === "response.completed" || type === "response.incomplete") {
      const text = assistantTextFromOutput(asArray(asObject(events[i]?.response)?.output));
      if (text.length > 0) return text;
    }
  }
  // Then a completed message output item.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (asString(events[i]?.type) !== "response.output_item.done") continue;
    const item = asObject(events[i]?.item);
    if (item?.type === "message") {
      const text = contentText(item.content);
      if (text.length > 0) return text;
    }
  }
  // Finally, accumulate the streamed text deltas.
  let accumulated = "";
  for (const event of events) {
    if (asString(event.type) === "response.output_text.delta") {
      accumulated += asString(event.delta) ?? "";
    }
  }
  return accumulated;
}

/** Final assistant text from an OpenAI chat-completions chunk stream. */
function finalOutputFromChatSse(events: Record<string, unknown>[]): string {
  let accumulated = "";
  for (const event of events) {
    const choice = asObject(asArray(event.choices)[0]);
    if (choice === undefined) continue;
    accumulated += asString(asObject(choice.delta)?.content) ?? "";
    const message = asObject(choice.message);
    if (message !== undefined) accumulated += contentText(message.content);
  }
  return accumulated;
}

/** Final assistant text from an Anthropic Messages event stream. */
function finalOutputFromAnthropicSse(events: Record<string, unknown>[]): string {
  let accumulated = "";
  for (const event of events) {
    if (asString(event.type) !== "content_block_delta") continue;
    const delta = asObject(event.delta);
    if (asString(delta?.type) === "text_delta") accumulated += asString(delta?.text) ?? "";
  }
  return accumulated;
}

/** Reconstruct the final answer from a streamed (SSE) response body. */
function finalOutputFromSse(call: RawCall): string {
  const events = parseSseEvents(call.responseText);
  if (events.length === 0) return "";
  switch (call.dialect) {
    case "openai-responses":
      return finalOutputFromResponsesSse(events);
    case "openai-chat":
      return finalOutputFromChatSse(events);
    case "anthropic-messages":
      return finalOutputFromAnthropicSse(events);
    default: {
      const exhaustive: never = call.dialect;
      throw new Error(`unsupported gateway dialect: ${String(exhaustive)}`);
    }
  }
}

/** Pull the final assistant text out of a model response body (per dialect). */
function finalOutputForCall(call: RawCall): string {
  const body = asObject(tryParseJson(call.responseText));
  if (body === undefined) {
    // Not a single JSON object: a streamed response is an SSE event stream.
    return finalOutputFromSse(call);
  }
  if (call.dialect === "anthropic-messages") return contentText(body.content);
  if (call.dialect === "openai-responses") {
    const output = asArray(body.output);
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const obj = asObject(output[i]);
      if (obj?.type === "message" || obj?.role === "assistant") return contentText(obj.content);
    }
    return asString(body.output_text) ?? "";
  }
  const choices = asArray(body.choices);
  const first = asObject(choices[0]);
  const message = asObject(first?.message);
  return contentText(message?.content);
}

/**
 * Reconstruct a trajectory from captured wire calls. The last successful call's
 * request carries the full accumulated conversation (every prior tool call and
 * observation), and its response carries the final answer, so it reconstructs
 * the whole trajectory in one pass.
 */
export function reconstructTrajectory(calls: readonly RawCall[]): CapturedTrajectory {
  const successful = calls.filter((call) => call.statusCode >= 200 && call.statusCode < 300);
  const source = successful.at(-1) ?? calls.at(-1);
  if (source === undefined) return { steps: [], finalOutput: "" };
  const steps = stepsForCall(source);
  const finalOutput = finalOutputForCall(source);
  // Ensure the final answer is the trailing output step.
  if (finalOutput.length > 0 && steps.at(-1)?.text !== finalOutput) {
    steps.push({ index: steps.length, type: "output", text: truncate(finalOutput, MAX_TEXT) });
  }
  return { steps, finalOutput: finalOutput.length > 0 ? finalOutput : (steps.at(-1)?.text ?? "") };
}

/** A provenance sink that accumulates raw calls for trajectory reconstruction. */
export type TrajectoryCapture = {
  sink: ProvenanceSink;
  calls: RawCall[];
  reconstruct(): CapturedTrajectory;
};

export function createTrajectoryCapture(): TrajectoryCapture {
  const calls: RawCall[] = [];
  return {
    calls,
    sink: {
      onModelCallRaw(context: ModelGatewayCallContext, result: ModelGatewayCallResult): void {
        calls.push({
          dialect: context.dialect,
          requestBody: context.requestBody,
          responseText: result.responseBody?.toString("utf8") ?? "",
          statusCode: result.statusCode
        });
      }
    },
    reconstruct: () => reconstructTrajectory(calls)
  };
}
