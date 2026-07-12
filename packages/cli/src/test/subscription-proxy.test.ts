import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  discoverProxy,
  registerRunningProxy,
  stopProxy
} from "../fusion/subscription-proxy.js";

const tmpRoots: string[] = [];
function freshStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fk-proxy-state-"));
  tmpRoots.push(dir);
  process.env.FUSIONKIT_SUBSCRIPTIONS_DIR = dir;
  return dir;
}

after(() => {
  delete process.env.FUSIONKIT_SUBSCRIPTIONS_DIR;
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("register -> discover -> release round-trips the proxy record", async () => {
  const dir = freshStateDir();
  // Disable portless so the test exercises the pure loopback-fallback lifecycle.
  const registration = await registerRunningProxy({
    loopbackUrl: "http://127.0.0.1:8790",
    port: 8790,
    token: "secret-token",
    portless: false
  });
  assert.equal(registration.url, "http://127.0.0.1:8790");

  const discovered = discoverProxy();
  assert.ok(discovered);
  assert.equal(discovered.token, "secret-token");
  assert.equal(discovered.pid, process.pid);
  assert.ok(existsSync(join(dir, "proxy.json")));

  await registration.release();
  assert.equal(discoverProxy(), undefined);
  assert.equal(existsSync(join(dir, "proxy.json")), false);
});

test("discoverProxy clears a stale record whose owner is gone", () => {
  const dir = freshStateDir();
  // Craft a record with a pid that cannot be alive; discover must treat it as
  // stale and remove it (registerRunningProxy always uses process.pid).
  const proxyJson = join(dir, "proxy.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    proxyJson,
    JSON.stringify({
      token: "x",
      pid: 999_999_999,
      url: "http://127.0.0.1:8790",
      port: 8790,
      startedAt: new Date().toISOString()
    })
  );
  assert.equal(discoverProxy(), undefined);
  assert.equal(existsSync(proxyJson), false);
});

test("stopProxy on no running proxy reports not stopped", async () => {
  freshStateDir();
  const result = await stopProxy();
  assert.equal(result.stopped, false);
});
