import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const routekitCli = join(root, "packages", "routekit-cli", "dist", "index.js");

test("documented safe CLI commands remain executable", () => {
  for (const [cli, args] of [
    [routekitCli, ["start", "--help"]],
    [routekitCli, ["status", "--help"]],
    [routekitCli, ["stop", "--help"]],
    [routekitCli, ["accounts", "add", "--help"]],
    [routekitCli, ["providers", "add", "--help"]],
    [routekitCli, ["accounts", "login", "--help"]],
    [routekitCli, ["accounts", "remove", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
    });
    assert.match(output, /Usage:/);
  }
  // The cliproxy subtree is gone from the public accounts surface.
  const accountsHelp = execFileSync(process.execPath, [routekitCli, "accounts", "--help"], {
    encoding: "utf8",
    env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
  });
  assert.match(accountsHelp, /\blogin\b/);
  assert.doesNotMatch(accountsHelp, /\bcliproxy\b/);

  const rootHelp = execFileSync(process.execPath, [routekitCli, "--help"], {
    encoding: "utf8",
    env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
  });
  assert.match(rootHelp, /^\s+start\b/m);
  assert.match(rootHelp, /^\s+status\b/m);
  assert.match(rootHelp, /^\s+stop\b/m);
  assert.doesNotMatch(rootHelp, /^\s+daemon\b/m);
  assert.doesNotMatch(rootHelp, /^\s+gateway\b/m);
});
