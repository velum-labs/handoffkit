import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { DEFAULT_TRIO, defaultKeyEnv, loadEnvFileInto, materializeSampleRepo, startFusionStack } from "../fusion-quickstart.js";

const SENTINEL = "FUSION_OK";

const FIX_DIFF = [
  "```diff",
  "--- a/calculator.js",
  "+++ b/calculator.js",
  "@@ -1 +1 @@",
  "-exports.add = (left, right) => left - right;",
  "+exports.add = (left, right) => left + right;",
  "```"
].join("\n");

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

/**
 * A real OpenAI-compatible endpoint standing in for one panel model: it returns
 * a genuine fix diff for solve-agent calls and a synthesized sentinel for judge
 * calls, and records which role each request played so the test can prove each
 * candidate hit its own endpoint.
 */
async function startFake(modelId: string): Promise<Fake> {
  let solveCalls = 0;
  let judgeCalls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(req)) as {
          model?: string;
          messages?: Array<{ role?: string; content?: string }>;
        };
        const system = (body.messages ?? []).find((message) => message.role === "system")?.content ?? "";
        const isJudge = system.includes("synthesize coding harness candidate evidence");
        const content = isJudge ? `${SENTINEL}: synthesized fix from ${modelId}` : FIX_DIFF;
        if (isJudge) judgeCalls += 1;
        else solveCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_fake",
            model: body.model ?? modelId,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    solveCalls: () => solveCalls,
    judgeCalls: () => judgeCalls,
    close: () => closeServer(server)
  };
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
  assert.equal(defaultKeyEnv("openai-compatible"), undefined);
  assert.equal(defaultKeyEnv("mlx"), undefined);
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

test("real coding-harness fusion routes each candidate to its own model endpoint and returns a judged synthesis", async () => {
  const repo = materializeSampleRepo(join(freshDir("fusion-stack-"), "repo"));
  const models = [
    { id: "qwen", model: "panel-qwen" },
    { id: "gemma", model: "panel-gemma" },
    { id: "llama", model: "panel-llama" }
  ];
  const fakes = await Promise.all(models.map((model) => startFake(model.id)));
  const endpoints: Record<string, string> = {
    qwen: fakes[0]!.url,
    gemma: fakes[1]!.url,
    llama: fakes[2]!.url
  };
  const stack = await startFusionStack({
    repo,
    outputRoot: freshDir("fusion-runs-"),
    models,
    endpoints,
    harness: "command",
    judgeModel: "panel-qwen",
    log: () => {}
  });
  try {
    const response = await fetch(`${stack.fusionUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        messages: [{ role: "user", content: "Fix calculator add() so the test passes." }]
      })
    });
    assert.equal(response.status, 200);
    const reportPath = response.headers.get("x-fusion-report");
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.match(body.choices[0]?.message.content ?? "", new RegExp(SENTINEL));

    // Each panel model produced its own real candidate against its own endpoint.
    assert.ok(fakes[0]!.solveCalls() >= 1, "qwen endpoint must run its candidate");
    assert.ok(fakes[1]!.solveCalls() >= 1, "gemma endpoint must run its candidate");
    assert.ok(fakes[2]!.solveCalls() >= 1, "llama endpoint must run its candidate");
    // Judge synthesis hit the judge endpoint (the first model's server).
    assert.ok(fakes[0]!.judgeCalls() >= 1, "judge synthesis must hit the judge endpoint");

    assert.ok(reportPath, "expected x-fusion-report header");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      results: Array<{
        ensemble?: {
          candidates: Array<{ status: string }>;
          judgeSynthesisRecord?: { status?: string };
        };
      }>;
    };
    const ensemble = report.results.find((row) => row.ensemble)?.ensemble;
    assert.equal(ensemble?.candidates.length, 3, "every panel model is a candidate");
    assert.ok(
      ensemble?.candidates.every((candidate) => candidate.status === "succeeded"),
      "each real candidate patched the repo and passed its tests"
    );
    assert.equal(ensemble?.judgeSynthesisRecord?.status, "succeeded");
  } finally {
    await stack.close();
    await Promise.all(fakes.map((fake) => fake.close()));
  }
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

test("agent harness produces a trajectory and fuses it through the synthesis endpoint", async () => {
  const repo = materializeSampleRepo(join(freshDir("fusion-agent-"), "repo"));
  const model = await startFakeAnswerModel("This repo is a calculator sample.");
  // Fake fusionkit synthesis endpoint: records trajectories and returns a sentinel.
  let fusedTrajectories: unknown[] = [];
  const synth = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "POST" && path === "/v1/fusion/trajectories:fuse") {
        const body = JSON.parse(await readBody(req)) as { trajectories?: unknown[] };
        fusedTrajectories = body.trajectories ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ final_output: `${SENTINEL}: this repo is a calculator sample`, decision: "synthesize" }));
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
    harness: "agent",
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
    assert.equal(fusedTrajectories.length, 1, "one trajectory must be fused");
    const trajectory = fusedTrajectories[0] as { steps?: unknown[]; final_output?: string; model_id?: string };
    assert.equal(trajectory.model_id, "alpha");
    assert.ok(Array.isArray(trajectory.steps) && trajectory.steps.length >= 1, "trajectory must carry steps");
    assert.match(trajectory.final_output ?? "", /calculator sample/);
  } finally {
    await stack.close();
    await model.close();
    await closeServer(synth);
  }
});

const FK_DIR = process.env.WARRANT_FUSION_FK_DIR;
const CLOUD_SKIP = FK_DIR !== undefined ? false : "set WARRANT_FUSION_FK_DIR=<fusionkit checkout> to test the cloud-fronted path";

test(
  "cloud path: a fusionkit-fronted OpenAI-compatible endpoint backs a real coding candidate",
  { skip: CLOUD_SKIP },
  async () => {
    const repo = materializeSampleRepo(join(freshDir("fusion-cloud-"), "repo"));
    const fake = await startFake("cloud");
    const stack = await startFusionStack({
      repo,
      outputRoot: freshDir("fusion-cloud-runs-"),
      // openai-compatible provider -> fusionkit's simple_openai_server fronts the fake backend.
      models: [{ id: "cloud", model: "fake-model", provider: "openai-compatible", baseUrl: fake.url }],
      fusionkitDir: FK_DIR as string,
      harness: "command",
      timeoutMs: 120_000,
      log: () => {}
    });
    try {
      const response = await fetch(`${stack.fusionUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fusion-panel",
          messages: [{ role: "user", content: "Fix calculator add() so the test passes." }]
        })
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      assert.match(body.choices[0]?.message.content ?? "", new RegExp(SENTINEL));
      // The fusionkit-fronted endpoint served both the candidate and judge calls.
      assert.ok(fake.solveCalls() >= 1, "candidate must reach the cloud-fronted endpoint");
      assert.ok(fake.judgeCalls() >= 1, "judge synthesis must reach the cloud-fronted endpoint");
    } finally {
      await stack.close();
      await fake.close();
    }
  }
);

const LIVE =
  process.env.WARRANT_FUSION_LIVE === "1" ? false : "set WARRANT_FUSION_LIVE=1 to run the real local MLX trio";

test(
  "live: the real local MLX trio backs a coding-harness fusion run through the gateway",
  { skip: LIVE },
  async () => {
    const repo = materializeSampleRepo(join(freshDir("fusion-live-"), "repo"));
    const stack = await startFusionStack({
      repo,
      outputRoot: freshDir("fusion-live-runs-"),
      models: [...DEFAULT_TRIO],
      harness: "command",
      timeoutMs: 180_000,
      log: (line) => console.error(line)
    });
    try {
      const response = await fetch(`${stack.fusionUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fusion-panel",
          messages: [{ role: "user", content: "Fix the failing calculator add() test." }]
        })
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      assert.ok((body.choices[0]?.message.content ?? "").length > 0, "real trio must return a synthesized answer");
      const reportPath = response.headers.get("x-fusion-report");
      assert.ok(reportPath);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        results: Array<{ ensemble?: { candidates: unknown[]; judgeSynthesisRecord?: unknown } }>;
      };
      const ensemble = report.results.find((row) => row.ensemble)?.ensemble;
      assert.equal(ensemble?.candidates.length, 3);
      assert.ok(ensemble?.judgeSynthesisRecord !== undefined);
    } finally {
      await stack.close();
    }
  }
);
