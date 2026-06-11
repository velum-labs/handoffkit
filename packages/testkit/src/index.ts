/**
 * @warrant/testkit — in-process plane + runner stacks and git fixtures,
 * shared by the integration tests and the demo series. Everything runs
 * locally with the built-in mock agent: no vendor CLIs, no API keys.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Plane, SecretStore, defaultPolicy, startPlaneServer } from "@warrant/plane";
import { generateEd25519KeyPair } from "@warrant/protocol";
import type { Policy } from "@warrant/protocol";
import { Runner } from "@warrant/runner";
import { PlaneClient } from "@warrant/sdk";

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
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
    writeFileSync(join(dir, path), content);
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
  port?: number;
  host?: string;
};

export type Stack = {
  planeUrl: string;
  adminToken: string;
  enrollToken: string;
  plane: Plane;
  client: PlaneClient;
  runner: Runner;
  pool: string;
  /** Process one pending run on the bundled runner, if any. */
  runOnce(): Promise<string | undefined>;
  stop(): Promise<void>;
};

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

  const secretStore = new SecretStore(
    join(planeDir, "secrets.enc"),
    SecretStore.generateKeyHex()
  );
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
    enrollToken: ENROLL_TOKEN
  });
  await runner.ensureEnrolled();
  let runnerLoop: Promise<void> | undefined;
  if (options.startRunner) {
    runnerLoop = runner.start();
  }

  return {
    planeUrl,
    adminToken: ADMIN_TOKEN,
    enrollToken: ENROLL_TOKEN,
    plane,
    client: new PlaneClient(planeUrl, ADMIN_TOKEN),
    runner,
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
