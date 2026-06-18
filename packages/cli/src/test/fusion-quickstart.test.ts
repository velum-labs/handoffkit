import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { DEFAULT_TRIO, materializeSampleRepo, startFusionStack } from "../fusion-quickstart.js";

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
