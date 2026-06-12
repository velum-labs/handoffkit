import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Warrant-owned MLX environment.
 *
 * The managed MLX backend does not shell out to whatever `mlx_lm.server`
 * happens to be on PATH — it owns the entire stack. This provisioner
 * materializes and maintains a dedicated directory containing:
 *
 *   <dir>/venv/      a private Python venv with mlx-lm at an exact pin
 *   <dir>/env.json   a manifest of what was provisioned (and from where)
 *   <dir>/hf-cache/  HF_HOME, so model weights live inside the owned dir
 *   <dir>/logs/      server stdout/stderr
 *
 * The whole footprint is one directory: inspectable (info), verifiable
 * (verify), repairable (re-provision on pin mismatch), and removable
 * (destroy). The server process is always spawned via the venv's own
 * interpreter — never a PATH lookup.
 *
 * The mlx-lm pin follows the same trusted-pin policy as the repo's npm
 * allowlist: exact version, bumped only as a reviewed code change.
 */

/** Exact-pinned mlx-lm version this provisioner installs. */
export const MLX_LM_PIN = "0.31.3";

/** Minimum Python the venv may be built from. */
const MIN_PYTHON = { major: 3, minor: 9 };

/** Default owned directory for the MLX stack. */
export function defaultMlxDir(): string {
  return join(homedir(), ".warrant", "mlx");
}

export type MlxEnvManifest = {
  version: "warrant.mlxenv.v1";
  /** What pip installed (e.g. "mlx-lm==0.31.3"). */
  packageSpec: string;
  /** Module whose import proves the install is usable. */
  importName: string;
  /** The system interpreter the venv was created from. */
  basePython: string;
  /** The venv interpreter every spawn uses. */
  interpreterPath: string;
  pythonVersion: string;
  createdAt: string;
};

/** Everything the process layer needs to spawn the server. */
export type SpawnSpec = {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Append server output here (inside the owned dir). */
  logFile?: string;
};

/** A capability the current host cannot satisfy (wrong OS, no Python). */
export class MlxCapabilityError extends Error {
  readonly code = "capability_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "MlxCapabilityError";
  }
}

export type MlxEnvOptions = {
  /** Owned directory. Defaults to ~/.warrant/mlx. */
  dir?: string;
  /** pip requirement to install. Defaults to the MLX_LM_PIN pin. */
  packageSpec?: string;
  /** Import that must succeed after install. Defaults to "mlx_lm". */
  importName?: string;
  /** Explicit base interpreter; otherwise "python3" is resolved and checked. */
  python?: string;
  /**
   * Enforce the MLX platform gate (macOS on Apple Silicon). Defaults to
   * true; tests provisioning stub packages on other hosts disable it.
   */
  requirePlatform?: boolean;
  /**
   * Override the install step (default: `pip install --no-input <spec>`
   * with the venv's pip). Tests inject an offline installer.
   */
  install?: (venvPython: string, packageSpec: string) => void;
};

type RunResult = { status: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], env?: Record<string, string>): RunResult {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    ...(env ? { env } : {})
  });
  if (result.error) {
    return { status: 127, stdout: "", stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function directorySizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

export class MlxEnv {
  readonly dir: string;
  private readonly packageSpec: string;
  private readonly importName: string;
  private readonly requirePlatform: boolean;
  private readonly explicitPython: string | undefined;
  private readonly installHook:
    | ((venvPython: string, packageSpec: string) => void)
    | undefined;
  private provisionPromise: Promise<MlxEnvManifest> | undefined;

  constructor(options: MlxEnvOptions = {}) {
    this.dir = options.dir ?? defaultMlxDir();
    this.packageSpec = options.packageSpec ?? `mlx-lm==${MLX_LM_PIN}`;
    this.importName = options.importName ?? "mlx_lm";
    this.requirePlatform = options.requirePlatform ?? true;
    this.explicitPython = options.python;
    this.installHook = options.install;
  }

  get manifestPath(): string {
    return join(this.dir, "env.json");
  }

  get venvDir(): string {
    return join(this.dir, "venv");
  }

  get venvPython(): string {
    const binDir = process.platform === "win32" ? "Scripts" : "bin";
    const exe = process.platform === "win32" ? "python.exe" : "python";
    return join(this.venvDir, binDir, exe);
  }

  get hfCacheDir(): string {
    return join(this.dir, "hf-cache");
  }

  get logsDir(): string {
    return join(this.dir, "logs");
  }

  private readManifest(): MlxEnvManifest | undefined {
    if (!existsSync(this.manifestPath)) return undefined;
    try {
      const parsed = JSON.parse(
        readFileSync(this.manifestPath, "utf8")
      ) as Partial<MlxEnvManifest>;
      if (
        parsed.version !== "warrant.mlxenv.v1" ||
        typeof parsed.packageSpec !== "string" ||
        typeof parsed.interpreterPath !== "string"
      ) {
        return undefined;
      }
      return parsed as MlxEnvManifest;
    } catch {
      return undefined;
    }
  }

  private assertPlatform(): void {
    if (!this.requirePlatform) return;
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new MlxCapabilityError(
        `MLX requires macOS on Apple Silicon; this host is ${process.platform}/${process.arch}. ` +
          "Use a cloud model (or handoffModel escalation) on this machine."
      );
    }
  }

  /** Resolve and sanity-check the base interpreter used to build the venv. */
  private resolveBasePython(): string {
    const candidate = this.explicitPython ?? "python3";
    const probe = run(candidate, [
      "-c",
      "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
    ]);
    if (probe.status !== 0) {
      throw new MlxCapabilityError(
        `no usable Python interpreter ("${candidate}"): ${probe.stderr.trim() || "not found"}`
      );
    }
    const [major = 0, minor = 0] = probe.stdout.trim().split(".").map(Number);
    if (
      major < MIN_PYTHON.major ||
      (major === MIN_PYTHON.major && minor < MIN_PYTHON.minor)
    ) {
      throw new MlxCapabilityError(
        `Python ${probe.stdout.trim()} is too old; mlx-lm needs >= ${MIN_PYTHON.major}.${MIN_PYTHON.minor}`
      );
    }
    return candidate;
  }

  /** Does the venv interpreter exist and import the managed package? */
  private importWorks(): boolean {
    if (!existsSync(this.venvPython)) return false;
    return run(this.venvPython, ["-c", `import ${this.importName}`]).status === 0;
  }

  /** Manifest matches the current pin and the env actually works. */
  verify(): boolean {
    const manifest = this.readManifest();
    return (
      manifest !== undefined &&
      manifest.packageSpec === this.packageSpec &&
      manifest.importName === this.importName &&
      this.importWorks()
    );
  }

  /** Manifest plus on-disk footprint of the owned directory. */
  info(): {
    dir: string;
    provisioned: boolean;
    manifest?: MlxEnvManifest;
    diskBytes: number;
  } {
    const manifest = this.readManifest();
    return {
      dir: this.dir,
      provisioned: this.verify(),
      ...(manifest ? { manifest } : {}),
      diskBytes: existsSync(this.dir) ? directorySizeBytes(this.dir) : 0
    };
  }

  /** Remove the entire owned footprint: venv, manifest, weights, logs. */
  destroy(): void {
    this.provisionPromise = undefined;
    rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Idempotently provision the env. A matching manifest plus a passing
   * import check is a no-op; anything else (fresh host, pin bump, broken
   * venv) provisions in place. Concurrent callers share one provision run.
   */
  ensureProvisioned(): Promise<MlxEnvManifest> {
    const existing = this.readManifest();
    if (existing && this.verify()) return Promise.resolve(existing);
    if (!this.provisionPromise) {
      this.provisionPromise = this.provision().finally(() => {
        this.provisionPromise = undefined;
      });
    }
    return this.provisionPromise;
  }

  private async provision(): Promise<MlxEnvManifest> {
    this.assertPlatform();
    const basePython = this.resolveBasePython();

    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.hfCacheDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });

    // A stale or pin-mismatched venv is rebuilt from scratch rather than
    // upgraded in place: rebuilds are cheap and exact, upgrades are neither.
    if (existsSync(this.venvDir)) {
      rmSync(this.venvDir, { recursive: true, force: true });
    }
    const venv = run(basePython, ["-m", "venv", this.venvDir]);
    if (venv.status !== 0) {
      throw new MlxCapabilityError(
        `failed to create venv with ${basePython} -m venv: ${venv.stderr.trim() || venv.stdout.trim()}`
      );
    }

    if (this.installHook) {
      this.installHook(this.venvPython, this.packageSpec);
    } else {
      const install = run(this.venvPython, [
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        this.packageSpec
      ]);
      if (install.status !== 0) {
        throw new Error(
          `pip install ${this.packageSpec} failed: ${install.stderr.trim().slice(-2000)}`
        );
      }
    }

    if (!this.importWorks()) {
      throw new Error(
        `provisioned env cannot import "${this.importName}"; the install is broken`
      );
    }

    const versionProbe = run(this.venvPython, [
      "-c",
      "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')"
    ]);
    const manifest: MlxEnvManifest = {
      version: "warrant.mlxenv.v1",
      packageSpec: this.packageSpec,
      importName: this.importName,
      basePython,
      interpreterPath: this.venvPython,
      pythonVersion: versionProbe.stdout.trim(),
      createdAt: new Date().toISOString()
    };
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  }

  /**
   * Provision (if needed) and produce the spawn spec for the server:
   * the venv's interpreter running `-m mlx_lm server` with a minimal,
   * explicit environment whose caches live inside the owned dir.
   */
  async prepare(model: string, port: number, extraArgs: string[] = []): Promise<SpawnSpec> {
    await this.ensureProvisioned();
    return {
      cmd: this.venvPython,
      args: [
        "-m",
        "mlx_lm",
        "server",
        "--model",
        model,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        ...extraArgs
      ],
      env: {
        // Explicit, minimal environment: the venv's bin first (so any
        // helper the server execs resolves inside the env), model caches
        // contained in the owned dir, no inherited surprises.
        PATH: [dirname(this.venvPython), "/usr/bin", "/bin"].join(delimiter),
        HOME: homedir(),
        HF_HOME: this.hfCacheDir,
        HF_HUB_DISABLE_TELEMETRY: "1",
        VIRTUAL_ENV: this.venvDir
      },
      cwd: this.dir,
      logFile: join(this.logsDir, "server.log")
    };
  }
}
