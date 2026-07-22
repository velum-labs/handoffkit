import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CLIPROXY_PINNED_VERSION } from "@routekit/accounts";
import { RouteKitControlClient } from "@routekit/control";
import { ControlClient, ControlError, createServiceRecordStore } from "@routekit/runtime";

import { startRouteKitDaemon } from "../index.js";

async function mockProvider(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      const send = (): void => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "daemon answer" },
                finish_reason: "stop"
              }
            ]
          })
        );
      };
      if (req.headers["x-test-slow"] === "1") setTimeout(send, 500);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () =>
      await new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("singleton daemon exposes authenticated control and a stable reloadable data plane", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(
    configPath,
    "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n"
  );
  const upstream = await mockProvider();
  const daemon = await startRouteKitDaemon({
    packageVersion: "1.2.3",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    drainGraceMs: 2_000,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_PORTLESS: "0"
    }
  });
  try {
    const record = createServiceRecordStore({
      home: stateHome,
      product: "routekit"
    }).read("daemon");
    assert.ok(record !== undefined);
    assert.equal(record.pid, process.pid);
    assert.equal(record.dataUrl, daemon.dataUrl);
    assert.equal(record.protocolVersion, "control.v1");
    assert.equal(record.generation, 1);
    assert.equal(statSync(join(stateHome, "services", "daemon.json")).mode & 0o777, 0o600);
    assert.ok(record.authTokenFile !== undefined);
    const dataToken = readFileSync(record.authTokenFile, "utf8").trim();
    assert.equal((await fetch(`${daemon.dataUrl}/v1/models`)).status, 401);

    await assert.rejects(
      new ControlClient({ url: record.url, token: "wrong" }).health()
    );
    const client = new RouteKitControlClient({
      url: record.url,
      token: record.controlToken!
    });
    const status = await client.call("daemon.status", {});
    assert.equal(status.packageVersion, "1.2.3");
    assert.equal(status.dataUrl, daemon.dataUrl);
    const models = await client.call("models.list", {});
    assert.deepEqual(models.models.map((model) => model.id), ["openai/mock-model"]);

    const beforeUrl = status.dataUrl;
    const snapshot = await client.call("config.get", {});
    await assert.rejects(
      client.call("config.update", {
        expectedRevision: snapshot.revision,
        document:
          "providers:\n  openai:\n    apiKey: must-not-enter-daemon-state\n"
      }),
      /inline credential/
    );
    const updated = await client.call(
      "config.update",
      {
        expectedRevision: snapshot.revision,
        document:
          "providers:\n  openai:\n    strategy: sticky\ndefaultModel: openai/mock-model\n"
      },
      { idempotencyKey: "config-one" }
    );
    assert.equal(updated.revision, snapshot.revision + 1);
    assert.equal((await client.call("daemon.status", {})).dataUrl, beforeUrl);
    assert.equal((await fetch(`${beforeUrl}/health`)).status, 200);

    const inflight = fetch(`${beforeUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dataToken}`,
        "x-test-slow": "1"
      },
      body: JSON.stringify({
        model: "openai/mock-model",
        messages: [{ role: "user", content: "finish during reload" }]
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reloaded = client.call("config.update", {
      expectedRevision: updated.revision,
      document:
        "providers:\n  openai:\n    strategy: round_robin\ndefaultModel: openai/mock-model\n"
    });
    const response = await inflight;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /daemon answer/);
    const afterInflight = await reloaded;
    assert.equal(afterInflight.revision, updated.revision + 1);

    await assert.rejects(
      client.call("config.update", {
        expectedRevision: snapshot.revision,
        document: "providers: {}\n"
      }),
      (error: unknown) => error instanceof ControlError && error.code === "conflict"
    );
    assert.equal((await client.call("config.get", {})).revision, afterInflight.revision);
    const concurrent = await Promise.allSettled([
      client.call("config.update", {
        expectedRevision: afterInflight.revision,
        document:
          "providers:\n  openai:\n    strategy: sticky\ndefaultModel: openai/mock-model\n"
      }),
      client.call("config.update", {
        expectedRevision: afterInflight.revision,
        document:
          "providers:\n  openai:\n    strategy: capacity_weighted\ndefaultModel: openai/mock-model\n"
      })
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal(
      concurrent.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ControlError &&
          result.reason.code === "conflict"
      ).length,
      1
    );
    assert.equal(
      (await client.call("config.get", {})).revision,
      afterInflight.revision + 1
    );

    const enrolled = await client.call(
      "accounts.enroll",
      {
        kind: "codex",
        label: "work",
        credential: {
          tokens: {
            access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
            refresh_token: "must-not-be-returned",
            account_id: "acct-work"
          }
        }
      },
      { idempotencyKey: "enroll-work" }
    );
    assert.equal(enrolled.enrolled, true);
    const accounts = await client.call("accounts.list", {});
    assert.deepEqual(accounts.accounts, [
      { subscriptionKind: "codex", label: "work", connector: "native" }
    ]);
    assert.doesNotMatch(JSON.stringify(accounts), /must-not-be-returned/);
    const removed = await client.call(
      "accounts.remove",
      { kind: "codex", label: "work" },
      { idempotencyKey: "remove-work" }
    );
    assert.equal(removed.removed, true);
    await assert.rejects(
      client.call(
        "accounts.remove",
        { kind: "github", label: "work" },
        { idempotencyKey: "remove-unknown" }
      ),
      (error: unknown) =>
        error instanceof ControlError && /unknown subscription kind/.test(error.message)
    );
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await predicate();
}

test("daemon owns the cliproxy sidecar: spawn, restart, account routing, shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-cliproxy-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(configPath, "providers:\n  cliproxy: {}\ndefaultModel: cliproxy/g-model\n");
  const cliproxyDirectory = join(stateHome, "cliproxy");
  const authDirectory = join(cliproxyDirectory, "auth");
  const markerPath = join(root, "sidecar-pids.log");
  const port = await freePort();
  // Managed sidecar config: RouteKit-owned ingress key and listen port.
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(cliproxyDirectory, "config.yaml"),
    [
      'host: "127.0.0.1"',
      `port: ${port}`,
      `auth-dir: "${authDirectory}"`,
      "api-keys:",
      '  - "rk-test-ingress-key"',
      ""
    ].join("\n")
  );
  writeFileSync(
    join(authDirectory, "antigravity-user@example.com.json"),
    JSON.stringify({ type: "antigravity" })
  );
  // Fake pinned binary: records its pid and serves /v1/models on the
  // configured port so discovery and reachability run against it.
  const binary = join(cliproxyDirectory, "bin", CLIPROXY_PINNED_VERSION, "cli-proxy-api");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const http = require("node:http");',
      'const cfg = fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8");',
      "const port = Number(/port:\\s*(\\d+)/.exec(cfg)[1]);",
      // Record the pid only after the listener is accepting so crash-recovery
      // waiters do not race the bind.
      "http.createServer((req, res) => {",
      '  res.setHeader("content-type", "application/json");',
      '  res.end(JSON.stringify({ data: [{ id: "g-model", object: "model" }] }));',
      '}).listen(port, "127.0.0.1", () => {',
      `  fs.appendFileSync(${JSON.stringify(markerPath)}, process.pid + "\\n");`,
      "});",
      ""
    ].join("\n")
  );
  chmodSync(binary, 0o755);
  const daemon = await startRouteKitDaemon({
    packageVersion: "1.2.3",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    drainGraceMs: 2_000,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      ROUTEKIT_PORTLESS: "0",
      ROUTEKIT_CLIPROXY_API_KEY: undefined,
      ROUTEKIT_CLIPROXY_BASE_URL: undefined
    }
  });
  let firstPid = 0;
  try {
    const record = createServiceRecordStore({
      home: stateHome,
      product: "routekit"
    }).read("daemon");
    assert.ok(record?.controlToken !== undefined);
    const client = new RouteKitControlClient({
      url: record.url,
      token: record.controlToken
    });

    // The daemon spawned the sidecar and the router discovers through it
    // with the injected managed ingress key + base URL.
    const pids = readFileSync(markerPath, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 1);
    firstPid = pids[0]!;
    assert.ok(processAlive(firstPid));
    const models = await client.call("models.list", {});
    assert.deepEqual(models.models.map((model) => model.id), ["cliproxy/g-model"]);

    // One unified account surface: the cliproxy store shows up beside native
    // accounts with its connector and a live relay.
    const status = await client.call("accounts.status", {});
    assert.deepEqual(status.accounts, [
      {
        subscriptionKind: "gemini",
        label: "antigravity-user@example.com",
        connector: "cliproxy",
        localOnly: true,
        credentialValid: true,
        configured: true,
        relayOpen: true,
        active: true,
        models: []
      }
    ]);

    // Crash recovery: kill the sidecar; the daemon respawns it.
    process.kill(firstPid, "SIGKILL");
    assert.ok(
      await waitFor(() => {
        const seen = readFileSync(markerPath, "utf8").trim().split("\n");
        return seen.length === 2;
      }, 10_000),
      "sidecar was not respawned after a crash"
    );
    // Wait until the respawned listener answers discovery before mutating.
    assert.ok(
      await waitFor(async () => {
        try {
          const listed = await client.call("models.list", {});
          return listed.models.some((model) => model.id === "cliproxy/g-model");
        } catch {
          return false;
        }
      }, 10_000),
      "respawned sidecar did not become discoverable"
    );

    // accounts.sync rescans the store; accounts.remove routes by connector.
    const synced = await client.call("accounts.sync", {}, { idempotencyKey: "sync-1" });
    assert.equal(synced.synced, true);
    // Legacy cliproxy claude auth files list under the raw type but remove
    // through the native kind alias (`claude` → `claude-code`).
    writeFileSync(
      join(authDirectory, "legacy-claude@example.com.json"),
      JSON.stringify({ type: "claude" })
    );
    const orphanRemoved = await client.call(
      "accounts.remove",
      { kind: "claude-code", label: "legacy-claude@example.com" },
      { idempotencyKey: "remove-legacy-claude" }
    );
    assert.equal(orphanRemoved.removed, true);
    assert.equal(existsSync(join(authDirectory, "legacy-claude@example.com.json")), false);
    const removed = await client.call(
      "accounts.remove",
      { kind: "gemini", label: "antigravity-user@example.com" },
      { idempotencyKey: "remove-gemini" }
    );
    assert.equal(removed.removed, true);
    assert.equal(
      existsSync(join(authDirectory, "antigravity-user@example.com.json")),
      false
    );
  } finally {
    await daemon.close();
  }
  const survivors = readFileSync(markerPath, "utf8")
    .trim()
    .split("\n")
    .map(Number)
    .filter(processAlive);
  for (const pid of survivors) process.kill(pid, "SIGKILL");
  assert.deepEqual(survivors, [], "daemon shutdown must stop the managed sidecar");
  rmSync(root, { recursive: true, force: true });
});

test("second daemon cannot claim authority and generations remain monotonic", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-singleton-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(
    configPath,
    "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n"
  );
  const upstream = await mockProvider();
  const options = {
    packageVersion: "1.0.0",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_PORTLESS: "0"
    }
  } as const;
  const first = await startRouteKitDaemon(options);
  try {
    await assert.rejects(
      startRouteKitDaemon(options),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /already running/);
        assert.equal(
          JSON.stringify(error).includes(first.record.controlToken ?? "impossible-token"),
          false,
          "singleton conflicts must not disclose the control credential"
        );
        return true;
      }
    );
    assert.equal(first.record.generation, 1);
  } finally {
    await first.close();
  }
  const second = await startRouteKitDaemon(options);
  try {
    assert.equal(second.record.generation, 2);
  } finally {
    await second.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
