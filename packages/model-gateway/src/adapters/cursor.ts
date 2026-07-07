/**
 * Translate Cursor's BYOK request hybrid into OpenAI Chat Completions.
 *
 * When Cursor's "Override OpenAI Base URL" feature is active, Cursor POSTs to
 * `{base_url}/chat/completions` but — for agent mode and GPT-family routing —
 * the JSON body is shaped like the OpenAI *Responses* API (`input` item list,
 * flat tool definitions, `reasoning`/`text` objects), while the response it
 * renders is standard Chat Completions SSE. This module is the pure
 * translation layer behind the `/v1/cursor/*` routes (the FusionKit analogue
 * of OpenRouter's `/api/v1/cursor`, and the TS port of the Python
 * `fusionkit_server.cursor_endpoint`): it maps the Responses-hybrid body onto
 * the Chat Completions shape the rest of the gateway already handles.
 *
 * No I/O happens here. The translation is total: weird-but-parseable input is
 * never a reason to throw — unknown item and tool types are dropped so the
 * boundary stays defensive without 4xx-ing on new shapes.
 */

type JsonObject = Record<string, unknown>;

/** Fields copied through unchanged when present and non-null. */
const PASSTHROUGH_FIELDS = ["model", "temperature", "top_p", "tool_choice", "stream"] as const;

/**
 * Permissive schema synthesized for grammar-based ("custom") tools that
 * declare no JSON schema of their own; the model's call output flows back as
 * a normal function tool call with the raw text under `input`.
 */
const CUSTOM_TOOL_PARAMETERS: JsonObject = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"]
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed request body is routable by the cursor route: a JSON
 * object carrying either `messages` (plain Chat Completions, e.g. Ask mode)
 * or `input` (the Responses hybrid). Rejecting other shapes is the route's
 * job; the translation itself stays total.
 */
export function isCursorChatBody(body: unknown): body is JsonObject {
  return isObject(body) && ("messages" in body || "input" in body);
}

/**
 * Map a Cursor BYOK request body onto a Chat Completions body.
 *
 * Dual-shape tolerance: Cursor only sends the Responses hybrid for some
 * models/modes; Ask mode may send plain Chat Completions. A body that
 * already carries `messages` is returned unchanged; a body with `input`
 * is translated. A body with neither yields an empty `messages` list.
 */
export function translateCursorRequest(body: JsonObject): JsonObject {
  if ("messages" in body) return { ...body };
  const translated: JsonObject = {};
  for (const key of PASSTHROUGH_FIELDS) {
    if (key in body && body[key] !== null && body[key] !== undefined) {
      translated[key] = body[key];
    }
  }
  translated.messages = inputItemsToMessages(body.input);
  const tools = translateTools(body.tools);
  if (tools !== undefined) translated.tools = tools;
  translateSampling(body, translated);
  return translated;
}

/**
 * Flatten a Responses-API `input` item list into chat messages.
 *
 * Handles message items (typed or bare role/content objects),
 * `function_call` items (folded into assistant `tool_calls`, merging
 * consecutive calls of the same assistant turn), `function_call_output`
 * items (`tool` messages), and drops `reasoning` and unknown items.
 */
function inputItemsToMessages(items: unknown): JsonObject[] {
  if (typeof items === "string") {
    // The Responses API also accepts a plain string as the whole input.
    return [{ role: "user", content: items }];
  }
  if (!Array.isArray(items)) return [];
  const messages: JsonObject[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const kind = item.type;
    if (kind === undefined || kind === null || kind === "message") {
      messages.push(messageFromItem(item));
    } else if (kind === "function_call") {
      appendFunctionCall(messages, item);
    } else if (kind === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: asStr(item.call_id),
        content: stringify(item.output)
      });
    }
    // "reasoning" (encrypted/opaque items) and unknown types are dropped.
  }
  return messages;
}

function messageFromItem(item: JsonObject): JsonObject {
  let role = item.role;
  if (role === "developer") role = "system";
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    role = "user";
  }
  return { role, content: contentText(item.content) };
}

/**
 * Concatenate the text parts of a Responses content value.
 *
 * Accepts a plain string or a parts list (`input_text` / `output_text` /
 * anything else carrying a string `text`); non-text parts such as
 * `input_image` are ignored rather than rejected.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isObject(part) && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("");
  }
  return "";
}

/**
 * Fold a `function_call` item into the current assistant turn.
 *
 * Consecutive function calls after the same assistant message extend that
 * message's `tool_calls` list; otherwise a new assistant message opens.
 */
function appendFunctionCall(messages: JsonObject[], item: JsonObject): void {
  const call: JsonObject = {
    id: asStr(item.call_id) || asStr(item.id),
    type: "function",
    function: {
      name: asStr(item.name),
      arguments: stringify(item.arguments) || "{}"
    }
  };
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  if (last !== undefined && last.role === "assistant") {
    if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
    (last.tool_calls as JsonObject[]).push(call);
    return;
  }
  messages.push({ role: "assistant", content: "", tool_calls: [call] });
}

/**
 * Map Responses tool definitions onto Chat Completions nested tools.
 *
 * Cursor sends flat function tools (`{type: "function", name, ...}`) and
 * grammar-based custom tools (`{type: "custom", name, format}`). Flat tools
 * are nested under `function`; custom tools become plain function tools with
 * their declared schema or a permissive synthesized one. Already-nested
 * tools pass through unchanged; other typed entries are forwarded as-is for
 * the gateway's downstream tool normalization.
 */
function translateTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const translated: JsonObject[] = [];
  for (const entry of tools) {
    if (!isObject(entry)) continue;
    if (isObject(entry.function)) {
      translated.push(entry);
      continue;
    }
    const kind = entry.type;
    if (kind === "function") {
      translated.push(nestedFunctionTool(entry, defaultParameters(entry)));
    } else if (kind === "custom") {
      translated.push(nestedFunctionTool(entry, customParameters(entry)));
    } else {
      // Typed nameless tools (e.g. web_search) and future shapes flow
      // through; the downstream tool normalization decides their fate.
      translated.push(entry);
    }
  }
  return translated.length > 0 ? translated : undefined;
}

function nestedFunctionTool(entry: JsonObject, parameters: JsonObject): JsonObject {
  return {
    type: "function",
    function: {
      name: asStr(entry.name),
      description: asStr(entry.description),
      parameters
    }
  };
}

function defaultParameters(entry: JsonObject): JsonObject {
  if (isObject(entry.parameters)) return entry.parameters;
  return { type: "object", properties: {} };
}

function customParameters(entry: JsonObject): JsonObject {
  if (isObject(entry.parameters)) return entry.parameters;
  return { ...CUSTOM_TOOL_PARAMETERS };
}

/** Fold Responses sampling names into Chat Completions ones in place. */
function translateSampling(body: JsonObject, translated: JsonObject): void {
  const maxTokens = body.max_output_tokens ?? body.max_tokens;
  if (typeof maxTokens === "number" && Number.isInteger(maxTokens)) {
    translated.max_tokens = maxTokens;
  }
}

function asStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Stringify a non-string tool output/arguments value losslessly. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}
