import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
// TODO(lib): suggest fastify or hono — raw node:http lacks middleware, graceful shutdown, TLS, and structured routing.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { PolicyDeniedError } from "@warrant/protocol";
import type { ChainedEvent, Receipt } from "@warrant/protocol";

import type { Capability, Principal } from "./auth.js";
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

// TODO(hardcoded): 64 MiB request body cap is not configurable via PlaneServerOptions.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const UI_FILES: Record<string, { file: string; type: string }> = {
  "/ui": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" }
};

function uiAssetPath(file: string): string {
  return fileURLToPath(new URL(`../ui/${file}`, import.meta.url));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(req)).toString("utf8");
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

function clientIp(req: IncomingMessage): string {
  // TODO(brittle): uses socket.remoteAddress only; behind a reverse proxy auth lockout/rate limits key on the proxy IP.
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
  host?: string;
  rateLimit?: Partial<RateLimitConfig>;
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
  // TODO(hardcoded): default bind host "127.0.0.1" may be wrong for container/K8s deployments expecting 0.0.0.0.
  const { port, host = "127.0.0.1", rateLimit } =
    typeof options === "number" ? { port: options, rateLimit: undefined } : options;
  const limiter = new RateLimiter(rateLimit ?? DEFAULT_RATE_LIMIT);

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    handle(plane, limiter, req, res, requestId).catch((error: unknown) => {
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
      const message = error instanceof Error ? error.message : String(error);
      plane.log.error({ requestId, err: message }, "request failed");
      // TODO(brittle): unexpected errors return 400 instead of 500; may leak internal error messages to clients.
      sendJson(res, 400, { error: message });
    });
  });
  // TODO(hardcoded): keepAliveTimeout=0 disables idle timeout; should be tunable for reverse-proxy compatibility.
  server.keepAliveTimeout = 0;
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
  plane: Plane,
  limiter: RateLimiter,
  req: IncomingMessage,
  capability: Capability
): Principal {
  const token = bearerToken(req);
  const ip = clientIp(req);
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
  plane: Plane,
  limiter: RateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost"); // TODO(hardcoded): synthetic base URL for path parsing only.
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
    // TODO(brittle): synchronous readFileSync blocks the event loop on every UI asset request.
    const body = readFileSync(uiAssetPath(uiEntry.file));
    res.writeHead(200, {
      "content-type": uiEntry.type,
      "content-length": body.length,
      "cache-control": "no-store"
    });
    res.end(body);
    return;
  }

  if (method === "GET" && path === "/v1/health") {
    // TODO(hardcoded): health response shape and service name are fixed strings.
    sendJson(res, 200, { ok: true, service: "warrant-plane" });
    return;
  }

  if (method === "GET" && path === "/v1/ready") {
    const ready = plane.ready();
    sendJson(res, ready ? 200 : 503, { ready });
    return;
  }

  if (method === "GET" && path === "/v1/metrics") {
    requirePrincipal(plane, limiter, req, "policy:read");
    sendJson(res, 200, { metrics: plane.metrics.snapshot() });
    return;
  }

  // Runner enrollment authenticates with an enroll token (principal or
  // single-use), not a control-plane principal.
  if (method === "POST" && path === "/v1/runners/enroll") {
    const ip = clientIp(req);
    if (limiter.isLockedOut(ip)) {
      throw new RequestError(429, "too many authentication failures; backing off");
    }
    const body = parseBody(enrollBodySchema, await readJson(req));
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
    const body = parseBody(claimBodySchema, await readJson(req));
    const claim = plane.claim(body);
    sendJson(res, 200, claim ?? { empty: true });
    return;
  }

  // ---- Principal-authenticated routes ----

  if (method === "GET" && path === "/v1/runners") {
    requirePrincipal(plane, limiter, req, "runners:read");
    sendJson(res, 200, { runners: plane.listRunners() });
    return;
  }

  if (method === "GET" && path === "/v1/policy") {
    requirePrincipal(plane, limiter, req, "policy:read");
    sendJson(res, 200, plane.policySnapshot);
    return;
  }

  if (method === "GET" && path === "/v1/principals") {
    requirePrincipal(plane, limiter, req, "principals:manage");
    sendJson(res, 200, { principals: plane.listPrincipals() });
    return;
  }

  if (method === "POST" && path === "/v1/principals") {
    requirePrincipal(plane, limiter, req, "principals:manage");
    const body = parseBody(issuePrincipalBodySchema, await readJson(req));
    sendJson(res, 200, plane.issuePrincipal(body.name, body.role));
    return;
  }

  if (method === "POST" && path === "/v1/enroll-tokens") {
    requirePrincipal(plane, limiter, req, "principals:manage");
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
    const content = await readBody(req);
    sendJson(res, 200, { hash: plane.blobs.putBlob(content) });
    return;
  }

  // Blobs are content-addressed by sha256; knowing the hash (which only
  // appears in capability-gated receipts/events or the issued contract) is
  // itself the read capability, so reads are not separately gated.
  const blobMatch = path.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
  if (method === "GET" && blobMatch && blobMatch[1]) {
    // TODO(brittle): blob GET is unauthenticated; hash-as-capability assumes hashes never leak via logs/errors.
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
    requirePrincipal(plane, limiter, req, "runs:read");
    sendJson(res, 200, { runs: plane.listRuns() });
    return;
  }

  if (method === "POST" && path === "/v1/runs") {
    requirePrincipal(plane, limiter, req, "runs:create");
    const body = parseBody(createRunBodySchema, await readJson(req));
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

  // TODO(brittle): run ID path segment regex may not match all issued run_* UUID formats if ID scheme changes.
  const runMatch = path.match(/^\/v1\/runs\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (runMatch && runMatch[1]) {
    const runId = runMatch[1];
    const sub = runMatch[2] ?? "";

    if (method === "POST" && sub === "/approve") {
      const principal = requirePrincipal(plane, limiter, req, "runs:approve");
      const body = parseBody(approveBodySchema, await readJson(req));
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
      const principal = requirePrincipal(plane, limiter, req, "runs:cancel");
      const body = parseBody(cancelBodySchema, await readJson(req));
      const actor = body.actor ?? { kind: "human" as const, id: principal.name };
      const record = plane.cancel(runId, actor);
      sendJson(res, 200, { runId: record.id, status: record.status });
      return;
    }

    if (method === "POST" && sub === "/events") {
      const body = parseBody(eventsBodySchema, await readJson(req));
      // TODO(brittle): events accepted as z.unknown() then cast; malformed shapes fail late inside verifyChain.
      plane.appendRunnerEvents(
        runId,
        body.claimToken,
        body.events as ChainedEvent[]
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && sub === "/complete") {
      const body = parseBody(completeBodySchema, await readJson(req));
      // TODO(brittle): receipt accepted as z.unknown(); invalid receipts fail deep in complete() with opaque errors.
      const countersigned = plane.complete(
        runId,
        body.claimToken,
        body.receipt as Receipt
      );
      sendJson(res, 200, { receipt: countersigned });
      return;
    }

    if (method === "GET" && sub === "/bundle") {
      requirePrincipal(plane, limiter, req, "runs:read");
      const bundle = plane.getBundle(runId);
      if (!bundle) {
        sendJson(res, 404, { error: "bundle not available" });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (method === "GET" && sub === "") {
      requirePrincipal(plane, limiter, req, "runs:read");
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
    requirePrincipal(plane, limiter, req, "export:read");
    const since = url.searchParams.get("since") ?? undefined;
    const jsonl = plane.exportJsonl(since);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(jsonl);
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}
