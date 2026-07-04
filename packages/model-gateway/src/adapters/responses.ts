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
  | { type: "custom_tool_call"; call_id?: string; id?: string; name: string; input?: string }
  | { type: "custom_tool_call_output"; call_id: string; output: unknown }
  | { type: string; [key: string]: unknown };

/** A tool declaration on a Responses request: a function tool (JSON-schema
 *  `parameters`), a freeform "custom" tool (a grammar/text `format` and raw
 *  string input — e.g. Codex's `apply_patch` for GPT-5-family models), or a
 *  *typed* tool identified only by its `type` (e.g. Codex's `tool_search` /
 *  `web_search` entries, which carry no `name`). */
type ResponsesTool = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
  format?: { type?: string; syntax?: string; definition?: string };
  /** Typed tools declare who executes them ("client" for CLI-side tools). */
  execution?: string;
};

export type ResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; name?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
};

// ---- OpenAI chat shapes we read back ----

type OpenAiToolCall = { id?: string; index?: number; function?: { name?: string; arguments?: string } };
// Reasoning rides two distinct wire fields: `reasoning_content` carries
// complete narration beats (the fusion judge channel — one summary part per
// delta), while `reasoning` carries the upstream model's raw thinking tokens
// (local MLX / router passthrough — accumulated into a single summary part).
type OpenAiDelta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiToolCall[];
};
type OpenAiChoice = {
  delta?: OpenAiDelta;
  message?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAiToolCall[];
  };
  finish_reason?: string | null;
};
type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };
type OpenAiChunk = { choices?: OpenAiChoice[]; usage?: OpenAiUsage; provider_cost?: unknown };
type OpenAiResponse = {
  id?: string;
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
  provider_cost?: unknown;
};

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
  // A typed tool choice (e.g. {type: "tool_search"}) resolves to the name the
  // tool is projected under on the chat side (its type).
  const name = choice.name ?? (choice.type !== "function" ? choice.type : undefined);
  if (name === undefined || name.length === 0) return undefined;
  return { type: "function", function: { name } };
}

/**
 * How a declared tool must be emitted when the model calls it:
 * - `function`: a plain `function_call` item (JSON-schema function tools, and
 *   tools discovered mid-conversation via `tool_search_output`).
 * - `custom`: a `custom_tool_call` item carrying raw string input (freeform
 *   tools like Codex's `apply_patch`).
 * - `typed`: the tool's own native item type (`<type>_call`, e.g.
 *   `tool_search_call`) — Codex dispatches these by payload shape, and a
 *   `function_call` under the same name fails with "handler received
 *   unsupported payload".
 */
export type ResponsesToolKind = "function" | "custom" | "typed";

export type ResponsesToolEntry = {
  kind: ResponsesToolKind;
  /**
   * The tool's namespace, for tools *discovered* through a `tool_search`
   * execution (e.g. `spawn_agent` under `multi_agent_v1`). Codex routes a
   * discovered tool's `function_call` by name **and** namespace — without the
   * namespace the call fails with "unsupported call".
   */
  namespace?: string;
};

export type ResponsesToolRegistry = ReadonlyMap<string, ResponsesToolEntry>;

const EMPTY_TOOL_REGISTRY: ResponsesToolRegistry = new Map();

/**
 * Whether a declared tool is a *typed, client-executed* tool: identified only
 * by its `type` (no `name`) and executed by the caller (`execution: "client"`,
 * e.g. Codex's `tool_search` for deferred-tool discovery). Server-executed
 * typed tools (e.g. `web_search`, which OpenAI's backend runs) are excluded —
 * the gateway cannot honor them, so advertising them to the fused model would
 * produce calls nobody executes.
 */
function isClientTypedTool(tool: ResponsesTool): boolean {
  return (
    typeof tool.type === "string" &&
    tool.type.length > 0 &&
    tool.type !== "function" &&
    tool.type !== "custom" &&
    (tool.name === undefined || tool.name.length === 0) &&
    tool.execution === "client"
  );
}

/** A tool definition harvested from an echoed `tool_search_output` item. */
type DiscoveredTool = {
  name: string;
  namespace?: string;
  description?: string;
  parameters?: unknown;
};

function collectDiscovered(entries: unknown[], namespace: string | undefined, out: DiscoveredTool[]): void {
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      type?: string;
      name?: string;
      description?: string;
      parameters?: unknown;
      tools?: unknown;
    };
    if (record.type === "namespace" && Array.isArray(record.tools)) {
      collectDiscovered(record.tools, typeof record.name === "string" ? record.name : namespace, out);
      continue;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      out.push({
        name: record.name,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.parameters !== undefined ? { parameters: record.parameters } : {})
      });
    }
  }
}

/**
 * The tools *discovered* through prior typed-tool executions in this
 * conversation. Codex never adds discovered tools to the request's `tools`
 * array — their definitions ride inside the echoed `tool_search_output` items
 * (possibly grouped under namespaces) and Codex dispatches subsequent calls by
 * name + namespace. Harvesting them here is what closes the discovery loop:
 * the follow-up fused turn can advertise and call `spawn_agent` etc.
 */
function discoveredToolsFromInput(body: ResponsesRequest): DiscoveredTool[] {
  const found: DiscoveredTool[] = [];
  if (!Array.isArray(body.input)) return found;
  for (const item of body.input) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: string; tools?: unknown };
    if (typeof record.type !== "string" || !record.type.endsWith("_output")) continue;
    if (!Array.isArray(record.tools)) continue;
    collectDiscovered(record.tools, undefined, found);
  }
  return found;
}

/**
 * The per-request tool registry: every callable tool the request declares or
 * has discovered, keyed by the name the chat-side model calls it under, mapped
 * to how its calls must be emitted. Typed tools are keyed by their `type`;
 * discovered tools carry their namespace for egress dispatch.
 */
export function responsesToolRegistry(body: ResponsesRequest): ResponsesToolRegistry {
  const registry = new Map<string, ResponsesToolEntry>();
  for (const tool of body.tools ?? []) {
    if (typeof tool.name === "string" && tool.name.length > 0) {
      registry.set(tool.name, { kind: tool.type === "custom" ? "custom" : "function" });
      continue;
    }
    if (isClientTypedTool(tool)) registry.set(tool.type as string, { kind: "typed" });
  }
  for (const tool of discoveredToolsFromInput(body)) {
    if (registry.has(tool.name)) continue;
    registry.set(tool.name, {
      kind: "function",
      ...(tool.namespace !== undefined ? { namespace: tool.namespace } : {})
    });
  }
  return registry;
}

/**
 * Back-compat helper: the names of the freeform ("custom") tools a Responses
 * request declares (see {@link responsesToolRegistry}).
 */
export function customToolNames(body: ResponsesRequest): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, entry] of responsesToolRegistry(body)) {
    if (entry.kind === "custom") names.add(name);
  }
  return names;
}

/** The chat function-tool schema a custom tool is forwarded as. */
const CUSTOM_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: "The complete raw text input for this tool (not JSON-encoded)."
    }
  },
  required: ["input"],
  additionalProperties: false
} as const;

/** Fold a custom tool's freeform contract (and grammar, if any) into a
 *  description the chat-side model can actually follow. */
function customToolDescription(tool: ResponsesTool): string {
  const parts: string[] = [];
  if (typeof tool.description === "string" && tool.description.length > 0) parts.push(tool.description);
  parts.push(
    `This is a freeform tool: put the ENTIRE raw tool input as one string in the "input" field. ` +
      `Do not wrap it in any other JSON structure.`
  );
  const definition = tool.format?.definition;
  if (typeof definition === "string" && definition.length > 0) {
    const syntax = tool.format?.syntax;
    parts.push(`The input must conform to this ${syntax ?? "grammar"}:\n${definition}`);
  }
  return parts.join("\n\n");
}

/** Extract the raw string input from a chat tool call's accumulated arguments.
 *  The model was asked for `{"input": "..."}`; a model that emitted the raw
 *  text directly (non-JSON) is passed through verbatim. */
function customToolInput(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { input?: unknown }).input === "string") {
      return (parsed as { input: string }).input;
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON: treat the whole argument string as the raw input
  }
  return args;
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
    // The assistant text message immediately preceding the pending function
    // calls, if any. A model that answered with text + tool calls in one turn
    // is replayed by Codex as a message item followed by function_call items;
    // they must fold back into ONE assistant message (content + tool_calls).
    // Split across two assistant messages, some models (qwen3-coder) read the
    // text-only turn as a completed turn and stop calling tools entirely.
    let pendingAssistantText: Record<string, unknown> | undefined;
    const flushToolCalls = (): void => {
      if (pendingToolCalls.length === 0) return;
      if (pendingAssistantText !== undefined) {
        pendingAssistantText.tool_calls = pendingToolCalls;
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
      }
      pendingToolCalls = [];
      pendingAssistantText = undefined;
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
      // A prior custom (freeform) tool call echoed back by the caller. Re-encode
      // its raw input as the `{input}` JSON arguments the chat side uses, so the
      // conversation round-trips losslessly.
      if (item.type === "custom_tool_call") {
        const call = item as Extract<ResponsesInputItem, { type: "custom_tool_call" }>;
        pendingToolCalls.push({
          id: call.call_id ?? call.id ?? `call_${randomId()}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify({ input: call.input ?? "" }) }
        });
        continue;
      }
      // A prior *typed* tool call echoed back (e.g. `tool_search_call`): replay
      // it as an assistant tool call under the tool's projected name (its item
      // type minus `_call`) so the chat-side history stays coherent across the
      // caller's discovery/execution loop.
      if (
        typeof item.type === "string" &&
        item.type.endsWith("_call") &&
        item.type !== "function_call" &&
        item.type !== "custom_tool_call" &&
        typeof (item as { call_id?: unknown }).call_id === "string"
      ) {
        const call = item as { type: string; call_id: string; id?: string; arguments?: unknown };
        pendingToolCalls.push({
          id: call.call_id,
          type: "function",
          function: {
            name: call.type.slice(0, -"_call".length),
            arguments:
              typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments ?? {})
          }
        });
        continue;
      }
      flushToolCalls();
      // Reasoning items round-trip: Codex echoes the fusion narration item back
      // verbatim on the next request (with `summary`, and `content` that may be
      // null). Drop it — narration must never leak into the panel prompt
      // (mirrors the Anthropic adapter dropping thinking blocks). A reasoning
      // item may sit between an assistant message and its function calls, so
      // dropping it must not break their adjacency (`pendingAssistantText`
      // survives; every other item type invalidates it below).
      if (item.type === "reasoning") continue;
      pendingAssistantText = undefined;
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const out = item as { call_id: string; output: unknown };
        const content = typeof out.output === "string" ? out.output : JSON.stringify(out.output);
        messages.push({ role: "tool", tool_call_id: out.call_id, content });
        continue;
      }
      // A typed tool's result (e.g. `tool_search_output`): the whole item body
      // (minus wire boilerplate) is the tool result the chat side reads — for
      // tool_search that is the discovered tool list.
      if (
        typeof item.type === "string" &&
        item.type.endsWith("_output") &&
        typeof (item as { call_id?: unknown }).call_id === "string"
      ) {
        const { type: _type, call_id, id: _id, ...rest } = item as {
          type: string;
          call_id: string;
          id?: string;
          [key: string]: unknown;
        };
        messages.push({ role: "tool", tool_call_id: call_id, content: JSON.stringify(rest) });
        continue;
      }
      // message item (explicit type "message" or a bare {role, content}); any
      // other item type without string/array content is skipped, never iterated.
      const message = item as { role?: string; content?: string | ResponsesContentPart[] | null };
      if (typeof message.content !== "string" && !Array.isArray(message.content)) continue;
      const role = message.role === "developer" ? "system" : message.role ?? "user";
      const chatMessage: Record<string, unknown> = { role, content: contentToParts(message.content) };
      messages.push(chatMessage);
      if (role === "assistant") pendingAssistantText = chatMessage;
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
  {
    // Every callable tool is forwarded as a chat function tool (Chat
    // Completions only speaks JSON function tools):
    // - named function tools pass through;
    // - a freeform "custom" tool (e.g. Codex's `apply_patch`) has no JSON
    //   schema — it becomes a function tool with an `{input: string}` schema
    //   and its grammar folded into the description;
    // - a typed client-executed tool (e.g. Codex's `tool_search`, the
    //   deferred-tool discovery door) is projected under its `type` as the
    //   function name, so the chat-side model can call it and the caller can
    //   dispatch it (the egress emits its native `<type>_call` item).
    // Server-executed typed tools (e.g. `web_search`) are excluded: nothing on
    // this side can run them, so advertising them would only produce calls
    // nobody answers.
    const tools: Record<string, unknown>[] = [];
    for (const tool of body.tools ?? []) {
      if (typeof tool.name === "string" && tool.name.length > 0) {
        tools.push(
          tool.type === "custom"
            ? {
                type: "function",
                function: {
                  name: tool.name,
                  description: customToolDescription(tool),
                  parameters: CUSTOM_TOOL_PARAMETERS
                }
              }
            : {
                type: "function",
                function: {
                  name: tool.name,
                  ...(tool.description !== undefined ? { description: tool.description } : {}),
                  parameters: tool.parameters ?? { type: "object", properties: {} }
                }
              }
        );
        continue;
      }
      if (isClientTypedTool(tool)) {
        tools.push({
          type: "function",
          function: {
            name: tool.type,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            parameters: tool.parameters ?? { type: "object", properties: {} }
          }
        });
      }
    }
    // Tools discovered mid-conversation (via a prior `tool_search` execution)
    // never appear in the request's `tools` array — the caller expects them to
    // be callable anyway, so they must be advertised to the chat-side model.
    const declared = new Set(
      tools.map((tool) => (tool.function as { name?: string } | undefined)?.name)
    );
    for (const tool of discoveredToolsFromInput(body)) {
      if (declared.has(tool.name)) continue;
      declared.add(tool.name);
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters ?? { type: "object", properties: {} }
        }
      });
    }
    if (tools.length > 0) chat.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const choice = mapToolChoice(body.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
  }
  if (body.stream === true) chat.stream_options = { include_usage: true };
  return chat;
}

// ---- non-streaming response translation ----

/** Parse a typed tool call's accumulated arguments into the JSON value its
 *  native item carries (`arguments` is an object on the wire, not a string). */
function typedToolArguments(args: string): unknown {
  if (args.trim().length === 0) return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}

/** The native item for a typed tool call (e.g. name "tool_search" ->
 *  `tool_search_call`). Codex dispatches typed tools by payload shape; a
 *  `function_call` under the same name fails with "unsupported payload". */
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

function buildOutput(
  message: OpenAiChoice["message"],
  toolRegistry: ResponsesToolRegistry
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const reasoning =
    typeof message?.reasoning === "string" && message.reasoning.length > 0
      ? message.reasoning
      : typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
        ? message.reasoning_content
        : "";
  if (reasoning.length > 0) {
    // A reasoning-only turn must still produce output: without this item an
    // all-thinking response assembles as `output: []`, which callers (codex)
    // treat as an empty turn and retry.
    output.push({
      type: "reasoning",
      id: `rs_${randomId()}`,
      summary: [{ type: "summary_text", text: reasoning }]
    });
  }
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
      const name = call.function?.name ?? "";
      const args = call.function?.arguments ?? "";
      const entry = toolRegistry.get(name) ?? { kind: "function" as const };
      if (entry.kind === "custom") {
        // The caller declared this tool as freeform: it expects a
        // `custom_tool_call` item carrying the raw string input.
        output.push({
          type: "custom_tool_call",
          id: `ctc_${randomId()}`,
          call_id: call.id ?? `call_${randomId()}`,
          name,
          input: customToolInput(args),
          status: "completed"
        });
        continue;
      }
      if (entry.kind === "typed") {
        output.push(
          typedToolCallItem({
            name,
            itemId: `ttc_${randomId()}`,
            callId: call.id ?? `call_${randomId()}`,
            args
          })
        );
        continue;
      }
      output.push({
        type: "function_call",
        id: `fc_${randomId()}`,
        call_id: call.id ?? `call_${randomId()}`,
        name,
        // A discovered tool's call routes by name *and* namespace.
        ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
        arguments: args,
        status: "completed"
      });
    }
  }
  return output;
}

export function chatToResponses(
  openai: OpenAiResponse,
  model: string,
  toolRegistry: ResponsesToolRegistry = EMPTY_TOOL_REGISTRY
): Record<string, unknown> {
  const message = openai.choices?.[0]?.message;
  const output = buildOutput(message, toolRegistry);
  const inputTokens = openai.usage?.prompt_tokens;
  const outputTokens = openai.usage?.completion_tokens;
  return {
    id: `resp_${openai.id ?? randomId()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage:
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
            ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
            ...(inputTokens !== undefined && outputTokens !== undefined
              ? { total_tokens: inputTokens + outputTokens }
              : {})
          }
        : null,
    ...(openai.provider_cost !== undefined ? { provider_cost: openai.provider_cost } : {})
  };
}

// ---- streaming translation (OpenAI chat SSE -> Responses SSE) ----

function sse(type: string, data: Record<string, unknown>): Uint8Array {
  return ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
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
    default: {
      const exhaustive: never = tool.kind;
      throw new Error(`unknown tool kind: ${String(exhaustive)}`);
    }
  }
}

export function openAiSseToResponses(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  toolRegistry: ResponsesToolRegistry = EMPTY_TOOL_REGISTRY
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
    controller.enqueue(sse("response.created", { response: baseResponse("in_progress", []) }));
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
      sse("response.output_item.added", {
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
      sse("response.reasoning_summary_part.added", { ...base, part: { type: "summary_text", text: "" } })
    );
    controller.enqueue(sse("response.reasoning_summary_text.delta", { ...base, delta: text }));
    controller.enqueue(sse("response.reasoning_summary_text.done", { ...base, text }));
    controller.enqueue(
      sse("response.reasoning_summary_part.done", { ...base, part: { type: "summary_text", text } })
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
        sse("response.reasoning_summary_part.added", {
          item_id: reasoningItemId,
          output_index: reasoningOutputIndex,
          summary_index: tokenPartIndex,
          part: { type: "summary_text", text: "" }
        })
      );
    }
    reasoningParts[tokenPartIndex] += text;
    controller.enqueue(
      sse("response.reasoning_summary_text.delta", {
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
    controller.enqueue(sse("response.reasoning_summary_text.done", { ...base, text }));
    controller.enqueue(
      sse("response.reasoning_summary_part.done", { ...base, part: { type: "summary_text", text } })
    );
  };

  const reasoningSummary = (): Array<Record<string, unknown>> =>
    reasoningParts.map((text) => ({ type: "summary_text", text }));

  const closeReasoning = (controller: Controller): void => {
    if (!reasoningOpen || reasoningClosed) return;
    closeTokenPart(controller);
    reasoningClosed = true;
    controller.enqueue(
      sse("response.output_item.done", {
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
    if (reasoningParts.length > 0) {
      output.push({ type: "reasoning", id: reasoningItemId, summary: reasoningSummary() });
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
      output.push(streamedToolItem(tool));
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
      if (tool.kind === "custom") {
        // The raw input is only extractable from the completed JSON arguments,
        // so a custom call flushes its whole input here in one delta + done.
        const input = customToolInput(tool.args);
        const base = { item_id: tool.itemId, output_index: tool.outputIndex };
        controller.enqueue(sse("response.custom_tool_call_input.delta", { ...base, delta: input }));
        controller.enqueue(sse("response.custom_tool_call_input.done", { ...base, input }));
        controller.enqueue(
          sse("response.output_item.done", { output_index: tool.outputIndex, item: streamedToolItem(tool) })
        );
        continue;
      }
      if (tool.kind === "typed") {
        // A typed tool's native item carries its arguments as a completed JSON
        // value, so it flushes whole in the item.done (no argument deltas).
        controller.enqueue(
          sse("response.output_item.done", { output_index: tool.outputIndex, item: streamedToolItem(tool) })
        );
        continue;
      }
      controller.enqueue(
        sse("response.function_call_arguments.done", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          arguments: tool.args
        })
      );
      controller.enqueue(
        sse("response.output_item.done", { output_index: tool.outputIndex, item: streamedToolItem(tool) })
      );
    }
    controller.enqueue(sse("response.completed", { response: baseResponse("completed", assembleOutput()) }));
  };

  const process = (controller: Controller, chunk: OpenAiChunk): void => {
    if (chunk.usage !== undefined) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
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
          const name = call.function?.name ?? "";
          const entry = toolRegistry.get(name) ?? { kind: "function" as const };
          const kind = entry.kind;
          tool = {
            outputIndex: nextOutputIndex++,
            itemId: kind === "custom" ? `ctc_${randomId()}` : kind === "typed" ? `ttc_${randomId()}` : `fc_${randomId()}`,
            callId: call.id ?? `call_${randomId()}`,
            name,
            args: "",
            kind,
            ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {})
          };
          tools.set(openAiIndex, tool);
          controller.enqueue(
            sse("response.output_item.added", {
              output_index: tool.outputIndex,
              item:
                kind === "custom"
                  ? { type: "custom_tool_call", id: tool.itemId, call_id: tool.callId, name: tool.name, input: "" }
                  : kind === "typed"
                    ? { type: `${tool.name}_call`, id: tool.itemId, call_id: tool.callId, status: "in_progress", execution: "client", arguments: {} }
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
        if (call.function?.name !== undefined && tool.name.length === 0) tool.name = call.function.name;
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          tool.args += args;
          // Custom and typed calls buffer their arguments (extracted at finalize).
          if (tool.kind === "function") {
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
      // Keep reading upstream until at least one chunk is enqueued (or the
      // stream closes). A pull that resolves without enqueuing anything can
      // stall Node's webstreams pull scheduling permanently (observed on Node
      // 24 when e.g. the upstream's `[DONE]` line arrives after finalize
      // already ran — the keepalive timer is cleared by then, so nothing else
      // ever unblocks the stream).
      for (;;) {
        const sizeBefore = controller.desiredSize ?? 0;
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
        if ((controller.desiredSize ?? 0) !== sizeBefore) return;
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
  signal?: AbortSignal,
  panelDepth?: number
): Promise<Response> {
  const requestedModel = body.model ?? backend.defaultModel ?? "";
  const upstreamModel = backend.resolveModel?.(body.model) ?? backend.defaultModel;
  const toolRegistry = responsesToolRegistry(body);
  const chat = responsesToChat(body, upstreamModel);
  const upstream = await backend.chat(chat, signal, { modelCallId, ...(panelDepth !== undefined ? { panelDepth } : {}) });

  if (!upstream.ok) {
    const detail = await upstream.text();
    return jsonResponse(upstream.status, { error: { type: "api_error", message: detail.slice(0, 2000) } });
  }

  if (body.stream === true) {
    const source = upstream.body;
    if (source === null) return jsonResponse(502, { error: { type: "api_error", message: "no upstream stream" } });
    return new Response(openAiSseToResponses(source, requestedModel, toolRegistry), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }

  const openai = (await upstream.json()) as OpenAiResponse;
  return jsonResponse(200, chatToResponses(openai, requestedModel, toolRegistry));
}
