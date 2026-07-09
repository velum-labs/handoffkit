/**
 * REAL coding-agent CLIs against the full stack — no mocked tool clients.
 *
 * The actual `claude` (Claude Code) and `codex` (Codex CLI) binaries are
 * spawned and pointed at the REAL Node fusion gateway -> REAL Python engine
 * (`fusionkit serve`) -> scripted provider simulator. The CLIs speak their
 * own production wire dialects, advertise their own real toolsets, and — in
 * the tool-loop tests — EXECUTE the fused turn's committed tool calls on this
 * machine (proven by the files those commands create), then close the loop
 * with a second fused turn.
 *
 * Only the model behind the provider wire is scripted. Suites skip (with the
 * reason) where the binaries or the Python toolchain are unavailable; the
 * `stack-e2e` CI job installs both CLIs and runs them for real.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { cliSkip, judgeAnalysis, runClaudeCode, runCodexExec, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const STACK_SKIP = stackToolingSkip();
const CLAUDE_SKIP = STACK_SKIP !== false ? STACK_SKIP : cliSkip("claude");
const CODEX_SKIP = STACK_SKIP !== false ? STACK_SKIP : cliSkip("codex");

const MEMBERS = [
  { id: "alpha", model: "gpt-panel-a", provider: "openai" },
  { id: "beta", model: "claude-panel-b", provider: "anthropic" },
  { id: "judge", model: "gpt-judge", provider: "openai" }
] as const;

let stack: SimFusionStack;
let workRoot: string;

before(async function () {
  if (STACK_SKIP !== false) return;
  stack = await startSimFusionStack({ members: [...MEMBERS], judgeId: "judge" });
  workRoot = mkdtempSync(join(tmpdir(), "fusionkit-cli-e2e-"));
});

after(async () => {
  if (STACK_SKIP !== false) return;
  await stack.close();
  rmSync(workRoot, { recursive: true, force: true });
});

/** Script one fused turn: both members answer, the judge analyzes + synthesizes. */
async function queueFusedTurn(answer: string | { tool_calls: Array<{ id: string; name: string; arguments: string }> }): Promise<void> {
  await stack.sim.queue("gpt-panel-a", ["candidate from the openai member"]);
  await stack.sim.queue("claude-panel-b", ["candidate from the anthropic member"]);
  await stack.sim.queue("gpt-judge", [
    { reply: judgeAnalysis() },
    typeof answer === "string" ? { reply: answer } : answer
  ]);
}

// --- Claude Code (the real binary) ----------------------------------------------------

test("real Claude Code CLI completes a fused turn through the whole stack", { skip: CLAUDE_SKIP }, async () => {
  await stack.sim.reset();
  await queueFusedTurn("FUSION_OK: fused answer delivered to the real claude binary");

  const result = await runClaudeCode({
    gatewayUrl: stack.gatewayUrl,
    prompt: "Report the fused answer verbatim.",
    cwd: workRoot
  });
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /FUSION_OK: fused answer delivered to the real claude binary/);

  // The real CLI's own request drove the fanout: members saw Claude Code's
  // genuine agent payload (its real toolset and the user prompt) verbatim.
  const memberCall = (await stack.sim.calls({ model: "gpt-panel-a" }))[0];
  const memberWire = JSON.stringify(memberCall?.request);
  assert.ok(memberWire.includes("Report the fused answer verbatim."));
  assert.ok(memberWire.includes('"Bash"'), "Claude Code's real toolset must reach the panel wire");
  assert.equal((await stack.sim.calls({ model: "gpt-judge" })).length, 2);
});

test("real Claude Code CLI executes a fused Bash tool call locally and closes the loop", { skip: CLAUDE_SKIP }, async () => {
  await stack.sim.reset();
  const cwd = mkdtempSync(join(workRoot, "claude-tools-"));
  const proofPath = join(cwd, "fusion_proof.txt");
  // Turn 1: the fused step commits a REAL Bash call for the CLI to execute.
  await queueFusedTurn({
    tool_calls: [
      {
        id: "call_bash",
        name: "Bash",
        arguments: JSON.stringify({ command: "echo FUSION_TOOL_RAN > fusion_proof.txt" })
      }
    ]
  });
  // Turn 2: the CLI posts the tool result back; the loop closes on a final answer.
  await queueFusedTurn("FUSION_OK: bash tool loop complete");

  const result = await runClaudeCode({
    gatewayUrl: stack.gatewayUrl,
    prompt: "Create the proof file the way you see fit, then report.",
    cwd,
    dangerouslySkipPermissions: true
  });
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /FUSION_OK: bash tool loop complete/);

  // Hard proof the REAL binary executed the fused tool call on this machine.
  assert.ok(existsSync(proofPath), "claude must have executed the fused Bash call");
  assert.match(readFileSync(proofPath, "utf8"), /FUSION_TOOL_RAN/);

  // And the executed tool's result really flowed back over the provider wire
  // into the second fused turn.
  const judgeCalls = await stack.sim.calls({ model: "gpt-judge" });
  assert.equal(judgeCalls.length, 4, await stack.sim.describeJournal());
});

// --- Codex CLI (the real binary) ------------------------------------------------------

test("real Codex CLI completes a fused turn through the whole stack", { skip: CODEX_SKIP }, async () => {
  await stack.sim.reset();
  await queueFusedTurn("FUSION_OK: fused answer delivered to the real codex binary");

  const cwd = mkdtempSync(join(workRoot, "codex-plain-"));
  const result = await runCodexExec({
    gatewayUrl: stack.gatewayUrl,
    prompt: "Report the fused answer verbatim.",
    cwd
  });
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /FUSION_OK: fused answer delivered to the real codex binary/);

  const memberCall = (await stack.sim.calls({ model: "gpt-panel-a" }))[0];
  const memberWire = JSON.stringify(memberCall?.request);
  assert.ok(memberWire.includes("Report the fused answer verbatim."));
  assert.ok(
    memberWire.includes('"exec_command"'),
    "Codex's real toolset must reach the panel wire"
  );
});

test("real Codex CLI executes a fused exec_command locally and closes the loop", { skip: CODEX_SKIP }, async () => {
  await stack.sim.reset();
  const cwd = mkdtempSync(join(workRoot, "codex-tools-"));
  const proofPath = join(cwd, "fusion_proof.txt");
  await queueFusedTurn({
    tool_calls: [
      {
        id: "call_exec",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "echo FUSION_TOOL_RAN > fusion_proof.txt" })
      }
    ]
  });
  await queueFusedTurn("FUSION_OK: exec_command tool loop complete");

  const result = await runCodexExec({
    gatewayUrl: stack.gatewayUrl,
    prompt: "Create the proof file the way you see fit, then report.",
    cwd
  });
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /FUSION_OK: exec_command tool loop complete/);

  assert.ok(existsSync(proofPath), "codex must have executed the fused exec_command");
  assert.match(readFileSync(proofPath, "utf8"), /FUSION_TOOL_RAN/);
  assert.equal((await stack.sim.calls({ model: "gpt-judge" })).length, 4, await stack.sim.describeJournal());
});
