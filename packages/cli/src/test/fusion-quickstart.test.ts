import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  defaultKeyEnv,
  fusionPreambleLines,
  loadEnvFileInto,
  panelMemberSummary,
  sessionReceiptLines,
  startFusionStack
} from "../fusion-quickstart.js";

const SENTINEL = "FUSION_OK";

/**
 * Create a real git repo with a genuinely failing test, so each panel model has
 * a concrete coding task to fuse over.
 */
function materializeSampleRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root });
  };
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "fusion@warrant.local"]);
  git(["config", "user.name", "warrant-fusion"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fusion-sample", private: true, scripts: { test: "node --test" } }, null, 2) + "\n"
  );
  writeFileSync(join(root, "calculator.js"), "exports.add = (left, right) => left - right;\n");
  writeFileSync(
    join(root, "calculator.test.js"),
    [
      "const assert = require('node:assert/strict');",
      "const { add } = require('./calculator.js');",
      "assert.equal(add(2, 3), 5);",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "README.md"),
    "# fusion sample\n\n`add` is buggy (it subtracts); `npm test` fails until it is fixed.\n"
  );
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "failing calculator sample"]);
  return root;
}

type Fake = {
  url: string;
  solveCalls: () => number;
  judgeCalls: () => number;
  close: () => Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const tmpRoots: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("loadEnvFileInto fills missing keys from a .env without overriding existing ones", () => {
  const dir = freshDir("fusion-env-");
  const envPath = join(dir, ".env");
  writeFileSync(
    envPath,
    ["# comment", "export OPENAI_API_KEY=sk-from-file", 'ANTHROPIC_API_KEY="sk-ant-quoted"', "", "BARE=1"].join("\n")
  );
  const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-already-set" };
  loadEnvFileInto(envPath, env);
  assert.equal(env.OPENAI_API_KEY, "sk-already-set", "existing values must win");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-quoted", "quotes are stripped");
  assert.equal(env.BARE, "1");
  loadEnvFileInto(join(dir, "missing.env"), env); // no-op when absent
});

test("defaultKeyEnv maps cloud providers to their conventional key env vars", () => {
  assert.equal(defaultKeyEnv("openai"), "OPENAI_API_KEY");
  assert.equal(defaultKeyEnv("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(defaultKeyEnv("google"), "GEMINI_API_KEY");
  assert.equal(defaultKeyEnv("openrouter"), "OPENROUTER_API_KEY");
  assert.equal(defaultKeyEnv("openai-compatible"), undefined);
  assert.equal(defaultKeyEnv("mlx"), undefined);
});

test("panelMemberSummary describes API key auth without exposing secret values", () => {
  const summary = panelMemberSummary({
    id: "gpt",
    model: "gpt-5.5",
    provider: "openai",
    keyEnv: "OPENAI_API_KEY"
  });

  assert.equal(summary, "gpt=openai:gpt-5.5 [api key env OPENAI_API_KEY]");
  assert.doesNotMatch(summary, /sk-/);
});

test("panelMemberSummary describes subscription and endpoint auth", () => {
  assert.equal(
    panelMemberSummary({ id: "cx", model: "gpt-5.5", auth: "codex" }),
    "cx=codex:gpt-5.5 [codex login]"
  );
  assert.equal(
    panelMemberSummary({
      id: "cc",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      auth: "claude-code"
    }),
    "cc=anthropic:claude-sonnet-4-6 [claude-code login]"
  );
  assert.equal(
    panelMemberSummary(
      { id: "alpha", model: "fake", provider: "openai-compatible" },
      { alpha: "http://127.0.0.1:1234" }
    ),
    "alpha=openai-compatible:fake [pre-running endpoint]"
  );
});

test("fusionPreambleLines includes Codex gateway auth method", () => {
  const lines = fusionPreambleLines({
    tool: "codex",
    repo: "/repo",
    models: [{ id: "gpt", model: "gpt-5.5", provider: "openai" }],
    judgeLabel: "gpt-5.5",
    budgetUsd: 2.5,
    onRateLimit: "fusion"
  });

  assert.deepEqual(lines, [
    "tool: codex -> FusionKit gateway",
    "codex auth: ephemeral CODEX_HOME -> FusionKit local provider (Responses; requires_openai_auth=false)",
    "model: fusion-panel",
    "repo: /repo",
    "judge: gpt-5.5",
    "panel: gpt=openai:gpt-5.5 [api key env OPENAI_API_KEY]",
    "budget: $2.5",
    "rate limits: fusion"
  ]);
});

test("sessionReceiptLines reports provider spend and local compute separately", () => {
  const lines = sessionReceiptLines(
    [
      {
        id: "abcdef123456",
        traceId: "trace",
        sessionSpan: "span",
        createdAt: 0,
        updatedAt: 0,
        turnCount: 1,
        cost: {
          totalUsd: 0.011,
          providerUsd: 0.01,
          localComputeUsd: 0.001,
          localActiveMs: 10_000,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          meteredTurns: 2,
          unknownCostTurns: 1,
          meteredEntries: 2,
          unknownCostEntries: 1,
          currency: "USD"
        }
      }
    ],
    { elapsedMs: 12_000, tool: "codex" }
  );

  assert.match(lines[1] ?? "", /provider spend\/est \$0\.0100/);
  assert.match(lines[1] ?? "", /local compute: 10s active \(\$0\.0010 est\)/);
  assert.match(lines[1] ?? "", /150 tokens/);
});

test("materializeSampleRepo creates a real git repo whose tests fail until add() is fixed", () => {
  const repo = materializeSampleRepo(join(freshDir("fusion-sample-"), "repo"));
  assert.match(readFileSync(join(repo, "calculator.js"), "utf8"), /left - right/);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const tests = spawnSync("node", ["--test"], { cwd: repo, encoding: "utf8", env });
  assert.notEqual(tests.status, 0, "the sample repo's tests must fail before a fix");
  const isRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, encoding: "utf8" });
  assert.equal(isRepo.stdout.trim(), "true");
});

/** A fake OpenAI-compatible endpoint that answers directly (no tool calls). */
async function startFakeAnswerModel(answer: string): Promise<Fake> {
  let calls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake", object: "model" }] }));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        await readBody(req);
        calls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_fake",
            object: "chat.completion",
            created: 0,
            model: "fake",
            choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    solveCalls: () => calls,
    judgeCalls: () => 0,
    close: () => closeServer(server)
  };
}

test("agent front door: panel produces a trajectory the judge step consumes", async () => {
  const repo = materializeSampleRepo(join(freshDir("fusion-agent-"), "repo"));
  const model = await startFakeAnswerModel("This repo is a calculator sample.");
  // Fake FusionKit judge step: records the candidate trajectories + conversation it
  // receives and returns a terminal assistant answer (no tool calls) as an OpenAI
  // chat completion, which is what the new front door proxies to the harness.
  let stepTrajectories: unknown[] = [];
  let stepMessages: Array<{ role?: string }> = [];
  const synth = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "POST" && path === "/v1/fusion/trajectories:fuse") {
        const body = JSON.parse(await readBody(req)) as { trajectories?: unknown[]; messages?: Array<{ role?: string }> };
        stepTrajectories = body.trajectories ?? [];
        stepMessages = body.messages ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-step",
            object: "chat.completion",
            created: 0,
            model: "fusion-panel",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `${SENTINEL}: this repo is a calculator sample` },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            fusion: {
              trajectory: {
                trajectory_id: "synthesis_quickstart",
                synthesis: { decision: "synthesize", rationale: "fused" }
              }
            }
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => synth.listen(0, "127.0.0.1", resolve));
  const synthAddress = synth.address();
  assert.ok(typeof synthAddress === "object" && synthAddress !== null);
  const synthesisUrl = `http://127.0.0.1:${synthAddress.port}`;

  const stack = await startFusionStack({
    repo,
    outputRoot: freshDir("fusion-agent-runs-"),
    models: [{ id: "alpha", model: "fake", provider: "openai-compatible", baseUrl: model.url }],
    endpoints: { alpha: model.url },
    synthesisUrl,
    log: () => {}
  });
  try {
    const response = await fetch(`${stack.fusionUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fusion-panel", messages: [{ role: "user", content: "What's in this repo?" }] })
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.match(body.choices[0]?.message.content ?? "", new RegExp(SENTINEL));
    assert.ok(model.solveCalls() >= 1, "the panel model agent must run");
    assert.equal(stepTrajectories.length, 1, "the panel's one trajectory must reach the judge step");
    const trajectory = stepTrajectories[0] as { items?: unknown[]; final_output?: string; model_id?: string };
    assert.equal(trajectory.model_id, "alpha");
    assert.ok(Array.isArray(trajectory.items) && trajectory.items.length >= 1, "trajectory must carry items");
    assert.match(trajectory.final_output ?? "", /calculator sample/);
    assert.ok(stepMessages.some((message) => message.role === "user"), "the conversation must reach the judge");
  } finally {
    await stack.close();
    await model.close();
    await closeServer(synth);
  }
});

