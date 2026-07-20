import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
      { subscriptionKind: "codex", label: "work" }
    ]);
    assert.doesNotMatch(JSON.stringify(accounts), /must-not-be-returned/);
    const removed = await client.call(
      "accounts.remove",
      { kind: "codex", label: "work" },
      { idempotencyKey: "remove-work" }
    );
    assert.equal(removed.removed, true);
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
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
      ROUTEKIT_HOME: stateHome,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_PORTLESS: "0"
    }
  } as const;
  const first = await startRouteKitDaemon(options);
  try {
    await assert.rejects(startRouteKitDaemon(options), /already running/);
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

