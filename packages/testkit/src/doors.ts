/**
 * The gateway front-door axis of the test matrix, declared once.
 *
 * A {@link DoorProfile} describes one tool-facing dialect the gateway serves —
 * how to build requests (plain, streaming, tool-loop turns), and how to
 * extract text / tool calls from its native JSON and SSE shapes — so suites
 * parametrize over `DOOR_PROFILES` instead of hand-writing per-door tests.
 * Adding a door = one profile entry; every matrix suite picks it up.
 */

import { parseSse, sseDone } from "./sse.js";
import type { SseFrame } from "./sse.js";

export type DoorToolCall = { id: string; name: string; arguments: string };

/** One prior tool-loop exchange: the committed call and its executed result. */
export type DoorToolExchange = { call: DoorToolCall; result: string };

export type DoorRequestInput = {
  model: string;
  user: string;
  stream?: boolean;
  /** Declare the standard test tool (`read_file`) on the request. */
  withTools?: boolean;
  /** Prior tool exchange to replay (turn 2 of a tool loop). */
  toolExchange?: DoorToolExchange;
};

export type DoorProfile = {
  /** Stable id used in generated test names. */
  id: string;
  path: string;
  headers?: Record<string, string>;
  /** Whether the gateway serves an SSE variant on this door. */
  supportsStreaming: boolean;
  buildRequest: (input: DoorRequestInput) => Record<string, unknown>;
  /** Final answer text from the door's native JSON response shape. */
  textOf: (body: unknown) => string;
  /** The first committed tool call from the native JSON response, if any. */
  toolCallOf: (body: unknown) => DoorToolCall | undefined;
  /** Concatenated answer text from the door's native SSE frames. */
  streamTextOf: (frames: readonly SseFrame[]) => string;
  /** True when the SSE stream terminated with the door's native close marker. */
  streamClosed: (frames: readonly SseFrame[]) => boolean;
};

const READ_FILE_PARAMETERS = {
  type: "object",
  properties: { path: { type: "string" } }
} as const;

function frameData(frame: SseFrame): Record<string, unknown> | undefined {
  return typeof frame.data === "object" && frame.data !== null
    ? (frame.data as Record<string, unknown>)
    : undefined;
}

function frameTypes(frames: readonly SseFrame[]): string[] {
  return frames
    .map((frame) => frameData(frame)?.type)
    .filter((value): value is string => typeof value === "string");
}

// --- OpenAI Chat Completions shapes (shared by the openai and cursor doors) -----

type ChatBody = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
};

function chatText(body: unknown): string {
  return (body as ChatBody).choices?.[0]?.message?.content ?? "";
}

function chatToolCall(body: unknown): DoorToolCall | undefined {
  const call = (body as ChatBody).choices?.[0]?.message?.tool_calls?.[0];
  if (call === undefined) return undefined;
  return {
    id: call.id ?? "",
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "{}"
  };
}

function chatStreamText(frames: readonly SseFrame[]): string {
  return frames
    .map((frame) => {
      const choices = frameData(frame)?.choices as
        | Array<{ delta?: { content?: string } }>
        | undefined;
      return choices?.[0]?.delta?.content ?? "";
    })
    .join("");
}

function chatToolMessages(input: DoorRequestInput): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: input.user }];
  if (input.toolExchange !== undefined) {
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: input.toolExchange.call.id,
            type: "function",
            function: {
              name: input.toolExchange.call.name,
              arguments: input.toolExchange.call.arguments
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: input.toolExchange.call.id,
        content: input.toolExchange.result
      }
    );
  }
  return messages;
}

// --- Responses input items (shared by the codex and cursor doors) ----------------

function responsesInputItems(input: DoorRequestInput): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [
    { type: "message", role: "user", content: [{ type: "input_text", text: input.user }] }
  ];
  if (input.toolExchange !== undefined) {
    items.push(
      {
        type: "function_call",
        call_id: input.toolExchange.call.id,
        name: input.toolExchange.call.name,
        arguments: input.toolExchange.call.arguments
      },
      {
        type: "function_call_output",
        call_id: input.toolExchange.call.id,
        output: input.toolExchange.result
      }
    );
  }
  return items;
}

const RESPONSES_TOOLS = [
  {
    type: "function",
    name: "read_file",
    description: "read a file",
    parameters: READ_FILE_PARAMETERS
  }
];

// --- the door profiles -------------------------------------------------------------

export const DOOR_PROFILES: readonly DoorProfile[] = [
  {
    id: "openai-chat",
    path: "/v1/chat/completions",
    supportsStreaming: true,
    buildRequest: (input) => ({
      model: input.model,
      messages: chatToolMessages(input),
      ...(input.stream === true ? { stream: true } : {}),
      ...(input.withTools === true
        ? {
            tools: [
              {
                type: "function",
                function: {
                  name: "read_file",
                  description: "read a file",
                  parameters: READ_FILE_PARAMETERS
                }
              }
            ]
          }
        : {})
    }),
    textOf: chatText,
    toolCallOf: chatToolCall,
    streamTextOf: chatStreamText,
    streamClosed: (frames) => sseDone(frames)
  },
  {
    id: "anthropic-messages",
    path: "/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    supportsStreaming: true,
    buildRequest: (input) => {
      const messages: Array<Record<string, unknown>> = [{ role: "user", content: input.user }];
      if (input.toolExchange !== undefined) {
        messages.push(
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: input.toolExchange.call.id,
                name: input.toolExchange.call.name,
                input: JSON.parse(input.toolExchange.call.arguments || "{}") as unknown
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: input.toolExchange.call.id,
                content: input.toolExchange.result
              }
            ]
          }
        );
      }
      return {
        model: input.model,
        max_tokens: 512,
        messages,
        ...(input.stream === true ? { stream: true } : {}),
        ...(input.withTools === true
          ? {
              tools: [
                { name: "read_file", description: "read a file", input_schema: READ_FILE_PARAMETERS }
              ]
            }
          : {})
      };
    },
    textOf: (body) => {
      const content = (body as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      return content.find((block) => block.type === "text")?.text ?? "";
    },
    toolCallOf: (body) => {
      const content = (body as {
        content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
      }).content;
      const toolUse = content?.find((block) => block.type === "tool_use");
      if (toolUse === undefined) return undefined;
      return {
        id: toolUse.id ?? "",
        name: toolUse.name ?? "",
        arguments: JSON.stringify(toolUse.input ?? {})
      };
    },
    streamTextOf: (frames) =>
      frames
        .map((frame) => {
          const data = frameData(frame);
          if (data?.type !== "content_block_delta") return "";
          return (data.delta as { text?: string } | undefined)?.text ?? "";
        })
        .join(""),
    streamClosed: (frames) => frameTypes(frames).includes("message_stop")
  },
  {
    id: "codex-responses",
    path: "/v1/responses",
    supportsStreaming: true,
    buildRequest: (input) => ({
      model: input.model,
      input: responsesInputItems(input),
      ...(input.stream === true ? { stream: true } : {}),
      ...(input.withTools === true ? { tools: RESPONSES_TOOLS } : {})
    }),
    textOf: (body) => {
      const output = (body as {
        output?: Array<{ type: string; content?: Array<{ text?: string }> }>;
      }).output ?? [];
      return output.find((item) => item.type === "message")?.content?.[0]?.text ?? "";
    },
    toolCallOf: (body) => {
      const output = (body as {
        output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
      }).output;
      const call = output?.find((item) => item.type === "function_call");
      if (call === undefined) return undefined;
      return { id: call.call_id ?? "", name: call.name ?? "", arguments: call.arguments ?? "{}" };
    },
    streamTextOf: (frames) =>
      frames
        .map((frame) => {
          const data = frameData(frame);
          if (data?.type !== "response.output_text.delta") return "";
          return typeof data.delta === "string" ? data.delta : "";
        })
        .join(""),
    streamClosed: (frames) => frameTypes(frames).includes("response.completed")
  },
  {
    id: "cursor-chat",
    path: "/v1/cursor/chat/completions",
    // Cursor's BYOK hybrid: Responses-shaped request in, chat completion out.
    supportsStreaming: true,
    buildRequest: (input) => ({
      model: input.model,
      input: responsesInputItems(input),
      ...(input.stream === true ? { stream: true } : {}),
      ...(input.withTools === true ? { tools: RESPONSES_TOOLS } : {})
    }),
    textOf: chatText,
    toolCallOf: chatToolCall,
    streamTextOf: chatStreamText,
    streamClosed: (frames) => sseDone(frames)
  }
];

/** Fetch one door with a built request; returns the raw `Response`. */
export async function callDoor(
  gatewayUrl: string,
  door: DoorProfile,
  input: DoorRequestInput
): Promise<Response> {
  return await fetch(`${gatewayUrl}${door.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...door.headers },
    body: JSON.stringify(door.buildRequest(input))
  });
}

/** Parse an SSE response body into frames (convenience for door suites). */
export async function doorFrames(response: Response): Promise<{ frames: SseFrame[]; raw: string }> {
  const raw = await response.text();
  return { frames: parseSse(raw), raw };
}
