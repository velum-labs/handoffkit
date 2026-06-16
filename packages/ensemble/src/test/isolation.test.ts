import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CandidateContainerDriver, CandidateMicrovmDriver } from "../harness.js";
import {
  runCandidateCommandWithIsolation,
  secretAbsenceMetadata,
  secretValueHash
} from "../isolation.js";

function workspaceFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "candidate-isolation-"));
  writeFileSync(join(root, "README.md"), "# isolated\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("process isolation preserves current command behavior and records hardening", async () => {
  const workspace = workspaceFixture();
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "printf process-ok",
      cwd: workspace.root,
      timeoutMs: 1000
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "process-ok");
    assert.equal(result.hardening.requested_isolation, "process");
    assert.equal(result.hardening.actual_isolation, "process");
    assert.equal(result.hardening.cleanup.status, "not_required");
    assert.equal(result.hardening.network_policy.default_deny, true);
    assert.equal(result.hardening.network_policy.enforced, false);
  } finally {
    workspace.cleanup();
  }
});

test("fake container isolation records runtime, mounts, network, and cleanup", async () => {
  const workspace = workspaceFixture();
  const driver: CandidateContainerDriver = {
    id: "fake-container",
    supportsNetworkPolicy: true,
    execute(input) {
      assert.equal(input.image, "node:22-test");
      assert.equal(input.workdir, "/workspace");
      assert.deepEqual(input.mountPolicy.readOnlyCachePaths, ["/tmp/cache"]);
      assert.deepEqual(input.networkPolicy.allowHosts, ["registry.example.com"]);
      return {
        stdout: "container-ok",
        stderr: "",
        exitCode: 0,
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "printf container-ok",
      cwd: workspace.root,
      isolation: {
        kind: "container",
        image: "node:22-test",
        driver,
        mountPolicy: { readOnlyCachePaths: ["/tmp/cache"] },
        networkPolicy: {
          defaultDeny: true,
          allowHosts: ["registry.example.com"],
          enforce: true
        }
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "container-ok");
    assert.equal(result.hardening.requested_isolation, "container");
    assert.equal(result.hardening.runtime.image, "node:22-test");
    assert.equal(result.hardening.runtime.driver, "fake-container");
    assert.equal(result.hardening.cleanup.status, "succeeded");
  } finally {
    workspace.cleanup();
  }
});

test("container isolation fails closed when network policy cannot be enforced", async () => {
  const workspace = workspaceFixture();
  const driver: CandidateContainerDriver = {
    id: "weak-container",
    supportsNetworkPolicy: false,
    execute() {
      throw new Error("should not execute");
    }
  };
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "printf never",
      cwd: workspace.root,
      isolation: {
        kind: "container",
        driver,
        networkPolicy: {
          defaultDeny: true,
          allowHosts: ["api.example.com"],
          enforce: true
        }
      }
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cannot enforce/);
    assert.equal(result.hardening.cleanup.status, "failed");
    assert.equal(result.hardening.network_policy.enforced, true);
  } finally {
    workspace.cleanup();
  }
});

test("container cleanup is recorded for failures and timeouts", async () => {
  const workspace = workspaceFixture();
  const driver: CandidateContainerDriver = {
    id: "timeout-container",
    supportsNetworkPolicy: true,
    execute() {
      return {
        stdout: "",
        stderr: "timed out",
        exitCode: 1,
        timedOut: true,
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "sleep 10",
      cwd: workspace.root,
      isolation: { kind: "container", driver }
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.hardening.cleanup.status, "succeeded");
  } finally {
    workspace.cleanup();
  }
});

test("fake microVM isolation records vercel-sandbox runtime evidence", async () => {
  const workspace = workspaceFixture();
  const driver: CandidateMicrovmDriver = {
    id: "fake-vercel-sandbox",
    provider: "vercel-sandbox",
    supportsNetworkPolicy: true,
    execute(input) {
      assert.equal(input.provider, "vercel-sandbox");
      assert.equal(input.runtime, "node24");
      assert.equal(input.snapshotId, "snap_test");
      assert.equal(input.workdir, "/workspace");
      assert.deepEqual(input.networkPolicy.allowHosts, []);
      return {
        stdout: "microvm-ok",
        stderr: "",
        exitCode: 0,
        actualIsolation: "vercel-sandbox",
        runtime: {
          provider: "vercel-sandbox",
          runtime: "node24",
          snapshotId: "snap_test",
          sandboxId: "sbx_test",
          runtimeDigest: "sha256:" + "c".repeat(64)
        },
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "printf microvm-ok",
      cwd: workspace.root,
      isolation: {
        kind: "microvm",
        driver,
        snapshotId: "snap_test",
        networkPolicy: { defaultDeny: true, allowHosts: [], enforce: true }
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "microvm-ok");
    assert.equal(result.hardening.requested_isolation, "microvm");
    assert.equal(result.hardening.actual_isolation, "vercel-sandbox");
    assert.equal(result.hardening.runtime.provider, "vercel-sandbox");
    assert.equal(result.hardening.runtime.runtime, "node24");
    assert.equal(result.hardening.runtime.snapshot_id, "snap_test");
    assert.equal(result.hardening.runtime.sandbox_id, "sbx_test");
    assert.equal(result.hardening.runtime.driver, "fake-vercel-sandbox");
    assert.equal(result.hardening.network_policy.enforced, true);
    assert.equal(result.hardening.cleanup.status, "succeeded");
  } finally {
    workspace.cleanup();
  }
});

test("fake microVM isolation fails closed when network policy cannot be enforced", async () => {
  const workspace = workspaceFixture();
  const driver: CandidateMicrovmDriver = {
    id: "weak-microvm",
    provider: "vercel-sandbox",
    supportsNetworkPolicy: false,
    execute() {
      throw new Error("should not execute");
    }
  };
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "printf never",
      cwd: workspace.root,
      isolation: {
        kind: "microvm",
        driver,
        networkPolicy: {
          defaultDeny: true,
          allowHosts: ["api.example.com"],
          enforce: true
        }
      }
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cannot enforce/);
    assert.equal(result.hardening.requested_isolation, "microvm");
    assert.equal(result.hardening.actual_isolation, "vercel-sandbox");
    assert.equal(result.hardening.cleanup.status, "failed");
    assert.equal(result.hardening.network_policy.enforced, true);
  } finally {
    workspace.cleanup();
  }
});

test("fake microVM cleanup failures and timeouts are recorded distinctly", async () => {
  const workspace = workspaceFixture();
  const cleanupFailureDriver: CandidateMicrovmDriver = {
    id: "cleanup-failure-microvm",
    provider: "vercel-sandbox",
    supportsNetworkPolicy: true,
    execute() {
      return {
        stdout: "",
        stderr: "cleanup failed",
        exitCode: 1,
        actualIsolation: "vercel-sandbox",
        cleanup: { attempted: true, succeeded: false, error: "stop failed" }
      };
    }
  };
  const cleanupTimeoutDriver: CandidateMicrovmDriver = {
    id: "cleanup-timeout-microvm",
    provider: "vercel-sandbox",
    supportsNetworkPolicy: true,
    execute() {
      return {
        stdout: "",
        stderr: "cleanup timed out",
        exitCode: 1,
        actualIsolation: "vercel-sandbox",
        cleanup: {
          attempted: true,
          succeeded: false,
          timedOut: true,
          error: "stop timed out"
        }
      };
    }
  };
  try {
    const failed = await runCandidateCommandWithIsolation({
      command: "exit 1",
      cwd: workspace.root,
      isolation: { kind: "microvm", driver: cleanupFailureDriver }
    });
    assert.equal(failed.hardening.cleanup.status, "failed");
    assert.equal(failed.hardening.cleanup.error, "stop failed");

    const timedOut = await runCandidateCommandWithIsolation({
      command: "exit 1",
      cwd: workspace.root,
      isolation: { kind: "microvm", driver: cleanupTimeoutDriver }
    });
    assert.equal(timedOut.hardening.cleanup.status, "timed_out");
    assert.equal(timedOut.hardening.cleanup.timed_out, true);
    assert.equal(timedOut.hardening.cleanup.error, "stop timed out");
  } finally {
    workspace.cleanup();
  }
});

test("fake microVM secret absence evidence omits raw secret values", async () => {
  const workspace = workspaceFixture();
  const secretValue = "microvm-secret-value";
  const secretHash = secretValueHash(secretValue);
  const driver: CandidateMicrovmDriver = {
    id: "secretless-microvm",
    provider: "vercel-sandbox",
    supportsNetworkPolicy: true,
    execute(input) {
      assert.equal(JSON.stringify(input).includes(secretValue), false);
      assert.deepEqual(input.secretPolicy.secretNames, ["VERCEL_TOKEN"]);
      assert.deepEqual(input.secretPolicy.secretValueHashes, [secretHash]);
      assert.deepEqual(input.secretPolicy.injectedEnvNames, ["VERCEL_TOKEN"]);
      return {
        stdout: "secretless",
        stderr: "",
        exitCode: 0,
        actualIsolation: "vercel-sandbox",
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
  try {
    const result = await runCandidateCommandWithIsolation({
      command: "printf secretless",
      cwd: workspace.root,
      isolation: {
        kind: "microvm",
        driver,
        secretPolicy: {
          secretNames: ["VERCEL_TOKEN"],
          secretValueHashes: [secretHash],
          injectedEnvNames: ["VERCEL_TOKEN"]
        }
      }
    });

    assert.equal(result.hardening.secret_absence.scanned, true);
    assert.equal(result.hardening.secret_absence.leaks_found, false);
    assert.equal(result.hardening.secret_absence.secret_names[0], "VERCEL_TOKEN");
    assert.equal(result.hardening.secret_absence.secret_value_hashes[0], secretHash);
    assert.equal(JSON.stringify(result.hardening).includes(secretValue), false);
  } finally {
    workspace.cleanup();
  }
});

test("secret absence scanning records names and hashes without raw values", () => {
  const workspace = workspaceFixture();
  const secretValue = "super-secret-value";
  try {
    const clean = secretAbsenceMetadata({
      cwd: workspace.root,
      transcript: "no secrets here",
      secretPolicy: {
        secretNames: ["API_TOKEN"],
        secretValueHashes: [secretValueHash(secretValue)],
        injectedEnvNames: ["API_TOKEN"]
      }
    });
    assert.equal(clean.scanned, true);
    assert.equal(clean.leaks_found, false);
    assert.equal(JSON.stringify(clean).includes(secretValue), false);

    writeFileSync(join(workspace.root, "leak.txt"), "API_TOKEN should not be here\n");
    const leaked = secretAbsenceMetadata({
      cwd: workspace.root,
      transcript: secretValue,
      secretPolicy: { secretNames: ["API_TOKEN"] },
      knownSecretValues: [secretValue]
    });
    assert.equal(leaked.leaks_found, true);
    assert.equal(leaked.leak_count > 0, true);
    assert.equal(JSON.stringify(leaked).includes(secretValue), false);
  } finally {
    workspace.cleanup();
  }
});
