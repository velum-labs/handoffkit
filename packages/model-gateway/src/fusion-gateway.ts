/**
 * Fusion Harness Gateway — the provider-facing front door that lets a coding
 * tool (Codex, Claude Code, Cursor via Cursorkit) be the entrypoint. A prompt
 * sent from the tool hits this gateway, which translates the request into a
 * dialect-agnostic prompt, runs the unified HandoffKit/FusionKit harness
 * ensemble through an injected runner, then translates the synthesized final
 * answer back into the tool's native wire format.
 *
 * The runner is injected (not imported) so this package stays free of a
 * dependency on `@fusionkit/ensemble`, which already depends on this package.
 */

import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { newTraceId, TRACE_ID_HEADER } from "@fusionkit/protocol";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";

import { chatToAnthropicMessage, openAiSseToAnthropic } from "./adapters/anthropic.js";
import type { AnthropicRequest } from "./adapters/anthropic.js";
import { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";
import { chatToResponses, openAiSseToResponses } from "./adapters/responses.js";
import type { ResponsesRequest } from "./adapters/responses.js";

export type FrontDoorDialect = "openai-responses" | "anthropic-messages" | "openai-chat";

export type FrontDoorRunnerInput = {
  dialect: FrontDoorDialect;
  prompt: string;
  requestedModel: string | undefined;
  requestId: string;
  /** Correlates this front-door request with all downstream trace events. */
  traceId: string;
};

export type FrontDoorRunnerResult = {
  finalOutput: string;
  runId: string;
  status: "succeeded" | "failed" | "skipped";
  evidence: string[];
  reportPath?: string;
};

export type FrontDoorRunner = (input: FrontDoorRunnerInput) => Promise<FrontDoorRunnerResult>;

export type FusionGatewayOptions = {
  /** Runs the unified harness ensemble for a single front-door prompt. */
  runner: FrontDoorRunner;
  /** Bind host; defaults to loopback. */
  host?: string;
  /** Bind port; defaults to an ephemeral free port. */
  port?: number;
  /** When set, require this bearer token (or matching `x-api-key`). */
  authToken?: string;
  /** Model id echoed back in responses and `/v1/models`. */
  defaultModel?: string;
};

export type FusionGateway = {
  /** Base URL clients should target (without the `/v1` suffix). */
  url(): string;
  port(): number;
  close(): Promise<void>;
};

export const FUSION_RUN_ID_HEADER = "x-fusion-run-id";
export const FUSION_STATUS_HEADER = "x-fusion-status";
export const FUSION_EVIDENCE_HEADER = "x-fusion-evidence";
export const FUSION_REPORT_HEADER = "x-fusion-report";

const DEFAULT_MODEL = FUSION_PANEL_MODEL;

// ---- prompt extraction ----

type ResponsesContentPart = { type?: string; text?: string };

function partText(part: ResponsesContentPart): string {
  if (typeof part.text === "string") return part.text;
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => partText(part as ResponsesContentPart)).join("");
  }
  return "";
}

export function promptFromResponses(body: ResponsesRequest): string {
  const parts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    parts.push(body.instructions);
  }
  const input = body.input;
  if (typeof input === "string") {
    parts.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const type = (item as { type?: string }).type;
      if (type === "function_call" || type === "function_call_output") continue;
      const content = (item as { content?: unknown }).content;
      const text = contentToText(content);
      if (text.length > 0) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

export function promptFromAnthropic(body: AnthropicRequest): string {
  const parts: string[] = [];
  if (typeof body.system === "string" && body.system.length > 0) {
    parts.push(body.system);
  } else if (Array.isArray(body.system)) {
    parts.push(body.system.map((block) => block.text).join("\n"));
  }
  for (const message of body.messages ?? []) {
    if (message.role !== "user") continue;
    const text = contentToText(message.content);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

type ChatMessage = { role?: string; content?: unknown };
export type ChatRequest = { model?: string; messages?: ChatMessage[]; stream?: boolean };

export function promptFromChat(body: ChatRequest): string {
  const parts: string[] = [];
  for (const message of body.messages ?? []) {
    if (message.role !== "user" && message.role !== "system") continue;
    const text = contentToText(message.content);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

// ---- response formatting ----

function syntheticOpenAiResponse(finalOutput: string): {
  id: string;
  choices: Array<{ message: { content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number };
} {
  return {
    id: Math.random().toString(36).slice(2, 12),
    choices: [{ message: { content: finalOutput }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  };
}

export function formatResponses(finalOutput: string, model: string): Record<string, unknown> {
  return chatToResponses(syntheticOpenAiResponse(finalOutput), model);
}

export function formatAnthropic(finalOutput: string, model: string): Record<string, unknown> {
  return chatToAnthropicMessage(syntheticOpenAiResponse(finalOutput), model);
}

export function formatChat(finalOutput: string, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl_${Math.random().toString(36).slice(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: finalOutput },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// ---- streaming ----

const SSE_ENCODER = new TextEncoder();

/**
 * Build a synthetic OpenAI Chat Completions SSE stream carrying a single
 * already-complete answer. The existing Responses/Anthropic SSE translators
 * consume this to emit each dialect's native streamed event sequence.
 */
function openAiChatSseFromText(finalOutput: string): ReadableStream<Uint8Array> {
  const frames = [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { role: "assistant", content: finalOutput }, finish_reason: null }]
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0 }
    })}\n\n`,
    "data: [DONE]\n\n"
  ];
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(SSE_ENCODER.encode(frames[index]));
        index += 1;
      } else {
        controller.close();
      }
    }
  });
}

async function pipeSse(res: ServerResponse, stream: ReadableStream<Uint8Array>): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && !res.write(Buffer.from(value))) await once(res, "drain");
    }
  } finally {
    res.end();
  }
}

function writeChatSse(res: ServerResponse, finalOutput: string, model: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  const id = `chatcmpl_${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: finalOutput }, finish_reason: null }]
    })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function openAiModels(model: string): Record<string, unknown> {
  return { object: "list", data: [{ id: model, object: "model", owned_by: "fusion-gateway" }] };
}

function anthropicModels(model: string): Record<string, unknown> {
  return {
    object: "list",
    data: [{ type: "model", id: model, display_name: model }],
    has_more: false
  };
}

// ---- server ----

const NO_BODY = Symbol("no-body");

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const buffer = await readBody(req);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    writeJson(res, 400, { error: { message: "invalid JSON body", type: "bad_request" } });
    return NO_BODY;
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.byteLength));
  res.end(payload);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth === `Bearer ${token}`) return true;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey === token;
}

function requestId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startFusionGateway(options: FusionGatewayOptions): Promise<FusionGateway> {
  const host = options.host ?? "127.0.0.1";
  const defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  const { runner, authToken } = options;

  async function runFrontDoor(
    res: ServerResponse,
    dialect: FrontDoorDialect,
    prompt: string,
    requestedModel: string | undefined,
    stream: boolean,
    format: (finalOutput: string, model: string) => Record<string, unknown>,
    traceId: string
  ): Promise<void> {
    const id = requestId(dialect);
    res.setHeader(TRACE_ID_HEADER, traceId);
    const result = await runner({ dialect, prompt, requestedModel, requestId: id, traceId });
    res.setHeader(FUSION_RUN_ID_HEADER, result.runId);
    res.setHeader(FUSION_STATUS_HEADER, result.status);
    res.setHeader(FUSION_EVIDENCE_HEADER, JSON.stringify(result.evidence));
    if (result.reportPath !== undefined) res.setHeader(FUSION_REPORT_HEADER, result.reportPath);
    const model = requestedModel ?? defaultModel;
    if (!stream) {
      writeJson(res, 200, format(result.finalOutput, model));
      return;
    }
    switch (dialect) {
      case "openai-responses":
        await pipeSse(res, openAiSseToResponses(openAiChatSseFromText(result.finalOutput), model));
        return;
      case "anthropic-messages":
        await pipeSse(res, openAiSseToAnthropic(openAiChatSseFromText(result.finalOutput), model));
        return;
      case "openai-chat":
        writeChatSse(res, result.finalOutput, model);
        return;
      default: {
        const exhaustive: never = dialect;
        throw new Error(`unhandled dialect ${String(exhaustive)}`);
      }
    }
  }

  function traceIdFor(req: IncomingMessage): string {
    const incoming = req.headers[TRACE_ID_HEADER];
    if (typeof incoming === "string" && incoming.length > 0) return incoming;
    if (Array.isArray(incoming) && incoming.length > 0 && incoming[0]) return incoming[0];
    return newTraceId();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/health") {
      writeJson(res, 200, { status: "ok", service: "fusion-harness-gateway" });
      return;
    }

    if (authToken !== undefined && !authorized(req, authToken)) {
      writeJson(res, 401, { error: { message: "unauthorized", type: "auth_error" } });
      return;
    }

    if (method === "GET" && (path === "/v1/models" || path === "/models")) {
      if (req.headers["anthropic-version"] !== undefined) {
        writeJson(res, 200, anthropicModels(defaultModel));
        return;
      }
      writeJson(res, 200, openAiModels(defaultModel));
      return;
    }

    // Cursor may probe the models list relative to its BYOK base URL
    // (`.../v1/cursor`); mirror /v1/models there.
    if (method === "GET" && path === "/v1/cursor/models") {
      writeJson(res, 200, openAiModels(defaultModel));
      return;
    }

    if (method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = raw as ResponsesRequest;
      await runFrontDoor(res, "openai-responses", promptFromResponses(body), body.model, body.stream === true, formatResponses, traceIdFor(req));
      return;
    }

    if (method === "POST" && path === "/v1/messages/count_tokens") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = raw as AnthropicRequest;
      const text = promptFromAnthropic(body);
      writeJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
      return;
    }

    if (method === "POST" && (path === "/v1/messages" || path === "/messages")) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = raw as AnthropicRequest;
      await runFrontDoor(res, "anthropic-messages", promptFromAnthropic(body), body.model, body.stream === true, formatAnthropic, traceIdFor(req));
      return;
    }

    if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = raw as ChatRequest;
      await runFrontDoor(res, "openai-chat", promptFromChat(body), body.model, body.stream === true, formatChat, traceIdFor(req));
      return;
    }

    // Cursor's BYOK base-URL override POSTs a Responses-API-shaped body to
    // `{base_url}/chat/completions` while expecting Chat Completions back (a
    // known Cursor hybrid). Translate it, then delegate to the exact code path
    // the plain /v1/chat/completions route uses. Plain Chat Completions bodies
    // (Cursor Ask mode) pass through untranslated.
    if (method === "POST" && path === "/v1/cursor/chat/completions") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      if (!isCursorChatBody(raw)) {
        writeJson(res, 400, {
          error: {
            message: 'request body must be a JSON object with "messages" or "input"',
            type: "invalid_request_error"
          }
        });
        return;
      }
      const body = translateCursorRequest(raw) as ChatRequest;
      await runFrontDoor(res, "openai-chat", promptFromChat(body), body.model, body.stream === true, formatChat, traceIdFor(req));
      return;
    }

    writeJson(res, 404, { error: { message: `no route for ${method} ${path}`, type: "not_found" } });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // Must never throw: a throw here becomes an unhandled rejection that
      // kills the hosting process. Once headers are sent (an SSE turn that
      // failed mid-stream), destroy the response instead of writing JSON.
      try {
        if (!res.headersSent) {
          writeJson(res, 502, { error: { message: errorMessage(error), type: "front_door_error" } });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      } catch {
        // last resort: drop the response, keep the server alive
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;

  return {
    url: () => `http://${host}:${port}`,
    port: () => port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
