import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunContract } from "@fusionkit/protocol";

import {
  executionSpecFor,
  executionHash,
  prepareExecution,
  requireShellExecution
} from "../execution.js";
import { ProcessSessionBackend } from "../process-backend.js";

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

test("pi prepares a non-spawnable placeholder argv (harness-only)", () => {
  // The harness backend needs a prepared execution (env, timeout, hash) just
  // like claude-code, and ignores the argv. Preparation must therefore
  // succeed; the placeholder argv exists only to hash. The process backend
  // (tested separately) is what refuses to spawn pi.
  const contract = contractFixture({
    agent: { kind: "pi" },
    task: { prompt: "fix the bug" },
    execution: { kind: "agent", agent: { kind: "pi" }, prompt: "fix the bug" }
  });
  const execution = prepareExecution({ contract, mockScriptPath: "/tmp/mock-agent.js" });
  assert.equal(execution.kind, "argv");
  assert.match(executionHash(execution), /^[0-9a-f]{64}$/);
});

test("the process backend refuses to spawn pi", () => {
  const backend = new ProcessSessionBackend();
  const piContract = contractFixture({
    agent: { kind: "pi" },
    execution: { kind: "agent", agent: { kind: "pi" }, prompt: "fix the bug" }
  });
  const commandContract = contractFixture();
  assert.equal(backend.supports?.("argv", piContract), false);
  assert.equal(backend.supports?.("shell", commandContract), true);
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

test("codex prepares an explicit governed argv (codex-cli 0.144.2 shape)", () => {
  const prompt = "Fix the failing test without network access.";
  const contract = contractFixture({
    agent: { kind: "codex" },
    task: { prompt },
    execution: { kind: "agent", agent: { kind: "codex" }, prompt }
  });
  const execution = prepareExecution({
    contract,
    mockScriptPath: "/tmp/mock-agent.js"
  });
  assert.equal(execution.kind, "argv");
  if (execution.kind !== "argv") return;
  assert.equal(execution.cmd, "codex");
  assert.deepEqual(execution.args, [
    "exec",
    "--sandbox",
    "workspace-write",
    "--json",
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    prompt
  ]);
  // Local codex exec --help does not expose -a/--ask-for-approval; do not invent it.
  assert.equal(execution.args.includes("-a"), false);
  assert.equal(execution.args.includes("--ask-for-approval"), false);
  // --ignore-user-config requires a verified isolated CODEX_HOME; leave unset for now.
  assert.equal(execution.args.includes("--ignore-user-config"), false);
});

test("codex executionHash changes when boundary flags change", () => {
  const prompt = "Fix the failing test without network access.";
  const governed = prepareExecution({
    contract: contractFixture({
      agent: { kind: "codex" },
      task: { prompt },
      execution: { kind: "agent", agent: { kind: "codex" }, prompt }
    }),
    mockScriptPath: "/tmp/mock-agent.js"
  });
  // Old loose argv shape (pre-hardening): missing sandbox/json/ephemeral/ignore-rules.
  const loose = prepareExecution({
    contract: contractFixture({
      execution: {
        kind: "argv",
        command: "codex",
        args: ["exec", "--skip-git-repo-check", prompt]
      }
    }),
    mockScriptPath: "/tmp/mock-agent.js"
  });
  assert.notEqual(executionHash(governed), executionHash(loose));
});

test("codex prepared env does not yet isolate CODEX_HOME from host HOME", () => {
  // Coverage note / TODO: ProcessSessionBackend still seeds HOME from
  // process.env.HOME, and prepareAgentExecution does not set CODEX_HOME.
  // Adding --ignore-user-config without a generated isolated
  // CODEX_HOME/config.toml + auth boundary would break ambient auth.
  // Follow-up should generate a session-scoped CODEX_HOME before claiming
  // host-config isolation. Process-tier egress remains proxy-only.
  const execution = prepareExecution({
    contract: contractFixture({
      agent: { kind: "codex" },
      task: { prompt: "fix it" },
      execution: { kind: "agent", agent: { kind: "codex" }, prompt: "fix it" }
    }),
    mockScriptPath: "/tmp/mock-agent.js"
  });
  assert.equal(execution.env.HOME, undefined);
  assert.equal(execution.env.CODEX_HOME, undefined);
  assert.equal(execution.egressProxy, true);
});
