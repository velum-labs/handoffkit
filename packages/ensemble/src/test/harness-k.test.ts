import assert from "node:assert/strict";
import { test } from "node:test";

import { terminalProposalFromSteps } from "../agent.js";
import { descriptorFor } from "../harness-factories.js";
import type { UnifiedHarnessE2EOptions } from "../unified-types.js";

function options(k: number | undefined, extra: Partial<UnifiedHarnessE2EOptions> = {}): UnifiedHarnessE2EOptions {
  return {
    id: "k_test",
    fusionBackendUrl: "http://127.0.0.1:1",
    repo: process.cwd(),
    outputRoot: "/tmp/k-test-out",
    prompt: "task",
    harnesses: ["agent"],
    models: [{ id: "alpha", model: "provider/alpha" }],
    ...(k !== undefined ? { k } : {}),
    ...extra
  };
}

test("finite k on a CLI harness fails fast with the harness named", () => {
  for (const kind of ["codex", "claude-code", "cursor-acp", "cursor-desktop", "command"] as const) {
    assert.throws(
      () => descriptorFor(kind, options(2)),
      new RegExp(`finite k \\(k=2\\) is not supported by the "${kind}" harness`),
      `${kind} must reject finite k`
    );
  }
});

test("finite k on the agent harness builds a descriptor", () => {
  const descriptor = descriptorFor("agent", options(3));
  assert.equal(descriptor.models.length, 1);
});

test("unset k builds every descriptor as before (agent case)", () => {
  const descriptor = descriptorFor("agent", options(undefined));
  assert.equal(descriptor.models.length, 1);
});

test("terminalProposalFromSteps mirrors the wire-side proposal semantics on steps", () => {
  // Bounded rollout: executed call+observation, captured k-th batch, empty output marker.
  assert.deepEqual(
    terminalProposalFromSteps([
      { index: 0, type: "tool_call", tool_name: "read_file", tool_input: '{"path":"a.ts"}' },
      { index: 1, type: "observation", text: "contents" },
      { index: 2, type: "tool_call", tool_name: "write_file", tool_input: '{"path":"a.ts"}' },
      { index: 3, type: "output", text: "" }
    ]),
    [{ name: "write_file", arguments_preview: '{"path":"a.ts"}' }]
  );
  // Completed rollout: ends in a real answer — nothing proposed.
  assert.deepEqual(
    terminalProposalFromSteps([
      { index: 0, type: "tool_call", tool_name: "run", tool_input: "{}" },
      { index: 1, type: "observation", text: "ok" },
      { index: 2, type: "output", text: "done: all tests pass" }
    ]),
    []
  );
  // Parallel captured batch stays whole and ordered.
  assert.deepEqual(
    terminalProposalFromSteps([
      { index: 0, type: "tool_call", tool_name: "a", tool_input: "{}" },
      { index: 1, type: "tool_call", tool_name: "b", tool_input: "{}" },
      { index: 2, type: "output", text: "" }
    ]).map((call) => call.name),
    ["a", "b"]
  );
});
