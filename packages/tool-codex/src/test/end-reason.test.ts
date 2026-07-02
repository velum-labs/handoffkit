import assert from "node:assert/strict";
import { test } from "node:test";

import { codexEndReason } from "../harness.js";

function stdoutOf(...events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

test("codexEndReason: a turn.completed event means the model finished its turn", () => {
  const result = {
    stdout: stdoutOf(
      { type: "item.completed", item: { type: "agent_message", text: "OK" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
    ),
    stderr: "",
    exitCode: 0
  };
  assert.deepEqual(codexEndReason(result), { kind: "completed", exitCode: 0 });
});

test("codexEndReason: a clean exit without turn.completed is an abort", () => {
  const result = {
    stdout: stdoutOf({ type: "item.completed", item: { type: "agent_message", text: "working..." } }),
    stderr: "",
    exitCode: 0
  };
  const reason = codexEndReason(result);
  assert.equal(reason.kind, "aborted");
  assert.equal(reason.exitCode, 0);
  assert.match(reason.detail ?? "", /without reporting a completed turn/);
});

test("codexEndReason: timeout and non-zero exits are classified with detail", () => {
  assert.deepEqual(codexEndReason({ stdout: "", stderr: "", exitCode: 124, timedOut: true }), {
    kind: "timeout",
    exitCode: 124,
    timedOut: true
  });
  const failed = codexEndReason({
    stdout: stdoutOf({ type: "error", message: "stream disconnected before completion" }),
    stderr: "boom",
    exitCode: 1
  });
  assert.deepEqual(failed, {
    kind: "exit_error",
    exitCode: 1,
    detail: "stream disconnected before completion"
  });
});

test("codexEndReason: legacy task_complete counts as completed and non-JSON lines are skipped", () => {
  const result = {
    stdout: "OpenAI Codex v0.99\n" + stdoutOf({ type: "task_complete", last_agent_message: "done" }),
    stderr: "",
    exitCode: 0
  };
  assert.equal(codexEndReason(result).kind, "completed");
});
