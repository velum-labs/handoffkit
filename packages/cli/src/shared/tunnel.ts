/**
 * Public-tunnel provisioning for flows whose client cannot reach loopback.
 *
 * Cursor's BYOK ("Override OpenAI Base URL") requests are proxied through
 * Cursor's backend, which blocks private addresses (`ssrf_blocked`), so a
 * local gateway must be reachable over public HTTPS. This helper makes that
 * turnkey: it starts a Cloudflare Quick Tunnel (via `untun`, no account
 * needed) in front of the gateway and verifies the public URL actually routes
 * before handing it out — freshly minted trycloudflare.com hostnames can take
 * a few seconds to propagate.
 *
 * A quick tunnel URL is public (random hostname, no auth of its own), so
 * callers must always pair it with a gateway bearer token; use
 * {@link generateSessionToken} when the user did not configure one.
 */

import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";

import { startTunnel } from "untun";
import type { Tunnel, TunnelOptions } from "untun";

export type PublicTunnel = {
  /** The public HTTPS base URL (no trailing slash). */
  url: string;
  close: () => Promise<void>;
};

export type StartPublicTunnelOptions = {
  /** The loopback gateway URL to expose, e.g. `http://127.0.0.1:8787`. */
  gatewayUrl: string;
  log?: (line: string) => void;
  /** Max time to wait for the tunnel URL to become publicly routable. */
  timeoutMs?: number;
  /** Injectable tunnel starter (tests). Defaults to untun's `startTunnel`. */
  start?: (options: TunnelOptions) => Promise<Tunnel | undefined>;
  /** Injectable readiness probe (tests). Defaults to an HTTP GET. */
  probe?: (url: string) => Promise<boolean>;
};

/** A per-session gateway bearer token for tunnel-exposed gateways. */
export function generateSessionToken(): string {
  return `fk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Resolve a hostname via DNS-over-HTTPS (1.1.1.1). Freshly minted
 * trycloudflare.com hostnames are often NXDOMAIN-cached by local resolvers
 * for minutes after the tunnel is already reachable from the internet (which
 * is where Cursor's backend connects from), so the readiness probe must not
 * depend on local DNS.
 */
async function resolveOverDoh(hostname: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
      headers: { accept: "application/dns-json" }
    });
    const data = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
    return data.Answer?.find((answer) => answer.type === 1)?.data;
  } catch {
    return undefined;
  }
}

/** HTTPS GET against a specific IP with the tunnel hostname as SNI/Host. */
function probeIp(ip: string, hostname: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: ip, servername: hostname, path, headers: { host: hostname }, timeout: 10_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
    req.end();
  });
}

async function httpProbe(url: string): Promise<boolean> {
  // Cloudflare returns 530 (error 1033) while the quick tunnel's hostname is
  // still propagating; anything below that means our gateway answered.
  try {
    const response = await fetch(url, { redirect: "manual" });
    return response.status < 500;
  } catch {
    // Local DNS may still NXDOMAIN the fresh hostname; verify from the
    // internet's point of view via DoH + a direct-IP request instead.
  }
  const parsed = new URL(url);
  const ip = await resolveOverDoh(parsed.hostname);
  if (ip === undefined) return false;
  try {
    return (await probeIp(ip, parsed.hostname, `${parsed.pathname}${parsed.search}`)) < 500;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start a Cloudflare Quick Tunnel in front of `gatewayUrl` and resolve once
 * the public URL responds. Throws (after closing the tunnel) when the tunnel
 * cannot start or never becomes routable; callers decide whether that is
 * fatal or degrades to manual-tunnel instructions.
 */
export async function startPublicTunnel(options: StartPublicTunnelOptions): Promise<PublicTunnel> {
  const log = options.log ?? ((): void => undefined);
  // Edge propagation of a fresh trycloudflare.com hostname is usually ~20s
  // but can take considerably longer; be generous before declaring failure.
  const timeoutMs = options.timeoutMs ?? 90_000;
  const start = options.start ?? startTunnel;
  const probe = options.probe ?? httpProbe;

  log(`fusion: starting public tunnel to ${options.gatewayUrl} (Cloudflare Quick Tunnel)...`);
  const tunnel = await start({ url: options.gatewayUrl, acceptCloudflareNotice: true });
  if (tunnel === undefined) {
    throw new Error("public tunnel did not start (cloudflared unavailable)");
  }
  try {
    const url = (await tunnel.getURL()).replace(/\/+$/, "");
    // Verify the hostname actually routes to our gateway before printing it:
    // handing out a URL that 530s would look like a broken product.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe(`${url}/health`)) break;
      if (Date.now() >= deadline) {
        throw new Error(`public tunnel ${url} did not become reachable within ${timeoutMs}ms`);
      }
      await sleep(500);
    }
    log(`fusion: public tunnel ready at ${url}`);
    return { url, close: () => tunnel.close() };
  } catch (error) {
    try {
      await tunnel.close();
    } catch {
      // best-effort teardown of a tunnel we could not verify
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
