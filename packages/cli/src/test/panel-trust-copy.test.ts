import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PANEL_TRUST_HELP,
  PANEL_TRUST_LEVELS,
  PANEL_TRUST_MESSAGE,
  PANEL_TRUST_OPTIONS
} from "../shared/options.js";

// Regression coverage for the panel sandbox prompt copy (ENG-619). Every
// interactive surface (init extras, `config edit`, the `config set` picker)
// renders these shared strings, so pinning them here pins the wizard copy.

test("panel sandbox prompt copy snapshot", () => {
  assert.equal(PANEL_TRUST_MESSAGE, "Panel model sandbox — what may each model touch while it drafts?");
  assert.equal(
    PANEL_TRUST_HELP,
    "each panel model drafts unattended in its own disposable git worktree. " +
      "full lifts the coding agent's sandbox so drafts never hit permission walls; " +
      "guarded keeps the sandbox, blocking edits outside each model's worktree. " +
      "keep full (the default) unless you don't fully trust every panel model."
  );
  assert.deepEqual(
    PANEL_TRUST_OPTIONS.map((option) => ({ ...option })),
    [
      {
        value: "full",
        label: "full",
        hint: "no sandbox: may run any command and edit any file on this machine (default)"
      },
      {
        value: "guarded",
        label: "guarded",
        hint: "sandboxed: may only edit files inside its own draft worktree"
      }
    ]
  );
});

test("panel sandbox option labels are exactly the persisted config values", () => {
  // What the wizard shows must be what lands in fusion.json (`panelTrust`)
  // and what `--panel-trust` accepts.
  assert.deepEqual([...PANEL_TRUST_LEVELS], ["full", "guarded"]);
  assert.deepEqual(
    PANEL_TRUST_OPTIONS.map((option) => option.label),
    PANEL_TRUST_OPTIONS.map((option) => option.value)
  );
});

test("panel sandbox prompt copy avoids internal jargon and states the tradeoff", () => {
  const copy = [
    PANEL_TRUST_MESSAGE,
    PANEL_TRUST_HELP,
    ...PANEL_TRUST_OPTIONS.map((option) => option.hint)
  ].join("\n");
  assert.doesNotMatch(copy, /autonomy/i);
  assert.doesNotMatch(copy, /harness-fenced/i);
  assert.doesNotMatch(copy, /candidate/i);
  // The recommended default is called out, and both hints say what changes.
  assert.match(PANEL_TRUST_OPTIONS.find((option) => option.value === "full")?.hint ?? "", /default/);
  assert.match(PANEL_TRUST_OPTIONS.find((option) => option.value === "guarded")?.hint ?? "", /worktree/);
});
