import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ProviderFailureError } from "@routekit/contracts";

import {
  anthropicModelsResponse,
  handleAnthropicMessages,
  handleCountTokens
} from "./adapters/anthropic.js";
import type { AnthropicRequest } from "./adapters/anthropic.js";
import { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
import { authorizedRequest } from "./auth.js";
import { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";
import { handleResponses } from "./adapters/responses.js";
import type { ResponsesRequest } from "./adapters/responses.js";
import type { Backend } from "./backend.js";
import {
  validateAnthropicRequest,
  validateChatRequest,
  validateCountTokensRequest,
  validateResponsesRequest
} from "./adapters/validate.js";
import type { WireRejection } from "./adapters/validate.js";
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
 * dialects each agent harness needs: OpenAI chat, Anthropic Messages, OpenAI
 * Responses, and Cursor's Responses-hybrid BYOK shape.
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
  /** Optional client-authenticated Responses relay. */
  codexRelay?: ProviderRelay;
  /** Provider-native relays sharing this HTTP boundary. */
  providerRelays?: Partial<Record<ProviderRelayDialect, ProviderRelay>>;
  /** Optional provider usage payload for `GET /usage`. */
  usage?: () => unknown;
};

export type ProviderRelayDialect = "anthropic" | "codex";

export type ProviderRelay = {
  readonly dialect: ProviderRelayDialect;
  shouldRelay(
    headers: IncomingMessage["headers"],
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: IncomingMessage["headers"],
    body: AnthropicRequest | ResponsesRequest,
    signal?: AbortSignal
  ): Promise<Response>;
  models?(
    headers: IncomingMessage["headers"],
    search: string,
    signal?: AbortSignal
  ): Promise<Response>;
  countTokens?(
    headers: IncomingMessage["headers"],
    body: AnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response>;
  mergedCatalog?(
    headers: IncomingMessage["headers"],
    search: string
  ): Promise<{
    models: Array<Record<string, unknown>>;
    etag?: string;
  } | undefined>;
  mergeDataIds?(
    data: Array<{ id: string } & Record<string, unknown>>,
    models: readonly Record<string, unknown>[]
  ): Array<{ id: string } & Record<string, unknown>>;
  close?(): Promise<void> | void;
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
  // Client-forwarded Codex auth and server-owned subscription accounts are
  // distinct trust models. Gateway auth disables only the client-forwarded
  // relay; a server-owned account set remains available behind the proxy key.
  const codexClientRelay = authToken === undefined ? options.codexRelay : undefined;
  const anthropicRelay = options.providerRelays?.anthropic;
  const codexProviderRelay = options.providerRelays?.codex;
  const codexCatalogRelay =
    codexProviderRelay?.mergedCatalog !== undefined
      ? codexProviderRelay
      : codexClientRelay;
  const codexRequestRelay = codexProviderRelay ?? codexClientRelay;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // This catch must never throw: a throw here becomes an unhandled
      // rejection that kills the process hosting the gateway.
      writeGatewayError(res, error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    if (authToken !== undefined && !authorizedRequest(req, authToken)) {
      writeJson(res, 401, { error: { message: "unauthorized", type: "auth_error" } });
      return;
    }

    if (method === "GET" && path === "/usage") {
      writeJson(res, options.usage === undefined ? 404 : 200, options.usage?.() ?? {
        error: { message: "provider usage is not configured", type: "not_found" }
      });
      return;
    }

    if (
      method === "GET" &&
      (path === "/v1/models" || path === "/models" || path === "/backend-api/codex/models")
    ) {
      // Claude Code's discovery probe carries `anthropic-version` and expects
      // the Anthropic-shaped model list; everyone else gets the OpenAI shape.
      if (req.headers["anthropic-version"] !== undefined) {
        if (anthropicRelay?.models !== undefined) {
          await pipeUpstream(res, await anthropicRelay.models(req.headers, url.search));
          return;
        }
        await pipeUpstream(res, anthropicModelsResponse(backend.defaultModel, backend.listModelIds?.()));
        return;
      }
      if (codexCatalogRelay !== undefined) {
        // Codex parses the `models` key (its ModelInfo catalog — this is what
        // drives its /model picker); OpenAI-shape clients read `data`. Serving
        // both keys on one response keeps every client working.
          const merged = await codexCatalogRelay.mergedCatalog?.(req.headers, url.search);
        if (merged !== undefined) {
          const base = (await (await backend.models()).json()) as {
            data?: Array<{ id: string } & Record<string, unknown>>;
          };
          if (merged.etag !== undefined) res.setHeader("etag", merged.etag);
          writeJson(res, 200, {
            object: "list",
            data: codexCatalogRelay.mergeDataIds?.(base.data ?? [], merged.models) ?? base.data ?? [],
            models: merged.models
          });
          return;
        }
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

    const requestContext = { headers: req.headers };

    if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      if (rejectInvalid(res, validateChatRequest(raw))) return;
      const body = withDefaultModel(raw, backend.defaultModel);
      await handleModelCall(res, provenance, {
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) =>
          backend.chat(body, signal, { modelCallId: callId, requestContext })
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
      if ("input" in raw && rejectInvalid(res, validateResponsesRequest(raw))) return;
      // Validate the translated body before invoking the backend.
      const translated = translateCursorRequest(raw);
      if (rejectInvalid(res, validateChatRequest(translated))) return;
      const body = withDefaultModel(translated, backend.defaultModel);
      await handleModelCall(res, provenance, {
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) =>
          backend.chat(body, signal, { modelCallId: callId, requestContext })
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
      if (rejectInvalid(res, validateCountTokensRequest(raw))) return;
      if (anthropicRelay?.countTokens !== undefined) {
        await pipeUpstream(
          res,
          await anthropicRelay.countTokens(req.headers, raw as AnthropicRequest)
        );
        return;
      }
      await pipeUpstream(res, handleCountTokens(raw as AnthropicRequest));
      return;
    }

    if (method === "POST" && path === "/v1/messages") {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      if (rejectInvalid(res, validateAnthropicRequest(raw))) return;
      const body = raw as AnthropicRequest;
      const requestedModel = typeof body.model === "string" ? body.model : undefined;
      if (
        anthropicRelay !== undefined &&
        anthropicRelay.shouldRelay(
          req.headers,
          requestedModel,
          (model) => backend.servesModel?.(model) ?? false
        )
      ) {
        await handleModelCall(res, provenance, {
          dialect: "anthropic-messages",
          body,
          defaultModel: backend.defaultModel,
          invoke: (_callId, signal) => anthropicRelay.relay(req.headers, body, signal)
        });
        return;
      }
      await handleModelCall(res, provenance, {
        dialect: "anthropic-messages",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) =>
          handleAnthropicMessages(backend, body, callId, signal, { requestContext })
      });
      return;
    }

    if (
      method === "POST" &&
      (path === "/v1/responses" || path === "/backend-api/codex/responses")
    ) {
      const raw = await readJson(req, res);
      if (raw === NO_BODY) return;
      if (rejectInvalid(res, validateResponsesRequest(raw))) return;
      const body = raw as ResponsesRequest;
      // A stock-model pick from a Codex client: the gateway does not serve
      // this model itself, and the request carries the client's own ChatGPT
      // auth — forward it verbatim to the Codex backend instead of silently
      // folding it into the default.
      const requestedModel = typeof body.model === "string" ? body.model : undefined;
      if (
        codexRequestRelay !== undefined &&
        codexRequestRelay.shouldRelay(req.headers, requestedModel, (model) =>
          backend.servesModel?.(model) ?? false
        )
      ) {
        await handleModelCall(res, provenance, {
          dialect: "openai-responses",
          body,
          defaultModel: backend.defaultModel,
          invoke: (_callId, signal) =>
            codexRequestRelay.relay(req.headers, body, signal)
        });
        return;
      }
      await handleModelCall(res, provenance, {
        dialect: "openai-responses",
        body,
        defaultModel: backend.defaultModel,
        invoke: (callId, signal) =>
          handleResponses(backend, body, callId, signal, { requestContext })
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
      await backend.close?.();
      const relays = new Set(
        [codexClientRelay, anthropicRelay, codexProviderRelay].filter(
          (relay): relay is ProviderRelay => relay !== undefined
        )
      );
      await Promise.all([...relays].map(async (relay) => relay.close?.()));
    }
  };
}

// ---- HTTP helpers (Node built-ins only) ----

const NO_BODY = Symbol("no-body");
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new RequestBodyTooLargeError();
  return Buffer.concat(chunks);
}

class RequestBodyTooLargeError extends Error {}

/**
 * Read and parse a JSON request body. On malformed JSON, write a 400 and
 * return the NO_BODY sentinel so the caller stops processing.
 */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    req.resume();
    writeJson(res, 413, {
      error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
    });
    return NO_BODY;
  }
  let buffer: Buffer;
  try {
    buffer = await readBody(req);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLargeError)) throw error;
    writeJson(res, 413, {
      error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
    });
    return NO_BODY;
  }
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    writeJson(res, 400, { error: { message: "invalid JSON body", type: "bad_request" } });
    return NO_BODY;
  }
}

/** Write a structural-validation rejection (if any) and report whether one was written. */
function rejectInvalid(res: ServerResponse, rejection: WireRejection | undefined): boolean {
  if (rejection === undefined) return false;
  writeJson(res, rejection.status, rejection.body);
  return true;
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

/**
 * Map a normalized provider failure to HTTP, preserving retry timing.
 */
function writeGatewayError(
  res: ServerResponse,
  error: unknown
): { statusCode: number; payload: Buffer } {
  if (error instanceof ProviderFailureError) {
    const { failure } = error;
    const resetAt = failure.resetsAt;
    if (resetAt !== undefined && !res.headersSent) {
      res.setHeader("retry-after", Math.max(0, Math.ceil(resetAt - Date.now() / 1000)));
    }
    const payload = writeErrorSafely(res, 429, {
      error: {
        message: failure.message,
        type: "rate_limit_error",
        ...(resetAt !== undefined ? { resets_at: resetAt } : {})
      }
    });
    return { statusCode: 429, payload };
  }
  const payload = writeErrorSafely(res, 502, {
    error: { message: errorMessage(error), type: "upstream_error" }
  });
  return { statusCode: 502, payload };
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
    // Only buffer the response body when a provenance sink will consume it.
    const body = await pipeUpstream(res, upstream, sink !== undefined, aborter.signal);
    const result = {
      statusCode: upstream.status,
      responseBody: body,
      durationMs: Date.now() - started
    };
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } catch (error) {
    const { statusCode, payload } = writeGatewayError(res, error);
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

/**
 * Cap on the body we buffer for provenance. A streamed turn is piped to the
 * client regardless; this only bounds the in-memory copy kept for the
 * provenance sink (request/response hashing + usage extraction), so a runaway
 * upstream cannot grow gateway memory without bound. 2 MiB comfortably covers a
 * routed chat completion (JSON or SSE); past it, provenance sees a truncated body.
 */
const PROVENANCE_BODY_CAP_BYTES = 2 * 1024 * 1024;

async function pipeUpstream(
  res: ServerResponse,
  upstream: Response,
  collectBody = false,
  signal?: AbortSignal
): Promise<Buffer> {
  res.statusCode = upstream.status;
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) res.setHeader("content-type", contentType);
  const body = upstream.body;
  if (body === null) {
    res.end();
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        if (signal?.aborted === true || res.destroyed || res.writableEnded) {
          await reader.cancel(signal?.reason).catch(() => undefined);
          break;
        }
        const chunk = Buffer.from(value);
        // Accumulate for provenance only when a sink wants it, and only up to
        // the cap; the client always receives the full stream via res.write.
        if (collectBody && collectedBytes < PROVENANCE_BODY_CAP_BYTES) {
          chunks.push(chunk);
          collectedBytes += chunk.length;
        }
        if (!res.write(chunk)) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
        }
      }
    }
  } catch (error) {
    // The upstream stream died mid-response (e.g. a local model server was
    // OOM-killed). Destroy instead of end so the client sees an abnormal
    // disconnect for this request rather than a silently truncated body.
    res.destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (!res.destroyed && !res.writableEnded) res.end();
  return Buffer.concat(chunks);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
