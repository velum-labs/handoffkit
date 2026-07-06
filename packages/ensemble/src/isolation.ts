import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { hashCanonicalSha256 } from "@fusionkit/protocol";
import { buildChildEnv, CANDIDATE_ISOLATION_DEFAULTS } from "@fusionkit/runtime-utils";

import type {
  CandidateActualIsolationKind,
  CandidateContainerDriver,
  CandidateHardeningMetadata,
  CandidateIsolationConfig,
  CandidateIsolationMountPolicy,
  CandidateIsolationNetworkPolicy,
  CandidateIsolationSecretPolicy,
  CandidateMicrovmDriver,
  CandidateMicrovmProvider,
  CandidateMicrovmRuntimeMetadata
} from "./harness.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CONTAINER_IMAGE = CANDIDATE_ISOLATION_DEFAULTS.containerImage;
const DEFAULT_CONTAINER_ENGINE = CANDIDATE_ISOLATION_DEFAULTS.containerEngine;
const DEFAULT_CONTAINER_WORKDIR = CANDIDATE_ISOLATION_DEFAULTS.containerWorkdir;
const DEFAULT_MICROVM_PROVIDER: CandidateMicrovmProvider =
  CANDIDATE_ISOLATION_DEFAULTS.microvmProvider;
const DEFAULT_MICROVM_RUNTIME = CANDIDATE_ISOLATION_DEFAULTS.microvmRuntime;
const UNKNOWN_RUNTIME_DIGEST = CANDIDATE_ISOLATION_DEFAULTS.unknownRuntimeDigest;
const DEFAULT_IGNORED_DIRS = [".git", "node_modules", ".warrant", ".fusionkit"];
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024;

export type CandidateCommandIsolationInput = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  isolation?: CandidateIsolationConfig;
  env?: Record<string, string | undefined>;
};

export type CandidateCommandIsolationResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  hardening: CandidateHardeningMetadata;
};

type NormalizedIsolation =
  | {
      kind: "process";
      networkPolicy: Required<CandidateIsolationNetworkPolicy>;
      mountPolicy: Required<CandidateIsolationMountPolicy>;
      secretPolicy: Required<CandidateIsolationSecretPolicy>;
    }
  | {
      kind: "container";
      image: string;
      engine: "docker" | "podman";
      driver?: CandidateContainerDriver;
      networkPolicy: Required<CandidateIsolationNetworkPolicy>;
      mountPolicy: Required<CandidateIsolationMountPolicy>;
      secretPolicy: Required<CandidateIsolationSecretPolicy>;
    }
  | {
      kind: "microvm";
      provider: CandidateMicrovmProvider;
      runtime: string;
      snapshotId?: string;
      sandboxId?: string;
      imageDigest?: string;
      runtimeDigest?: string;
      driver?: CandidateMicrovmDriver;
      networkPolicy: Required<CandidateIsolationNetworkPolicy>;
      mountPolicy: Required<CandidateIsolationMountPolicy>;
      secretPolicy: Required<CandidateIsolationSecretPolicy>;
    };

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export async function runCandidateCommandWithIsolation(
  input: CandidateCommandIsolationInput
): Promise<CandidateCommandIsolationResult> {
  const isolation = normalizeIsolation(input.isolation);
  switch (isolation.kind) {
    case "process":
      return runProcessCommand(input, isolation);
    case "container":
      return runContainerCommand(input, isolation);
    case "microvm":
      return runMicrovmCommand(input, isolation);
    default:
      return assertNever(isolation);
  }
}

export function createCliContainerDriver(
  engine: "docker" | "podman" = DEFAULT_CONTAINER_ENGINE
): CandidateContainerDriver {
  return {
    id: engine,
    supportsNetworkPolicy: false,
    async execute(input) {
      const args = [
        "run",
        "--rm",
        "-v",
        `${input.cwd}:${input.workdir}:rw`,
        "-w",
        input.workdir
      ];
      for (const cachePath of input.mountPolicy.readOnlyCachePaths) {
        args.push("-v", `${cachePath}:${cachePath}:ro`);
      }
      if (input.networkPolicy.defaultDeny && input.networkPolicy.allowHosts.length === 0) {
        args.push("--network", "none");
      }
      args.push(input.image, "sh", "-lc", input.command);
      const result = await runHostCommand(engine, args, input.cwd, input.timeoutMs);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        cleanup: {
          attempted: true,
          succeeded: !result.timedOut,
          ...(result.timedOut
            ? { error: "container cleanup not confirmed after timeout" }
            : {})
        }
      };
    }
  };
}

export function secretAbsenceMetadata(input: {
  cwd: string;
  transcript: string;
  secretPolicy?: CandidateIsolationSecretPolicy;
  ignoredDirs?: readonly string[];
  knownSecretValues?: readonly string[];
}): CandidateHardeningMetadata["secret_absence"] {
  const secretPolicy = normalizeSecretPolicy(input.secretPolicy);
  const scanScope = ["transcript"];
  const haystacks = [input.transcript];
  for (const file of listScannableFiles(input.cwd, input.ignoredDirs ?? DEFAULT_IGNORED_DIRS)) {
    scanScope.push(`file:${file.relativePath}`);
    haystacks.push(file.content);
  }
  const leaks = countLeaks(haystacks, [
    ...secretPolicy.secretNames,
    ...secretPolicy.secretValueHashes,
    ...(input.knownSecretValues ?? [])
  ]);
  return {
    secret_names: secretPolicy.secretNames,
    secret_value_hashes: secretPolicy.secretValueHashes,
    injected_env_names: secretPolicy.injectedEnvNames,
    scanned: true,
    leaks_found: leaks > 0,
    scan_scope: scanScope,
    leak_count: leaks
  };
}

async function runProcessCommand(
  input: CandidateCommandIsolationInput,
  isolation: NormalizedIsolation
): Promise<CandidateCommandIsolationResult> {
  const command = await runHostCommand(
    "/bin/sh",
    ["-lc", input.command],
    input.cwd,
    input.timeoutMs,
    input.env
  );
  const transcript = [command.stdout, command.stderr].filter(Boolean).join("\n");
  return {
    ...command,
    hardening: hardeningMetadata({
      requestedIsolation: isolation.kind,
      actualIsolation: "process",
      isolation,
      secretAbsence: secretAbsenceMetadata({
        cwd: input.cwd,
        transcript,
        secretPolicy: isolation.secretPolicy,
        ignoredDirs: isolation.mountPolicy.ignoredDirs
      }),
      networkEnforced: false,
      cleanup: {
        attempted: false,
        succeeded: true
      }
    })
  };
}

async function runContainerCommand(
  input: CandidateCommandIsolationInput,
  isolation: Extract<NormalizedIsolation, { kind: "container" }>
): Promise<CandidateCommandIsolationResult> {
  const driver =
    isolation.driver ?? createCliContainerDriver(isolation.engine ?? DEFAULT_CONTAINER_ENGINE);
  const image = isolation.image ?? DEFAULT_CONTAINER_IMAGE;
  if (
    isolation.networkPolicy.enforce &&
    isolation.networkPolicy.defaultDeny &&
    isolation.networkPolicy.allowHosts.length > 0 &&
    !driver.supportsNetworkPolicy
  ) {
    const stderr = "container driver cannot enforce host allowlist network policy";
    const secretAbsence = secretAbsenceMetadata({
      cwd: input.cwd,
      transcript: stderr,
      secretPolicy: isolation.secretPolicy,
      ignoredDirs: isolation.mountPolicy.ignoredDirs
    });
    return {
      stdout: "",
      stderr,
      exitCode: 1,
      timedOut: false,
      hardening: hardeningMetadata({
        requestedIsolation: "container",
        actualIsolation: "container",
        isolation,
        driverId: driver.id,
        image,
        secretAbsence,
        networkEnforced: true,
        cleanup: {
          attempted: true,
          succeeded: false,
          error: "network policy unsupported"
        }
      })
    };
  }

  let result: Awaited<ReturnType<CandidateContainerDriver["execute"]>>;
  try {
    result = await driver.execute({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      image,
      workdir: isolation.mountPolicy.workdir,
      mountPolicy: isolation.mountPolicy,
      networkPolicy: isolation.networkPolicy
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      stdout: "",
      stderr: message,
      exitCode: 1,
      timedOut: false,
      cleanup: {
        attempted: true,
        succeeded: false,
        error: message
      }
    };
  }
  const transcript = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    hardening: hardeningMetadata({
      requestedIsolation: "container",
      actualIsolation: "container",
      isolation,
      driverId: driver.id,
      image,
      secretAbsence: secretAbsenceMetadata({
        cwd: input.cwd,
        transcript,
        secretPolicy: isolation.secretPolicy,
        ignoredDirs: isolation.mountPolicy.ignoredDirs
      }),
      networkEnforced:
        isolation.networkPolicy.enforce &&
        (driver.supportsNetworkPolicy ||
          (isolation.networkPolicy.defaultDeny &&
            isolation.networkPolicy.allowHosts.length === 0)),
      cleanup: result.cleanup ?? {
        attempted: true,
        succeeded: true
      }
    })
  };
}

async function runMicrovmCommand(
  input: CandidateCommandIsolationInput,
  isolation: Extract<NormalizedIsolation, { kind: "microvm" }>
): Promise<CandidateCommandIsolationResult> {
  const driver = isolation.driver;
  if (driver === undefined) {
    const stderr = "microVM isolation requires an execution driver";
    return {
      stdout: "",
      stderr,
      exitCode: 1,
      timedOut: false,
      hardening: hardeningMetadata({
        requestedIsolation: "microvm",
        actualIsolation: "process",
        isolation,
        runtimeFields: microvmRuntimeFields(isolation),
        secretAbsence: secretAbsenceMetadata({
          cwd: input.cwd,
          transcript: stderr,
          secretPolicy: isolation.secretPolicy,
          ignoredDirs: isolation.mountPolicy.ignoredDirs
        }),
        networkEnforced: false,
        cleanup: {
          attempted: false,
          succeeded: true
        }
      })
    };
  }

  if (
    isolation.networkPolicy.enforce &&
    isolation.networkPolicy.defaultDeny &&
    isolation.networkPolicy.allowHosts.length > 0 &&
    !driver.supportsNetworkPolicy
  ) {
    const stderr = "microVM driver cannot enforce host allowlist network policy";
    return {
      stdout: "",
      stderr,
      exitCode: 1,
      timedOut: false,
      hardening: hardeningMetadata({
        requestedIsolation: "microvm",
        actualIsolation: actualMicrovmIsolation(driver.provider),
        isolation,
        driverId: driver.id,
        runtimeFields: microvmRuntimeFields(isolation, driver),
        secretAbsence: secretAbsenceMetadata({
          cwd: input.cwd,
          transcript: stderr,
          secretPolicy: isolation.secretPolicy,
          ignoredDirs: isolation.mountPolicy.ignoredDirs
        }),
        networkEnforced: true,
        cleanup: {
          attempted: true,
          succeeded: false,
          error: "network policy unsupported"
        }
      })
    };
  }

  let result: Awaited<ReturnType<CandidateMicrovmDriver["execute"]>>;
  try {
    result = await driver.execute({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      provider: isolation.provider,
      runtime: isolation.runtime,
      snapshotId: isolation.snapshotId,
      workdir: isolation.mountPolicy.workdir,
      mountPolicy: isolation.mountPolicy,
      networkPolicy: isolation.networkPolicy,
      secretPolicy: isolation.secretPolicy
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      stdout: "",
      stderr: message,
      exitCode: 1,
      timedOut: false,
      actualIsolation: actualMicrovmIsolation(driver.provider),
      cleanup: {
        attempted: true,
        succeeded: false,
        error: message
      }
    };
  }

  const transcript = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    hardening: hardeningMetadata({
      requestedIsolation: "microvm",
      actualIsolation: result.actualIsolation ?? actualMicrovmIsolation(driver.provider),
      isolation,
      driverId: driver.id,
      runtimeFields: microvmRuntimeFields(isolation, driver, result.runtime),
      secretAbsence: secretAbsenceMetadata({
        cwd: input.cwd,
        transcript,
        secretPolicy: isolation.secretPolicy,
        ignoredDirs: isolation.mountPolicy.ignoredDirs
      }),
      networkEnforced: isolation.networkPolicy.enforce && driver.supportsNetworkPolicy,
      cleanup: result.cleanup ?? {
        attempted: true,
        succeeded: true
      }
    })
  };
}

async function runHostCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number | undefined,
  env?: Record<string, string | undefined>
): Promise<CommandResult> {
  // Candidate commands are model-influenced, so the child env is always
  // allowlist-built (system baseline + caller-injected values); the parent's
  // credentials are never inherited wholesale.
  const extra = Object.fromEntries(
    Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const mergedEnv = buildChildEnv({ extra });
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: mergedEnv,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {})
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      timedOut: false
    };
  } catch (error) {
    const failed = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string;
      killed?: boolean;
      message?: string;
    };
    const timedOut = failed.killed === true || failed.signal === "SIGTERM";
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message ?? "",
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      timedOut
    };
  }
}

function normalizeIsolation(
  isolation: CandidateIsolationConfig | undefined
): NormalizedIsolation {
  const kind = isolation?.kind ?? "process";
  const mountPolicy = normalizeMountPolicy(isolation?.mountPolicy);
  const networkPolicy = normalizeNetworkPolicy(isolation?.networkPolicy);
  const secretPolicy = normalizeSecretPolicy(isolation?.secretPolicy);
  if (isolation?.kind === "container") {
    return {
      kind: "container",
      image: isolation?.image ?? DEFAULT_CONTAINER_IMAGE,
      engine: isolation?.engine ?? DEFAULT_CONTAINER_ENGINE,
      driver: isolation?.driver,
      mountPolicy,
      networkPolicy,
      secretPolicy
    };
  }
  if (isolation?.kind === "microvm") {
    return {
      kind: "microvm",
      provider: isolation.provider ?? DEFAULT_MICROVM_PROVIDER,
      runtime: isolation.runtime ?? DEFAULT_MICROVM_RUNTIME,
      snapshotId: isolation.snapshotId,
      sandboxId: isolation.sandboxId,
      imageDigest: isolation.imageDigest,
      runtimeDigest: isolation.runtimeDigest ?? UNKNOWN_RUNTIME_DIGEST,
      driver: isolation.driver,
      mountPolicy,
      networkPolicy,
      secretPolicy
    };
  }
  return {
    kind: "process",
    mountPolicy,
    networkPolicy,
    secretPolicy
  };
}

function normalizeMountPolicy(
  policy: CandidateIsolationMountPolicy | undefined
): Required<CandidateIsolationMountPolicy> {
  return {
    workdir: policy?.workdir ?? DEFAULT_CONTAINER_WORKDIR,
    worktreeWritable: policy?.worktreeWritable ?? true,
    readOnlyCachePaths: [...(policy?.readOnlyCachePaths ?? [])],
    ignoredDirs: [...(policy?.ignoredDirs ?? DEFAULT_IGNORED_DIRS)]
  };
}

function normalizeNetworkPolicy(
  policy: CandidateIsolationNetworkPolicy | undefined
): Required<CandidateIsolationNetworkPolicy> {
  return {
    defaultDeny: policy?.defaultDeny ?? true,
    allowHosts: [...(policy?.allowHosts ?? [])],
    enforce: policy?.enforce ?? true
  };
}

function normalizeSecretPolicy(
  policy: CandidateIsolationSecretPolicy | undefined
): Required<CandidateIsolationSecretPolicy> {
  return {
    secretNames: [...(policy?.secretNames ?? [])],
    secretValueHashes: [...(policy?.secretValueHashes ?? [])],
    injectedEnvNames: [...(policy?.injectedEnvNames ?? [])]
  };
}

function hardeningMetadata(input: {
  requestedIsolation: CandidateIsolationConfig["kind"];
  actualIsolation: CandidateActualIsolationKind;
  isolation: NormalizedIsolation;
  image?: string;
  driverId?: string;
  runtimeFields?: Partial<Omit<CandidateHardeningMetadata["runtime"], "workdir">>;
  secretAbsence: CandidateHardeningMetadata["secret_absence"];
  networkEnforced: boolean;
  cleanup: {
    attempted: boolean;
    succeeded: boolean;
    timedOut?: boolean;
    error?: string;
  };
}): CandidateHardeningMetadata {
  return {
    requested_isolation: input.requestedIsolation,
    actual_isolation: input.actualIsolation,
    runtime: {
      ...(input.runtimeFields ?? {}),
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.driverId !== undefined ? { driver: input.driverId } : {}),
      workdir: input.isolation.mountPolicy.workdir
    },
    mount_policy: {
      worktree_writable: input.isolation.mountPolicy.worktreeWritable,
      read_only_caches: input.isolation.mountPolicy.readOnlyCachePaths,
      ignored_dirs: input.isolation.mountPolicy.ignoredDirs
    },
    network_policy: {
      default_deny: input.isolation.networkPolicy.defaultDeny,
      allow_hosts: input.isolation.networkPolicy.allowHosts,
      enforced: input.networkEnforced
    },
    cleanup: {
      attempted: input.cleanup.attempted,
      succeeded: input.cleanup.succeeded,
      status: cleanupStatus(input.cleanup),
      ...(input.cleanup.timedOut === true ? { timed_out: true } : {}),
      ...(input.cleanup.error !== undefined ? { error: input.cleanup.error } : {})
    },
    secret_absence: input.secretAbsence
  };
}

function cleanupStatus(input: {
  attempted: boolean;
  succeeded: boolean;
  timedOut?: boolean;
}): CandidateHardeningMetadata["cleanup"]["status"] {
  if (!input.attempted) return "not_required";
  if (input.succeeded) return "succeeded";
  if (input.timedOut === true) return "timed_out";
  return "failed";
}

function actualMicrovmIsolation(
  provider: CandidateMicrovmProvider
): Extract<CandidateActualIsolationKind, "microvm" | "vercel-sandbox"> {
  return provider === "vercel-sandbox" ? "vercel-sandbox" : "microvm";
}

function microvmRuntimeFields(
  isolation: Extract<NormalizedIsolation, { kind: "microvm" }>,
  driver?: CandidateMicrovmDriver,
  runtime?: CandidateMicrovmRuntimeMetadata
): Partial<Omit<CandidateHardeningMetadata["runtime"], "workdir">> {
  return {
    provider: runtime?.provider ?? driver?.provider ?? isolation.provider,
    runtime: runtime?.runtime ?? isolation.runtime,
    ...(runtime?.snapshotId ?? isolation.snapshotId
      ? { snapshot_id: runtime?.snapshotId ?? isolation.snapshotId }
      : {}),
    ...(runtime?.sandboxId ?? isolation.sandboxId
      ? { sandbox_id: runtime?.sandboxId ?? isolation.sandboxId }
      : {}),
    ...(runtime?.imageDigest ?? isolation.imageDigest
      ? { image_digest: runtime?.imageDigest ?? isolation.imageDigest }
      : {}),
    runtime_digest: runtime?.runtimeDigest ?? isolation.runtimeDigest ?? UNKNOWN_RUNTIME_DIGEST
  };
}

function assertNever(value: never): never {
  throw new Error(`unsupported candidate isolation kind: ${String(value)}`);
}

function listScannableFiles(
  root: string,
  ignoredDirs: readonly string[]
): { relativePath: string; content: string }[] {
  if (!existsSync(root)) return [];
  const ignored = new Set(ignoredDirs);
  const files: { relativePath: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = statSync(path).size;
      if (size > DEFAULT_MAX_SCAN_BYTES) continue;
      files.push({
        relativePath: relative(root, path),
        content: readFileSync(path, "utf8")
      });
    }
  };
  walk(root);
  return files;
}

function countLeaks(haystacks: readonly string[], needles: readonly string[]): number {
  const activeNeedles = needles.filter((needle) => needle.length > 0);
  let count = 0;
  for (const haystack of haystacks) {
    for (const needle of activeNeedles) {
      if (haystack.includes(needle)) count += 1;
    }
  }
  return count;
}

export function secretValueHash(value: string): string {
  return hashCanonicalSha256(value);
}
