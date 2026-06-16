import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RunContract, RunEvent } from "@warrant/protocol";
import {
  CapabilityMismatchError,
  prepareExecution,
  type SessionExecution
} from "@warrant/runner";

import {
  listWorkspaceFiles,
  SANDBOX_IGNORED_DIRS,
  toVercelNetwork,
  VercelSandboxBackend,
  type VercelSandboxCreateInput,
  type VercelSandboxInstance
} from "../index.js";

type FakeSandbox = {
  sandbox: VercelSandboxInstance;
  mkdirCalls: Array<{ path: string; recursive?: boolean }>;
  runCalls: Array<{ command: string; args: string[] }>;
  stopCalled: boolean;
  writtenFiles: Array<{ path: string; content: string | Uint8Array }>;
};

function contractFixture(overrides: Partial<RunContract> = {}): RunContract {
  return {
    version: "warrant.contract.v1",
    runId: "run_vercel_sandbox_test",
    issuedAt: "2026-06-11T00:00:00.000Z",
    issuer: { keyId: "ed25519:0000000000000000", role: "plane" },
    requestedBy: { kind: "human", id: "alice" },
    agent: { kind: "command" },
    task: { prompt: "echo hi" },
    runner: { pool: "default" },
    workspace: {
      version: "warrant.manifest.v1",
      baseRef: "abc",
      bundleHash: "1".repeat(64),
      untrackedFiles: [],
      deniedPatterns: [],
      deniedPaths: []
    },
    policyHash: "2".repeat(64),
    secrets: [],
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    expiresAt: "2026-06-11T01:00:00.000Z",
    signatures: [],
    ...overrides
  };
}

function sessionInput(input: {
  repoDir: string;
  contract?: RunContract;
  secrets?: { name: string; value: string }[];
  emit?: (event: RunEvent) => void;
}): SessionExecution {
  const contract = input.contract ?? contractFixture();
  return {
    contract,
    repoDir: input.repoDir,
    secrets: input.secrets ?? [],
    execution: prepareExecution({ contract, mockScriptPath: "/tmp/mock-agent.js" }),
    emit: input.emit ?? (() => undefined)
  };
}

function makeRepo(files: Record<string, string>): string {
  const repoDir = mkdtempSync(join(tmpdir(), "vercel-sandbox-test-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(repoDir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return repoDir;
}

function makeFakeSandbox(input: {
  stdout?: string;
  stderr?: string;
  runError?: Error;
  stopError?: Error;
  readdir?: (path: string) => string[];
  directories?: ReadonlySet<string>;
  files?: ReadonlyMap<string, Uint8Array>;
} = {}): FakeSandbox {
  const fake: FakeSandbox = {
    sandbox: undefined as unknown as VercelSandboxInstance,
    mkdirCalls: [],
    runCalls: [],
    stopCalled: false,
    writtenFiles: []
  };
  fake.sandbox = {
    fs: {
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        fake.mkdirCalls.push({ path, recursive: options?.recursive });
      },
      readdir: async (path: string) => input.readdir?.(path) ?? [],
      stat: async (path: string) => ({
        isDirectory: () => input.directories?.has(path) ?? false
      }),
      readFile: async (path: string) =>
        Buffer.from(input.files?.get(path) ?? new Uint8Array())
    },
    writeFiles: async (
      files: Array<{ path: string; content: string | Uint8Array }>
    ) => {
      fake.writtenFiles.push(...files);
    },
    runCommand: async (command: string, args: string[]) => {
      fake.runCalls.push({ command, args });
      if (input.runError) throw input.runError;
      return {
        exitCode: 0,
        stdout: async () => input.stdout ?? "",
        stderr: async () => input.stderr ?? ""
      };
    },
    stop: async () => {
      fake.stopCalled = true;
      if (input.stopError) throw input.stopError;
      return {};
    }
  } as unknown as VercelSandboxInstance;
  return fake;
}

test("network policy maps to Vercel Sandbox egress policy", () => {
  assert.equal(toVercelNetwork({ defaultDeny: false, allowHosts: [] }), "allow-all");
  assert.equal(toVercelNetwork({ defaultDeny: true, allowHosts: [] }), "deny-all");
  assert.deepEqual(
    toVercelNetwork({
      defaultDeny: true,
      allowHosts: ["api.example.com", "registry.npmjs.org"]
    }),
    { allow: ["api.example.com", "registry.npmjs.org"] }
  );
});

test("workspace staging ignores VCS, dependencies, and Warrant state", () => {
  assert.ok(SANDBOX_IGNORED_DIRS.has(".warrant"));
  const repoDir = makeRepo({
    "README.md": "keep\n",
    ".git/config": "local git metadata\n",
    "node_modules/pkg/index.js": "dependency\n",
    ".warrant/cache.json": "local warrant state\n",
    "src/index.ts": "export {}\n",
    "src/.warrant/trace.json": "nested warrant state\n"
  });
  try {
    assert.deepEqual(listWorkspaceFiles(repoDir).sort(), [
      "README.md",
      "src/index.ts"
    ]);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("backend passes hardened create options and honors execution cwd", async () => {
  const repoDir = makeRepo({
    "README.md": "root\n",
    "packages/app/package.json": "{}\n"
  });
  const fake = makeFakeSandbox({ stdout: "ok\n" });
  let createInput: VercelSandboxCreateInput | undefined;
  const backend = new VercelSandboxBackend({
    token: "fake-token",
    runtime: "node24",
    sourceSnapshotId: "snap_123",
    tags: { run: "test", lane: "vercel-backend" },
    resources: { vcpus: 4 },
    createSandbox: async (input) => {
      createInput = input;
      return fake.sandbox;
    }
  });
  const contract = contractFixture({
    network: { defaultDeny: true, allowHosts: ["api.example.com"] },
    execution: {
      kind: "shell",
      script: "pwd",
      cwd: "packages/app",
      timeoutMs: 12_345
    }
  });

  try {
    const result = await backend.execute(sessionInput({ repoDir, contract }));

    assert.equal(result.exitCode, 0);
    assert.equal(result.log.toString("utf8"), "ok\n");
    assert.deepEqual(createInput, {
      token: "fake-token",
      timeout: 12_345,
      networkPolicy: { allow: ["api.example.com"] },
      persistent: false,
      resources: { vcpus: 4 },
      tags: { run: "test", lane: "vercel-backend" },
      source: { type: "snapshot", snapshotId: "snap_123" }
    });
    assert.ok(createInput && !("runtime" in createInput));
    assert.deepEqual(fake.mkdirCalls, [
      { path: "/warrant/workspace", recursive: true }
    ]);
    assert.deepEqual(
      fake.writtenFiles.map((file) => file.path).sort(),
      [
        "/warrant/workspace/README.md",
        "/warrant/workspace/packages/app/package.json"
      ]
    );
    assert.equal(fake.runCalls.length, 1);
    assert.equal(fake.runCalls[0]?.command, "sh");
    assert.equal(
      fake.runCalls[0]?.args[1],
      "cd '/warrant/workspace/packages/app' && pwd"
    );
    assert.equal(fake.stopCalled, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("backend fails closed without Vercel credentials", async () => {
  const repoDir = makeRepo({ "README.md": "root\n" });
  const previous = {
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID
  };
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_PROJECT_ID;
  let created = false;
  const backend = new VercelSandboxBackend({
    createSandbox: async () => {
      created = true;
      return makeFakeSandbox().sandbox;
    }
  });

  try {
    await assert.rejects(
      backend.execute(sessionInput({ repoDir })),
      CapabilityMismatchError
    );
    assert.equal(created, false);
  } finally {
    if (previous.VERCEL_TOKEN === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previous.VERCEL_TOKEN;
    if (previous.VERCEL_TEAM_ID === undefined) delete process.env.VERCEL_TEAM_ID;
    else process.env.VERCEL_TEAM_ID = previous.VERCEL_TEAM_ID;
    if (previous.VERCEL_PROJECT_ID === undefined) {
      delete process.env.VERCEL_PROJECT_ID;
    } else {
      process.env.VERCEL_PROJECT_ID = previous.VERCEL_PROJECT_ID;
    }
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("backend stops sandbox after execution failure", async () => {
  const repoDir = makeRepo({ "README.md": "root\n" });
  const fake = makeFakeSandbox({ runError: new Error("boom") });
  const backend = new VercelSandboxBackend({
    token: "fake-token",
    createSandbox: async () => fake.sandbox
  });

  try {
    await assert.rejects(backend.execute(sessionInput({ repoDir })), /boom/);
    assert.equal(fake.stopCalled, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("backend swallows sandbox stop failures after successful execution", async () => {
  const repoDir = makeRepo({ "README.md": "root\n" });
  const fake = makeFakeSandbox({
    stdout: "done\n",
    stopError: new Error("stop failed")
  });
  const backend = new VercelSandboxBackend({
    token: "fake-token",
    createSandbox: async () => fake.sandbox
  });

  try {
    const result = await backend.execute(sessionInput({ repoDir }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.log.toString("utf8"), "done\n");
    assert.equal(fake.stopCalled, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
