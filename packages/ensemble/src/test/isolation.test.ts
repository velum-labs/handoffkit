import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CandidateContainerDriver } from "../harness.js";
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
