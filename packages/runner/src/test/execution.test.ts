import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunContract } from "@warrant/protocol";

import {
  executionSpecFor,
  executionHash,
  prepareExecution,
  requireShellExecution
} from "../execution.js";

function contractFixture(overrides: Partial<RunContract> = {}): RunContract {
  const contract: RunContract = {
    version: "warrant.contract.v1",
    runId: "run_test",
    issuedAt: "2026-06-11T00:00:00.000Z",
    issuer: { keyId: "ed25519:0000000000000000", role: "plane" },
    requestedBy: { kind: "human", id: "alice" },
    agent: { kind: "command" },
    task: { prompt: "echo hi" },
    runner: { pool: "default" },
    workspace: {
      version: "warrant.manifest.v1",
      baseRef: "abc",
      bundleHash: "1".repeat(64),
      untrackedFiles: [],
      deniedPatterns: [],
      deniedPaths: []
    },
    policyHash: "2".repeat(64),
    secrets: [],
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    expiresAt: "2026-06-11T01:00:00.000Z",
    signatures: [],
    ...overrides
  };
  return contract;
}

test("command contracts default to explicit shell execution", () => {
  const contract = contractFixture();
  assert.deepEqual(executionSpecFor(contract), {
    kind: "shell",
    script: "echo hi"
  });
  const execution = prepareExecution({
    contract,
    mockScriptPath: "/tmp/mock-agent.js"
  });
  const shell = requireShellExecution(execution);
  assert.equal(shell.script, "echo hi");
  assert.equal(shell.shell, "sh");
  assert.equal(shell.timeoutMs, 10 * 60 * 1000);
});

test("agent executions prepare vendor argv without shell wrapping", () => {
  const contract = contractFixture({
    agent: { kind: "mock" },
    task: { prompt: "do work" },
    execution: { kind: "agent", agent: { kind: "mock" }, prompt: "do work" }
  });
  const execution = prepareExecution({
    contract,
    mockScriptPath: "/tmp/mock-agent.js"
  });
  assert.equal(execution.kind, "argv");
  if (execution.kind === "argv") {
    assert.equal(execution.cmd, process.execPath);
    assert.deepEqual(execution.args, ["/tmp/mock-agent.js", "do work"]);
  }
});

test("pi cannot be prepared as a spawned command (harness-only)", () => {
  const contract = contractFixture({
    agent: { kind: "pi" },
    task: { prompt: "fix the bug" },
    execution: { kind: "agent", agent: { kind: "pi" }, prompt: "fix the bug" }
  });
  assert.throws(
    () => prepareExecution({ contract, mockScriptPath: "/tmp/mock-agent.js" }),
    /pi runs only via the AI SDK harness backend/
  );
});

test("executionHash records the prepared execution shape", () => {
  const shell = prepareExecution({
    contract: contractFixture({ execution: { kind: "shell", script: "echo hi" } }),
    mockScriptPath: "/tmp/mock-agent.js"
  });
  const argv = prepareExecution({
    contract: contractFixture({
      execution: { kind: "argv", command: "echo", args: ["hi"] }
    }),
    mockScriptPath: "/tmp/mock-agent.js"
  });
  assert.notEqual(executionHash(shell), executionHash(argv));
  assert.match(executionHash(shell), /^[0-9a-f]{64}$/);
});
