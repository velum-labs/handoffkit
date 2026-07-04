import assert from "node:assert/strict";
import { test } from "node:test";

import { panelMemberPreamble } from "../harness.js";
import { PANEL_CANDIDATE_CONTRACT, buildPanelPrompt, panelCandidateContract } from "../unified.js";

const PANEL = [
  { id: "qwen-fast", model: "qwen" },
  { id: "gemma-writer", model: "gemma" },
  { id: "codex", model: "gpt-5.5-codex" }
];

test("buildPanelPrompt: identity off keeps the legacy generic suffix and no passthrough", () => {
  const out = buildPanelPrompt({
    prompt: "Fix the bug.",
    panel: PANEL,
    harnessSystem: "You are Codex. Follow repo conventions.",
    panelIdentity: false
  });
  assert.ok(out.startsWith("Fix the bug."));
  assert.ok(out.includes("one model in a FusionKit panel answering this task independently"));
  // Harness system is not passed through when identity is off.
  assert.ok(!out.includes("Follow repo conventions"));
  // No per-model roster in the generic suffix.
  assert.ok(!out.includes("qwen-fast, gemma-writer, codex"));
});

test("buildPanelPrompt: identity on passes through harness system and lists the roster", () => {
  const out = buildPanelPrompt({
    prompt: "Fix the bug.",
    panel: PANEL,
    harnessSystem: "You are Codex. Follow repo conventions.",
    panelIdentity: true
  });
  assert.ok(out.includes("Custom instructions for this task"));
  assert.ok(out.includes("Follow repo conventions"));
  assert.ok(out.includes("Fix the bug."));
  assert.ok(out.includes("[qwen-fast, gemma-writer, codex]"));
});

test("buildPanelPrompt: identity on without harness system still lists the roster", () => {
  const out = buildPanelPrompt({ prompt: "Do it.", panel: PANEL, panelIdentity: true });
  assert.ok(!out.includes("Custom instructions for this task"));
  assert.ok(out.includes("[qwen-fast, gemma-writer, codex]"));
});

test("buildPanelPrompt: the candidate contract is appended last in both identity modes", () => {
  for (const panelIdentity of [false, true]) {
    const out = buildPanelPrompt({
      prompt: "Fix the bug.",
      panel: PANEL,
      harnessSystem: "You are Codex.",
      panelIdentity
    });
    assert.ok(out.endsWith(PANEL_CANDIDATE_CONTRACT), `contract must close the prompt (identity=${panelIdentity})`);
    assert.ok(out.includes("never ask for permission or clarification"));
    // The contract follows the membership suffix, never precedes the task.
    assert.ok(out.indexOf(PANEL_CANDIDATE_CONTRACT) > out.indexOf("Fix the bug."));
  }
});

test("the candidate contract guards against fusion-* sub-agent attempts", () => {
  // Same-model sub-agents are allowed; fused gateway models are declared
  // unreachable so members answer instead of flailing (the observed 5-minute
  // "boot fusionkit serve in the worktree" failure mode).
  assert.ok(PANEL_CANDIDATE_CONTRACT.includes("sub-agents always run on your own model"));
  assert.ok(PANEL_CANDIDATE_CONTRACT.includes('"fusion-*"'));
  assert.ok(PANEL_CANDIDATE_CONTRACT.includes("not reachable from inside the panel"));
  assert.ok(PANEL_CANDIDATE_CONTRACT.includes("answer directly"));
  // The parameterless contract builder is the guarded default.
  assert.equal(panelCandidateContract(), PANEL_CANDIDATE_CONTRACT);
  assert.equal(panelCandidateContract([]), PANEL_CANDIDATE_CONTRACT);
});

test("with fused sub-agent access, the contract names the spawnable ensembles instead of guarding", () => {
  const contract = panelCandidateContract(["fusion-panel", "fusion-kimi"]);
  assert.ok(contract.includes("fusion-panel, fusion-kimi"));
  assert.ok(contract.includes("available as sub-agent models"));
  assert.ok(contract.includes("never try to boot a server or gateway"));
  assert.ok(!contract.includes("not reachable from inside the panel"));
  // The base contract (permissions, no-questions) is unchanged.
  assert.ok(contract.includes("never ask for permission or clarification"));
});

test("buildPanelPrompt threads the fused model ids into the contract tail", () => {
  const out = buildPanelPrompt({
    prompt: "Fix the bug.",
    panel: PANEL,
    fusedModelIds: ["fusion-panel", "fusion-kimi"]
  });
  assert.ok(out.includes("fusion-panel, fusion-kimi"));
  assert.ok(!out.includes("not reachable from inside the panel"));
});

test("panelMemberPreamble: names the model and its 1-based peer index", () => {
  assert.equal(
    panelMemberPreamble("gemma-writer", 1, 3),
    'You are model "gemma-writer", panel member 2 of 3 in a FusionKit ensemble answering this task independently.'
  );
});
