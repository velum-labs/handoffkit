/**
 * @warrant/testkit — in-process plane + runner stacks and git fixtures,
 * shared by the integration tests and the demo series. Everything runs
 * locally with the built-in mock agent: no vendor CLIs, no API keys.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  defaultPolicy,
  generateMasterKeyHex,
  masterKeyFromMaterial,
  Plane,
  SecretStore,
  startPlaneServer
} from "@warrant/plane";
import { generateEd25519KeyPair } from "@warrant/protocol";
import type { Policy, RunRequestInput, WorkspaceManifest } from "@warrant/protocol";
import { Runner } from "@warrant/runner";
import type { SessionBackend } from "@warrant/runner";
import { PlaneClient } from "@warrant/sdk";
import { captureWorkspace, gitText } from "@warrant/workspace";
import type { CapturedWorkspace } from "@warrant/workspace";

/** Re-exported shared git helper so fixtures and tests share one implementation. */
export function git(cwd: string, args: string[]): string {
  return gitText(cwd, args);
}

export type RepoFixtureOptions = {
  files?: Record<string, string>;
};

/** A throwaway git repository with an initial commit. */
export function makeRepo(options: RepoFixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "warrant-repo-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "fixture@warrant.local"]);
  git(dir, ["config", "user.name", "warrant-fixture"]);
  const files = options.files ?? { "README.md": "# fixture\n" };
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "init"]);
  return dir;
}

export type StackOptions = {
  /** Mutate the default policy before the plane starts. */
  policy?: (policy: Policy) => void;
  /** Secrets to preload into the org store. */
  secrets?: Record<string, string>;
  /** Pool the bundled runner enrolls in. Defaults to "default". */
  pool?: string;
  /** Start the runner's background polling loop. Defaults to false. */
  startRunner?: boolean;
  /** Extra session backends for the bundled runner (e.g. hermetic). */
  backends?: SessionBackend[];
  port?: number;
  host?: string;
};

export type Stack = {
  planeUrl: string;
  adminToken: string;
  client: PlaneClient;
  pool: string;
  /** Process one pending run on the bundled runner, if any. */
  runOnce(): Promise<string | undefined>;
  stop(): Promise<void>;
};

/**
 * Capture a repository and upload its blobs to the plane — the standard
 * preamble of every demo/test that requests a run against real workspace
 * state.
 */
export async function uploadWorkspace(
  client: PlaneClient,
  repo: string
): Promise<CapturedWorkspace> {
  const captured = captureWorkspace(repo);
  await client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await client.putBlob(captured.dirtyDiff);
  return captured;
}

/**
 * The standard mock-agent run request the demos and tests share: human
 * requester, deny-by-default network, empty budget, minimal-context
 * disclosure. Pass overrides for whatever the scenario actually varies.
 */
export function mockRunRequest(
  input: { prompt: string; pool: string; workspace: WorkspaceManifest } & Partial<RunRequestInput>
): RunRequestInput {
  return {
    requestedBy: { kind: "human", id: "demo@example.com" },
    agentKind: "mock",
    secretNames: [],
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    ...input
  };
}

/**
 * Boot a stack and a repo fixture, run `fn`, and always tear both down —
 * the lifecycle every non-interactive demo shares.
 */
export async function withStackAndRepo(
  options: StackOptions & RepoFixtureOptions,
  fn: (ctx: { stack: Stack; repo: string }) => Promise<void>
): Promise<void> {
  const stack = await startStack(options);
  const repo = makeRepo(options.files ? { files: options.files } : {});
  try {
    await fn({ stack, repo });
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

// Fixed, well-known credentials for ephemeral in-process test stacks. The
// stack binds to loopback on a random port and is torn down with the test,
// so deterministic tokens are a feature here (assertable, greppable), not
// a security concern — production tokens are minted by `warrant init`.
const ADMIN_TOKEN = "testkit-admin-token";
const ENROLL_TOKEN = "testkit-enroll-token";

/** Boot an in-process plane plus one enrolled runner. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const pool = options.pool ?? "default";
  const planeDir = mkdtempSync(join(tmpdir(), "warrant-plane-"));
  const runnerDir = mkdtempSync(join(tmpdir(), "warrant-runner-"));

  const policy = defaultPolicy();
  if (!policy.runners.allowPools.includes(pool)) {
    policy.runners.allowPools.push(pool);
  }
  options.policy?.(policy);

  const master = masterKeyFromMaterial(generateMasterKeyHex());
  const secretStore = new SecretStore(join(planeDir, "secrets.enc"), master);
  for (const [name, value] of Object.entries(options.secrets ?? {})) {
    secretStore.set(name, value);
  }

  const keys = generateEd25519KeyPair();
  const plane = new Plane({
    dataDir: join(planeDir, "data"),
    policy,
    planePrivateKeyPem: keys.privateKeyPem,
    planePublicKeyPem: keys.publicKeyPem,
    adminToken: ADMIN_TOKEN,
    enrollToken: ENROLL_TOKEN,
    secretStore
  });
  const started = await startPlaneServer(plane, {
    port: options.port ?? 0,
    ...(options.host ? { host: options.host } : {})
  });
  const planeUrl = `http://127.0.0.1:${started.port}`;

  const runner = new Runner({
    planeUrl,
    pool,
    dataDir: runnerDir,
    enrollToken: ENROLL_TOKEN,
    ...(options.backends ? { backends: options.backends } : {})
  });
  await runner.ensureEnrolled();
  let runnerLoop: Promise<void> | undefined;
  if (options.startRunner) {
    runnerLoop = runner.start();
  }

  return {
    planeUrl,
    adminToken: ADMIN_TOKEN,
    client: new PlaneClient(planeUrl, ADMIN_TOKEN),
    pool,
    runOnce: () => runner.runOnce(),
    stop: async () => {
      runner.stop();
      if (runnerLoop) await runnerLoop;
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      rmSync(planeDir, { recursive: true, force: true });
      rmSync(runnerDir, { recursive: true, force: true });
    }
  };
}
