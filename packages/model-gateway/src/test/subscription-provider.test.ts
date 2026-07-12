import assert from "node:assert/strict";
import { test } from "node:test";

import { subscriptionProvider } from "../subscriptions/index.js";

test("Anthropic adapter parses first-party unified subscription windows", () => {
  const provider = subscriptionProvider("claude-code");
  const limits = provider.parseLimits(
    new Headers({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1774933200",
      "anthropic-ratelimit-unified-7d-sonnet-status": "rejected",
      "anthropic-ratelimit-unified-7d-sonnet-utilization": "1",
      "anthropic-ratelimit-unified-7d-sonnet-reset": "1775000000"
    })
  );
  assert.equal(limits?.windows["5h"]?.utilization, 0.42);
  assert.equal(limits?.windows["5h"]?.resetsAt, 1774933200);
  assert.equal(limits?.windows["7d-sonnet"]?.status, "rejected");
  assert.equal(limits?.windows["7d-sonnet"]?.utilization, 1);
});

test("Anthropic adapter distinguishes quota rejection from a short throttle", () => {
  const provider = subscriptionProvider("claude-code");
  const quota = provider.classify(
    429,
    new Headers({
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-utilization": "1",
      "anthropic-ratelimit-unified-7d-reset": "1775000000"
    }),
    { error: { message: "weekly limit reached" } }
  );
  assert.equal(quota?.category, "quota_exhausted");
  assert.equal(quota?.resetsAt, 1775000000);

  const throttle = provider.classify(
    429,
    new Headers({ "retry-after": "2" }),
    { error: { message: "temporarily rate limited" } }
  );
  assert.equal(throttle?.category, "transient");
  assert.equal(throttle?.retryAfter, 2);
});

test("Codex adapter parses dynamic limit headers and stream rate-limit events", () => {
  const provider = subscriptionProvider("codex");
  const headers = provider.parseLimits(
    new Headers({
      "x-codex-active-limit": "codex_other",
      "x-codex-other-primary-used-percent": "35",
      "x-codex-other-primary-window-minutes": "300",
      "x-codex-other-primary-reset-at": "1774933200",
      "x-codex-other-limit-name": "gpt-5.3-codex",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-balance": "$12.00"
    })
  );
  assert.equal(headers?.windows["codex_other:primary"]?.utilization, 0.35);
  assert.equal(headers?.windows["codex_other:primary"]?.windowSeconds, 18_000);
  assert.equal(headers?.windows["codex_other:primary"]?.limitName, "gpt-5.3-codex");
  assert.equal(headers?.credits?.balance, "$12.00");

  const stream = provider.parseStreamEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 50, reset_at: 1774933300 },
        secondary: { used_percent: 10, reset_at: 1775000000 }
      }
    }
  });
  assert.equal(stream?.windows.primary?.utilization, 0.5);
  assert.equal(stream?.windows.secondary?.utilization, 0.1);
});

test("Codex adapter recognizes usage_limit_reached as quota exhaustion", () => {
  const failure = subscriptionProvider("codex").classify(
    429,
    new Headers(),
    {
      error: {
        error_type: "usage_limit_reached",
        message: "weekly usage limit reached",
        resets_at: 1775000000
      }
    }
  );
  assert.equal(failure?.category, "quota_exhausted");
  assert.equal(failure?.resetsAt, 1775000000);
});
