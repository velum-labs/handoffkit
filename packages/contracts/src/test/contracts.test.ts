import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalize,
  hashCanonical,
  requestHash,
  responseHash
} from "../index.js";
import type {
  CapabilityStatus,
  HarnessEvent,
  ModelCallContract,
  ModelEndpoint,
  ProviderError
} from "../index.js";

test("canonical hashing is stable across object insertion order", () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashCanonical({ b: 2, a: 1 }), hashCanonical({ a: 1, b: 2 }));
  assert.equal(requestHash({ b: 2, a: 1 }), responseHash({ a: 1, b: 2 }));
});

test("neutral model and harness contracts compose without product types", () => {
  const capability: CapabilityStatus = "supported";
  const endpoint: ModelEndpoint = {
    endpointId: "primary",
    model: "model-a",
    capabilities: { tools: capability }
  };
  const error: ProviderError = { kind: "rate_limited", retryable: true };
  const call: ModelCallContract = {
    call_id: "call-1",
    endpoint_id: endpoint.endpointId,
    model: endpoint.model,
    request_hash: requestHash({ prompt: "hello" }),
    messages: [{ role: "user", content: "hello" }],
    status: "failed",
    side_effects: "none",
    started_at: "2026-07-15T00:00:00.000Z",
    error
  };
  const event: HarnessEvent<"generic"> = {
    kind: "generic",
    sessionId: "session-1",
    at: "2026-07-15T00:00:00.000Z",
    type: "turn.failed",
    errorCode: error.kind,
    message: "retry"
  };

  assert.equal(call.endpoint_id, endpoint.endpointId);
  assert.equal(event.errorCode, "rate_limited");
});
