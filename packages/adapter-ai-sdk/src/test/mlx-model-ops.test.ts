import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { MlxEnv } from "../mlx-env.js";
import type { DownloadProgress } from "../mlx-env.js";

/**
 * Exercises the NDJSON parsing of scanModels/downloadModel without MLX or the
 * network by standing in a fake venv interpreter that emits canned helper
 * output. The interpreter branches on the helper subcommand ($2) and is a no-op
 * for the `-c "import ..."` verification call so a pre-written manifest makes
 * ensureProvisioned a no-op.
 */
const FAKE_PY = `#!/bin/sh
cmd="$2"
case "$cmd" in
  scan)
    printf '%s\\n' '{"type":"model","repo":"mlx-community/Bravo","sizeBytes":200,"files":4}'
    printf '%s\\n' 'noise line that is not json'
    printf '%s\\n' '{"type":"model","repo":"mlx-community/Alpha","sizeBytes":100,"files":3}'
    printf '%s\\n' '{"type":"scan_done","count":2}'
    ;;
  download)
    printf '%s\\n' '{"type":"file","name":"model.safetensors"}'
    printf '%s\\n' '{"type":"progress","downloaded":40,"total":100}'
    printf '%s\\n' '{"type":"progress","downloaded":100,"total":100}'
    printf '%s\\n' '{"type":"download_done","path":"/tmp/snap"}'
    ;;
  *)
    exit 0
    ;;
esac
`;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "warrant-mlxops-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** An MlxEnv whose venv interpreter is a fake shell script emitting NDJSON. */
function fakeEnv(dir: string): MlxEnv {
  const env = new MlxEnv({
    dir,
    packageSpec: "stub==1.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    uv: false
  });
  const binDir = join(dir, "venv", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(env.venvPython, FAKE_PY);
  chmodSync(env.venvPython, 0o755);
  return env;
}

/** Write a manifest matching the env so ensureProvisioned is a no-op. */
function writeMatchingManifest(env: MlxEnv): void {
  writeFileSync(
    env.manifestPath,
    JSON.stringify({
      version: "warrant.mlxenv.v1",
      packageSpec: "stub==1.0.0",
      extraPackageSpecs: [],
      importName: "warrant_stub",
      toolchain: "venv+pip via fake",
      interpreterPath: env.venvPython,
      pythonVersion: "3.12.0",
      createdAt: new Date().toISOString()
    })
  );
}

test("scanModels returns [] when the env is not provisioned", async () => {
  const env = new MlxEnv({ dir: tempDir(), requirePlatform: false });
  assert.deepEqual(await env.scanModels(), []);
});

test("scanModels parses NDJSON, ignores noise, and sorts by repo", async () => {
  const env = fakeEnv(tempDir());
  const models = await env.scanModels();
  assert.deepEqual(
    models.map((model) => model.repo),
    ["mlx-community/Alpha", "mlx-community/Bravo"]
  );
  const alpha = models[0];
  assert.equal(alpha?.sizeBytes, 100);
  assert.equal(alpha?.files, 3);
});

test("downloadModel reports byte progress and resolves to the snapshot path", async () => {
  const env = fakeEnv(tempDir());
  writeMatchingManifest(env);
  assert.equal(env.verify(), true, "the matching manifest verifies via the fake interpreter");

  const updates: DownloadProgress[] = [];
  const path = await env.downloadModel("mlx-community/Alpha", {
    onProgress: (progress) => updates.push(progress)
  });
  assert.equal(path, "/tmp/snap");
  assert.deepEqual(
    updates.map((update) => update.downloaded),
    [40, 100]
  );
  assert.equal(updates[0]?.total, 100);
  assert.equal(updates[0]?.file, "model.safetensors");
});

test("downloadModel rejects immediately when the signal is already aborted", async () => {
  const env = fakeEnv(tempDir());
  writeMatchingManifest(env);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => env.downloadModel("mlx-community/Alpha", { signal: controller.signal }),
    /aborted/
  );
});

test("removeModel deletes a single model's cache directory", () => {
  const env = new MlxEnv({ dir: tempDir(), requirePlatform: false });
  const repoDir = join(env.hfCacheDir, "hub", "models--mlx-community--Alpha");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "config.json"), "{}");

  assert.equal(env.removeModel("mlx-community/Alpha"), true);
  assert.equal(existsSync(repoDir), false);
  assert.equal(env.removeModel("mlx-community/Alpha"), false, "removing again is a no-op");
});
