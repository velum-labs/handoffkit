import { readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { governedCompute } from "@fusionkit/adapter-compute";
import {
  runCandidateCommandWithIsolation,
  secretAbsenceMetadata
} from "@fusionkit/ensemble";
import type { CandidateContainerDriver } from "@fusionkit/ensemble";
import { makeRepo, startStack } from "@fusionkit/testkit";
import type { Stack, StackOptions } from "@fusionkit/testkit";
import { vercelSandboxBackend } from "@fusionkit/session-vercel-sandbox";
import { Sandbox } from "@vercel/sandbox";

const FILE_COUNT = Number(process.env.WARRANT_MICROVM_BENCH_FILES ?? "100");
const ITERATIONS = Number(process.env.WARRANT_MICROVM_BENCH_ITERS ?? "3");
const LIVE = process.env.WARRANT_MICROVM_LIVE === "1";
const SNAPSHOT_ID = process.env.WARRANT_MICROVM_SNAPSHOT_ID;

const BUDGETS = {
  localPhaseMs: 30_000,
  liveWarmMicrovmMs: 30_000
};

const SECTIONS = [
  "local",
  "governed-compute",
  "direct-live",
  "warm-snapshot"
] as const;

const SECTION_TITLES: Record<Section, string> = {
  local: "local path",
  "governed-compute": "governed compute path",
  "direct-live": "direct live substrate path",
  "warm-snapshot": "warm snapshot path"
};

type Section = (typeof SECTIONS)[number];

type Measurement =
  | {
      section: Section;
      name: string;
      values: number[];
      budgetMs?: number;
      unit: "ms" | "files" | "bytes";
    }
  | {
      section: Section;
      name: string;
      skipped: true;
      reason: string;
    };

type LiveSandboxResult = {
  stdout(): Promise<string>;
  stderr(): Promise<string>;
  exitCode: number;
};

type LiveSandbox = {
  runCommand(command: string, args: string[]): Promise<LiveSandboxResult>;
  stop(): Promise<unknown>;
};

type LiveSandboxFactory = {
  create(options: Record<string, unknown>): Promise<LiveSandbox>;
};

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function seedCorpus(repo: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const path = join(repo, `src/mod${i % 25}/file${i}.ts`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `export const value${i} = ${i};\n`);
  }
}

function listFiles(root: string): string[] {
  const ignored = new Set([".git", "node_modules", ".warrant"]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

function bytesFor(paths: readonly string[]): number {
  return paths.reduce((total, path) => total + statSync(path).size, 0);
}

async function measureIterations(fn: () => Promise<void> | void): Promise<number[]> {
  const values: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn();
    values.push(performance.now() - start);
  }
  return values;
}

function fakeContainerDriver(): CandidateContainerDriver {
  return {
    id: "fake-microvm-bench-container",
    supportsNetworkPolicy: true,
    execute() {
      return {
        stdout: "fake-container-ok",
        stderr: "",
        exitCode: 0,
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
}

function hasDirectLiveCredentials(): boolean {
  return Boolean(process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN);
}

function hasGovernedLiveCredentials(): boolean {
  return Boolean(process.env.VERCEL_TOKEN);
}

function directLiveCredentials(): Record<string, unknown> {
  return {
    ...(process.env.VERCEL_TOKEN ? { token: process.env.VERCEL_TOKEN } : {}),
    ...(process.env.VERCEL_TEAM_ID ? { teamId: process.env.VERCEL_TEAM_ID } : {}),
    ...(process.env.VERCEL_PROJECT_ID
      ? { projectId: process.env.VERCEL_PROJECT_ID }
      : {})
  };
}

function directSandboxCreateOptions(mode: "cold" | "warm-snapshot"): Record<string, unknown> {
  const base = {
    ...directLiveCredentials(),
    timeout: 60_000,
    persistent: false,
    networkPolicy: "deny-all",
    tags: { example: "microvm-isolation-bench", mode }
  };

  if (mode === "warm-snapshot") {
    return {
      ...base,
      source: { type: "snapshot", snapshotId: SNAPSHOT_ID }
    };
  }

  return {
    ...base,
    runtime: "node24"
  };
}

function governedLiveBackendOptions(): Parameters<typeof vercelSandboxBackend>[0] {
  return {
    runtime: "node24",
    persistent: false,
    tags: { example: "microvm-isolation-bench", mode: SNAPSHOT_ID ? "warm-snapshot" : "cold" },
    ...(SNAPSHOT_ID ? { sourceSnapshotId: SNAPSHOT_ID } : {})
  };
}

function liveBackends(): StackOptions["backends"] | undefined {
  if (!LIVE || !hasGovernedLiveCredentials()) return undefined;
  return [vercelSandboxBackend(governedLiveBackendOptions())];
}

async function runDirectSandboxProbe(mode: "cold" | "warm-snapshot"): Promise<void> {
  const factory = Sandbox as unknown as LiveSandboxFactory;
  const sandbox = await factory.create(directSandboxCreateOptions(mode));
  try {
    const result = await sandbox.runCommand("sh", ["-lc", "printf microvm-ok"]);
    const stdout = await result.stdout();
    const stderr = await result.stderr();
    if (result.exitCode !== 0 || stdout !== "microvm-ok") {
      throw new Error(`direct live sandbox failed: ${stdout}${stderr}`);
    }
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

async function measureDirectLiveVercelSandbox(
  mode: "cold" | "warm-snapshot"
): Promise<Measurement> {
  const section = mode === "warm-snapshot" ? "warm-snapshot" : "direct-live";
  const name =
    mode === "warm-snapshot"
      ? "direct vercel sandbox warm snapshot"
      : "direct vercel sandbox cold";

  if (!LIVE) {
    return {
      section,
      name,
      skipped: true,
      reason: "set WARRANT_MICROVM_LIVE=1"
    };
  }
  if (mode === "warm-snapshot" && !SNAPSHOT_ID) {
    return {
      section,
      name,
      skipped: true,
      reason: "set WARRANT_MICROVM_SNAPSHOT_ID"
    };
  }
  if (!hasDirectLiveCredentials()) {
    return {
      section,
      name,
      skipped: true,
      reason: "missing VERCEL_TOKEN or VERCEL_OIDC_TOKEN"
    };
  }

  return {
    section,
    name,
    values: await measureIterations(() => runDirectSandboxProbe(mode)),
    ...(mode === "warm-snapshot" ? { budgetMs: BUDGETS.liveWarmMicrovmMs } : {}),
    unit: "ms"
  };
}

async function measureLocalPath(repo: string): Promise<Measurement[]> {
  seedCorpus(repo, FILE_COUNT);
  const files = listFiles(repo);

  return [
    { section: "local", name: "workspace file count", values: [files.length], unit: "files" },
    {
      section: "local",
      name: "workspace staged bytes",
      values: [bytesFor(files)],
      unit: "bytes"
    },
    {
      section: "local",
      name: "file discovery",
      values: await measureIterations(() => {
        void listFiles(repo);
      }),
      budgetMs: BUDGETS.localPhaseMs,
      unit: "ms"
    },
    {
      section: "local",
      name: "process isolation command",
      values: await measureIterations(async () => {
        const result = await runCandidateCommandWithIsolation({
          command: "printf process-ok",
          cwd: repo,
          timeoutMs: 30_000
        });
        if (result.exitCode !== 0 || result.stdout !== "process-ok") {
          throw new Error("process isolation command failed");
        }
      }),
      budgetMs: BUDGETS.localPhaseMs,
      unit: "ms"
    },
    {
      section: "local",
      name: "fake container command",
      values: await measureIterations(async () => {
        const result = await runCandidateCommandWithIsolation({
          command: "printf fake-container-ok",
          cwd: repo,
          timeoutMs: 30_000,
          isolation: {
            kind: "container",
            driver: fakeContainerDriver(),
            networkPolicy: { defaultDeny: true, allowHosts: [], enforce: true },
            mountPolicy: { readOnlyCachePaths: ["/tmp/warrant-cache"] }
          }
        });
        if (result.exitCode !== 0 || result.stdout !== "fake-container-ok") {
          throw new Error("fake container command failed");
        }
      }),
      budgetMs: BUDGETS.localPhaseMs,
      unit: "ms"
    },
    {
      section: "local",
      name: "secret absence scan",
      values: await measureIterations(() => {
        const scan = secretAbsenceMetadata({
          cwd: repo,
          transcript: "clean transcript",
          secretPolicy: { secretNames: ["MICROVM_TOKEN"] },
          knownSecretValues: ["should-not-appear"]
        });
        if (scan.leaks_found) throw new Error("unexpected secret leak");
      }),
      budgetMs: BUDGETS.localPhaseMs,
      unit: "ms"
    }
  ];
}

async function measureGovernedProcessCommand(stack: Stack, repo: string): Promise<Measurement> {
  const compute = governedCompute({
    workspace: repo,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    pool: "microvm-bench",
    actor: { kind: "human", id: "microvm-bench" },
    timeoutMs: 30_000
  });
  const sandbox = await compute.sandbox.create();
  try {
    return {
      section: "governed-compute",
      name: "compute sandbox command",
      values: await measureIterations(async () => {
        const result = await sandbox.runCommand("printf compute-ok");
        if (result.exitCode !== 0 || result.output !== "compute-ok") {
          throw new Error(`compute command failed: ${result.output}`);
        }
      }),
      budgetMs: BUDGETS.localPhaseMs,
      unit: "ms"
    };
  } finally {
    await sandbox.destroy();
  }
}

async function measureGovernedLiveVercelSandbox(
  stack: Stack,
  repo: string
): Promise<Measurement> {
  const name = SNAPSHOT_ID
    ? "governed vercel-sandbox warm snapshot"
    : "governed vercel-sandbox command";

  if (!LIVE) {
    return {
      section: "governed-compute",
      name,
      skipped: true,
      reason: "set WARRANT_MICROVM_LIVE=1"
    };
  }
  if (!hasGovernedLiveCredentials()) {
    return {
      section: "governed-compute",
      name,
      skipped: true,
      reason: "missing VERCEL_TOKEN for governed backend"
    };
  }

  const compute = governedCompute({
    workspace: repo,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    pool: "microvm-bench",
    actor: { kind: "human", id: "microvm-bench" },
    timeoutMs: 60_000,
    session: "vercel-sandbox"
  });
  const sandbox = await compute.sandbox.create();
  try {
    return {
      section: "governed-compute",
      name,
      values: await measureIterations(async () => {
        const result = await sandbox.runCommand("printf governed-microvm-ok");
        if (result.exitCode !== 0 || result.output !== "governed-microvm-ok") {
          throw new Error(`governed live command failed: ${result.output}`);
        }
      }),
      ...(SNAPSHOT_ID ? { budgetMs: BUDGETS.liveWarmMicrovmMs } : {}),
      unit: "ms"
    };
  } finally {
    await sandbox.destroy();
  }
}

function printMeasurement(measurement: Measurement): boolean {
  if ("skipped" in measurement) {
    console.log(`  [SKIP] ${measurement.name.padEnd(32)} ${measurement.reason}`);
    return true;
  }
  const p50 = percentile(measurement.values, 50);
  const p95 = percentile(measurement.values, 95);
  const budget = measurement.budgetMs;
  const ok = budget === undefined || p95 <= budget;
  const status = ok ? "OK " : "FAIL";
  const budgetText = budget === undefined ? "" : ` (p95 budget ${budget} ms)`;
  console.log(
    `  [${status}] ${measurement.name.padEnd(32)} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} ${measurement.unit}${budgetText}`
  );
  return ok;
}

function printReport(measurements: readonly Measurement[]): boolean {
  console.log(`microvm isolation bench: ${FILE_COUNT} files, ${ITERATIONS} iterations`);
  console.log("");

  let ok = true;
  for (const section of SECTIONS) {
    const items = measurements.filter((measurement) => measurement.section === section);
    if (items.length === 0) continue;
    console.log(`${SECTION_TITLES[section]}:`);
    for (const measurement of items) {
      ok = printMeasurement(measurement) && ok;
    }
    console.log("");
  }

  console.log("target: warm microVM overhead <30000 ms");
  console.log(
    "note: governed live uses session=\"vercel-sandbox\"; direct live is raw substrate timing"
  );
  if (SNAPSHOT_ID) {
    console.log(`snapshot: ${SNAPSHOT_ID}`);
  }

  return ok;
}

export async function main(): Promise<void> {
  const repo = makeRepo({ files: { "README.md": "# microvm isolation bench\n" } });
  const backends = liveBackends();
  const stack = await startStack({
    pool: "microvm-bench",
    startRunner: true,
    ...(backends ? { backends } : {}),
    policy: (policy) => {
      policy.agents.allow = ["command"];
    }
  });
  const measurements: Measurement[] = [];

  try {
    measurements.push(...await measureLocalPath(repo));
    measurements.push(await measureGovernedProcessCommand(stack, repo));
    measurements.push(await measureGovernedLiveVercelSandbox(stack, repo));
    measurements.push(await measureDirectLiveVercelSandbox("cold"));
    measurements.push(await measureDirectLiveVercelSandbox("warm-snapshot"));

    const ok = printReport(measurements);
    if (!ok) process.exitCode = 1;
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
