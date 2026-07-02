import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { resolveInitOverwrite } from "../fusion-init.js";

const tmpRoots: string[] = [];

function configPathInTmp(exists: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-init-"));
  tmpRoots.push(dir);
  const configPath = join(dir, ".fusionkit", "fusion.json");
  if (exists) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{}\n");
  }
  return configPath;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("resolveInitOverwrite proceeds when no config exists", async () => {
  const configPath = configPathInTmp(false);
  const result = await resolveInitOverwrite({ configPath, force: false });
  assert.deepEqual(result, { action: "proceed", force: false });
});

test("resolveInitOverwrite proceeds with force when config exists", async () => {
  const configPath = configPathInTmp(true);
  const result = await resolveInitOverwrite({ configPath, force: true });
  assert.deepEqual(result, { action: "proceed", force: true });
});

test("resolveInitOverwrite refuses when config exists and prompts are disabled", async () => {
  const configPath = configPathInTmp(true);
  const prev = process.env.FUSIONKIT_NO_TUI;
  process.env.FUSIONKIT_NO_TUI = "1";
  try {
    const result = await resolveInitOverwrite({ configPath, force: false });
    assert.deepEqual(result, { action: "refuse" });
  } finally {
    if (prev === undefined) delete process.env.FUSIONKIT_NO_TUI;
    else process.env.FUSIONKIT_NO_TUI = prev;
  }
});
