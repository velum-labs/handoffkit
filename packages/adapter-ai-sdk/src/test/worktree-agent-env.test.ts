import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorktreeCommand } from "../worktree-agent.js";

/**
 * The panel agent's `run` tool executes model-chosen shell commands, so the
 * child environment must be allowlist-built: the parent's credentials must be
 * invisible to `env`-style probes (whose output lands in persisted, traced
 * trajectories), while the system baseline (PATH) and explicitly allowed
 * names still flow.
 */

function withEnv(name: string, value: string, body: () => void): void {
  const prior = process.env[name];
  process.env[name] = value;
  try {
    body();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

test("run tool child env excludes parent credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "fusionkit-envtest-"));
  try {
    withEnv("FAKE_PROVIDER_API_KEY", "sk-super-secret", () => {
      const output = runWorktreeCommand(root, "env", 10_000, []);
      assert.ok(!output.includes("sk-super-secret"), "parent secret leaked into run tool output");
      assert.ok(!output.includes("FAKE_PROVIDER_API_KEY"), "parent secret name leaked into run tool output");
      assert.match(output, /(^|\n)PATH=/, "system baseline (PATH) must still be forwarded");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run tool child env forwards explicitly allowed names", () => {
  const root = mkdtempSync(join(tmpdir(), "fusionkit-envtest-"));
  try {
    withEnv("FAKE_ALLOWED_VAR", "visible-value", () => {
      const denied = runWorktreeCommand(root, "env", 10_000, []);
      assert.ok(!denied.includes("visible-value"), "non-allowlisted var must not flow by default");
      const allowed = runWorktreeCommand(root, "env", 10_000, ["FAKE_ALLOWED_VAR"]);
      assert.ok(allowed.includes("FAKE_ALLOWED_VAR=visible-value"), "allowlisted var must flow");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
