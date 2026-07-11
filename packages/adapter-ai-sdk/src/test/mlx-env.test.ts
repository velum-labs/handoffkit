import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { mlxServer } from "../managed-server.js";
import {
  MLX_LM_STRUCTURED_PIN,
  MlxCapabilityError,
  MlxEnv
} from "../mlx-env.js";

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

const uvAvailable =
  spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;
const skipUv = uvAvailable ? false : "uv is not available on this host";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-mlxenv-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write stub modules into the venv's site-packages. Dotted names create
 * package directories (e.g. "mlx_lm.structured.integration" becomes
 * mlx_lm/structured/integration.py with __init__.py files along the way).
 */
function stubInstaller(
  counter: { installs: number; specs?: string[][] },
  moduleNames: string[] = ["fusionkit_stub"]
) {
  return (
    venvPython: string,
    packageSpec: string,
    extraPackageSpecs: string[]
  ): void => {
    counter.installs++;
    counter.specs?.push([packageSpec, ...extraPackageSpecs]);
    const purelib = spawnSync(
      venvPython,
      ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
      { encoding: "utf8" }
    ).stdout.trim();
    for (const name of moduleNames) {
      const parts = name.split(".");
      let dir = purelib;
      for (const pkg of parts.slice(0, -1)) {
        dir = join(dir, pkg);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "__init__.py"), "");
      }
      writeFileSync(join(dir, `${parts[parts.length - 1]}.py`), "VALUE = 1\n");
    }
  };
}

test("provisions an owned venv, writes the manifest, and is idempotent", { skip }, async () => {
  const dir = tempDir();
  const counter = { installs: 0 };
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
    install: stubInstaller(counter)
  });

  assert.equal(env.verify(), false, "nothing provisioned yet");
  const manifest = await env.ensureProvisioned();
  assert.equal(counter.installs, 1);
  assert.equal(manifest.packageSpec, "fusionkit-stub==1.0.0");
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
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
    install: stubInstaller(counter)
  });
  await v1.ensureProvisioned();
  assert.equal(counter.installs, 1);

  const v2 = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==2.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
    install: stubInstaller(counter)
  });
  assert.equal(v2.verify(), false, "old manifest does not satisfy the new pin");
  const manifest = await v2.ensureProvisioned();
  assert.equal(counter.installs, 2, "pin bump rebuilt the env");
  assert.equal(manifest.packageSpec, "fusionkit-stub==2.0.0");
  assert.equal(v2.verify(), true);
});

test("prepare() spawns from the owned env with contained caches", { skip }, async () => {
  const dir = tempDir();
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
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

test("extra package specs are installed, recorded, and verified", { skip }, async () => {
  const dir = tempDir();
  const counter = { installs: 0, specs: [] as string[][] };
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    extraPackageSpecs: ["outlines-core==0.0.0", "/path/to/overlay"],
    importName: "fusionkit_stub",
    extraImportNames: ["fusionkit_overlay_stub"],
    requirePlatform: false,
    uv: false,
    install: stubInstaller(counter, ["fusionkit_stub", "fusionkit_overlay_stub"])
  });

  const manifest = await env.ensureProvisioned();
  assert.deepEqual(counter.specs, [
    ["fusionkit-stub==1.0.0", "outlines-core==0.0.0", "/path/to/overlay"]
  ]);
  assert.deepEqual(manifest.extraPackageSpecs, [
    "outlines-core==0.0.0",
    "/path/to/overlay"
  ]);
  assert.equal(env.verify(), true);

  // Changing the extras invalidates the env: the next ensureProvisioned
  // rebuilds it.
  const changed = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    extraPackageSpecs: ["outlines-core==9.9.9", "/path/to/overlay"],
    importName: "fusionkit_stub",
    extraImportNames: ["fusionkit_overlay_stub"],
    requirePlatform: false,
    uv: false,
    install: stubInstaller(counter, ["fusionkit_stub", "fusionkit_overlay_stub"])
  });
  assert.equal(changed.verify(), false, "extras drift fails verification");
  await changed.ensureProvisioned();
  assert.equal(counter.installs, 2, "extras drift re-provisioned");
  assert.equal(changed.verify(), true);
});

test("a missing extra import fails verification", { skip }, async () => {
  const dir = tempDir();
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    extraPackageSpecs: ["/path/to/overlay"],
    importName: "fusionkit_stub",
    extraImportNames: ["fusionkit_overlay_stub"],
    requirePlatform: false,
    uv: false,
    // Installs only the primary stub: the overlay import must fail.
    install: stubInstaller({ installs: 0 }, ["fusionkit_stub"])
  });
  await assert.rejects(
    () => env.ensureProvisioned(),
    /cannot import "fusionkit_stub, fusionkit_overlay_stub"/
  );
  assert.equal(env.verify(), false);
});

test("a manifest without extras does not satisfy options with extras", { skip }, async () => {
  const dir = tempDir();
  const plain = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
    install: stubInstaller({ installs: 0 })
  });
  await plain.ensureProvisioned();
  assert.equal(plain.verify(), true);

  const withExtras = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    extraPackageSpecs: ["/path/to/overlay"],
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
    install: stubInstaller({ installs: 0 })
  });
  assert.equal(withExtras.verify(), false);
});

test("prepare() spawns an overridden server module when configured", { skip }, async () => {
  const dir = tempDir();
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    serverModule: "my_custom.server",
    requirePlatform: false,
    uv: false,
    install: stubInstaller({ installs: 0 })
  });

  const spec = await env.prepare("mlx-community/test-model", 12345);
  assert.deepEqual(spec.args.slice(0, 2), ["-m", "my_custom.server"]);
  assert.ok(!spec.args.includes("server"), "no stray stock subcommand");
  assert.ok(spec.args.includes("mlx-community/test-model"));
});

test("destroy() removes the entire owned footprint", { skip }, async () => {
  const dir = tempDir();
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: false,
    install: stubInstaller({ installs: 0 })
  });
  await env.ensureProvisioned();
  assert.equal(env.verify(), true);

  env.destroy();
  assert.equal(existsSync(dir), false, "env, manifest, caches, and logs are gone");
  assert.equal(env.verify(), false);
});

test("mlxServer with structured provisions the self-contained fork", { skip }, async () => {
  const dir = tempDir();
  const counter = { installs: 0, specs: [] as string[][] };
  const server = mlxServer({
    model: "mlx-community/test-model",
    structured: true,
    env: {
      dir,
      requirePlatform: false,
      uv: false,
      install: stubInstaller(counter, ["mlx_lm", "mlx_lm.structured.integration"])
    }
  });

  // Drive the env directly (starting the real server needs a model).
  const spec = await server.env.prepare("mlx-community/test-model", 12345);
  assert.equal(counter.installs, 1);
  assert.deepEqual(
    counter.specs[0],
    [MLX_LM_STRUCTURED_PIN],
    "the fork with its [structured] extra is the only spec"
  );
  // The fork keeps the stock entry point; the hooks activate because the
  // structured extra's dependencies import, not via a different module.
  assert.deepEqual(spec.args.slice(0, 3), ["-m", "mlx_lm", "server"]);
  assert.equal(server.env.verify(), true);
});

test("structured verification requires the structured subpackage import", { skip }, async () => {
  const env = mlxServer({
    model: "mlx-community/test-model",
    structured: true,
    env: {
      dir: tempDir(),
      requirePlatform: false,
      uv: false,
      // Installs mlx_lm without the structured subpackage: must fail.
      install: stubInstaller({ installs: 0 }, ["mlx_lm"])
    }
  }).env;
  await assert.rejects(
    () => env.ensureProvisioned(),
    /cannot import "mlx_lm, mlx_lm\.structured\.integration"/
  );
});

test("explicit env options win over structured defaults", { skip }, async () => {
  const counter = { installs: 0, specs: [] as string[][] };
  const server = mlxServer({
    model: "mlx-community/test-model",
    structured: true,
    env: {
      dir: tempDir(),
      packageSpec: "mlx-lm[structured] @ git+https://example.invalid/fork@my-rev",
      requirePlatform: false,
      uv: false,
      install: stubInstaller(counter, ["mlx_lm", "mlx_lm.structured.integration"])
    }
  });
  await server.env.prepare("mlx-community/test-model", 12345);
  assert.equal(
    counter.specs[0]?.[0],
    "mlx-lm[structured] @ git+https://example.invalid/fork@my-rev"
  );
});

test("mlxServer without structured keeps the stock entry point", { skip }, async () => {
  const server = mlxServer({
    model: "mlx-community/test-model",
    env: {
      dir: tempDir(),
      packageSpec: "fusionkit-stub==1.0.0",
      importName: "fusionkit_stub",
      requirePlatform: false,
      uv: false,
      install: stubInstaller({ installs: 0 })
    }
  });
  const spec = await server.env.prepare("mlx-community/test-model", 12345);
  assert.deepEqual(spec.args.slice(0, 3), ["-m", "mlx_lm", "server"]);
});

test("structured cannot be combined with a pre-built MlxEnv", () => {
  const env = new MlxEnv({ dir: tempDir(), requirePlatform: false });
  assert.throws(
    () => mlxServer({ model: "m", env, structured: true }),
    /configure extraPackageSpecs/
  );
});

test("a missing interpreter is a clear capability error", { skip }, async () => {
  const env = new MlxEnv({
    dir: tempDir(),
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
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

test("provisions with uv when it is available", { skip: skipUv }, async () => {
  const dir = tempDir();
  const counter = { installs: 0 };
  const env = new MlxEnv({
    dir,
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    install: stubInstaller(counter)
  });

  const manifest = await env.ensureProvisioned();
  assert.match(manifest.toolchain, /^uv /, "uv was preferred over venv+pip");
  assert.equal(counter.installs, 1);
  assert.equal(env.verify(), true);
  assert.ok(existsSync(env.venvPython), "uv-built venv interpreter exists");
});

test("an explicitly requested uv that cannot run is an error, not a fallback", async () => {
  const env = new MlxEnv({
    dir: tempDir(),
    packageSpec: "fusionkit-stub==1.0.0",
    importName: "fusionkit_stub",
    requirePlatform: false,
    uv: "/definitely/not/a/uv"
  });
  await assert.rejects(
    () => env.ensureProvisioned(),
    (error: unknown) =>
      error instanceof MlxCapabilityError && /not runnable/.test(error.message)
  );
});
