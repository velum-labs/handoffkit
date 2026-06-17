import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
  FUSION_REPORT_HEADER,
  FUSION_RUN_ID_HEADER,
  runAcpAgent,
  runFrontDoorAcceptance
} from "@warrant/model-gateway";
import type { FusionGateway } from "@warrant/model-gateway";

import { buildAcpRunner, startConfiguredGateway } from "../gateway.js";
import type { GatewayRunnerConfig } from "../gateway.js";

/**
 * Comprehensive front-door e2e. Exercises the real chain end to end:
 *
 *   native front door (Codex Responses / Claude Messages / Cursorkit Chat / ACP)
 *     -> real Fusion Harness Gateway
 *     -> real runUnifiedHarnessE2E
 *     -> two panel models, each in its own git worktree
 *     -> a real command harness that patches code and runs the failing test
 *     -> FusionKit-backed judge synthesis
 *     -> native-shaped response
 *
 * Assertions read the on-disk unified report and the candidate patch artifacts
 * so we validate genuine per-model isolation, patch/test/tool evidence, and
 * judge synthesis — not just a stubbed sentinel.
 */

const SENTINEL = "FUSION_OK";

type Backend = {
  url: string;
  judgeCallCount: () => number;
  close: () => Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * A realistic local OpenAI-compatible model backend that stands in for
 * FusionKit. The judge synthesizer calls `/v1/chat/completions`; we echo the
 * candidate evidence count so the synthesized answer is grounded in the run.
 */
async function startModelBackend(): Promise<Backend> {
  let judgeCalls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "local-fusion", object: "model" }] }));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          model?: string;
          messages?: Array<{ role?: string; content?: string }>;
        };
        const isJudge = (body.messages ?? []).some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("synthesize coding harness candidate evidence")
        );
        if (isJudge) judgeCalls += 1;
        const content = `${SENTINEL}: synthesized calculator fix from ${body.model ?? "model"}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_e2e",
            model: body.model ?? "local-fusion",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 }
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    judgeCallCount: () => judgeCalls,
    close: () => closeServer(server)
  };
}

/**
 * A repo with a real bug: `add` subtracts. `solve.js` applies the fix, runs the
 * failing unit test (which throws unless the fix is correct), and records the
 * harness-injected model id — proving per-candidate environment isolation.
 */
function makeCodingRepo(): { root: string; repo: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gateway-e2e-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "e2e@warrant.local"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "warrant-e2e"], { cwd: repo });
  writeFileSync(join(repo, "calculator.js"), "exports.add = (left, right) => left - right;\n");
  writeFileSync(
    join(repo, "calculator.test.js"),
    [
      "const assert = require('node:assert/strict');",
      "const { add } = require('./calculator.js');",
      "assert.equal(add(2, 3), 5);",
      "console.log('TEST_OK');",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(repo, "solve.js"),
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync('calculator.js', 'exports.add = (left, right) => left + right;\\n');",
      "require('./calculator.test.js');",
      "fs.writeFileSync('SOLVED_BY.txt', `${process.env.HARNESS_MODEL_ID}\\n`);",
      "console.log('SOLVE_OK');",
      ""
    ].join("\n")
  );
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "failing calculator fixture"], { cwd: repo });
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type UnifiedReport = {
  results: Array<{
    harness: string;
    status: string;
    ensemble?: {
      candidates: Array<{
        candidate_id: string;
        status: string;
        worktree_path?: string;
        artifacts?: Array<{ kind?: string; uri?: string }>;
        metadata?: { model_id?: string };
      }>;
      toolRecords: Array<{ status: string }>;
      judgeSynthesisRecord?: { final_output?: string; status?: string };
    };
  }>;
};

function readPatch(uri: string): string {
  return readFileSync(fileURLToPath(uri), "utf8");
}

let backend: Backend;
let gateway: FusionGateway;
let fixture: { root: string; repo: string; cleanup: () => void };
let config: GatewayRunnerConfig;

before(async () => {
  backend = await startModelBackend();
  fixture = makeCodingRepo();
  config = {
    fusionBackendUrl: backend.url,
    repo: fixture.repo,
    outputRoot: join(fixture.root, "gateway-runs"),
    harnesses: ["command"],
    models: [
      { id: "alpha", model: "fusion-alpha" },
      { id: "beta", model: "fusion-beta" }
    ],
    command: "node solve.js",
    judgeModel: "fusion-judge",
    timeoutMs: 60_000
  };
  gateway = await startConfiguredGateway({ config, host: "127.0.0.1", port: 0 });
});

after(async () => {
  await gateway.close();
  await backend.close();
  fixture.cleanup();
});

test("Codex Responses front door drives the full multi-model panel with real patch/test/judge evidence", async () => {
  const response = await fetch(`${gateway.url()}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      instructions: "Fix the add() bug so the test passes.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "calculator.test.js fails; make it pass." }]
        }
      ]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(FUSION_RUN_ID_HEADER)?.startsWith("gateway_"), true);

  // Native Codex Responses shape carrying the judge's synthesized answer.
  const body = (await response.json()) as {
    object: string;
    output: Array<{ content: Array<{ text: string }> }>;
  };
  assert.equal(body.object, "response");
  assert.match(body.output[0]?.content[0]?.text ?? "", new RegExp(SENTINEL));

  // Full provenance is pointed to by the report header.
  const reportPath = response.headers.get(FUSION_REPORT_HEADER);
  assert.ok(reportPath, "expected x-fusion-report header");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as UnifiedReport;
  const ensemble = report.results.find((row) => row.harness === "command")?.ensemble;
  assert.ok(ensemble, "expected a command ensemble result");

  // Two panel models -> two candidates -> two distinct worktrees.
  assert.equal(ensemble.candidates.length, 2);
  const worktrees = new Set(ensemble.candidates.map((candidate) => candidate.worktree_path));
  assert.equal(worktrees.size, 2, "each model must run in its own worktree");
  assert.deepEqual(
    ensemble.candidates.map((candidate) => candidate.metadata?.model_id).sort(),
    ["alpha", "beta"]
  );

  // Every candidate succeeded and produced a real patch that applies the fix
  // and is attributed to that candidate's injected model id.
  for (const candidate of ensemble.candidates) {
    assert.equal(candidate.status, "succeeded");
    const patch = candidate.artifacts?.find((artifact) => artifact.kind === "patch");
    assert.ok(patch?.uri, `candidate ${candidate.candidate_id} must have a patch artifact`);
    const patchText = readPatch(patch.uri);
    assert.match(patchText, /left \+ right/);
    assert.match(patchText, new RegExp(candidate.metadata?.model_id ?? "model"));
  }

  // Real tool-execution evidence and judge synthesis.
  assert.ok(ensemble.toolRecords.length >= 2);
  assert.ok(ensemble.toolRecords.every((record) => record.status === "succeeded"));
  assert.equal(ensemble.judgeSynthesisRecord?.status, "succeeded");
  assert.match(ensemble.judgeSynthesisRecord?.final_output ?? "", new RegExp(SENTINEL));
});

test("Claude Messages front door returns native Anthropic shape backed by a real run", async () => {
  const response = await fetch(`${gateway.url()}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "fusion-panel",
      max_tokens: 512,
      messages: [{ role: "user", content: "Fix calculator add() so the test passes." }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    type: string;
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.match(body.content[0]?.text ?? "", new RegExp(SENTINEL));

  const reportPath = response.headers.get(FUSION_REPORT_HEADER);
  assert.ok(reportPath);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as UnifiedReport;
  const ensemble = report.results[0]?.ensemble;
  assert.equal(ensemble?.candidates.length, 2);
  assert.equal(ensemble?.judgeSynthesisRecord?.status, "succeeded");
});

test("Cursorkit chat front door returns native chat-completion shape backed by a real run", async () => {
  const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      messages: [{ role: "user", content: "Fix calculator add() so the test passes." }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    choices: Array<{ message: { role: string; content: string } }>;
  };
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0]?.message.role, "assistant");
  assert.match(body.choices[0]?.message.content ?? "", new RegExp(SENTINEL));
});

test("generic ACP session lifecycle drives the real runner and streams the synthesized answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  const done = runAcpAgent({ runner: buildAcpRunner(config), input, output });
  const write = (message: unknown): void => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: fixture.repo, mcpServers: [] } });
  write({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId: "sess_1", prompt: [{ type: "text", text: "Fix calculator add()." }] }
  });
  input.end();
  await done;

  const messages = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown });

  const update = messages.find((message) => message.method === "session/update");
  const updateText =
    (update?.params as { update?: { content?: { text?: string } } } | undefined)?.update?.content
      ?.text ?? "";
  assert.match(updateText, new RegExp(SENTINEL));

  const promptResult = messages.find((message) => message.id === 3)?.result as
    | { stopReason: string; _meta: { status: string; evidence: string[] } }
    | undefined;
  assert.equal(promptResult?.stopReason, "end_turn");
  assert.equal(promptResult?._meta.status, "succeeded");
  assert.ok(promptResult?._meta.evidence.includes("judge_synthesis"));
  assert.ok(promptResult?._meta.evidence.includes("tool_execution"));
});

test("unified acceptance suite passes every reachable front door against the real gateway", async () => {
  const report = await runFrontDoorAcceptance({
    gatewayUrl: gateway.url(),
    sentinel: SENTINEL,
    acpRunner: buildAcpRunner(config)
  });

  const statusOf = (id: string): string | undefined =>
    report.front_doors.find((door) => door.id === id)?.status;
  const evidenceOf = (id: string): string[] =>
    report.front_doors.find((door) => door.id === id)?.evidence ?? [];

  for (const id of ["codex-responses", "claude-messages", "openai-chat", "generic-acp"]) {
    assert.equal(statusOf(id), "passed", `${id} should pass`);
    assert.ok(evidenceOf(id).includes("sentinel"), `${id} should carry sentinel evidence`);
  }
  assert.ok(evidenceOf("codex-responses").includes("judge_synthesis"));
  assert.ok(evidenceOf("codex-responses").includes("patch_artifact"));

  // External-dependency front doors are explicitly blocked, never silently passed.
  assert.equal(statusOf("codex-acp"), "blocked");
  assert.equal(statusOf("claude-acp"), "blocked");
  assert.equal(statusOf("cursor-acp"), "blocked");

  assert.ok(backend.judgeCallCount() >= 4, "judge synthesis must hit the model backend per front door");
});
