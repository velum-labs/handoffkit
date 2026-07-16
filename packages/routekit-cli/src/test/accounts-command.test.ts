import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildProgram } from "../cli.js";

test("accounts add canonically enrolls and activates the selected config", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-accounts-add-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const previousHome = process.env.HOME;
  const previousStateHome = process.env.ROUTEKIT_HOME;
  const originalWrite = process.stdout.write;
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(
    join(root, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
        refresh_token: "refresh",
        account_id: "acct-test"
      }
    })
  );
  writeFileSync(
    configPath,
    [
      "endpoints:",
      "  - endpointId: default",
      "    model: provider-model",
      "    baseUrl: https://example.test/v1",
      ""
    ].join("\n")
  );
  process.env.HOME = root;
  process.env.ROUTEKIT_HOME = stateHome;
  try {
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    await buildProgram().parseAsync([
      "node",
      "routekit",
      "--config",
      configPath,
      "--json",
      "accounts",
      "add",
      "codex",
      "--name",
      "primary"
    ]);
    const result = JSON.parse(output) as {
      subscriptionKind?: string;
      provider?: string;
      activated?: boolean;
      configPath?: string;
      path?: string;
    };
    assert.equal(result.subscriptionKind, "codex");
    assert.equal(result.provider, "codex");
    assert.equal(result.activated, true);
    assert.equal(result.configPath, configPath);
    assert.equal(
      result.path,
      join(stateHome, "subscriptions", "codex", "primary.json")
    );
    const persisted = readFileSync(configPath, "utf8");
    assert.match(persisted, /accounts:\n  codex:\n    enabled: true/);
    assert.doesNotMatch(persisted, /strategy:|switchThreshold:|cooldownMs:/);
  } finally {
    process.stdout.write = originalWrite;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStateHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounts remove emits JSON and plain idempotent results without credential data", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-accounts-command-"));
  const directory = join(root, "subscriptions", "codex");
  const previousHome = process.env.ROUTEKIT_HOME;
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  process.env.ROUTEKIT_HOME = root;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "primary.json"), '{"accessToken":"never-output"}\n', {
    mode: 0o600
  });
  try {
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    await buildProgram().parseAsync([
      "node",
      "routekit",
      "--json",
      "accounts",
      "remove",
      "codex",
      "primary"
    ]);
    assert.deepEqual(JSON.parse(output), {
      mode: "codex",
      label: "primary",
      path: join(directory, "primary.json"),
      removed: true,
      subscriptionKind: "codex"
    });
    assert.equal(output.includes("never-output"), false);

    let plainOutput = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      plainOutput += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    writeFileSync(join(directory, "primary.json"), "{}\n", { mode: 0o600 });
    await buildProgram().parseAsync([
      "node",
      "routekit",
      "accounts",
      "remove",
      "codex",
      "primary"
    ]);
    assert.match(plainOutput, /removed codex\/primary/);

    plainOutput = "";
    await buildProgram().parseAsync([
      "node",
      "routekit",
      "accounts",
      "remove",
      "codex",
      "primary"
    ]);
    assert.match(plainOutput, /codex\/primary is not enrolled/);
    assert.equal(plainOutput.includes("never-output"), false);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
