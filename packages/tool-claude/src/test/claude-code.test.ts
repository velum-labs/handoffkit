import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertHarnessRunResultV1, requestHash } from "@fusionkit/protocol";
import type { SessionBackend } from "@fusionkit/runner";
import { gitText } from "@fusionkit/workspace";

import { createMockHarness, runEnsemble } from "@fusionkit/ensemble";
import type { EnsembleDescriptor, HarnessAdapter } from "@fusionkit/ensemble";

import {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  createClaudeCodeHarness
} from "../index.js";

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

/**
 * A stand-in for the `claude` CLI: reads `--model` and ANTHROPIC_BASE_URL the
 * way the real CLI would, POSTs one Anthropic Messages turn, and prints the
 * reply as `--output-format stream-json` lines.
 */
const FAKE_CLAUDE_CLI = `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf("--model") + 1];
const base = process.env.ANTHROPIC_BASE_URL ?? "";
const apiKey = process.env.ANTHROPIC_API_KEY === undefined ? "apikey=absent" : "apikey=present";
const response = await fetch(base + "/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + (process.env.ANTHROPIC_AUTH_TOKEN ?? "")
  },
  body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hi" }] })
});
const message = await response.json();
const text = (message.content ?? [])
  .map((block) => (typeof block.text === "string" ? block.text : ""))
  .join("");
const result = text + " via " + model + " " + apiKey;
console.log(JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: result }] }
}));
console.log(JSON.stringify({ type: "result", subtype: "success", result, is_error: !response.ok }));
process.exit(response.ok ? 0 : 1);
`;

test("local claude-code harness routes a non-Anthropic panel member through its router endpoint", async () => {
  const repo = makeRepo();
  const routed: { path?: string; model?: string } = {};
  // Stands in for the fusion router: an OpenAI Chat Completions endpoint that
  // multiplexes panel members by the requested model (the endpoint id).
  const router = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body === "" ? "{}" : body) as { model?: string };
      routed.path = req.url ?? "";
      routed.model = parsed.model ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `ROUTED:${parsed.model ?? ""}` },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
  const address = router.address();
  const routerUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const cliPath = join(repo.repo, "fake-claude.mjs");
  writeFileSync(cliPath, FAKE_CLAUDE_CLI);
  chmodSync(cliPath, 0o755);

  try {
    const result = await runEnsemble(
      descriptor({
        models: [{ id: "openai", model: "gpt-5.5" }],
        harness: createClaudeCodeHarness({
          execution: "local",
          command: cliPath,
          fusionBackendUrl: routerUrl,
          modelEndpoints: { openai: routerUrl },
          env: {
            PATH: process.env.PATH,
            // Ambient Anthropic credentials must not leak into a router-backed
            // candidate (the CLI would prefer the API key over the gateway token).
            ANTHROPIC_API_KEY: "sk-ant-ambient"
          }
        }),
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        cleanupWorktrees: true
      })
    );

    assert.equal(result.candidates[0]?.status, "succeeded");
    // The translation gateway forwarded to the router's chat surface and forced
    // the endpoint id, regardless of the claude-aliased id the CLI requested.
    assert.equal(routed.path, "/v1/chat/completions");
    assert.equal(routed.model, "openai");
    assert.equal(result.candidates[0]?.metadata?.backend, "fusion-router");
    assert.equal(result.candidates[0]?.metadata?.cli_model, "claude-openai");
  } finally {
    router.close();
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
