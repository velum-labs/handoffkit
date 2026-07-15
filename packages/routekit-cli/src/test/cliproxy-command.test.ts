import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cliproxyApiKey, ensureCliproxyConfig } from "@routekit/accounts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

test("accounts cliproxy exposes its management surface without credential output", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-cliproxy-command-"));
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    ensureCliproxyConfig();
    const credential = cliproxyApiKey();
    assert.ok(credential);
    const env = {
      ...process.env,
      ROUTEKIT_HOME: home,
      ROUTEKIT_NO_TUI: "1"
    };
    const help = execFileSync(
      process.execPath,
      [cli, "accounts", "cliproxy", "--help"],
      { encoding: "utf8", env }
    );
    for (const command of ["install", "login", "serve", "status"]) {
      assert.match(help, new RegExp(`\\b${command}\\b`));
    }
    const output = execFileSync(
      process.execPath,
      [cli, "--json", "accounts", "cliproxy", "status"],
      { encoding: "utf8", env }
    );
    const status = JSON.parse(output) as Record<string, unknown>;
    assert.equal(typeof status.configPath, "string");
    assert.equal(output.includes(credential), false);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
