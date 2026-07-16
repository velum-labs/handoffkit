import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRouterConfig } from "@routekit/gateway";
import { parse as parseYaml } from "yaml";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const routekitCli = join(root, "packages", "routekit-cli", "dist", "index.js");
const fusionkitCli = join(root, "packages", "cli", "dist", "index.js");

test("documented RouteKit config and safe CLI commands remain executable", () => {
  const configPath = join(root, "configs", "models.example.yaml");
  const config = parseRouterConfig(parseYaml(readFileSync(configPath, "utf8")));
  assert.ok(config.endpoints.some((endpoint) => endpoint.account === "claude-code"));
  assert.ok(config.endpoints.some((endpoint) => endpoint.account === "codex"));
  assert.equal(config.accounts?.["claude-code"]?.enabled, true);
  assert.equal(config.accounts?.codex?.enabled, true);

  for (const [cli, args] of [
    [routekitCli, ["accounts", "add", "--help"]],
    [routekitCli, ["endpoints", "add", "--help"]],
    [routekitCli, ["accounts", "cliproxy", "--help"]],
    [fusionkitCli, ["serve", "--help"]],
    [fusionkitCli, ["config", "set", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
    });
    assert.match(output, /Usage:/);
  }
});
