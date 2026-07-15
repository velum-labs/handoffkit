import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpRunner } from "@routekit/gateway";
import {
  runFrontDoorAcceptance,
  type FrontDoorOutcome
} from "../front-door-acceptance.js";
import { startFusionGateway } from "../fusion-gateway.js";
import type { FrontDoorRunner } from "../fusion-gateway.js";

const SENTINEL = "FUSION_OK";

function sentinelRunner(): FrontDoorRunner {
  return async (input) => ({
    finalOutput: `${SENTINEL} handled ${input.dialect}`,
    runId: `run_${input.requestId}`,
    status: "succeeded",
    evidence: ["patch_artifact", "tool_execution", "judge_synthesis"]
  });
}

function sentinelAcpRunner(): AcpRunner {
  return async (input) => ({
    finalOutput: `${SENTINEL} acp ${input.prompt}`,
    runId: `run_${input.requestId}`,
    status: "succeeded",
    evidence: ["judge_synthesis"]
  });
}

function byId(report: { front_doors: FrontDoorOutcome[] }, id: string): FrontDoorOutcome {
  const outcome = report.front_doors.find((door) => door.id === id);
  assert.ok(outcome, `expected front door ${id}`);
  return outcome;
}

test("acceptance passes HTTP front doors and generic ACP, blocks missing adapters", async () => {
  const gateway = await startFusionGateway({ runner: sentinelRunner(), defaultModel: "fusion-panel" });
  try {
    const report = await runFrontDoorAcceptance({
      gatewayUrl: gateway.url(),
      sentinel: SENTINEL,
      acpRunner: sentinelAcpRunner()
    });

    assert.equal(byId(report, "codex-responses").status, "passed");
    assert.equal(byId(report, "claude-messages").status, "passed");
    assert.equal(byId(report, "openai-chat").status, "passed");
    assert.equal(byId(report, "generic-acp").status, "passed");

    assert.ok(byId(report, "codex-responses").evidence.includes("sentinel"));
    assert.ok(byId(report, "codex-responses").evidence.includes("judge_synthesis"));

    assert.equal(byId(report, "codex-acp").status, "blocked");
    assert.equal(byId(report, "claude-acp").status, "blocked");
    assert.equal(byId(report, "cursor-acp").status, "blocked");
    assert.equal(byId(report, "cursor-acp").reason, "cursorkit_backend_not_running");
  } finally {
    await gateway.close();
  }
});

test("acceptance uses injected adapter outcomes when provided", async () => {
  const gateway = await startFusionGateway({ runner: sentinelRunner(), defaultModel: "fusion-panel" });
  try {
    const report = await runFrontDoorAcceptance({
      gatewayUrl: gateway.url(),
      sentinel: SENTINEL,
      acpRunner: sentinelAcpRunner(),
      codexAcp: async () => ({ id: "codex-acp", status: "passed", evidence: ["sentinel"] }),
      claudeAcp: async () => ({
        id: "claude-acp",
        status: "skipped_with_reason",
        reason: "claude_credit_or_credential_blocked",
        evidence: []
      }),
      cursorAcp: async () => ({ id: "cursor-acp", status: "passed", evidence: ["sentinel"] })
    });

    assert.equal(byId(report, "codex-acp").status, "passed");
    assert.equal(byId(report, "claude-acp").status, "skipped_with_reason");
    assert.equal(byId(report, "claude-acp").reason, "claude_credit_or_credential_blocked");
    assert.equal(byId(report, "cursor-acp").status, "passed");
  } finally {
    await gateway.close();
  }
});

test("acceptance fails a front door when the sentinel is absent", async () => {
  const gateway = await startFusionGateway({
    runner: async (input) => ({
      finalOutput: `no marker for ${input.dialect}`,
      runId: "run_x",
      status: "succeeded",
      evidence: []
    }),
    defaultModel: "fusion-panel"
  });
  try {
    const report = await runFrontDoorAcceptance({ gatewayUrl: gateway.url(), sentinel: SENTINEL });
    assert.equal(byId(report, "codex-responses").status, "failed");
    assert.equal(byId(report, "generic-acp").status, "blocked");
    assert.equal(byId(report, "generic-acp").reason, "acp_runner_not_configured");
  } finally {
    await gateway.close();
  }
});
