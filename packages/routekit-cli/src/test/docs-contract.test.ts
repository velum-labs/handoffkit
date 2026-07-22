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
    [routekitCli, ["accounts", "login", "--help"]],
    [routekitCli, ["accounts", "remove", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
    });
    assert.match(output, /Usage:/);
  }
  // The cliproxy subtree is gone; commander must not silently fall through
  // to the parent accounts help for a removed subcommand.
  assert.throws(
    () =>
      execFileSync(process.execPath, [routekitCli, "accounts", "cliproxy", "--help"], {
        encoding: "utf8",
        env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      }),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      (error as { status?: number }).status !== 0
  );
});
