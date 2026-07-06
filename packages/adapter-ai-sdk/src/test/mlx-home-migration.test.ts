import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { defaultMlxDir, MlxEnv } from "../mlx-env.js";

/**
 * The FusionKit rename must not orphan gigabytes of downloaded models: the
 * env-root resolver migrates a pre-rename ~/.warrant/mlx directory to
 * ~/.fusionkit/mlx once, honors the FUSIONKIT_MLX_HOME override (which is
 * also what makes doctor/CLI tests hermetic), and old manifest versions are
 * rewritten in place instead of forcing a re-provision.
 */

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-mlxhome-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function withEnv(overrides: Record<string, string | undefined>, body: () => void): void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("FUSIONKIT_MLX_HOME overrides the default env root", () => {
  const override = join(tempDir(), "custom-mlx");
  withEnv({ FUSIONKIT_MLX_HOME: override }, () => {
    assert.equal(defaultMlxDir(), override);
  });
});

test("a pre-rename ~/.warrant/mlx cache is moved to ~/.fusionkit/mlx once", () => {
  const home = tempDir();
  withEnv({ HOME: home, FUSIONKIT_MLX_HOME: undefined }, () => {
    const legacy = join(home, ".warrant", "mlx");
    mkdirSync(join(legacy, "hf-cache"), { recursive: true });
    writeFileSync(join(legacy, "hf-cache", "weights.bin"), "eleven gigabytes, honest");

    const resolved = defaultMlxDir();
    assert.equal(resolved, join(home, ".fusionkit", "mlx"));
    assert.ok(existsSync(join(resolved, "hf-cache", "weights.bin")), "cache contents moved");
    assert.ok(!existsSync(legacy), "old directory is gone");

    // Second resolution is a plain read; nothing left to migrate.
    assert.equal(defaultMlxDir(), resolved);
  });
});

test("an old-version manifest is rewritten in place, not re-provisioned", () => {
  const dir = tempDir();
  const env = new MlxEnv({ dir, requirePlatform: false, uv: false });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    env.manifestPath,
    JSON.stringify({
      version: "warrant.mlxenv.v1",
      packageSpec: "stub==1.0.0",
      importName: "stub",
      toolchain: "venv+pip via fake",
      interpreterPath: env.venvPython,
      pythonVersion: "3.12.0",
      createdAt: new Date().toISOString()
    })
  );
  const info = env.info();
  assert.equal(info.manifest?.version, "fusionkit.mlxenv.v1", "manifest accepted and migrated");
  const onDisk = JSON.parse(readFileSync(env.manifestPath, "utf8")) as { version: string };
  assert.equal(onDisk.version, "fusionkit.mlxenv.v1", "migration persisted");
});
