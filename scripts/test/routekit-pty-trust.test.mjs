import assert from "node:assert/strict";
import test from "node:test";

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
