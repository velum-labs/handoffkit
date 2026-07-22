import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const routekitCli = join(root, "packages", "routekit-cli", "dist", "index.js");

test("documented safe CLI commands remain executable", () => {
  for (const [cli, args] of [
    [routekitCli, ["accounts", "add", "--help"]],
    [routekitCli, ["providers", "add", "--help"]],
    [routekitCli, ["accounts", "cliproxy", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
    });
    assert.match(output, /Usage:/);
  }
});
