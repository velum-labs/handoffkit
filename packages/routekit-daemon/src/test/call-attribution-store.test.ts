import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCallRecord } from "@routekit/gateway";

import {
  CallAttributionStore,
  callInspection
} from "../call-attribution-store.js";

function modelCall(callId: string, label = "work"): ModelCallRecord {
  return {
    call_id: callId,
    endpoint_id: "codex/gpt-5.3-codex",
    model: "codex/gpt-5.3-codex",
    request_hash: "sha256:request",
    response_hash: "sha256:response",
    messages: [{ role: "user", content: "sha256:message" }],
    status: "succeeded",
    side_effects: "none",
    started_at: "2026-07-22T00:00:00.000Z",
    finished_at: "2026-07-22T00:00:01.000Z",
    latency_ms: 1_000,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    },
    metadata: {
      attribution: {
        effective_model: "codex/gpt-5.3-codex",
        native_model: "gpt-5.3-codex",
        provider: "codex",
        billing_mode: "subscription",
        account: { label },
        attempts: 3,
        retries: 2,
        account_failovers: 1
      },
      unknown_usage: false,
      unknown_cost: false,
      cost_estimate_usd: 0.001,
      credential: "must-not-be-returned",
      source_path: "/secret/account.json"
    }
  };
}

test("call inspection exposes attribution while dropping sensitive metadata", () => {
  const inspection = callInspection(modelCall("model_call_safe"));
  assert.ok(inspection);
  assert.equal(inspection.effectiveModel, "codex/gpt-5.3-codex");
  assert.equal(inspection.account?.label, "work");
  assert.deepEqual(inspection.retries, {
    attempts: 3,
    total: 2,
    accountFailovers: 1
  });
  assert.equal(inspection.cost.estimateUsd, 0.001);
  assert.doesNotMatch(JSON.stringify(inspection), /must-not-be-returned/);
  assert.doesNotMatch(JSON.stringify(inspection), /secret\/account/);
  assert.equal("messages" in inspection, false);
});

test("call attribution store evicts by capacity and expiry", () => {
  let now = 0;
  const store = new CallAttributionStore({
    limit: 2,
    ttlMs: 100,
    now: () => now
  });
  store.onModelCall(modelCall("call_1"));
  now = 10;
  store.onModelCall(modelCall("call_2"));
  now = 20;
  store.onModelCall(modelCall("call_3"));
  assert.equal(store.get("call_1"), undefined);
  assert.ok(store.get("call_2"));
  now = 111;
  assert.equal(store.get("call_2"), undefined);
  assert.ok(store.get("call_3"));
});
