import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  snapshotsToUsage,
  startSubscriptionProxy,
  subscriptionUsageResponseSchema,
  SubscriptionProxyClient,
  SubscriptionProxyClientError,
  type SubscriptionAccountSetSnapshot
} from "../index.js";

const FUTURE_EXPIRY_MS = Date.now() + 3_600_000;

function claudeAccountDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "routekit-sdk-"));
  writeFileSync(
    join(directory, "primary.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "oauth-primary", expiresAt: FUTURE_EXPIRY_MS }
    })
  );
  return directory;
}

test("startSubscriptionProxy serves a typed client over the usage wire contract", async () => {
  const directory = claudeAccountDir();
  const proxy = await startSubscriptionProxy({
    accounts: { "claude-code": { source: { kind: "directory", path: directory } } },
    host: "127.0.0.1",
    port: 0,
    token: "proxy-secret"
  });
  try {
    assert.deepEqual([...proxy.providers], ["anthropic"]);

    const client = SubscriptionProxyClient.open({ baseUrl: proxy.url(), token: "proxy-secret" });
    assert.equal(await client.health(), true);

    const usage = await client.usage();
    assert.equal(usage.accountSets.length, 1);
    assert.equal(usage.accountSets[0]?.mode, "claude-code");
    assert.equal(usage.accountSets[0]?.members.length, 1);
    assert.equal(usage.accountSets[0]?.members[0]?.label, "primary");

    // The in-process snapshot and the over-the-wire response agree.
    assert.deepEqual(proxy.usage(), usage);

    // The wrong ingress token is rejected before any account is touched.
    const unauthorized = SubscriptionProxyClient.open({ baseUrl: proxy.url(), token: "wrong" });
    await assert.rejects(
      () => unauthorized.usage(),
      (error: unknown) => error instanceof SubscriptionProxyClientError && error.status === 401
    );
  } finally {
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startSubscriptionProxy fails fast when no account is available", async () => {
  const empty = mkdtempSync(join(tmpdir(), "routekit-sdk-empty-"));
  try {
    await assert.rejects(() =>
      startSubscriptionProxy({
        accounts: { "claude-code": { source: { kind: "directory", path: empty } } },
        port: 0
      })
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the usage wire schema round-trips an account-set snapshot", () => {
  const snapshot: SubscriptionAccountSetSnapshot = {
    mode: "codex",
    strategy: "capacity_weighted",
    switchThreshold: 0.9,
    members: [
      {
        id: "work",
        mode: "codex",
        label: "work",
        sourcePath: "/tmp/work.json",
        active: true,
        limits: {
          windows: { "codex:primary": { utilization: 0.4, resetsAt: 1_777_000_000 } },
          observedAt: 1_776_000_000,
          source: "headers"
        }
      }
    ]
  };
  const parsed = subscriptionUsageResponseSchema.parse(snapshotsToUsage([snapshot, undefined]));
  assert.deepEqual(parsed.accountSets, [snapshot]);
});
