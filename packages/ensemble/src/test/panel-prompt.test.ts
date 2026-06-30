import assert from "node:assert/strict";
import { test } from "node:test";

import { panelMemberPreamble } from "../harness.js";
import { buildPanelPrompt } from "../unified.js";

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

test("panelMemberPreamble: names the model and its 1-based peer index", () => {
  assert.equal(
    panelMemberPreamble("gemma-writer", 1, 3),
    'You are model "gemma-writer", panel member 2 of 3 in a FusionKit ensemble answering this task independently.'
  );
});
