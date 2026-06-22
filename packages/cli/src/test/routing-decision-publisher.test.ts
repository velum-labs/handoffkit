import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import type { RoutingDecision } from "@fusionkit/model-gateway";

import {
  createRoutingDecisionPublisher,
  isRoutingScopePublishEnabled,
  publishRoutingDecisionToScope,
  resolveRoutingScopeIngestUrl,
  ROUTING_SCOPE_PUBLISH_ENV
} from "../fusion/routing-decision-publisher.js";

const SAMPLE_DECISION: RoutingDecision = {
  scenario: "default",
  target: { providerId: "p1", model: "gpt-4o" },
  tokenCount: 12,
  reason: "standard request",
  fallbackIndex: 0
};

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test("isRoutingScopePublishEnabled defaults on and respects opt-out", () => {
  assert.equal(isRoutingScopePublishEnabled({}), true);
  assert.equal(isRoutingScopePublishEnabled({ [ROUTING_SCOPE_PUBLISH_ENV]: "0" }), false);
  assert.equal(isRoutingScopePublishEnabled({ [ROUTING_SCOPE_PUBLISH_ENV]: "false" }), false);
  assert.equal(isRoutingScopePublishEnabled({ [ROUTING_SCOPE_PUBLISH_ENV]: "off" }), false);
  assert.equal(isRoutingScopePublishEnabled({ [ROUTING_SCOPE_PUBLISH_ENV]: "1" }), true);
});

test("resolveRoutingScopeIngestUrl uses scope port and override env", () => {
  assert.equal(resolveRoutingScopeIngestUrl({}), "http://127.0.0.1:4317/api/routing/decisions");
  assert.equal(
    resolveRoutingScopeIngestUrl({ FUSION_ROUTING_SCOPE_URL: "http://localhost:9999/" }),
    "http://localhost:9999/api/routing/decisions"
  );
});

test("publishRoutingDecisionToScope is best-effort when dashboard is down", async () => {
  assert.doesNotThrow(() =>
    publishRoutingDecisionToScope(SAMPLE_DECISION, {
      ingestUrl: "http://127.0.0.1:1/api/routing/decisions"
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("publishRoutingDecisionToScope no-ops when publishing is disabled", async () => {
  let called = false;
  const server = createServer((req, res) => {
    called = true;
    void (async () => {
      await readAll(req);
      sendJson(res, 200, { published: true });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    publishRoutingDecisionToScope(SAMPLE_DECISION, {
      ingestUrl: `http://127.0.0.1:${port}/api/routing/decisions`,
      env: { [ROUTING_SCOPE_PUBLISH_ENV]: "off" }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(called, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("createRoutingDecisionPublisher POSTs routing decisions", async () => {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      bodies.push(JSON.parse((await readAll(req)).toString("utf8")));
      sendJson(res, 200, { published: true });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    const publish = createRoutingDecisionPublisher({
      ingestUrl: `http://127.0.0.1:${port}/api/routing/decisions`
    });
    publish(SAMPLE_DECISION);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(bodies[0], SAMPLE_DECISION);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
