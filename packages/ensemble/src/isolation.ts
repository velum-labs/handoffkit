import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { hashCanonicalSha256 } from "@warrant/protocol";

import type {
  CandidateContainerDriver,
  CandidateHardeningMetadata,
  CandidateIsolationConfig,
  CandidateIsolationMountPolicy,
  CandidateIsolationNetworkPolicy,
  CandidateIsolationSecretPolicy
} from "./harness.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CONTAINER_IMAGE = "node:22";
const DEFAULT_CONTAINER_ENGINE = "docker";
const DEFAULT_CONTAINER_WORKDIR = "/workspace";
const DEFAULT_IGNORED_DIRS = [".git", "node_modules", ".warrant"];
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024;

export type CandidateCommandIsolationInput = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  isolation?: CandidateIsolationConfig;
};

export type CandidateCommandIsolationResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  hardening: CandidateHardeningMetadata;
};

type NormalizedIsolation = {
  kind: "process" | "container";
  image?: string;
  engine?: "docker" | "podman";
  driver?: CandidateContainerDriver;
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
  if (isolation.kind === "container") {
    return runContainerCommand(input, isolation);
  }
  return runProcessCommand(input, isolation);
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
  const command = await runHostCommand("/bin/sh", ["-lc", input.command], input.cwd, input.timeoutMs);
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
  isolation: NormalizedIsolation
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

async function runHostCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number | undefined
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
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
  requestedIsolation: "process" | "container";
  actualIsolation: "process" | "container";
  isolation: NormalizedIsolation;
  image?: string;
  driverId?: string;
  secretAbsence: CandidateHardeningMetadata["secret_absence"];
  networkEnforced: boolean;
  cleanup: {
    attempted: boolean;
    succeeded: boolean;
    error?: string;
  };
}): CandidateHardeningMetadata {
  return {
    requested_isolation: input.requestedIsolation,
    actual_isolation: input.actualIsolation,
    runtime: {
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
      status: input.cleanup.attempted
        ? input.cleanup.succeeded
          ? "succeeded"
          : "failed"
        : "not_required",
      ...(input.cleanup.error !== undefined ? { error: input.cleanup.error } : {})
    },
    secret_absence: input.secretAbsence
  };
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
