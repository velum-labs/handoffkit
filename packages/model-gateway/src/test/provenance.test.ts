import assert from "node:assert/strict";
import { test } from "node:test";

import { buildModelCallRecord } from "../provenance.js";
import { readProducerVersion, resolveProducerGitSha, UNKNOWN_GIT_SHA } from "../provenance.js";

const GIT_SHA = /^[a-f0-9]{40}$/;

test("WS7: resolveProducerGitSha returns a real 40-hex SHA from a source checkout", () => {
  const previous = process.env.ROUTEKIT_BUILD_GIT_SHA;
  delete process.env.ROUTEKIT_BUILD_GIT_SHA;
  try {
    // The test runs from the handoffkit checkout (not node_modules), so the
    // runtime `git rev-parse HEAD` fallback resolves the real producer SHA.
    const sha = resolveProducerGitSha();
    assert.match(sha, GIT_SHA, "a checkout resolves a real git SHA");
    assert.notEqual(sha, "0".repeat(40), "never the all-zero faked-provenance placeholder");
  } finally {
    if (previous !== undefined) process.env.ROUTEKIT_BUILD_GIT_SHA = previous;
  }
});

test("WS7: a build-time stamp wins over the checkout git lookup", () => {
  const previous = process.env.ROUTEKIT_BUILD_GIT_SHA;
  const stamped = "a".repeat(40);
  process.env.ROUTEKIT_BUILD_GIT_SHA = stamped;
  try {
    assert.equal(resolveProducerGitSha(), stamped);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_BUILD_GIT_SHA;
    else process.env.ROUTEKIT_BUILD_GIT_SHA = previous;
  }
});

test("WS7: an installed copy (node_modules, no stamp) falls back to the 'unknown' sentinel", () => {
  const previous = process.env.ROUTEKIT_BUILD_GIT_SHA;
  delete process.env.ROUTEKIT_BUILD_GIT_SHA;
  try {
    // A node_modules path is treated as an installed artifact: no git lookup
    // (so we never mis-report the consumer's repo) → the clearly-marked sentinel.
    const sha = resolveProducerGitSha("/tmp/project/node_modules/@routekit/gateway/dist");
    assert.equal(sha, UNKNOWN_GIT_SHA);
    assert.equal(sha, "unknown");
    assert.notEqual(sha, "0".repeat(40), "the sentinel is never 40 zeros");
  } finally {
    if (previous !== undefined) process.env.ROUTEKIT_BUILD_GIT_SHA = previous;
  }
});

test("WS7: readProducerVersion reads this package's real version", () => {
  const version = readProducerVersion();
  assert.match(version, /^\d+\.\d+\.\d+/, "a real semver, not the 0.1.0 stub");
});

test("WS7: a built model-call record carries normalized provenance", () => {
  const record = buildModelCallRecord(
    {
      callId: "call_test_1",
      dialect: "openai-chat",
      requestedModel: "gpt-5.5",
      model: "gpt-5.5",
      stream: false,
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      startedAt: "2026-06-27T00:00:00.000Z"
    },
    { statusCode: 200, durationMs: 12, responseBody: Buffer.from(JSON.stringify({ id: "x" })) }
  );
  assert.equal(record.call_id, "call_test_1");
  assert.equal(record.endpoint_id, "openai-chat");
  assert.equal(record.status, "succeeded");
  assert.equal(record.metadata?.unknown_cost, true);
});
