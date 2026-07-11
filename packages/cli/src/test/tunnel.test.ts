import assert from "node:assert/strict";
import { test } from "node:test";

import { generateSessionToken, startPublicTunnel } from "../shared/tunnel.js";
import type { Tunnel } from "untun";

function fakeTunnel(url: string): { tunnel: Tunnel; closed: () => boolean } {
  let closed = false;
  return {
    tunnel: {
      getURL: async () => url,
      close: async () => {
        closed = true;
      }
    },
    closed: () => closed
  };
}

test("generateSessionToken yields unique url-safe bearer tokens", () => {
  const first = generateSessionToken();
  const second = generateSessionToken();
  assert.notEqual(first, second);
  assert.match(first, /^fk_[A-Za-z0-9_-]+$/);
  assert.ok(first.length >= 20, "token must be long enough to be unguessable");
});

test("startPublicTunnel returns the trimmed public URL once the probe passes", async () => {
  const { tunnel } = fakeTunnel("https://demo.trycloudflare.com/");
  const probed: string[] = [];
  const result = await startPublicTunnel({
    gatewayUrl: "http://127.0.0.1:8787",
    start: async (options) => {
      assert.equal(options.url, "http://127.0.0.1:8787");
      assert.equal(options.acceptCloudflareNotice, true);
      return tunnel;
    },
    probe: async (url) => {
      probed.push(url);
      return true;
    }
  });
  assert.equal(result.url, "https://demo.trycloudflare.com");
  assert.deepEqual(probed, ["https://demo.trycloudflare.com/health"]);
});

test("startPublicTunnel retries the probe until the hostname routes", async () => {
  const { tunnel } = fakeTunnel("https://slow.trycloudflare.com");
  let attempts = 0;
  const result = await startPublicTunnel({
    gatewayUrl: "http://127.0.0.1:1",
    start: async () => tunnel,
    probe: async () => {
      attempts += 1;
      return attempts >= 3;
    }
  });
  assert.equal(result.url, "https://slow.trycloudflare.com");
  assert.equal(attempts, 3);
});

test("startPublicTunnel closes the tunnel and throws when it never becomes reachable", async () => {
  const { tunnel, closed } = fakeTunnel("https://dead.trycloudflare.com");
  await assert.rejects(
    startPublicTunnel({
      gatewayUrl: "http://127.0.0.1:1",
      timeoutMs: 0,
      start: async () => tunnel,
      probe: async () => false
    }),
    /did not become reachable/
  );
  assert.equal(closed(), true, "an unreachable tunnel must be torn down");
});

test("startPublicTunnel throws when cloudflared cannot start", async () => {
  await assert.rejects(
    startPublicTunnel({
      gatewayUrl: "http://127.0.0.1:1",
      start: async () => undefined
    }),
    /did not start/
  );
});

test("startPublicTunnel close propagates to the underlying tunnel", async () => {
  const { tunnel, closed } = fakeTunnel("https://ok.trycloudflare.com");
  const result = await startPublicTunnel({
    gatewayUrl: "http://127.0.0.1:1",
    start: async () => tunnel,
    probe: async () => true
  });
  await result.close();
  assert.equal(closed(), true);
});
