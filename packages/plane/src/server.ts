import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { PolicyDeniedError } from "@warrant/protocol";
import type { ChainedEvent, Receipt } from "@warrant/protocol";
import { Plane } from "./plane.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Static control panel assets, served from the package's ui directory. */
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
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

export type PlaneServerOptions = {
  port: number;
  /** Bind address. Defaults to loopback; use 0.0.0.0 for containers. */
  host?: string;
};

/**
 * Control-plane HTTP API plus the control panel UI. Runners connect
 * outbound to this server; no inbound connectivity to runners is ever
 * required.
 */
export function startPlaneServer(
  plane: Plane,
  options: PlaneServerOptions | number
): Promise<{ server: Server; port: number; host: string }> {
  const { port, host = "127.0.0.1" } =
    typeof options === "number" ? { port: options } : options;
  const server = createServer((req, res) => {
    handle(plane, req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PolicyDeniedError) {
        sendJson(res, 403, { error: message, code: error.code, reasons: error.reasons });
        return;
      }
      sendJson(res, 400, { error: message });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({ server, port: boundPort, host });
    });
  });
}

async function handle(
  plane: Plane,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const path = url.pathname;
  const token = bearerToken(req);

  if (method === "GET" && path === "/") {
    res.writeHead(302, { location: "/ui/" });
    res.end();
    return;
  }

  const uiEntry = UI_FILES[path];
  if (method === "GET" && uiEntry) {
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
    sendJson(res, 200, { ok: true, service: "warrant-plane" });
    return;
  }

  if (method === "POST" && path === "/v1/runners/enroll") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      enrollToken: string;
      publicKeyPem: string;
      pool: string;
    };
    sendJson(res, 200, plane.enrollRunner(body));
    return;
  }

  if (method === "GET" && path === "/v1/runners") {
    if (!plane.checkAdminToken(token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, { runners: plane.listRunners() });
    return;
  }

  if (method === "GET" && path === "/v1/policy") {
    if (!plane.checkAdminToken(token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, plane.policySnapshot);
    return;
  }

  if (method === "POST" && path === "/v1/blobs") {
    if (!plane.checkAdminToken(token) && !token) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const content = await readBody(req);
    sendJson(res, 200, { hash: plane.blobs.putBlob(content) });
    return;
  }

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
    if (!plane.checkAdminToken(token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, { runs: plane.listRuns() });
    return;
  }

  if (method === "POST" && path === "/v1/runs") {
    if (!plane.checkAdminToken(token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      dryRun?: boolean;
      request: Parameters<Plane["requestRun"]>[0];
    };
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

  if (method === "POST" && path === "/v1/claims") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      runnerToken: string;
      pool: string;
    };
    const claim = plane.claim(body);
    sendJson(res, 200, claim ?? { empty: true });
    return;
  }

  const runMatch = path.match(/^\/v1\/runs\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (runMatch && runMatch[1]) {
    const runId = runMatch[1];
    const sub = runMatch[2] ?? "";

    if (method === "POST" && sub === "/approve") {
      if (!plane.checkAdminToken(token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        actor: { kind: "human" | "service"; id: string };
      };
      const record = plane.approve(runId, body.actor);
      sendJson(res, 200, { runId: record.id, status: record.status });
      return;
    }

    if (method === "POST" && sub === "/cancel") {
      if (!plane.checkAdminToken(token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        actor: { kind: "human" | "service"; id: string };
      };
      const record = plane.cancel(runId, body.actor);
      sendJson(res, 200, { runId: record.id, status: record.status });
      return;
    }

    if (method === "POST" && sub === "/events") {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        claimToken: string;
        events: ChainedEvent[];
      };
      plane.appendRunnerEvents(runId, body.claimToken, body.events);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && sub === "/complete") {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        claimToken: string;
        receipt: Receipt;
      };
      const countersigned = plane.complete(runId, body.claimToken, body.receipt);
      sendJson(res, 200, { receipt: countersigned });
      return;
    }

    if (method === "GET" && sub === "/bundle") {
      if (!plane.checkAdminToken(token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const bundle = plane.getBundle(runId);
      if (!bundle) {
        sendJson(res, 404, { error: "bundle not available" });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (method === "GET" && sub === "") {
      if (!plane.checkAdminToken(token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
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
    if (!plane.checkAdminToken(token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const since = url.searchParams.get("since") ?? undefined;
    const jsonl = plane.exportJsonl(since);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(jsonl);
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}
