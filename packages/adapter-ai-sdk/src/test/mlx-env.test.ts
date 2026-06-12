import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { MlxCapabilityError, MlxEnv } from "../mlx-env.js";

/**
 * Exercises real environment ownership without MLX or macOS: the package
 * spec, import name, and install step are injectable, so these tests
 * provision a genuine venv into a temp dir and "install" a stub module
 * directly into its site-packages — the full own-the-env chain (venv
 * creation, import verification, manifest, repair, destroy) minus the
 * network-dependent pip download.
 */

const pythonAvailable =
  spawnSync("python3", ["-c", "import ensurepip"], { encoding: "utf8" })
    .status === 0;
const skip = pythonAvailable
  ? false
  : "python3 with venv support is not available on this host";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "warrant-mlxenv-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write the stub module into the venv's site-packages. */
function stubInstaller(counter: { installs: number }) {
  return (venvPython: string): void => {
    counter.installs++;
    const purelib = spawnSync(
      venvPython,
      ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
      { encoding: "utf8" }
    ).stdout.trim();
    writeFileSync(join(purelib, "warrant_stub.py"), "VALUE = 1\n");
  };
}

test("provisions an owned venv, writes the manifest, and is idempotent", { skip }, async () => {
  const dir = tempDir();
  const counter = { installs: 0 };
  const env = new MlxEnv({
    dir,
    packageSpec: "warrant-stub==1.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    install: stubInstaller(counter)
  });

  assert.equal(env.verify(), false, "nothing provisioned yet");
  const manifest = await env.ensureProvisioned();
  assert.equal(counter.installs, 1);
  assert.equal(manifest.packageSpec, "warrant-stub==1.0.0");
  assert.equal(manifest.interpreterPath, env.venvPython);
  assert.ok(existsSync(env.venvPython), "venv interpreter exists");
  assert.ok(existsSync(env.manifestPath), "manifest written");
  assert.equal(env.verify(), true);

  // Re-provisioning with a matching manifest is a no-op.
  const again = await env.ensureProvisioned();
  assert.equal(counter.installs, 1, "no second install");
  assert.equal(again.createdAt, manifest.createdAt);

  const info = env.info();
  assert.equal(info.provisioned, true);
  assert.ok(info.diskBytes > 0, "owned dir has a measurable footprint");
});

test("a pin change re-provisions the env in place", { skip }, async () => {
  const dir = tempDir();
  const counter = { installs: 0 };
  const v1 = new MlxEnv({
    dir,
    packageSpec: "warrant-stub==1.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    install: stubInstaller(counter)
  });
  await v1.ensureProvisioned();
  assert.equal(counter.installs, 1);

  const v2 = new MlxEnv({
    dir,
    packageSpec: "warrant-stub==2.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    install: stubInstaller(counter)
  });
  assert.equal(v2.verify(), false, "old manifest does not satisfy the new pin");
  const manifest = await v2.ensureProvisioned();
  assert.equal(counter.installs, 2, "pin bump rebuilt the env");
  assert.equal(manifest.packageSpec, "warrant-stub==2.0.0");
  assert.equal(v2.verify(), true);
});

test("prepare() spawns from the owned env with contained caches", { skip }, async () => {
  const dir = tempDir();
  const env = new MlxEnv({
    dir,
    packageSpec: "warrant-stub==1.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    install: stubInstaller({ installs: 0 })
  });

  const spec = await env.prepare("mlx-community/test-model", 12345, ["--max-tokens", "64"]);
  assert.equal(spec.cmd, env.venvPython, "always the venv interpreter, never PATH");
  assert.deepEqual(spec.args.slice(0, 3), ["-m", "mlx_lm", "server"]);
  assert.ok(spec.args.includes("mlx-community/test-model"));
  assert.ok(spec.args.includes("12345"));
  assert.ok(spec.args.includes("--max-tokens"));
  assert.equal(spec.env.HF_HOME, env.hfCacheDir, "model cache lives in the owned dir");
  assert.ok(spec.env.HF_HOME.startsWith(dir));
  assert.ok(spec.logFile?.startsWith(dir), "server logs live in the owned dir");
});

test("destroy() removes the entire owned footprint", { skip }, async () => {
  const dir = tempDir();
  const env = new MlxEnv({
    dir,
    packageSpec: "warrant-stub==1.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    install: stubInstaller({ installs: 0 })
  });
  await env.ensureProvisioned();
  assert.equal(env.verify(), true);

  env.destroy();
  assert.equal(existsSync(dir), false, "env, manifest, caches, and logs are gone");
  assert.equal(env.verify(), false);
});

test("a missing interpreter is a clear capability error", { skip }, async () => {
  const env = new MlxEnv({
    dir: tempDir(),
    packageSpec: "warrant-stub==1.0.0",
    importName: "warrant_stub",
    requirePlatform: false,
    python: "/definitely/not/a/python"
  });
  await assert.rejects(
    () => env.ensureProvisioned(),
    (error: unknown) =>
      error instanceof MlxCapabilityError && /no usable Python/.test(error.message)
  );
});

test(
  "the platform gate refuses non-Apple-Silicon hosts",
  { skip: process.platform === "darwin" && process.arch === "arm64" },
  async () => {
    const env = new MlxEnv({ dir: tempDir() });
    await assert.rejects(
      () => env.ensureProvisioned(),
      (error: unknown) =>
        error instanceof MlxCapabilityError &&
        /macOS on Apple Silicon/.test(error.message)
    );
  }
);
