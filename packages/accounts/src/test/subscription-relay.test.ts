import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startGateway } from "@routekit/gateway";
import {
  AnthropicBackendRelay,
  RelayOnlyBackend,
  SubscriptionAccountSet,
  snapshotsToUsage,
  subscriptionProvider
} from "../index.js";

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test("Anthropic relay strips ingress auth and transparently rotates pooled credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-anthropic-pool-"));
  const expiresAt = Date.now() + 3_600_000;
  writeFileSync(
    join(directory, "a.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "oauth-a",
        refreshToken: "refresh-a",
        expiresAt
      }
    })
  );
  writeFileSync(
    join(directory, "b.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "oauth-b",
        refreshToken: "refresh-b",
        expiresAt
      }
    })
  );

  const seen: Array<{ authorization?: string; beta?: string; body: unknown }> = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      if (req.method === "GET" && req.url?.startsWith("/v1/models") === true) {
        seen.push({
          ...(authorization !== undefined ? { authorization } : {}),
          ...(typeof req.headers["anthropic-beta"] === "string"
            ? { beta: req.headers["anthropic-beta"] }
            : {}),
          body: null
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-5", type: "model" }] }));
        return;
      }
      seen.push({
        ...(authorization !== undefined ? { authorization } : {}),
        ...(typeof req.headers["anthropic-beta"] === "string"
          ? { beta: req.headers["anthropic-beta"] }
          : {}),
        body: JSON.parse(await body(req))
      });
      if (authorization === "Bearer oauth-a") {
        res.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600)
        });
        res.end(JSON.stringify({ error: { message: "five hour limit reached" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_pool",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "POOLED_OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      );
    })().catch((error: unknown) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(typeof address === "object" && address !== null);

  const accounts = await SubscriptionAccountSet.open(subscriptionProvider("claude-code"), {
    mode: "claude-code",
    source: { kind: "directory", path: directory }
  });
  const relay = new AnthropicBackendRelay({
    accounts,
    backendUrl: `http://127.0.0.1:${address.port}`
  });
  const gateway = await startGateway({
    backend: new RelayOnlyBackend(),
    authToken: "proxy-secret",
    providerRelays: { anthropic: relay },
    usage: () => snapshotsToUsage([relay.snapshot()])
  });

  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-secret",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { content: Array<{ text: string }> };
    assert.equal(payload.content[0]?.text, "POOLED_OK");
    assert.deepEqual(
      seen.map((request) => request.authorization),
      ["Bearer oauth-a", "Bearer oauth-b"]
    );
    assert.ok(seen.every((request) => request.beta === "oauth-2025-04-20"));

    const models = await fetch(`${gateway.url()}/v1/models`, {
      headers: {
        authorization: "Bearer proxy-secret",
        "anthropic-version": "2023-06-01"
      }
    });
    assert.equal(models.status, 200);
    const catalog = (await models.json()) as { data: Array<{ id: string }> };
    assert.equal(catalog.data[0]?.id, "claude-sonnet-4-5");
    assert.equal(seen[2]?.authorization, "Bearer oauth-b");

    const usage = await fetch(`${gateway.url()}/usage`, {
      headers: { authorization: "Bearer proxy-secret" }
    });
    const status = (await usage.json()) as {
      accountSets: Array<{ members: Array<{ id: string; coolingUntil?: number }> }>;
    };
    assert.ok(
      status.accountSets[0]?.members.find((member) => member.id === "a")?.coolingUntil
    );
  } finally {
    await gateway.close();
    await closeServer(upstream);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an exhausted account set surfaces a 429 with retry-after, not a 502", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-exhausted-pool-"));
  writeFileSync(
    join(directory, "only.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "oauth-only", expiresAt: Date.now() + 3_600_000 }
    })
  );
  const resetAt = Math.floor(Date.now() / 1000) + 1800;
  const upstream = createServer((_req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-utilization": "1",
      "anthropic-ratelimit-unified-7d-reset": String(resetAt)
    });
    res.end(JSON.stringify({ error: { message: "weekly limit reached" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(typeof address === "object" && address !== null);

  const accounts = await SubscriptionAccountSet.open(subscriptionProvider("claude-code"), {
    mode: "claude-code",
    source: { kind: "directory", path: directory }
  });
  const gateway = await startGateway({
    backend: new RelayOnlyBackend(),
    authToken: "proxy-secret",
    providerRelays: {
      anthropic: new AnthropicBackendRelay({
        accounts,
        backendUrl: `http://127.0.0.1:${address.port}`
      })
    }
  });

  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-secret",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    const payload = (await response.json()) as { error: { type: string; resets_at?: number } };
    assert.equal(payload.error.type, "rate_limit_error");
    assert.equal(payload.error.resets_at, resetAt);
  } finally {
    await gateway.close();
    await closeServer(upstream);
    rmSync(directory, { recursive: true, force: true });
  }
});
