import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMigratingConfig, resolveLayer } from "../index.js";

test("loads a legacy config and writes the canonical path", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-"));
  try {
    const legacy = join(root, "old.json");
    const current = join(root, "state", "config.json");
    writeFileSync(legacy, '{"version":1}\n');
    const value = loadMigratingConfig({
      currentPath: current,
      legacyPaths: [legacy],
      parse: (raw) => raw as { version: number },
      serialize: (config) => config
    });
    assert.deepEqual(value, { version: 1 });
    assert.deepEqual(resolveLayer(undefined, "file", "default"), {
      value: "file",
      source: "config"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
