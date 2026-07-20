import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildProgram } from "../cli.js";

async function captureJson(args: string[]): Promise<Record<string, unknown>> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildProgram().parseAsync(["node", "routekit", "--json", ...args]);
    return JSON.parse(output) as Record<string, unknown>;
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("status and usage expose safe empty-state JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-status-"));
  const configPath = join(root, "router.yaml");
  const previousHome = process.env.ROUTEKIT_HOME;
  writeFileSync(configPath, "providers:\n  openai: {}\n");
  process.env.ROUTEKIT_HOME = join(root, "state");
  try {
    assert.deepEqual(await captureJson(["--config", configPath, "status"]), {
      ready: true,
      services: {
        gateway: { running: false },
        accounts: { running: false }
      },
      accounts: [],
      usage: null,
      recoveredTransactions: []
    });
    assert.deepEqual(await captureJson(["--config", configPath, "usage"]), {
      available: false,
      usage: null,
      accounts: []
    });
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
