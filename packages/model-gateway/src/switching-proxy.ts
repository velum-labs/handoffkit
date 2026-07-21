/**
 * Stable data-plane front door whose internal router generation can be
 * replaced atomically.
 *
 * A singleton daemon keeps this listener for its whole lifetime. Reload builds
 * a complete router on an ephemeral loopback port, calls `swapTarget`, then
 * drains the old router. Requests accepted before the swap stay attached to
 * the old generation; later requests immediately use the new one.
 */
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { assertAuthenticatedBind, trimTrailingSlashes } from "@routekit/runtime";

import { authorizedRequest } from "./auth.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export type SwitchingGatewayProxy = {
  url(): string;
  port(): number;
  target(): string;
  swapTarget(target: string): string;
  waitForTargetIdle(target: string, graceMs: number): Promise<boolean>;
  drain(graceMs?: number): Promise<void>;
  close(): Promise<void>;
};

function requestHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase()) || name === "host") continue;
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else {
      result.set(name, value);
    }
  }
  return result;
}
async function requestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("proxy request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.length));
  res.end(payload);
}

async function pipe(res: ServerResponse, upstream: Response): Promise<void> {
  res.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "content-length") {
      res.setHeader(name, value);
    }
  }
  if (upstream.body === null) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && !res.write(Buffer.from(value))) {
        await Promise.race([
          new Promise<void>((resolve) => res.once("drain", resolve)),
          new Promise<void>((resolve) => res.once("close", resolve))
        ]);
        if (res.destroyed) break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

export async function startSwitchingGatewayProxy(input: {
  target: string;
  host?: string;
  port?: number;
  authToken?: string;
}): Promise<SwitchingGatewayProxy> {
  const host = input.host ?? "127.0.0.1";
  assertAuthenticatedBind(host, input.authToken);
  type TargetGeneration = {
    url: string;
    leases: number;
    waiters: Set<() => void>;
  };
  let active: TargetGeneration = {
    url: trimTrailingSlashes(input.target),
    leases: 0,
    waiters: new Set()
  };
  const generations = new Map<string, TargetGeneration>([[active.url, active]]);
  let draining = false;
  let inflight = 0;
  const server = createServer((req, res) => {
    inflight += 1;
    res.once("close", () => {
      inflight -= 1;
    });
    void (async () => {
      const path = req.url ?? "/";
      if (path.split("?")[0] === "/health") {
        writeJson(res, draining ? 503 : 200, {
          status: draining ? "draining" : "ok"
        });
        return;
      }
      if (draining) {
        writeJson(res, 503, {
          error: { message: "gateway is draining", type: "unavailable" }
        });
        return;
      }
      if (input.authToken !== undefined && !authorizedRequest(req, input.authToken)) {
        writeJson(res, 401, {
          error: { message: "unauthorized", type: "auth_error" }
        });
        return;
      }
      const selected = active;
      selected.leases += 1;
      const aborter = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) aborter.abort(new Error("gateway client disconnected"));
      };
      res.once("close", onClose);
      try {
        const body = await requestBody(req);
        const upstream = await fetch(`${selected.url}${path}`, {
          method: req.method ?? "GET",
          headers: requestHeaders(req.headers),
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.any([
            aborter.signal,
            AbortSignal.timeout(10 * 60 * 1000)
          ])
        });
        await pipe(res, upstream);
      } catch {
        if (!res.destroyed && !res.headersSent) {
          writeJson(res, 502, {
            error: { message: "router generation unavailable", type: "upstream_error" }
          });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      } finally {
        res.off("close", onClose);
        selected.leases -= 1;
        if (selected.leases === 0) {
          for (const resolve of selected.waiters) resolve();
          selected.waiters.clear();
          if (selected !== active) generations.delete(selected.url);
        }
      }
    })();
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
  let drainRun: Promise<void> | undefined;
  const drain = (graceMs = 0): Promise<void> => {
    drainRun ??= (async () => {
      draining = true;
      server.closeIdleConnections();
      const deadline = Date.now() + graceMs;
      while (inflight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    })();
    return drainRun;
  };
  return {
    url: () => `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port: () => port,
    target: () => active.url,
    swapTarget(next) {
      const previous = active.url;
      const url = trimTrailingSlashes(next);
      active = generations.get(url) ?? { url, leases: 0, waiters: new Set() };
      generations.set(url, active);
      return previous;
    },
    async waitForTargetIdle(url, graceMs) {
      const generation = generations.get(trimTrailingSlashes(url));
      if (generation === undefined || generation.leases === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<boolean>((resolve) => {
        const done = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(true);
        };
        generation.waiters.add(done);
        timer = setTimeout(() => {
          generation.waiters.delete(done);
          resolve(false);
        }, graceMs);
      });
      const result = await idle;
      if (generation !== active && generation.leases === 0) generations.delete(generation.url);
      return result;
    },
    drain,
    close: async () => await drain(0)
  };
}
