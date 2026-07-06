import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { MLX_HELPER_PY } from "./mlx-helper-source.js";

/**
 * FusionKit-owned MLX environment.
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
 * FUSIONKIT_UV, or PATH discovery) — it is much faster and can supply its own
 * managed CPython, removing even the system-python requirement. Without uv
 * it falls back to stdlib `python3 -m venv` + pip, so uv is an upgrade,
 * never a dependency. uv's caches and managed interpreters are contained
 * inside the owned directory, so destroy() removes them too.
 */

/** Exact-pinned mlx-lm version this provisioner installs. */
export const MLX_LM_PIN = "0.31.3";

/**
 * The velum-labs/mlx-lm fork installed in structured mode: upstream mlx-lm
 * plus the self-contained mlx_lm.structured package (see the fork's
 * STRUCTURED.md), OpenAI-compatible tool calls (tool_choice auto/none/
 * required/named with guided tool-call JSON) and embeddings, and the
 * model-fusion contract work. Pinned to the current reviewed head of the
 * fork's main branch; refresh this SHA when we intentionally pick up fork
 * fixes.
 */
export const MLX_LM_STRUCTURED_PIN =
  "mlx-lm[structured] @ git+https://github.com/velum-labs/mlx-lm@55d672f44b4a2934bdc22c1c24ba411b557a0756";

/** Python version requested from uv (which can download it if absent). */
export const PYTHON_PIN = "3.12";

/** Minimum Python the venv may be built from. */
const MIN_PYTHON = { major: 3, minor: 9 };

/**
 * Default owned directory for the MLX stack: `$FUSIONKIT_MLX_HOME` when set
 * (tests and unusual layouts), otherwise `~/.fusionkit/mlx`. A pre-rename
 * `~/.warrant/mlx` directory is moved to the new location once — the cache
 * holds gigabytes of models and must survive the rename.
 */
export function defaultMlxDir(): string {
  const override = process.env.FUSIONKIT_MLX_HOME;
  if (override !== undefined && override.length > 0) return override;
  const dir = join(homedir(), ".fusionkit", "mlx");
  const legacyDir = join(homedir(), ".warrant", "mlx");
  if (!existsSync(dir) && existsSync(legacyDir)) {
    try {
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(legacyDir, dir);
    } catch {
      // Same-volume rename failed (permissions, races); keep using the old
      // location rather than silently re-provisioning 11 GB of models.
      return legacyDir;
    }
  }
  return dir;
}

export type MlxEnvManifest = {
  version: "fusionkit.mlxenv.v1";
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

/** A locally cached MLX model, as discovered in the owned HF cache. */
export type LocalModelInfo = {
  /** Hugging Face repo id (e.g. mlx-community/Qwen3-1.7B-4bit). */
  repo: string;
  /** Bytes the repo occupies on disk. */
  sizeBytes: number;
  /** Number of files in the cached snapshot. */
  files: number;
  /** Unix seconds the repo was last modified, when known. */
  lastModified?: number;
};

/** Byte-level progress for an in-flight model download. */
export type DownloadProgress = {
  /** Bytes downloaded so far across all in-flight files. */
  downloaded: number;
  /** Total bytes when known (absent => indeterminate, e.g. Xet transfers). */
  total?: number;
  /** The most recently started file, when reported. */
  file?: string;
};

/**
 * Provisioning progress. Emitted by `ensureProvisioned({ onEvent })` so a live
 * UI can show the venv/install/verify phases and a tail of toolchain output.
 */
export type ProvisionEvent =
  | { type: "phase"; phase: "venv" | "install" | "verify"; label: string }
  | { type: "log"; line: string }
  | { type: "done" };

/** A capability the current host cannot satisfy (wrong OS, no Python). */
export class MlxCapabilityError extends Error {
  readonly code = "capability_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "MlxCapabilityError";
  }
}

export type MlxEnvOptions = {
  /** Owned directory. Defaults to defaultMlxDir(). */
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
   * Default: FUSIONKIT_UV if set, otherwise "uv" discovered on PATH,
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
    // env-spread-allowed: trusted provisioning toolchain (uv/pip) we invoke ourselves, never model-chosen commands
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

/**
 * Run a command, streaming combined stdout/stderr to `onLine` (split on
 * newlines) as it arrives. Resolves with the exit status and captured output.
 * Used for the provisioning toolchain so a live UI can show a log tail; the
 * sync `run` above stays for fast probes and the offline install hook.
 */
function runStreaming(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> | undefined,
  onLine: (line: string) => void
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      // env-spread-allowed: trusted provisioning toolchain (uv/pip) we invoke ourselves, never model-chosen commands
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {})
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const pump = (chunk: Buffer, sink: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      if (sink === "out") stdout += text;
      else stderr += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0) onLine(trimmed);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => pump(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => pump(chunk, "err"));
    child.on("error", (error) => {
      resolve({ status: 127, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      if (pending.trim().length > 0) onLine(pending.trim());
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
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
      const raw = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Record<string, unknown>;
      // One-time migration of pre-rename manifests: accept the old version
      // string, rewrite it, and carry on — the env underneath is identical
      // and must not be re-provisioned.
      if (raw.version === "warrant.mlxenv.v1") {
        raw.version = "fusionkit.mlxenv.v1";
        writeFileSync(this.manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
      }
      const parsed = raw as Partial<MlxEnvManifest>;
      if (
        parsed.version !== "fusionkit.mlxenv.v1" ||
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
          "Use a cloud model or a caller-owned fallback on this machine."
      );
    }
  }

  /**
   * Pick the provisioning toolchain. An explicit `python` option forces
   * stdlib venv+pip with that interpreter; otherwise uv is preferred
   * (explicit path, FUSIONKIT_UV, or PATH discovery) with venv+pip as the
   * no-extra-requirements fallback.
   */
  private resolveToolchain(): Toolchain {
    if (this.explicitPython !== undefined) {
      return { kind: "venv-pip", python: this.checkPython(this.explicitPython) };
    }
    if (this.uvOption !== false) {
      const explicitUv = this.uvOption ?? process.env.FUSIONKIT_UV;
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
          "(install python3, or install uv and FusionKit will manage Python itself)"
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
   *
   * Pass `onEvent` to observe phases (venv/install/verify) and a tail of the
   * toolchain output for a live UI; omit it for the original silent behavior.
   */
  ensureProvisioned(options: { onEvent?: (event: ProvisionEvent) => void } = {}): Promise<MlxEnvManifest> {
    const existing = this.readManifest();
    if (existing && this.verify()) return Promise.resolve(existing);
    if (!this.provisionPromise) {
      this.provisionPromise = this.provision(options.onEvent).finally(() => {
        this.provisionPromise = undefined;
      });
    }
    return this.provisionPromise;
  }

  private async provision(onEvent?: (event: ProvisionEvent) => void): Promise<MlxEnvManifest> {
    this.assertPlatform();
    const toolchain = this.resolveToolchain();
    const onLog = onEvent ? (line: string) => onEvent({ type: "log", line }) : undefined;

    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.hfCacheDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });

    // A stale or pin-mismatched venv is rebuilt from scratch rather than
    // upgraded in place: rebuilds are cheap and exact, upgrades are neither.
    if (existsSync(this.venvDir)) {
      rmSync(this.venvDir, { recursive: true, force: true });
    }
    onEvent?.({ type: "phase", phase: "venv", label: "creating an isolated Python environment" });
    await this.createVenv(toolchain, onLog);

    if (this.installHook) {
      this.installHook(this.venvPython, this.packageSpec, this.extraPackageSpecs);
    } else {
      onEvent?.({ type: "phase", phase: "install", label: `installing ${this.packageSpec}` });
      await this.installPackages(toolchain, onLog);
    }

    onEvent?.({ type: "phase", phase: "verify", label: "verifying the install" });
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
      version: "fusionkit.mlxenv.v1",
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
    onEvent?.({ type: "done" });
    return manifest;
  }

  /** Run a toolchain step, streaming output to `onLog` when a UI is watching. */
  private async runStep(
    cmd: string,
    args: string[],
    extraEnv: Record<string, string> | undefined,
    onLog: ((line: string) => void) | undefined
  ): Promise<RunResult> {
    if (onLog) return runStreaming(cmd, args, extraEnv, onLog);
    return run(cmd, args, extraEnv);
  }

  private async createVenv(toolchain: Toolchain, onLog?: (line: string) => void): Promise<void> {
    if (toolchain.kind === "uv") {
      // uv resolves the pinned Python from the system or downloads a
      // managed CPython into the owned dir — no system-python requirement.
      const result = await this.runStep(
        toolchain.bin,
        ["venv", "--python", this.pythonVersion, this.venvDir],
        this.uvEnv,
        onLog
      );
      if (result.status !== 0) {
        throw new MlxCapabilityError(
          `uv venv (python ${this.pythonVersion}) failed: ${result.stderr.trim() || result.stdout.trim()}`
        );
      }
      return;
    }
    const result = await this.runStep(toolchain.python, ["-m", "venv", this.venvDir], undefined, onLog);
    if (result.status !== 0) {
      throw new MlxCapabilityError(
        `failed to create venv with ${toolchain.python} -m venv: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
  }

  private async installPackages(toolchain: Toolchain, onLog?: (line: string) => void): Promise<void> {
    const specs = [this.packageSpec, ...this.extraPackageSpecs];
    const result =
      toolchain.kind === "uv"
        ? await this.runStep(
            toolchain.bin,
            ["pip", "install", "--python", this.venvPython, ...specs],
            this.uvEnv,
            onLog
          )
        : await this.runStep(
            this.venvPython,
            ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", ...specs],
            undefined,
            onLog
          );
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

  /** The model-ops helper path inside the owned dir (rewritten to stay in sync). */
  private get helperPath(): string {
    return join(this.dir, "mlx-helper.py");
  }

  /** Minimal, owned-cache environment for helper (scan/download) spawns. */
  private helperEnv(): Record<string, string> {
    return {
      PATH: [dirname(this.venvPython), "/usr/bin", "/bin"].join(delimiter),
      HOME: homedir(),
      HF_HOME: this.hfCacheDir,
      HF_HUB_DISABLE_TELEMETRY: "1",
      VIRTUAL_ENV: this.venvDir
    };
  }

  /** Materialize the embedded helper into the owned dir and return its path. */
  private writeHelper(): string {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.helperPath, MLX_HELPER_PY);
    return this.helperPath;
  }

  /**
   * Run the helper, parsing each stdout line as JSON and forwarding it to
   * `onEvent`. Resolves with the exit status; non-JSON lines are ignored
   * (tqdm draws to stderr, so stdout stays pure NDJSON).
   */
  private runHelper(
    args: string[],
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const helper = this.writeHelper();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const child = spawn(this.venvPython, [helper, ...args], { env: this.helperEnv() });
      let pending = "";
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (parsed !== null && typeof parsed === "object") {
          onEvent(parsed as Record<string, unknown>);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (pending.length > 0) handleLine(pending);
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        resolve(code ?? 1);
      });
    });
  }

  /**
   * Discover MLX models already in the owned HF cache. Returns [] when the env
   * is not provisioned yet (the cache is then empty by construction). Reuses
   * mlx-lm's pinned `huggingface_hub` via the owned interpreter.
   */
  async scanModels(): Promise<LocalModelInfo[]> {
    if (!existsSync(this.venvPython)) return [];
    const models: LocalModelInfo[] = [];
    let errored: string | undefined;
    await this.runHelper(["scan"], (event) => {
      if (event.type === "model" && typeof event.repo === "string") {
        models.push({
          repo: event.repo,
          sizeBytes: typeof event.sizeBytes === "number" ? event.sizeBytes : 0,
          files: typeof event.files === "number" ? event.files : 0,
          ...(typeof event.lastModified === "number" ? { lastModified: event.lastModified } : {})
        });
      } else if (event.type === "error" && typeof event.message === "string") {
        errored = event.message;
      }
    });
    // A broken/missing huggingface_hub is reported, not silently empty.
    if (errored !== undefined && models.length === 0) return [];
    return models.sort((a, b) => a.repo.localeCompare(b.repo));
  }

  /**
   * Download a model's weights into the owned cache, provisioning the env first
   * if needed. Progress is reported via `onProgress`; the download is resumable
   * (HF skips files already on disk) and an aborted `signal` leaves resumable
   * partials in place. Resolves to the on-disk snapshot path.
   */
  async downloadModel(
    repo: string,
    options: { onProgress?: (progress: DownloadProgress) => void; signal?: AbortSignal } = {}
  ): Promise<string> {
    await this.ensureProvisioned();
    let path: string | undefined;
    let errored: string | undefined;
    let lastFile: string | undefined;
    const code = await this.runHelper(
      ["download", repo],
      (event) => {
        if (event.type === "file" && typeof event.name === "string") {
          lastFile = event.name;
        } else if (event.type === "progress" && typeof event.downloaded === "number") {
          options.onProgress?.({
            downloaded: event.downloaded,
            ...(typeof event.total === "number" ? { total: event.total } : {}),
            ...(lastFile !== undefined ? { file: lastFile } : {})
          });
        } else if (event.type === "download_done" && typeof event.path === "string") {
          path = event.path;
        } else if (event.type === "error" && typeof event.message === "string") {
          errored = event.message;
        }
      },
      options.signal
    );
    if (errored !== undefined) throw new Error(`download failed for ${repo}: ${errored}`);
    if (code !== 0 || path === undefined) {
      throw new Error(`download failed for ${repo} (exit ${code})`);
    }
    return path;
  }

  /**
   * Remove a single model's weights from the owned HF cache (the standard
   * `hub/models--org--name` directory under `HF_HOME`). Returns whether the
   * model was present. The venv and other models are left untouched.
   */
  removeModel(repo: string): boolean {
    const dirName = `models--${repo.replace(/\//g, "--")}`;
    const target = join(this.hfCacheDir, "hub", dirName);
    if (!existsSync(target)) return false;
    rmSync(target, { recursive: true, force: true });
    return true;
  }
}
