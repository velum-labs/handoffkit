import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { connect as netConnect } from "node:net";

export type EgressEvent = {
  host: string;
  decision: "allowed" | "blocked";
};

export type EgressProxy = {
  port: number;
  close(): Promise<void>;
};

/**
 * Deny-by-default egress proxy for agent sessions. The session environment
 * points HTTP(S)_PROXY at this proxy; CONNECT tunnels and absolute-form HTTP
 * requests are allowed only for allowlisted hosts, and every decision is
 * reported as a network event.
 *
 * Honest limitation (documented in the spec): this is process-level
 * enforcement. A malicious binary can ignore proxy variables; container or
 * microVM network namespaces close that gap and are the roadmap isolation
 * modes. Every allowed and blocked attempt is still recorded.
 */
export function startEgressProxy(
  allowHosts: string[],
  defaultDeny: boolean,
  onEvent: (event: EgressEvent) => void
): Promise<EgressProxy> {
  const allowed = new Set(allowHosts);
  const isAllowed = (host: string): boolean =>
    !defaultDeny || allowed.has(host);

  const server: Server = createServer((req, res) => {
    let host = "";
    try {
      host = new URL(req.url ?? "").hostname;
    } catch {
      res.writeHead(400);
      res.end("proxy requires absolute-form URLs");
      return;
    }
    if (!isAllowed(host)) {
      onEvent({ host, decision: "blocked" });
      res.writeHead(403);
      res.end("blocked by warrant egress policy");
      return;
    }
    onEvent({ host, decision: "allowed" });
    const target = new URL(req.url ?? "");
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end("upstream error");
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, socket) => {
    const [host, portRaw] = (req.url ?? "").split(":");
    const port = Number(portRaw || "443");
    if (!host || !isAllowed(host)) {
      onEvent({ host: host ?? "unknown", decision: "blocked" });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    onEvent({ host, decision: "allowed" });
    const upstream = netConnect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          })
      });
    });
  });
}
