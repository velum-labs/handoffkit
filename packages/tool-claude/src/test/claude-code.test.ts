import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertHarnessRunResultV1, requestHash } from "@fusionkit/protocol";
import type { SessionBackend } from "@fusionkit/runner";
import { gitText } from "@fusionkit/workspace";

import { createMockHarness, runEnsemble } from "@fusionkit/ensemble";
import type { EnsembleDescriptor, HarnessAdapter } from "@fusionkit/ensemble";

import { claudeCodeHarness, claudeCodeHarnessCredentialSkipReason } from "../index.js";

const BASE_DESCRIPTOR = {
  id: "ensemble_test",
  models: [{ id: "claude", model: "claude-sonnet-4-6" }],
  runtime: { id: "local" },
  judge: { id: "judge", model: "fake-judge" },
  policy: {
    id: "policy",
    allowedTools: ["read_file"],
    sideEffects: "read_only" as const,
    timeoutMs: 1_000
  },
  prompt: "Summarize model-fusion evidence.",
  sourceRepo: "handoffkit",
  baseGitSha: "a".repeat(40)
};

function descriptor(overrides: Partial<EnsembleDescriptor> = {}): EnsembleDescriptor {
  return {
    ...BASE_DESCRIPTOR,
    harness: createMockHarness() as HarnessAdapter,
    ...overrides
  };
}

function makeRepo(): { repo: string; cleanup: () => void; head: string; outputRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "ensemble-repo-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitText(repo, ["init", "--quiet", "--initial-branch=main"]);
  gitText(repo, ["config", "user.email", "ensemble@warrant.local"]);
  gitText(repo, ["config", "user.name", "ensemble"]);
  writeFileSync(join(repo, "README.md"), "# ensemble\n");
  gitText(repo, ["add", "-A"]);
  gitText(repo, ["commit", "--quiet", "-m", "init"]);
  return {
    repo,
    outputRoot: join(root, "out"),
    head: gitText(repo, ["rev-parse", "HEAD"]).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function liveClaudeSmokeSkipReason(): string | false {
  if ((process.env.FUSIONKIT_CLAUDE_SMOKE ?? process.env.WARRANT_CLAUDE_SMOKE) !== "1") {
    return "set FUSIONKIT_CLAUDE_SMOKE=1 plus Claude Code credentials to run the live Claude Code smoke";
  }
  return claudeCodeHarnessCredentialSkipReason() ?? false;
}

test("claude-code adapter can replace mock and skip clearly without credentials", async () => {
  const result = await runEnsemble(
    descriptor({
      models: [{ id: "claude", model: "claude-sonnet-4-6" }],
      harness: claudeCodeHarness({ env: {} })
    })
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.harnessRunResult.status, "skipped");
  assert.equal(result.candidates[0]?.status, "skipped");
  assert.equal(result.candidates[0]?.error?.kind, "capability_missing");
  assert.match(
    result.candidates[0]?.error?.message ?? "",
    /missing Claude Code credential/
  );
  assert.match(result.summary?.candidates[0]?.verification?.evidence[0] ?? "", /missing Claude/);
});

test("claude-code adapter delegates through a session backend from a generic descriptor", async () => {
  const repo = makeRepo();
  const seen: {
    agentKind?: string;
    env?: Record<string, string>;
    repoDir?: string;
  } = {};
  const backend: SessionBackend = {
    isolation: "vercel-sandbox",
    supports: () => true,
    execute: async (input) => {
      seen.agentKind = input.contract.agent.kind;
      seen.env = input.execution.env;
      seen.repoDir = input.repoDir;
      assert.equal(input.contract.isolation, "vercel-sandbox");
      assert.equal(input.contract.execution?.kind, "agent");
      assert.equal(input.secrets.length, 0);
      writeFileSync(join(input.repoDir, "CLAUDE_RESULT.md"), "fake claude result\n");
      input.emit({
        type: "command.executed",
        argvHash: requestHash({ adapter: "claude-code" }),
        exitCode: 0
      });
      return { exitCode: 0, log: Buffer.from("fake claude transcript") };
    }
  };

  try {
    const result = await runEnsemble(
      descriptor({
        models: [{ id: "claude", model: "claude-sonnet-4-6" }],
        harness: claudeCodeHarness({
          env: {
            ANTHROPIC_API_KEY: "sk-ant-test",
            VERCEL_TOKEN: "vercel-test"
          },
          backend
        }),
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        cleanupWorktrees: true
      })
    );

    assert.equal(result.harnessRunResult.status, "succeeded");
    assert.equal(result.candidates[0]?.status, "succeeded");
    assert.equal(seen.agentKind, "claude-code");
    assert.equal(seen.env?.ANTHROPIC_API_KEY, "sk-ant-test");
    assert.equal(Object.hasOwn(seen.env ?? {}, "VERCEL_TOKEN"), false);
    assert.notEqual(seen.repoDir, repo.repo);
    assert.ok(result.artifacts.some((artifact) => artifact.kind === "patch"));
    assert.match(result.candidates[0]?.metadata?.adapter as string, /claude-code/);
  } finally {
    repo.cleanup();
  }
});

test(
  "smoke: claude-code adapter runs live when credentials are available",
  { skip: liveClaudeSmokeSkipReason() },
  async () => {
    const repo = makeRepo();
    try {
      const result = await runEnsemble(
        descriptor({
          id: "claude_smoke",
          models: [{ id: "claude", model: "claude-sonnet-4-6" }],
          harness: claudeCodeHarness(),
          runtime: {
            id: "vercel-sandbox",
            isolation: {
              kind: "microvm",
              networkPolicy: {
                defaultDeny: true,
                allowHosts: [
                  "registry.npmjs.org",
                  "api.anthropic.com",
                  "ai-gateway.vercel.sh"
                ]
              }
            }
          },
          policy: {
            id: "claude-smoke-policy",
            allowedTools: ["read_file"],
            sideEffects: "read_only",
            timeoutMs: 180_000
          },
          prompt:
            "Read README.md if present, then reply exactly CLAUDE_LIVE_SMOKE_OK. Do not modify files.",
          workspace: repo.repo,
          baseGitSha: repo.head,
          outputRoot: repo.outputRoot,
          cleanupWorktrees: true
        })
      );

      assertHarnessRunResultV1(result.harnessRunResult);
      assert.equal(result.harnessRunResult.status, "succeeded");
      assert.equal(result.candidates[0]?.status, "succeeded");
    } finally {
      repo.cleanup();
    }
  }
);
