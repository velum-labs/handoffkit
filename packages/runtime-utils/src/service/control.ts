/**
 * Authenticated loopback control transport for product daemons.
 *
 * The transport is deliberately product-neutral: products define an explicit
 * method schema and dispatcher while this module owns the security boundary,
 * wire envelope, deadlines, cancellation, event streaming, and structured
 * errors. It never accepts argv or executes a CLI parser.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export const CONTROL_PROTOCOL_VERSION = "control.v1";
export const CONTROL_BODY_LIMIT_BYTES = 1024 * 1024;

export type ControlErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal"
  | "upgrade_required";

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(input: {
    code: ControlErrorCode;
    message: string;
    status?: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "ControlError";
    this.code = input.code;
    this.status = input.status ?? statusForCode(input.code);
    this.details = input.details;
  }
}
function statusForCode(code: ControlErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "upgrade_required":
      return 426;
    case "unavailable":
      return 503;
    case "internal":
      return 500;
  }
}
export type ControlRequest = {
  protocol: string;
  id: string;
  method: string;
  params?: unknown;
  idempotencyKey?: string;
  client?: { version?: string; cwd?: string };
};

export type ControlSuccess = {
  protocol: string;
  id: string;
  ok: true;
  result: unknown;
};

export type ControlFailure = {
  protocol: string;
  id: string;
  ok: false;
  error: { code: ControlErrorCode; message: string; details?: unknown };
};

export type ControlResponse = ControlSuccess | ControlFailure;

export type ControlEvent = {
  protocol: string;
  id: string;
  event: "data" | "done" | "error";
  data?: unknown;
  error?: ControlFailure["error"];
};

export type ControlHandlerContext = {
  signal: AbortSignal;
  requestId: string;
  idempotencyKey?: string;
  client?: ControlRequest["client"];
};

export type ControlHandler = (
  method: string,
  params: unknown,
  context: ControlHandlerContext
) => unknown | Promise<unknown> | AsyncIterable<unknown>;

export type RunningControlServer = {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
};

export type ControlServerErrorContext = {
  requestId: string;
  method?: string;
};

export function generateControlToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function controlTokenMatches(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  return timingSafeEqual(digest(expected), digest(candidate));
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : undefined;
}

function loopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  const host =
    raw?.startsWith("[") === true
      ? raw.slice(1, raw.indexOf("]"))
      : raw?.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.byteLength));
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== "application/json") {
    throw new ControlError({
      code: "bad_request",
      message: "control requests require application/json"
    });
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > CONTROL_BODY_LIMIT_BYTES) {
    throw new ControlError({ code: "bad_request", message: "control request body is too large" });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > CONTROL_BODY_LIMIT_BYTES) {
      throw new ControlError({ code: "bad_request", message: "control request body is too large" });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ControlError({ code: "bad_request", message: "invalid control request JSON" });
  }
}

function parseRequest(value: unknown): ControlRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "control request must be an object" });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.protocol !== "string" ||
    typeof record.id !== "string" ||
    typeof record.method !== "string" ||
    record.id.length === 0 ||
    record.method.length === 0
  ) {
    throw new ControlError({
      code: "bad_request",
      message: "control request requires protocol, id, and method"
    });
  }
  return {
    protocol: record.protocol,
    id: record.id,
    method: record.method,
    ...(record.params !== undefined ? { params: record.params } : {}),
    ...(typeof record.idempotencyKey === "string"
      ? { idempotencyKey: record.idempotencyKey }
      : {}),
    ...(typeof record.client === "object" && record.client !== null
      ? { client: record.client as ControlRequest["client"] }
      : {})
  };
}

function asFailure(id: string, error: unknown): { status: number; body: ControlFailure } {
  const normalized =
    error instanceof ControlError
      ? error
      : new ControlError({ code: "internal", message: "control operation failed" });
  return {
    status: normalized.status,
    body: {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined ? { details: normalized.details } : {})
      }
    }
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function ndjson(res: ServerResponse, event: ControlEvent): boolean {
  return res.write(`${JSON.stringify(event)}\n`);
}

export async function startControlServer(input: {
  handler: ControlHandler;
  token?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  product?: string;
  packageVersion?: string;
  capabilities?: readonly string[];
  /** Observe unexpected handler/transport failures without exposing them to clients. */
  onError?: (error: unknown, context: ControlServerErrorContext) => void;
}): Promise<RunningControlServer> {
  const host = input.host ?? "127.0.0.1";
  const token = input.token ?? generateControlToken();
  const reportError = (error: unknown, context: ControlServerErrorContext): void => {
    try {
      input.onError?.(error, context);
    } catch {
      // Observability must never change the control response or crash the server.
    }
  };
  const server = createServer((req, res) => {
    void (async () => {
      if (!loopbackHost(req)) {
        writeJson(res, 403, { error: { code: "unauthorized", message: "invalid control host" } });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!controlTokenMatches(token, bearer(req))) {
        writeJson(res, 401, { error: { code: "unauthorized", message: "unauthorized" } });
        return;
      }
      if (req.method === "GET" && url.pathname === "/control/v1/health") {
        writeJson(res, 200, {
          status: "ok",
          protocol: CONTROL_PROTOCOL_VERSION,
          product: input.product,
          version: input.packageVersion
        });
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/control/v1/call") {
        writeJson(res, 404, { error: { code: "not_found", message: "control route not found" } });
        return;
      }
      let requestId = "unknown";
      let requestMethod: string | undefined;
      try {
        const request = parseRequest(await readJson(req));
        requestId = request.id;
        requestMethod = request.method;
        if (request.protocol !== CONTROL_PROTOCOL_VERSION) {
          throw new ControlError({
            code: "upgrade_required",
            message: `unsupported control protocol ${request.protocol}`,
            details: { supported: [CONTROL_PROTOCOL_VERSION] }
          });
        }
        if (request.method === "hello") {
          writeJson(res, 200, {
            protocol: CONTROL_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result: {
              protocolVersion: CONTROL_PROTOCOL_VERSION,
              product: input.product,
              packageVersion: input.packageVersion,
              capabilities: input.capabilities ?? []
            }
          } satisfies ControlSuccess);
          return;
        }
        const aborter = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) aborter.abort(new Error("control client disconnected"));
        };
        res.once("close", onClose);
        try {
          const result = await input.handler(request.method, request.params, {
            signal: aborter.signal,
            requestId: request.id,
            ...(request.idempotencyKey !== undefined
              ? { idempotencyKey: request.idempotencyKey }
              : {}),
            ...(request.client !== undefined ? { client: request.client } : {})
          });
          if (isAsyncIterable(result)) {
            res.statusCode = 200;
            res.setHeader("content-type", "application/x-ndjson");
            res.setHeader("cache-control", "no-store");
            const iterator = result[Symbol.asyncIterator]();
            const disconnected = new Promise<IteratorResult<unknown>>((resolve) => {
              aborter.signal.addEventListener(
                "abort",
                () => resolve({ done: true, value: undefined }),
                { once: true }
              );
            });
            try {
              while (!aborter.signal.aborted) {
                const next = await Promise.race([iterator.next(), disconnected]);
                if (next.done) break;
                if (!ndjson(res, {
                  protocol: CONTROL_PROTOCOL_VERSION,
                  id: request.id,
                  event: "data",
                  data: next.value
                })) {
                  await Promise.race([once(res, "drain"), once(res, "close")]);
                }
              }
            } finally {
              if (aborter.signal.aborted) {
                await Promise.race([
                  iterator.return?.(),
                  new Promise((resolve) => setTimeout(resolve, 1_000))
                ]).catch(() => undefined);
              }
            }
            if (!aborter.signal.aborted) {
              ndjson(res, {
                protocol: CONTROL_PROTOCOL_VERSION,
                id: request.id,
                event: "done"
              });
              res.end();
            }
          } else {
            writeJson(res, 200, {
              protocol: CONTROL_PROTOCOL_VERSION,
              id: request.id,
              ok: true,
              result
            } satisfies ControlSuccess);
          }
        } finally {
          res.off("close", onClose);
        }
      } catch (error) {
        if (!(error instanceof ControlError)) {
          reportError(error, {
            requestId,
            ...(requestMethod !== undefined ? { method: requestMethod } : {})
          });
        }
        const failure = asFailure(requestId, error);
        if (!res.headersSent) writeJson(res, failure.status, failure.body);
        else if (!res.writableEnded) {
          ndjson(res, {
            protocol: CONTROL_PROTOCOL_VERSION,
            id: requestId,
            event: "error",
            error: failure.body.error
          });
          res.end();
        }
      }
    })().catch((error: unknown) => {
      reportError(error, { requestId: "unknown" });
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: { code: "internal", message: "control request failed" }
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : input.port ?? 0;
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    token,
    port,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
      server.closeAllConnections();
      await closed;
    }
  };
}

export type ControlClientOptions = {
  url: string;
  token: string;
  packageVersion?: string;
  cwd?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class ControlClient {
  readonly #options: ControlClientOptions;

  constructor(options: ControlClientOptions) {
    this.#options = options;
  }

  async health(): Promise<{ protocol: string; version?: string }> {
    const response = await (this.#options.fetch ?? fetch)(
      `${this.#options.url}/control/v1/health`,
      {
        headers: { authorization: `Bearer ${this.#options.token}` },
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 2_000)
      }
    );
    if (!response.ok) throw new Error(`control health failed (${response.status})`);
    const body = (await response.json()) as { protocol?: string; version?: string };
    if (typeof body.protocol !== "string") throw new Error("invalid control health response");
    return {
      protocol: body.protocol,
      ...(typeof body.version === "string" ? { version: body.version } : {})
    };
  }

  async call<T = unknown>(
    method: string,
    params?: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal; requestId?: string } = {}
  ): Promise<T> {
    const id = options.requestId ?? randomBytes(12).toString("hex");
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 30_000);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const request: ControlRequest = {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      client: {
        ...(this.#options.packageVersion !== undefined
          ? { version: this.#options.packageVersion }
          : {}),
        ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {})
      }
    };
    const response = await (this.#options.fetch ?? fetch)(
      `${this.#options.url}/control/v1/call`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#options.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(request),
        signal
      }
    );
    const body = (await response.json()) as ControlResponse;
    if (
      body.protocol !== CONTROL_PROTOCOL_VERSION ||
      body.id !== id ||
      typeof body.ok !== "boolean"
    ) {
      throw new Error("invalid control response");
    }
    if (!body.ok) {
      throw new ControlError({
        code: body.error.code,
        message: body.error.message,
        status: response.status,
        ...(body.error.details !== undefined ? { details: body.error.details } : {})
      });
    }
    return body.result as T;
  }

  async *stream<T = unknown>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; requestId?: string } = {}
  ): AsyncIterable<T> {
    const id = options.requestId ?? randomBytes(12).toString("hex");
    const request: ControlRequest = {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      client: {
        ...(this.#options.packageVersion !== undefined
          ? { version: this.#options.packageVersion }
          : {}),
        ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {})
      }
    };
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 30_000);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const response = await (this.#options.fetch ?? fetch)(
      `${this.#options.url}/control/v1/call`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#options.token}`,
          "content-type": "application/json",
          accept: "application/x-ndjson"
        },
        body: JSON.stringify(request),
        signal
      }
    );
    if (!response.ok || response.body === null) {
      try {
        const failure = (await response.json()) as ControlFailure;
        if (failure.ok === false) {
          throw new ControlError({
            code: failure.error.code,
            message: failure.error.message,
            status: response.status,
            ...(failure.error.details !== undefined
              ? { details: failure.error.details }
              : {})
          });
        }
      } catch (error) {
        if (error instanceof ControlError) throw error;
      }
      throw new Error(`control stream failed (${response.status})`);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    let terminal = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) {
            if (Buffer.byteLength(pending, "utf8") > CONTROL_BODY_LIMIT_BYTES) {
              throw new Error("control stream event exceeds the size limit");
            }
            break;
          }
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length === 0) continue;
          if (Buffer.byteLength(line, "utf8") > CONTROL_BODY_LIMIT_BYTES) {
            throw new Error("control stream event exceeds the size limit");
          }
          const event = JSON.parse(line) as ControlEvent;
          if (event.id !== id || event.protocol !== CONTROL_PROTOCOL_VERSION) {
            throw new Error("invalid control event");
          }
          if (event.event === "data") yield event.data as T;
          if (event.event === "error") {
            terminal = true;
            throw new ControlError({
              code: event.error?.code ?? "internal",
              message: event.error?.message ?? "control stream failed",
              ...(event.error?.details !== undefined ? { details: event.error.details } : {})
            });
          }
          if (event.event === "done") {
            terminal = true;
            return;
          }
        }
      }
      if (pending.length > 0) throw new Error("control stream ended with a partial event");
      if (!terminal) throw new Error("control stream ended without a terminal event");
    } finally {
      if (!terminal) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
