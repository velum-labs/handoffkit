import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  anthropicModelsResponse,
  handleAnthropicMessages,
  handleCountTokens
} from "./adapters/anthropic.js";
import type { AnthropicRequest } from "./adapters/anthropic.js";
import { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
import { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";
import { handleResponses } from "./adapters/responses.js";
import type { ResponsesRequest } from "./adapters/responses.js";
import { PANEL_DEPTH_HEADER, parsePanelDepth } from "./backend.js";
import type { Backend } from "./backend.js";
import {
  buildModelCallRecord,
  MODEL_CALL_ID_HEADER,
  modelCallId
} from "./provenance.js";
import type {
  GatewayDialect,
  ModelGatewayCallContext,
  ProvenanceSink
} from "./provenance.js";

/**
 * The local-model gateway HTTP server. It fronts a single OpenAI Chat
 * Completions backend (the owned mlx fork by default) and exposes the wire
 * dialects each agent harness needs. M1 implements the OpenAI chat surface
 * (opencode, Cursor IDE plan panel); the Anthropic Messages and OpenAI
 * Responses adapters return 501 until M2/M3 land.
 */

export type GatewayOptions = {
  backend: Backend;
  /** Bind host; defaults to loopback. */
  host?: string;
  /** Bind port; defaults to an ephemeral free port. */
  port?: number;
  /** When set, require this bearer token (or matching `x-api-key`). */
  authToken?: string;
  /** Optional observation sink for model calls. */
  provenance?: ProvenanceSink;
};

export type Gateway = {
  /** Base URL clients should target (without the `/v1` suffix). */
  url(): string;
  port(): number;
  close(): Promise<void>;
};

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const host = options.host ?? "127.0.0.1";
  const { backend, authToken, provenance } = options;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // This catch must never throw: a throw here becomes an unhandled
      // rejection that kills the process hosting the gateway (and, for the
      // in-process fusion gateway, the whole CLI).
      writeErrorSafely(res, 502, {
        error: { message: errorMessage(error), type: "upstream_error" }
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    if (authToken !== undefined && !authorized(req, authToken)) {
      writeJson(res, 401, { error: { message: "unauthorized", type: "auth_error" } });
      return;
    }

    if (method === "GET" && (path === "/v1/models" || path === "/models")) {
      // Claude Code's discovery probe carries `anthropic-version` and expects
      // the Anthropic-shaped model list; everyone else gets the OpenAI shape.
      if (req.headers["anthropic-version"] !== undefined) {
        await pipeUpstream(res, anthropicModelsResponse(backend.defaultModel, backend.listModelIds?.()));
        return;
      }
      await pipeUpstream(res, await backend.models());
      return;
    }

    // Cursor may probe the models list relative to its BYOK base URL
    // (`.../v1/cursor`); mirror /v1/models there.
    if (method === "GET" && path === "/v1/cursor/models") {
      await pipeUpstream(res, await backend.models());
      return;
    }

    // Anthropic single-model retrieve (`GET /v1/models/{id}`): Claude Code probes
    // this to validate a selected model before its first turn. Echo the id back
    // so any advertised/aliased id validates; routing is decided at chat time.
    if (method === "GET" && path.startsWith("/v1/models/")) {
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      writeJson(res, 200, {
        type: "model",
        id,
        display_name: id,
        created_at: new Date(0).toISOString()
      });
      return;
    }

    // Depth of the caller inside the fusion panel tree (0 = a user request).
    // Carried by panel-member capture gateways so a member's fused sub-agent
    // turn never re-provisions fused access one level further down.
    const panelDepth = parsePanelDepth(req.headers[PANEL_DEPTH_HEADER]);

    if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = withDefaultModel(raw, backend.defaultModel);
      await handleModelCall(res, provenance, {
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) => backend.chat(body, signal, { modelCallId: callId, panelDepth })
      });
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
      const body = withDefaultModel(translateCursorRequest(raw), backend.defaultModel);
      await handleModelCall(res, provenance, {
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) => backend.chat(body, signal, { modelCallId: callId, panelDepth })
      });
      return;
    }

    if (method === "POST" && path === "/v1/embeddings") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      await pipeUpstream(res, await backend.embeddings(withDefaultModel(raw, backend.defaultModel)));
      return;
    }

    if (method === "POST" && path === "/v1/messages/count_tokens") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      await pipeUpstream(res, handleCountTokens(raw as AnthropicRequest));
      return;
    }

    if (method === "POST" && path === "/v1/messages") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = raw as AnthropicRequest;
      await handleModelCall(res, provenance, {
        dialect: "anthropic-messages",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) => handleAnthropicMessages(backend, body, callId, signal, panelDepth)
      });
      return;
    }

    if (method === "POST" && path === "/v1/responses") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = raw as ResponsesRequest;
      await handleModelCall(res, provenance, {
        dialect: "openai-responses",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) => handleResponses(backend, body, callId, signal, panelDepth)
      });
      return;
    }

    writeJson(res, 404, { error: { message: `no route for ${method} ${path}`, type: "not_found" } });
  }

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
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // Release a backend that owns a process (e.g. the MLX server) instead of
      // leaking it when the gateway shuts down.
      await backend.close?.();
    }
  };
}

// ---- HTTP helpers (Node built-ins only) ----

const NO_BODY = Symbol("no-body");

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Read and parse a JSON request body. On malformed JSON, write a 400 and
 * return the NO_BODY sentinel so the caller stops processing.
 */
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

function writeJson(res: ServerResponse, status: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.byteLength));
  res.end(payload);
  return payload;
}

/**
 * Report an error on a response that may already be mid-stream. Once headers
 * are sent (e.g. an SSE turn whose upstream died — a crashed local model
 * server), `writeJson` would throw ERR_HTTP_HEADERS_SENT, so instead destroy
 * the socket: the client sees a clean disconnect for that one request while
 * the gateway process stays alive. Never throws.
 */
function writeErrorSafely(res: ServerResponse, status: number, value: unknown): Buffer {
  try {
    if (!res.headersSent) return writeJson(res, status, value);
    if (!res.writableEnded) res.destroy();
  } catch {
    // last resort: nothing we can do with this response, but the server lives
  }
  return Buffer.alloc(0);
}

type ModelCallRoute = {
  dialect: GatewayDialect;
  body: unknown;
  defaultModel: string | undefined;
  invoke: (callId: string, signal: AbortSignal) => Promise<Response>;
};

async function handleModelCall(
  res: ServerResponse,
  sink: ProvenanceSink | undefined,
  route: ModelCallRoute
): Promise<void> {
  const callId = modelCallId();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const context: ModelGatewayCallContext = {
    callId,
    dialect: route.dialect,
    requestedModel: effectiveModel(route.body, route.defaultModel),
    model: effectiveModel(route.body, route.defaultModel),
    stream: isStream(route.body),
    requestBody: route.body,
    startedAt,
    endpointId: route.defaultModel ?? route.dialect
  };
  res.setHeader(MODEL_CALL_ID_HEADER, callId);
  // Cancel upstream work if the client hangs up before we finish responding.
  const aborter = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) aborter.abort();
  };
  res.once("close", onClose);
  try {
    const upstream = await route.invoke(callId, aborter.signal);
    const body = await pipeUpstream(res, upstream);
    const result = {
      statusCode: upstream.status,
      responseBody: body,
      durationMs: Date.now() - started
    };
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } catch (error) {
    const statusCode = 502;
    const payload = writeErrorSafely(res, statusCode, {
      error: { message: errorMessage(error), type: "upstream_error" }
    });
    const result = {
      statusCode,
      responseBody: payload,
      durationMs: Date.now() - started,
      error
    };
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } finally {
    res.off("close", onClose);
  }
}

async function pipeUpstream(res: ServerResponse, upstream: Response): Promise<Buffer> {
  res.statusCode = upstream.status;
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) res.setHeader("content-type", contentType);
  const body = upstream.body;
  if (body === null) {
    res.end();
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        if (!res.write(chunk)) await once(res, "drain");
      }
    }
  } catch (error) {
    // The upstream stream died mid-response (e.g. a local model server was
    // OOM-killed). Destroy instead of end so the client sees an abnormal
    // disconnect for this request rather than a silently truncated body.
    res.destroy();
    throw error;
  }
  res.end();
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && constantTimeEquals(auth, `Bearer ${token}`)) {
    return true;
  }
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && constantTimeEquals(apiKey, token);
}

/** Length-independent constant-time string comparison (avoids timing leaks). */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
