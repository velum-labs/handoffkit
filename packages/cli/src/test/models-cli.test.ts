import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-models-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Isolate the owned MLX dir so the scan finds an empty cache (no network,
      // no provisioning), and keep output plain for stable assertions.
      FUSIONKIT_MLX_DIR: tempDir(),
      NO_COLOR: "1",
      FUSIONKIT_NO_TUI: "1"
    }
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("`models list` shows the catalog with nothing downloaded in a fresh cache", () => {
  const { status, stderr: out } = runCli(["models", "list"]);
  assert.equal(status, 0);
  assert.match(out, /catalog/);
  assert.match(out, /mlx-community\/Qwen3-1\.7B-4bit/);
  assert.match(out, /none yet/);
});

test("bare `models` defaults to listing", () => {
  const { status, stderr: out } = runCli(["models"]);
  assert.equal(status, 0);
  assert.match(out, /catalog/);
});

test("`models rm` reports when a model was not cached", () => {
  const { status, stderr: out } = runCli(["models", "rm", "mlx-community/Not-Here"]);
  assert.equal(status, 0);
  assert.match(out, /was not in the local cache/);
});
