import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildProgram } from "../cli.js";

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
      removed: true
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
