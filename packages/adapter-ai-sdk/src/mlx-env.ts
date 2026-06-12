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
 *
 * Toolchain: provisioning prefers `uv` when available (an explicit path,
 * WARRANT_UV, or PATH discovery) — it is much faster and can supply its own
 * managed CPython, removing even the system-python requirement. Without uv
 * it falls back to stdlib `python3 -m venv` + pip, so uv is an upgrade,
 * never a dependency. uv's caches and managed interpreters are contained
 * inside the owned directory, so destroy() removes them too.
 */

/** Exact-pinned mlx-lm version this provisioner installs. */
export const MLX_LM_PIN = "0.31.3";

/**
 * The velum-labs/mlx-lm fork installed in structured mode: upstream v0.31.3
 * plus optional structured-decoding hooks (a minimal patch series; see
 * python/mlx-lm-structured/README.md). The ref is the patch-series branch
 * for that upstream tag; prefer narrowing it to a commit SHA once the branch
 * is settled, since a moving ref weakens the manifest's exactness.
 */
export const MLX_LM_STRUCTURED_PIN =
  "mlx-lm @ git+https://github.com/velum-labs/mlx-lm@structured-0.31.3";

/**
 * Exact-pinned outlines-core version installed alongside the structured
 * decoding package (whose own dependency pin matches; this makes the pin
 * explicit in the provisioned env and in this repo's review surface).
 */
export const OUTLINES_CORE_PIN = "0.2.14";

/** Python version requested from uv (which can download it if absent). */
export const PYTHON_PIN = "3.12";

/** Minimum Python the venv may be built from. */
const MIN_PYTHON = { major: 3, minor: 9 };

/** Default owned directory for the MLX stack. */
export function defaultMlxDir(): string {
  return join(homedir(), ".warrant", "mlx");
}

export type MlxEnvManifest = {
  version: "warrant.mlxenv.v1";
  /** What was installed (e.g. "mlx-lm==0.31.3"). */
  packageSpec: string;
  /** Additional specs installed after the main one (e.g. the structured
   * decoding overlay). Absent in manifests written before this field
   * existed, which reads as []. */
  extraPackageSpecs?: string[];
  /** Module whose import proves the install is usable. */
  importName: string;
  /** What built the env: "uv <version>" or "venv+pip via <interpreter>". */
  toolchain: string;
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
  /** Requirement to install. Defaults to the MLX_LM_PIN pin. */
  packageSpec?: string;
  /**
   * Additional requirements installed after the main spec — pinned PyPI
   * specs or local package directories (e.g. the structured decoding
   * overlay). Part of the manifest: changing them re-provisions.
   */
  extraPackageSpecs?: string[];
  /** Import that must succeed after install. Defaults to "mlx_lm". */
  importName?: string;
  /** Additional imports that must succeed (one per extra package). */
  extraImportNames?: string[];
  /**
   * Python module spawned by prepare(). Defaults to the stock
   * `mlx_lm server`; the structured overlay uses STRUCTURED_SERVER_MODULE.
   */
  serverModule?: string;
  /**
   * Explicit base interpreter. Setting this forces the stdlib venv+pip
   * toolchain with exactly that interpreter (an escape hatch from uv).
   */
  python?: string;
  /**
   * uv binary to provision with, or `false` to disable uv entirely.
   * Default: WARRANT_UV if set, otherwise "uv" discovered on PATH,
   * otherwise the stdlib venv+pip fallback.
   */
  uv?: string | false;
  /** Python version requested from uv. Defaults to PYTHON_PIN. */
  pythonVersion?: string;
  /**
   * Enforce the MLX platform gate (macOS on Apple Silicon). Defaults to
   * true; tests provisioning stub packages on other hosts disable it.
   */
  requirePlatform?: boolean;
  /**
   * Override the install step (default: install <packageSpec> plus any
   * <extraPackageSpecs> into the venv with the resolved toolchain). Tests
   * inject an offline installer.
   */
  install?: (
    venvPython: string,
    packageSpec: string,
    extraPackageSpecs: string[]
  ) => void;
};

/** How the venv gets built and populated. */
type Toolchain =
  | { kind: "uv"; bin: string; version: string }
  | { kind: "venv-pip"; python: string };

type RunResult = { status: number; stdout: string; stderr: string };

/** Run a command; `extraEnv` overlays (never replaces) the process env. */
function run(
  cmd: string,
  args: string[],
  extraEnv?: Record<string, string>
): RunResult {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {})
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
  private readonly extraPackageSpecs: string[];
  private readonly importName: string;
  private readonly extraImportNames: string[];
  private readonly serverModule: string | undefined;
  private readonly requirePlatform: boolean;
  private readonly explicitPython: string | undefined;
  private readonly uvOption: string | false | undefined;
  private readonly pythonVersion: string;
  private readonly installHook:
    | ((
        venvPython: string,
        packageSpec: string,
        extraPackageSpecs: string[]
      ) => void)
    | undefined;
  private provisionPromise: Promise<MlxEnvManifest> | undefined;

  constructor(options: MlxEnvOptions = {}) {
    this.dir = options.dir ?? defaultMlxDir();
    this.packageSpec = options.packageSpec ?? `mlx-lm==${MLX_LM_PIN}`;
    this.extraPackageSpecs = options.extraPackageSpecs ?? [];
    this.importName = options.importName ?? "mlx_lm";
    this.extraImportNames = options.extraImportNames ?? [];
    this.serverModule = options.serverModule;
    this.requirePlatform = options.requirePlatform ?? true;
    this.explicitPython = options.python;
    this.uvOption = options.uv;
    this.pythonVersion = options.pythonVersion ?? PYTHON_PIN;
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

  /** uv's caches and managed interpreters, contained in the owned dir. */
  private get uvEnv(): Record<string, string> {
    return {
      UV_CACHE_DIR: join(this.dir, "uv-cache"),
      UV_PYTHON_INSTALL_DIR: join(this.dir, "uv-python")
    };
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
      if (
        parsed.extraPackageSpecs !== undefined &&
        !(
          Array.isArray(parsed.extraPackageSpecs) &&
          parsed.extraPackageSpecs.every((spec) => typeof spec === "string")
        )
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

  /**
   * Pick the provisioning toolchain. An explicit `python` option forces
   * stdlib venv+pip with that interpreter; otherwise uv is preferred
   * (explicit path, WARRANT_UV, or PATH discovery) with venv+pip as the
   * no-extra-requirements fallback.
   */
  private resolveToolchain(): Toolchain {
    if (this.explicitPython !== undefined) {
      return { kind: "venv-pip", python: this.checkPython(this.explicitPython) };
    }
    if (this.uvOption !== false) {
      const explicitUv = this.uvOption ?? process.env.WARRANT_UV;
      const candidate = explicitUv ?? "uv";
      const probe = run(candidate, ["--version"]);
      if (probe.status === 0) {
        return {
          kind: "uv",
          bin: candidate,
          version: probe.stdout.trim().replace(/^uv\s+/, "")
        };
      }
      // An explicitly requested uv that does not run is an error, not a
      // silent fallback; PATH discovery falling through is expected.
      if (explicitUv !== undefined) {
        throw new MlxCapabilityError(
          `requested uv ("${candidate}") is not runnable: ${probe.stderr.trim() || "not found"}`
        );
      }
    }
    return { kind: "venv-pip", python: this.checkPython("python3") };
  }

  /** Sanity-check a base interpreter for the stdlib venv+pip path. */
  private checkPython(candidate: string): string {
    const probe = run(candidate, [
      "-c",
      "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
    ]);
    if (probe.status !== 0) {
      throw new MlxCapabilityError(
        `no usable Python interpreter ("${candidate}"): ${probe.stderr.trim() || "not found"} ` +
          "(install python3, or install uv and Warrant will manage Python itself)"
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

  /** Does the venv interpreter exist and import the managed packages? */
  private importWorks(): boolean {
    if (!existsSync(this.venvPython)) return false;
    const imports = [this.importName, ...this.extraImportNames].join(", ");
    return run(this.venvPython, ["-c", `import ${imports}`]).status === 0;
  }

  private extrasMatch(manifest: MlxEnvManifest): boolean {
    const recorded = manifest.extraPackageSpecs ?? [];
    return (
      recorded.length === this.extraPackageSpecs.length &&
      recorded.every((spec, i) => spec === this.extraPackageSpecs[i])
    );
  }

  /** Manifest matches the current pins and the env actually works. */
  verify(): boolean {
    const manifest = this.readManifest();
    return (
      manifest !== undefined &&
      manifest.packageSpec === this.packageSpec &&
      this.extrasMatch(manifest) &&
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
    const toolchain = this.resolveToolchain();

    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.hfCacheDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });

    // A stale or pin-mismatched venv is rebuilt from scratch rather than
    // upgraded in place: rebuilds are cheap and exact, upgrades are neither.
    if (existsSync(this.venvDir)) {
      rmSync(this.venvDir, { recursive: true, force: true });
    }
    this.createVenv(toolchain);

    if (this.installHook) {
      this.installHook(this.venvPython, this.packageSpec, this.extraPackageSpecs);
    } else {
      this.installPackages(toolchain);
    }

    if (!this.importWorks()) {
      const imports = [this.importName, ...this.extraImportNames].join(", ");
      throw new Error(
        `provisioned env cannot import "${imports}"; the install is broken`
      );
    }

    const versionProbe = run(this.venvPython, [
      "-c",
      "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')"
    ]);
    const manifest: MlxEnvManifest = {
      version: "warrant.mlxenv.v1",
      packageSpec: this.packageSpec,
      extraPackageSpecs: this.extraPackageSpecs,
      importName: this.importName,
      toolchain:
        toolchain.kind === "uv"
          ? `uv ${toolchain.version}`
          : `venv+pip via ${toolchain.python}`,
      interpreterPath: this.venvPython,
      pythonVersion: versionProbe.stdout.trim(),
      createdAt: new Date().toISOString()
    };
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  }

  private createVenv(toolchain: Toolchain): void {
    if (toolchain.kind === "uv") {
      // uv resolves the pinned Python from the system or downloads a
      // managed CPython into the owned dir — no system-python requirement.
      const result = run(
        toolchain.bin,
        ["venv", "--python", this.pythonVersion, this.venvDir],
        this.uvEnv
      );
      if (result.status !== 0) {
        throw new MlxCapabilityError(
          `uv venv (python ${this.pythonVersion}) failed: ${result.stderr.trim() || result.stdout.trim()}`
        );
      }
      return;
    }
    const result = run(toolchain.python, ["-m", "venv", this.venvDir]);
    if (result.status !== 0) {
      throw new MlxCapabilityError(
        `failed to create venv with ${toolchain.python} -m venv: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
  }

  private installPackages(toolchain: Toolchain): void {
    const specs = [this.packageSpec, ...this.extraPackageSpecs];
    const result =
      toolchain.kind === "uv"
        ? run(
            toolchain.bin,
            ["pip", "install", "--python", this.venvPython, ...specs],
            this.uvEnv
          )
        : run(this.venvPython, [
            "-m",
            "pip",
            "install",
            "--no-input",
            "--disable-pip-version-check",
            ...specs
          ]);
    if (result.status !== 0) {
      throw new Error(
        `installing ${specs.join(", ")} failed: ${result.stderr.trim().slice(-2000)}`
      );
    }
  }

  /**
   * Provision (if needed) and produce the spawn spec for the server:
   * the venv's interpreter running `-m mlx_lm server` with a minimal,
   * explicit environment whose caches live inside the owned dir.
   */
  async prepare(model: string, port: number, extraArgs: string[] = []): Promise<SpawnSpec> {
    await this.ensureProvisioned();
    // The stock entry point is the `server` subcommand of the mlx_lm
    // module; an override (e.g. the structured overlay) is a module that is
    // itself the server and takes the same flags.
    const moduleArgs = this.serverModule
      ? ["-m", this.serverModule]
      : ["-m", "mlx_lm", "server"];
    return {
      cmd: this.venvPython,
      args: [
        ...moduleArgs,
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
