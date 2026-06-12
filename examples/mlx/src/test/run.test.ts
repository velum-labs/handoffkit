import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const RUN = fileURLToPath(new URL("../run.js", import.meta.url));

test("mlx smoke test exits with a platform message on unsupported hosts", () => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    // Gate-only on Apple Silicon: a full run would download weights and take minutes.
    return;
  }

  const result = spawnSync(process.execPath, [RUN], {
    encoding: "utf8",
    timeout: 30_000
  });
  assert.notEqual(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /MLX requires macOS on Apple Silicon/i);
});
