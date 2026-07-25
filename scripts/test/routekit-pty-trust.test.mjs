import assert from "node:assert/strict";
import test from "node:test";

import {
  modelMatchesRequest,
  modelVisible
} from "../lib/routekit-client-model-ui.mjs";
import { cursorWorkspaceTrustDecision } from "../lib/routekit-pty-trust.mjs";

const CURRENT_CURSOR_TRUST = `
⚠ Workspace Trust Required
Do you trust the contents of this directory?
[a] Trust this workspace
[q] Quit
`;

test("Cursor trust handling uses only the key advertised by an active prompt", () => {
  assert.deepEqual(cursorWorkspaceTrustDecision(CURRENT_CURSOR_TRUST), {
    state: "prompt",
    action: { type: "literal", value: "a" }
  });
  assert.deepEqual(
    cursorWorkspaceTrustDecision(`
      Workspace Trust Required
      [y] Yes, I trust this folder
      [n] No
    `),
    {
      state: "prompt",
      action: { type: "literal", value: "y" }
    }
  );
  assert.deepEqual(
    cursorWorkspaceTrustDecision(`
      Do you trust this workspace?
      [Enter] Continue
    `),
    {
      state: "prompt",
      action: { type: "key", value: "Enter" }
    }
  );
});

test("Cursor trust handling never sends a key during transition or after readiness", () => {
  assert.deepEqual(
    cursorWorkspaceTrustDecision(`${CURRENT_CURSOR_TRUST}\nTrusting workspace...`),
    {
      state: "transitioning",
      action: undefined
    }
  );
  assert.deepEqual(
    cursorWorkspaceTrustDecision(
      `${CURRENT_CURSOR_TRUST}\nTrusting workspace...\nopenrouter/openai/gpt-4o-mini`,
      { ready: true }
    ),
    {
      state: "ready",
      action: undefined
    }
  );
  assert.deepEqual(cursorWorkspaceTrustDecision("Cursor Agent\nAsk anything"), {
    state: "absent",
    action: undefined
  });
});

test("Claude model evidence accepts the current friendly label but verifies the request ID", () => {
  const model = "claude-code/claude-fable-5";
  assert.equal(
    modelVisible("Claude Code\nFable 5 · API Usage Billing", "claude", model),
    true
  );
  assert.equal(modelMatchesRequest("claude-fable-5", "claude", model), true);
  assert.equal(modelMatchesRequest("claude-sonnet-4-6", "claude", model), false);
});
