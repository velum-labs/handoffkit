import assert from "node:assert/strict";
import { test } from "node:test";

import { subscriptionProvider } from "../index.js";
import { codexModelsSearch } from "../provider.js";

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
  assert.deepEqual(Object.keys(limits?.windows ?? {}), [
    "five_hour",
    "seven_day_sonnet"
  ]);
  assert.equal(limits?.windows.five_hour?.utilization, 0.42);
  assert.equal(limits?.windows.five_hour?.resetsAt, 1774933200);
  assert.equal(limits?.windows.seven_day_sonnet?.status, "rejected");
  assert.equal(limits?.windows.seven_day_sonnet?.utilization, 1);
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

  const response = provider.parseLimits(new Headers(), {
    rate_limit: {
      primary_window: { used_percent: 20, reset_at: 1774933300 }
    }
  });
  assert.equal(response?.source, "response");
  assert.equal(response?.completeness, "partial");
  assert.equal(response?.windows.primary?.source, "response");
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

test("Codex model discovery supplies the required client version query", () => {
  assert.equal(codexModelsSearch("", "0.144.5"), "?client_version=0.144.5");
  assert.equal(
    codexModelsSearch("?include_hidden=true", "0.144.5"),
    "?include_hidden=true&client_version=0.144.5"
  );
  assert.equal(
    codexModelsSearch("?client_version=0.142.5", "0.144.5"),
    "?client_version=0.142.5"
  );
});

test("subscription adapters discover native models with member credentials", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return url.includes("anthropic")
      ? Response.json({ data: [{ id: "claude-opus-4-1" }] })
      : Response.json({
          models: [
            {
              slug: "gpt-5.5",
              supported_reasoning_levels: ["quick", "deep"],
              default_reasoning_level: "deep"
            }
          ]
        });
  };
  try {
    const claude = await subscriptionProvider("claude-code").discoverModels({
      mode: "claude-code",
      accessToken: "claude-token",
      sourcePath: "/tmp/claude.json"
    });
    const codex = await subscriptionProvider("codex").discoverModels({
      mode: "codex",
      accessToken: "codex-token",
      accountId: "acct",
      sourcePath: "/tmp/codex.json"
    });
    assert.deepEqual(claude, [{ id: "claude-opus-4-1" }]);
    assert.equal(typeof codex[0] === "string" ? codex[0] : codex[0]?.id, "gpt-5.5");
    assert.deepEqual(
      typeof codex[0] === "string" ? undefined : codex[0]?.reasoning?.efforts,
      [{ id: "quick" }, { id: "deep" }]
    );
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer claude-token");
    assert.equal(requests[0]?.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(requests[1]?.headers.get("authorization"), "Bearer codex-token");
    assert.equal(requests[1]?.headers.get("chatgpt-account-id"), "acct");
    assert.equal(requests[1]?.headers.get("originator"), "routekit");
    assert.match(requests[1]?.url ?? "", /[?&]client_version=[^&]+/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
