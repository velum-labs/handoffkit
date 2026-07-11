import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
// Served on raw node:http deliberately: the API surface is small and fully
// enumerated below, auth/validation/rate-limiting are explicit functions
// rather than middleware, and TLS termination is the fronting proxy's job
// in deployment (docker-compose/K8s).
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { PolicyDeniedError } from "@fusionkit/protocol";
import type { ChainedEvent, Receipt } from "@fusionkit/protocol";

import type { Capability, Principal } from "./auth.js";
import { isPlaneDomainError } from "./domain-errors.js";
import { Plane } from "./plane.js";
import { DEFAULT_RATE_LIMIT, RateLimiter } from "./ratelimit.js";
import type { RateLimitConfig } from "./ratelimit.js";
import {
  approveBodySchema,
  cancelBodySchema,
  claimBodySchema,
  completeBodySchema,
  createRunBodySchema,
  enrollBodySchema,
  eventsBodySchema,
  issuePrincipalBodySchema,
  parseBody,
  ValidationError
} from "./validation.js";

/** Default request body cap (workspace bundles can be large). */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Liveness payload. The shape (`ok` + `service`) is part of the public API
 * surface; deployment healthchecks and the docs reference it, so it is a
 * named constant rather than scattered literals.
 */
const HEALTH_RESPONSE = { ok: true, service: "warrant-plane" } as const;

const UI_FILES: Record<string, { file: string; type: string }> = {
  "/ui": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" }
};

// UI assets are read from disk once and served from memory thereafter; the
// bundle is three small files, so caching them avoids per-request blocking
// filesystem reads.
const uiAssetCache = new Map<string, Buffer>();

function uiAsset(file: string): Buffer {
  const cached = uiAssetCache.get(file);
  if (cached) return cached;
  const body = readFileSync(
    fileURLToPath(new URL(`../ui/${file}`, import.meta.url))
  );
  uiAssetCache.set(file, body);
  return body;
}

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new RequestError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const raw = (await readBody(req, maxBodyBytes)).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestError(400, "request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/**
 * Client identity for rate limiting and auth-failure backoff. By default the
 * socket address is used; behind a trusted reverse proxy, enable
 * `trustProxy` so limits key on the originating client from X-Forwarded-For
 * rather than the proxy itself. Only enable it when a proxy you control
 * sets the header, since clients can spoof it otherwise.
 */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      ?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** A request-handling error carrying an HTTP status. */
class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

export type PlaneServerOptions = {
  port: number;
  /**
   * Bind host. Defaults to loopback ("127.0.0.1") as a secure-by-default
   * choice; container/K8s deployments pass "0.0.0.0" explicitly (the CLI
   * and docker-compose already do).
   */
  host?: string;
  rateLimit?: Partial<RateLimitConfig>;
  /** Request body cap in bytes. Defaults to DEFAULT_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
  /**
   * HTTP keep-alive idle timeout in ms. Defaults to 0 (disabled): clients
   * in this repo retry idempotent requests, and disabling the idle timer
   * avoids closed-socket races. Set a positive value when fronted by a
   * reverse proxy whose own idle timeout should win.
   */
  keepAliveTimeoutMs?: number;
  /** Trust X-Forwarded-For from a fronting proxy for rate-limit keys. */
  trustProxy?: boolean;
};

/** Per-server request context threaded through the route handler. */
type ServerContext = {
  plane: Plane;
  limiter: RateLimiter;
  maxBodyBytes: number;
  trustProxy: boolean;
};

/**
 * Control-plane HTTP API plus the control panel UI. Every mutating and
 * data-returning route is authenticated against a principal and gated by
 * capability; bodies are schema-validated; requests are rate-limited per
 * principal/IP with auth-failure backoff; everything is logged with a
 * request id.
 */
export function startPlaneServer(
  plane: Plane,
  options: PlaneServerOptions | number
): Promise<{ server: Server; port: number; host: string }> {
  const resolved: PlaneServerOptions =
    typeof options === "number" ? { port: options } : options;
  const { port, host = "127.0.0.1" } = resolved;
  const limiter = new RateLimiter(resolved.rateLimit ?? DEFAULT_RATE_LIMIT);
  const context: ServerContext = {
    plane,
    limiter,
    maxBodyBytes: resolved.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    trustProxy: resolved.trustProxy ?? false
  };

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    handle(context, req, res, requestId).catch((error: unknown) => {
      if (error instanceof PolicyDeniedError) {
        sendJson(res, 403, { error: error.message, code: error.code, reasons: error.reasons });
        return;
      }
      if (error instanceof ValidationError) {
        sendJson(res, 400, { error: error.message, issues: error.issues });
        return;
      }
      if (error instanceof RequestError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (isPlaneDomainError(error)) {
        plane.log.warn({ requestId, err: error.message }, "request rejected");
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      plane.log.error(
        {
          requestId,
          err: error instanceof Error ? error.message : String(error)
        },
        "request failed"
      );
      sendJson(res, 500, { error: "internal server error" });
    });
  });
  server.keepAliveTimeout = resolved.keepAliveTimeoutMs ?? 0;
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      plane.log.info({ host, port: boundPort }, "plane listening");
      resolve({ server, port: boundPort, host });
    });
  });
}

/** Authenticate + authorize, recording rate-limit/auth-failure state. */
function requirePrincipal(
  ctx: ServerContext,
  req: IncomingMessage,
  capability: Capability
): Principal {
  const { plane, limiter } = ctx;
  const token = bearerToken(req);
  const ip = clientIp(req, ctx.trustProxy);
  if (limiter.isLockedOut(ip)) {
    throw new RequestError(429, "too many authentication failures; backing off");
  }
  const principal = plane.authorize(token, capability);
  if (!principal) {
    limiter.recordAuthFailure(ip);
    // Distinguish "no/invalid token" from "valid token, wrong role".
    if (plane.authenticate(token)) {
      throw new RequestError(403, "forbidden: principal lacks the required role");
    }
    throw new RequestError(401, "unauthorized");
  }
  limiter.recordAuthSuccess(ip);
  if (!limiter.allow(principal.principalId)) {
    throw new RequestError(429, "rate limit exceeded");
  }
  return principal;
}

async function handle(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string
): Promise<void> {
  const { plane, limiter } = ctx;
  // The base is only needed so WHATWG URL can parse the path + query of a
  // server-side request URL; it never appears in any response.
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const path = url.pathname;
  plane.log.debug({ requestId, method, path }, "request");

  // ---- Public routes ----

  if (method === "GET" && path === "/") {
    res.writeHead(302, { location: "/ui/" });
    res.end();
    return;
  }

  const uiEntry = UI_FILES[path];
  if (method === "GET" && uiEntry) {
    const body = uiAsset(uiEntry.file);
    res.writeHead(200, {
      "content-type": uiEntry.type,
      "content-length": body.length,
      "cache-control": "no-store"
    });
    res.end(body);
    return;
  }

  if (method === "GET" && path === "/v1/health") {
    sendJson(res, 200, HEALTH_RESPONSE);
    return;
  }

  if (method === "GET" && path === "/v1/ready") {
    const ready = plane.ready();
    sendJson(res, ready ? 200 : 503, { ready });
    return;
  }

  if (method === "GET" && path === "/v1/metrics") {
    requirePrincipal(ctx, req, "policy:read");
    sendJson(res, 200, { metrics: plane.metrics.snapshot() });
    return;
  }

  // Runner enrollment authenticates with an enroll token (principal or
  // single-use), not a control-plane principal.
  if (method === "POST" && path === "/v1/runners/enroll") {
    const ip = clientIp(req, ctx.trustProxy);
    if (limiter.isLockedOut(ip)) {
      throw new RequestError(429, "too many authentication failures; backing off");
    }
    const body = parseBody(enrollBodySchema, await readJson(req, ctx.maxBodyBytes));
    try {
      const result = plane.enrollRunner(body);
      limiter.recordAuthSuccess(ip);
      sendJson(res, 200, result);
    } catch (error) {
      limiter.recordAuthFailure(ip);
      throw error;
    }
    return;
  }

  // Runner claim/event/completion authenticate with runner tokens + signed
  // claim tokens (verified inside the plane), not principals.
  if (method === "POST" && path === "/v1/claims") {
    const body = parseBody(claimBodySchema, await readJson(req, ctx.maxBodyBytes));
    const claim = plane.claim(body);
    sendJson(res, 200, claim ?? { empty: true });
    return;
  }

  // ---- Principal-authenticated routes ----

  if (method === "GET" && path === "/v1/runners") {
    requirePrincipal(ctx, req, "runners:read");
    sendJson(res, 200, { runners: plane.listRunners() });
    return;
  }

  if (method === "GET" && path === "/v1/policy") {
    requirePrincipal(ctx, req, "policy:read");
    sendJson(res, 200, plane.policySnapshot);
    return;
  }

  if (method === "GET" && path === "/v1/principals") {
    requirePrincipal(ctx, req, "principals:manage");
    sendJson(res, 200, { principals: plane.listPrincipals() });
    return;
  }

  if (method === "POST" && path === "/v1/principals") {
    requirePrincipal(ctx, req, "principals:manage");
    const body = parseBody(issuePrincipalBodySchema, await readJson(req, ctx.maxBodyBytes));
    sendJson(res, 200, plane.issuePrincipal(body.name, body.role));
    return;
  }

  if (method === "POST" && path === "/v1/enroll-tokens") {
    requirePrincipal(ctx, req, "principals:manage");
    const issued = plane.issueEnrollToken();
    sendJson(res, 200, issued);
    return;
  }

  if (method === "POST" && path === "/v1/blobs") {
    // Writers are either a blobs:write principal (CLI/SDK) or a runner
    // holding a valid plane-signed claim token (artifact uploads).
    const token = bearerToken(req);
    const principal = plane.authorize(token, "blobs:write");
    if (!principal && !(token && plane.verifyClaimTokenSignature(token))) {
      throw new RequestError(401, "unauthorized");
    }
    const content = await readBody(req, ctx.maxBodyBytes);
    sendJson(res, 200, { hash: plane.blobs.putBlob(content) });
    return;
  }

  // Blobs are content-addressed by sha256; knowing the hash (which only
  // appears in capability-gated receipts/events or the issued contract) is
  // itself the read capability, so reads are not separately gated.
  // Deliberate hash-as-capability design: a sha256 is unguessable, and the
  // hashes only appear inside capability-gated responses (contracts,
  // receipts, events). The structured logger redacts token/secret carriers
  // and never logs blob hashes from request paths at info level.
  const blobMatch = path.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
  if (method === "GET" && blobMatch && blobMatch[1]) {
    const blob = plane.blobs.getBlob(blobMatch[1]);
    if (!blob) {
      sendJson(res, 404, { error: "blob not found" });
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": blob.length
    });
    res.end(blob);
    return;
  }

  if (method === "GET" && path === "/v1/runs") {
    requirePrincipal(ctx, req, "runs:read");
    sendJson(res, 200, { runs: plane.listRuns() });
    return;
  }

  if (method === "POST" && path === "/v1/runs") {
    requirePrincipal(ctx, req, "runs:create");
    const body = parseBody(createRunBodySchema, await readJson(req, ctx.maxBodyBytes));
    if (body.dryRun) {
      sendJson(res, 200, plane.dryRun(body.request));
      return;
    }
    const record = plane.requestRun(body.request);
    sendJson(res, 200, {
      runId: record.id,
      status: record.status,
      consentRequirements: record.consentRequirements
    });
    return;
  }

  // The segment charset is a superset of every id the plane issues
  // (`run_<uuid>`); unknown ids simply 404 from the store lookup below.
  const runMatch = path.match(/^\/v1\/runs\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (runMatch && runMatch[1]) {
    const runId = runMatch[1];
    const sub = runMatch[2] ?? "";

    if (method === "POST" && sub === "/approve") {
      const principal = requirePrincipal(ctx, req, "runs:approve");
      const body = parseBody(approveBodySchema, await readJson(req, ctx.maxBodyBytes));
      let actor = body.actor ?? {
        kind: "human" as const,
        id: principal.name
      };
      let verified: { idpSubject: string; idpIssuer: string } | undefined;
      if (body.idpToken) {
        verified = await plane.verifyIdpToken(body.idpToken);
        actor = { kind: "human", id: verified.idpSubject };
      }
      const record = plane.approve(runId, actor, verified);
      sendJson(res, 200, { runId: record.id, status: record.status });
      return;
    }

    if (method === "POST" && sub === "/cancel") {
      const principal = requirePrincipal(ctx, req, "runs:cancel");
      const body = parseBody(cancelBodySchema, await readJson(req, ctx.maxBodyBytes));
      const actor = body.actor ?? { kind: "human" as const, id: principal.name };
      const record = plane.cancel(runId, actor);
      sendJson(res, 200, { runId: record.id, status: record.status });
      return;
    }

    if (method === "POST" && sub === "/events") {
      const body = parseBody(eventsBodySchema, await readJson(req, ctx.maxBodyBytes));
      // Events are hash-chained and verified inside appendRunnerEvents; the
      // chain verification is the authoritative structural gate (a malformed
      // event cannot have a valid chain hash), so the cast is safe here.
      plane.appendRunnerEvents(
        runId,
        body.claimToken,
        body.events as ChainedEvent[]
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && sub === "/complete") {
      const body = parseBody(completeBodySchema, await readJson(req, ctx.maxBodyBytes));
      // The receipt is verified inside complete(): contract-hash binding and
      // the runner's ed25519 signature over the canonical payload. A
      // malformed receipt cannot carry a valid signature, so the signature
      // check is the authoritative structural gate.
      const countersigned = plane.complete(
        runId,
        body.claimToken,
        body.receipt as Receipt
      );
      sendJson(res, 200, { receipt: countersigned });
      return;
    }

    if (method === "GET" && sub === "/bundle") {
      requirePrincipal(ctx, req, "runs:read");
      const bundle = plane.getBundle(runId);
      if (!bundle) {
        sendJson(res, 404, { error: "bundle not available" });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (method === "GET" && sub === "") {
      requirePrincipal(ctx, req, "runs:read");
      const record = plane.getRun(runId);
      if (!record) {
        sendJson(res, 404, { error: "run not found" });
        return;
      }
      sendJson(res, 200, {
        runId: record.id,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        consentRequirements: record.consentRequirements,
        failureMessage: record.failureMessage,
        events: plane.getEvents(runId)
      });
      return;
    }
  }

  if (method === "GET" && path === "/v1/export") {
    requirePrincipal(ctx, req, "export:read");
    const since = url.searchParams.get("since") ?? undefined;
    const jsonl = plane.exportJsonl(since);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(jsonl);
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}
