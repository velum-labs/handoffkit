import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { caCertPath, createPortlessSession, detectProxy, stateDir } from "../shared/portless.js";

const tmpRoots: string[] = [];
function freshStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "portless-state-"));
  tmpRoots.push(dir);
  process.env.PORTLESS_STATE_DIR = dir;
  return dir;
}

after(() => {
  delete process.env.PORTLESS_STATE_DIR;
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("stateDir + caCertPath honor PORTLESS_STATE_DIR", () => {
  const dir = freshStateDir();
  assert.equal(stateDir(), dir);
  assert.equal(caCertPath(), join(dir, "ca.pem"));
});

test("detectProxy returns undefined when no proxy.port file exists", async () => {
  freshStateDir();
  assert.equal(await detectProxy(), undefined);
});

test("detectProxy returns undefined for a dead proxy pid", async () => {
  const dir = freshStateDir();
  writeFileSync(join(dir, "proxy.port"), "443");
  // pid 1 is alive but won't answer a portless probe; a clearly-dead pid keeps
  // this deterministic without binding a port.
  writeFileSync(join(dir, "proxy.pid"), "999999999");
  assert.equal(await detectProxy(), undefined);
});

test("a disabled session uses loopback URLs and never registers", async () => {
  const session = await createPortlessSession({ enabled: false });
  assert.equal(session.enabled, false);
  assert.equal(session.caCertPath, undefined);
  assert.equal(session.register("scope", 4317), "http://127.0.0.1:4317");
  assert.equal(session.register("gateway", 5123), "http://127.0.0.1:5123");
  session.unregister("scope"); // no throw

  let spawned = 0;
  const result = await session.discoverOrSpawn({
    name: "router",
    identity: "gpt,sonnet",
    healthCheck: async () => "gpt,sonnet",
    spawn: async () => {
      spawned += 1;
      return { port: 6001, close: () => {} };
    }
  });
  assert.equal(spawned, 1, "a disabled session always spawns (no discovery)");
  assert.equal(result.owned, true);
  assert.equal(result.url, "http://127.0.0.1:6001");
  assert.equal(result.loopbackUrl, "http://127.0.0.1:6001");
});

test("enabled session with no reachable proxy degrades to loopback", async () => {
  freshStateDir(); // empty: no proxy.port
  const session = await createPortlessSession({ enabled: true });
  // Whether or not portless is installed, an unreachable proxy degrades to
  // loopback (never a hard failure) so a fresh install always runs.
  assert.equal(session.enabled, false, "no proxy detected -> disabled");
  assert.equal(session.register("scope", 4317), "http://127.0.0.1:4317");
});
