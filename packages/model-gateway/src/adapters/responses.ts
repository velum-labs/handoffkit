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
import { randomId } from "@fusionkit/runtime-utils";
import type { OpenAiChoice } from "./openai-chat-wire.js";
import { droppedField } from "./dropped.js";
import { openAiSseToResponses } from "./responses-stream.js";
import { composeServerToolStream, runBufferedServerToolLoop } from "./server-tool-loop.js";
import type { ExecutedSearch } from "./server-tool-loop.js";
import { resolveWebSearchExecutor } from "./web-search.js";
export { openAiSseToResponses } from "./responses-stream.js";

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

/**
 * Codex encodes "unset" as an explicit JSON `null` for several optional fields
 * (e.g. `"reasoning": null` whenever the selected model's metadata advertises
 * no reasoning levels — the default for a custom-provider model like the fused
 * panel). Every nullable field below must be read with a null-tolerant guard;
 * reading `.effort` off a null `reasoning` 502'd every fused Codex turn.
 */
export type ResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; name?: string } | null;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  parallel_tool_calls?: boolean;
  /**
   * Codex serializes `reasoning: null` (not an absent key) for models whose
   * catalog metadata carries no reasoning level — every custom-provider panel
   * member slug (e.g. `grok-4`, `deepseek`) resolves to Codex's fallback model
   * info, which has none. Null must translate as "no reasoning", never throw.
   */
  reasoning?: { effort?: string; [key: string]: unknown } | null;
  text?: { format?: { type?: string; name?: string; schema?: unknown; strict?: boolean; [key: string]: unknown } } | null;
  previous_response_id?: string | null;
  truncation?: string | unknown;
  metadata?: Record<string, unknown> | null;
  include?: unknown[] | null;
  stream?: boolean;
};

// ---- OpenAI chat shapes we read back ----

type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };
type OpenAiChunk = { choices?: OpenAiChoice[]; usage?: OpenAiUsage; provider_cost?: unknown };
type OpenAiResponse = {
  id?: string;
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
  provider_cost?: unknown;
};

function partText(part: ResponsesContentPart): string {
  if (part.type === "refusal" && typeof part.text === "string") return part.text;
  if (typeof part.text === "string" && (part.type === "input_text" || part.type === "output_text" || part.type === "text")) {
    return part.text;
  }
  return "";
}

function mapTextFormat(text: NonNullable<ResponsesRequest["text"]>): unknown | undefined {
  const format = text.format;
  if (format === undefined) return undefined;
  switch (format.type) {
    case "json_schema":
      return {
        type: "json_schema",
        json_schema: {
          ...(typeof format.name === "string" ? { name: format.name } : {}),
          ...(format.schema !== undefined ? { schema: format.schema } : {}),
          ...(typeof format.strict === "boolean" ? { strict: format.strict } : {})
        }
      };
    case "json_object":
      return { type: "json_object" };
    default:
      droppedField("responses", "text");
      return undefined;
  }
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
    } else if (part.type === "input_file") {
      droppedField("responses", "input_file");
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
 * - `server`: a server-executed tool (`web_search`) the *gateway* runs via the
 *   server-tool loop. Its calls never surface as callable items — the loop
 *   intercepts them and the egress renders native `web_search_call` items.
 */
export type ResponsesToolKind = "function" | "custom" | "typed" | "server";

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

/**
 * A declared server-executed web search tool (Codex's `{type: "web_search"}`,
 * or variants like `web_search_preview`). When a web-search executor is
 * available the gateway runs these itself (see `server-tool-loop.ts`);
 * otherwise they are dropped with a warning as before.
 */
function isServerWebSearchTool(tool: ResponsesTool): boolean {
  return (
    typeof tool.type === "string" &&
    tool.type.startsWith("web_search") &&
    (tool.name === undefined || tool.name.length === 0) &&
    tool.execution !== "client"
  );
}

/** The name the gateway-executed web search tool is projected under chat-side. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

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
export type ResponsesTranslationOptions = { serverTools?: boolean };

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
export function responsesToolRegistry(
  body: ResponsesRequest,
  options: ResponsesTranslationOptions = {}
): ResponsesToolRegistry {
  const registry = new Map<string, ResponsesToolEntry>();
  for (const tool of body.tools ?? []) {
    if (typeof tool.name === "string" && tool.name.length > 0) {
      registry.set(tool.name, { kind: tool.type === "custom" ? "custom" : "function" });
      continue;
    }
    if (isClientTypedTool(tool)) registry.set(tool.type as string, { kind: "typed" });
    else if (options.serverTools === true && isServerWebSearchTool(tool)) {
      registry.set(WEB_SEARCH_TOOL_NAME, { kind: "server" });
    }
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
export function responsesToChat(
  body: ResponsesRequest,
  backendModel: string | undefined,
  options: ResponsesTranslationOptions = {}
): Record<string, unknown> {
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
      // A prior gateway-executed web search echoed back. Codex echoes these
      // items with no id/call_id and no results (on the real API results live
      // server-side), so the exchange cannot round-trip as a chat tool call —
      // fold it into the transcript as assistant context so the fused model
      // remembers the search happened and does not blindly repeat it.
      if (item.type === "web_search_call") {
        flushToolCalls();
        pendingAssistantText = undefined;
        const action = (item as { action?: { query?: unknown } }).action;
        const query = typeof action?.query === "string" ? action.query : "";
        messages.push({
          role: "assistant",
          content: query.length > 0 ? `[searched the web for: ${JSON.stringify(query)}]` : "[searched the web]"
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
      if (item.type === "reasoning") {
        droppedField("responses", "reasoning", "input");
        continue;
      }
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
  if (typeof body.max_output_tokens === "number") chat.max_completion_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  // `reasoning: null` means "this model has no reasoning config" (Codex sends
  // it for every custom-provider panel member slug) — skip silently rather
  // than treating it as an untranslatable field, and never dereference it.
  if (body.reasoning != null) {
    const effort = body.reasoning.effort;
    if (effort === "low" || effort === "medium" || effort === "high") {
      chat.reasoning_effort = effort;
    } else {
      droppedField("responses", "reasoning");
    }
  }
  if (body.text != null) {
    const responseFormat = mapTextFormat(body.text);
    if (responseFormat !== undefined) chat.response_format = responseFormat;
  }
  if (body.previous_response_id != null) droppedField("responses", "previous_response_id");
  if (body.truncation != null) droppedField("responses", "truncation");
  if (body.metadata != null) droppedField("responses", "metadata");
  if (body.include != null && body.include.length > 0) droppedField("responses", "include");
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
      } else if (options.serverTools === true && isServerWebSearchTool(tool)) {
        // Server-executed web search, honored by the gateway's server-tool
        // loop: projected as an ordinary function tool the fused model can
        // call; the loop intercepts and executes the calls.
        if (!tools.some((t) => (t.function as { name?: string } | undefined)?.name === WEB_SEARCH_TOOL_NAME)) {
          tools.push({
            type: "function",
            function: {
              name: WEB_SEARCH_TOOL_NAME,
              description: WEB_SEARCH_TOOL_DESCRIPTION,
              parameters: WEB_SEARCH_TOOL_PARAMETERS
            }
          });
        }
      } else if (
        typeof tool.type === "string" &&
        tool.type.length > 0 &&
        tool.type !== "function" &&
        tool.type !== "custom" &&
        (tool.name === undefined || tool.name.length === 0)
      ) {
        droppedField("responses", tool.type, "tools");
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
  if (body.tool_choice != null) {
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

/** The native output item for a gateway-executed web search. */
function executedSearchItem(search: ExecutedSearch): Record<string, unknown> {
  return {
    type: "web_search_call",
    id: search.itemId,
    status: search.status === "completed" ? "completed" : "failed",
    action: { type: "search", query: search.query }
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
      if (entry.kind === "server") {
        // Unreachable in practice: the server-tool loop intercepts these calls
        // before they reach a terminal message. Render the native item shape
        // (never a function_call — nobody on the caller's side dispatches it).
        output.push({
          type: "web_search_call",
          id: `ws_${randomId()}`,
          status: "completed",
          action: { type: "search", query: webSearchQueryOf(args) }
        });
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
  toolRegistry: ResponsesToolRegistry = EMPTY_TOOL_REGISTRY,
  searches: readonly ExecutedSearch[] = []
): Record<string, unknown> {
  const message = openai.choices?.[0]?.message;
  // Gateway-executed searches happened before the terminal step's output.
  const output = [...searches.map(executedSearchItem), ...buildOutput(message, toolRegistry)];
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

// ---- streaming translation (OpenAI chat SSE -> Responses SSE) ----

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
  // Server-executed web search is honored when the caller declared the tool,
  // an executor is available (a provider key exists), and no *client* tool
  // already owns the projected name; otherwise the ingress keeps its
  // honest-drop behavior.
  const declaresWebSearch = body.tools?.some(isServerWebSearchTool) === true;
  const clientNameCollision = body.tools?.some((tool) => tool.name === WEB_SEARCH_TOOL_NAME) === true;
  const executor = declaresWebSearch && !clientNameCollision ? resolveWebSearchExecutor("responses") : undefined;
  const serverTools = executor !== undefined;
  const toolRegistry = responsesToolRegistry(body, { serverTools });
  const chat = responsesToChat(body, upstreamModel, { serverTools });
  const requestOptions = {
    modelCallId,
    ...(panelDepth !== undefined ? { panelDepth } : {}),
    // The streamed response is translated to Responses SSE by
    // openAiSseToResponses, which emits its own keepalive.
    ...(body.stream === true ? { translated: true } : {})
  };
  const upstream = await backend.chat(chat, signal, requestOptions);

  if (!upstream.ok) {
    const detail = await upstream.text();
    return jsonResponse(upstream.status, { error: { type: "api_error", message: detail.slice(0, 2000) } });
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
      if (source === null) return jsonResponse(502, { error: { type: "api_error", message: "no upstream stream" } });
      const composed = composeServerToolStream({ ...loopOptions, firstStep: upstream });
      return new Response(openAiSseToResponses(composed, requestedModel, toolRegistry), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      });
    }
    const outcome = await runBufferedServerToolLoop({ ...loopOptions, firstStep: upstream });
    if (outcome.kind === "upstream_error") {
      const detail = await outcome.response.text();
      return jsonResponse(outcome.response.status, { error: { type: "api_error", message: detail.slice(0, 2000) } });
    }
    return jsonResponse(200, chatToResponses(outcome.openai as OpenAiResponse, requestedModel, toolRegistry, outcome.searches));
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
