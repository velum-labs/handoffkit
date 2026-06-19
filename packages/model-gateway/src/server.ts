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
import { handleResponses } from "./adapters/responses.js";
import type { ResponsesRequest } from "./adapters/responses.js";
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
      writeJson(res, 502, {
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
        await pipeUpstream(res, anthropicModelsResponse(backend.defaultModel));
        return;
      }
      await pipeUpstream(res, await backend.models());
      return;
    }

    if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      const body = withDefaultModel(raw, backend.defaultModel);
      await handleModelCall(res, provenance, {
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) => backend.chat(body, signal, { modelCallId: callId })
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
        invoke: (callId, signal) => handleAnthropicMessages(backend, body, callId, signal)
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
        invoke: (callId, signal) => handleResponses(backend, body, callId, signal)
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
    sink?.onModelCall?.(
      buildModelCallRecord(context, {
        statusCode: upstream.status,
        responseBody: body,
        durationMs: Date.now() - started
      })
    );
  } catch (error) {
    const statusCode = 502;
    const payload = writeJson(res, statusCode, {
      error: { message: errorMessage(error), type: "upstream_error" }
    });
    sink?.onModelCall?.(
      buildModelCallRecord(context, {
        statusCode,
        responseBody: payload,
        durationMs: Date.now() - started,
        error
      })
    );
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
  } finally {
    res.end();
  }
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth === `Bearer ${token}`) return true;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey === token;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
