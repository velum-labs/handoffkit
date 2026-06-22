import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
  FUSION_REPORT_HEADER,
  FUSION_RUN_ID_HEADER,
  runAcpAgent,
  runFrontDoorAcceptance
} from "@fusionkit/model-gateway";
import type { FusionGateway } from "@fusionkit/model-gateway";
import { resolveCursorkitCli } from "@fusionkit/ensemble";

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
      // The unified fusion endpoint is the judge: it returns an OpenAI chat
      // completion whose terminal `fusion.trajectory.synthesis` carries the
      // folded fusion result.
      if (req.method === "POST" && path === "/v1/fusion/trajectories:fuse") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as { model?: string };
        judgeCalls += 1;
        const content = `${SENTINEL}: synthesized calculator fix from ${body.model ?? "model"}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_e2e",
            model: body.model ?? "local-fusion",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
            fusion: {
              trajectory: {
                trajectory_id: "synthesis_e2e",
                synthesis: { decision: "synthesize", rationale: "fused" }
              }
            }
          })
        );
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as { model?: string };
        const content = `${SENTINEL}: model reply from ${body.model ?? "model"}`;
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

function sseEvents(raw: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  for (const block of raw.split("\n\n")) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      events.push({ event, data: "[DONE]" });
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(payload) });
    } catch {
      // ignore partial frames
    }
  }
  return events;
}

test("Codex Responses streaming emits a response.completed SSE sequence carrying the synthesized answer", async () => {
  const response = await fetch(`${gateway.url()}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Fix add() and report." }] }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sseEvents(await response.text());
  const types = events
    .map((event) => (typeof event.data === "object" && event.data !== null ? (event.data as { type?: string }).type : undefined))
    .filter((value): value is string => typeof value === "string");
  assert.ok(types.includes("response.created"), "must open with response.created");
  assert.ok(types.includes("response.output_text.delta"), "must stream output text deltas");
  assert.ok(types.includes("response.completed"), "must close with response.completed");
  const completed = events.find(
    (event) => typeof event.data === "object" && event.data !== null && (event.data as { type?: string }).type === "response.completed"
  )?.data as { response?: { output?: Array<{ content?: Array<{ text?: string }> }> } } | undefined;
  assert.match(completed?.response?.output?.[0]?.content?.[0]?.text ?? "", new RegExp(SENTINEL));
});

test("Anthropic Messages streaming emits message_stop SSE carrying the synthesized answer", async () => {
  const response = await fetch(`${gateway.url()}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "fusion-panel",
      stream: true,
      max_tokens: 256,
      messages: [{ role: "user", content: "Fix calculator add() and report." }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sseEvents(await response.text());
  const types = events
    .map((event) => (typeof event.data === "object" && event.data !== null ? (event.data as { type?: string }).type : undefined))
    .filter((value): value is string => typeof value === "string");
  assert.ok(types.includes("message_start"), "must open with message_start");
  assert.ok(types.includes("message_stop"), "must close with message_stop");
  const text = events
    .filter((event) => typeof event.data === "object" && event.data !== null && (event.data as { type?: string }).type === "content_block_delta")
    .map((event) => ((event.data as { delta?: { text?: string } }).delta?.text ?? ""))
    .join("");
  assert.match(text, new RegExp(SENTINEL));
});

test("OpenAI chat streaming emits chat.completion.chunk frames carrying the synthesized answer", async () => {
  const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      stream: true,
      messages: [{ role: "user", content: "Fix calculator add() and report." }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sseEvents(await response.text());
  assert.ok(events.some((event) => event.data === "[DONE]"), "must terminate with [DONE]");
  const text = events
    .filter((event) => typeof event.data === "object" && event.data !== null && (event.data as { object?: string }).object === "chat.completion.chunk")
    .map((event) => ((event.data as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""))
    .join("");
  assert.match(text, new RegExp(SENTINEL));
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

const LIVE_CLAUDE =
  (process.env.FUSIONKIT_GATEWAY_LIVE_CLAUDE ?? process.env.WARRANT_GATEWAY_LIVE_CLAUDE) === "1"
    ? false
    : "set FUSIONKIT_GATEWAY_LIVE_CLAUDE=1 with a working claude CLI";

test(
  "live: real Claude Code CLI drives the gateway fusion run and receives the synthesized answer",
  { skip: LIVE_CLAUDE },
  async () => {
    // A dedicated single-model gateway keeps the live run light: each Claude
    // model call triggers one real unified harness run (worktree + command +
    // judge) on this gateway and the synthesized answer is returned to Claude.
    const liveGateway = await startConfiguredGateway({
      config: { ...config, models: [{ id: "claude-panel", model: "fusion-claude" }] },
      host: "127.0.0.1",
      port: 0
    });
    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            "claude",
            ["-p", "Report the final calculator fix result.", "--output-format", "text"],
            {
              env: {
                ...process.env,
                // Claude Code appends `/v1/messages`, so the base URL is the
                // gateway root without a `/v1` suffix.
                ANTHROPIC_BASE_URL: liveGateway.url(),
                ANTHROPIC_AUTH_TOKEN: "local-gateway"
              },
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, stdout, stderr });
          });
        }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(SENTINEL));
    } finally {
      await liveGateway.close();
    }
  }
);

const LIVE_CODEX =
  (process.env.FUSIONKIT_GATEWAY_LIVE_CODEX ?? process.env.WARRANT_GATEWAY_LIVE_CODEX) === "1"
    ? false
    : "set FUSIONKIT_GATEWAY_LIVE_CODEX=1 with a working codex CLI";

test(
  "live: real Codex CLI drives the gateway fusion run and receives the synthesized answer",
  { skip: LIVE_CODEX },
  async () => {
    // Codex streams `/v1/responses`; the gateway must emit the Responses SSE
    // sequence ending in response.completed for Codex to accept the answer.
    const liveGateway = await startConfiguredGateway({
      config: { ...config, models: [{ id: "codex-panel", model: "fusion-codex" }] },
      host: "127.0.0.1",
      port: 0
    });
    const codexHome = mkdtempSync(join(tmpdir(), "gateway-live-codex-"));
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "fusion-panel"',
        'model_provider = "fusion-gateway"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        "",
        "[model_providers.fusion-gateway]",
        'name = "Fusion Harness Gateway"',
        // Codex appends `/responses`, so the provider base URL ends in `/v1`.
        `base_url = "${liveGateway.url()}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        ""
      ].join("\n")
    );
    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            "codex",
            ["exec", "--json", "--skip-git-repo-check", "Report the final calculator fix result."],
            {
              cwd: fixture.repo,
              env: { ...process.env, CODEX_HOME: codexHome },
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, stdout, stderr });
          });
        }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(SENTINEL));
    } finally {
      await liveGateway.close();
      rmSync(codexHome, { recursive: true, force: true });
    }
  }
);

// Drives the real cursor-agent CLI in ACP mode through the bundled Cursorkit
// bridge, whose local model backend is pointed at this gateway. Requires a
// logged-in cursor-agent (Cursorkit is bundled as an npm dependency).
const LIVE_CURSOR =
  (process.env.FUSIONKIT_GATEWAY_LIVE_CURSOR ?? process.env.WARRANT_GATEWAY_LIVE_CURSOR) === "1"
    ? false
    : "set FUSIONKIT_GATEWAY_LIVE_CURSOR=1 with a logged-in cursor-agent";

test(
  "live: real cursor-agent (ACP) drives the Cursorkit bridge into the gateway fusion run",
  { skip: LIVE_CURSOR },
  async () => {
    const { serveCli } = resolveCursorkitCli();
    const liveGateway = await startConfiguredGateway({
      config: { ...config, models: [{ id: "cursor-panel", model: "fusion-cursor" }] },
      host: "127.0.0.1",
      port: 0
    });
    const bridgePort = 9700 + Math.floor(Math.random() * 250);
    let bridgeOut = "";
    const scrubbed: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("BRIDGE_") || key.startsWith("MODEL_") || key.startsWith("E2E_") || key.startsWith("CURSOR_UPSTREAM")) {
        scrubbed[key] = undefined;
      }
    }
    const bridgeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...scrubbed })) {
      if (value !== undefined) bridgeEnv[key] = value;
    }
    Object.assign(bridgeEnv, {
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_ROUTE_INVENTORY: "true",
      CURSOR_UPSTREAM_BASE_URL: "https://api2.cursor.sh",
      MODEL_BASE_URL: `${liveGateway.url()}/v1`,
      MODEL_API_KEY: "local",
      MODEL_NAME: "local-fusion",
      MODEL_PROVIDER_MODEL: "fusion-panel",
      MODEL_CONTEXT_TOKEN_LIMIT: "128000"
    });
    const bridge = spawn(process.execPath, [serveCli, "serve"], {
      env: bridgeEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    bridge.stdout.on("data", (chunk: Buffer) => {
      bridgeOut += chunk.toString("utf8");
    });
    bridge.stderr.on("data", (chunk: Buffer) => {
      bridgeOut += chunk.toString("utf8");
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!/bridge listening/.test(bridgeOut) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.match(bridgeOut, /bridge listening/, "Cursorkit bridge must start");

      const acp = spawn(
        "cursor-agent",
        ["--endpoint", `http://127.0.0.1:${bridgePort}`, "--model", "local-fusion", "--mode", "ask", "acp"],
        { cwd: fixture.repo, stdio: ["pipe", "pipe", "pipe"] }
      );
      let acpText = "";
      let nextId = 1;
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
      const rl = readline.createInterface({ input: acp.stdout });
      const send = (method: string, params: unknown): Promise<unknown> => {
        const id = nextId++;
        acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      };
      rl.on("line", (line) => {
        let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.id !== undefined && message.method === undefined) {
          const waiter = pending.get(Number(message.id));
          if (waiter === undefined) return;
          pending.delete(Number(message.id));
          if (message.error !== undefined) waiter.reject(message.error);
          else waiter.resolve(message.result);
          return;
        }
        if (message.method !== undefined) {
          if (message.method === "session/update") acpText += JSON.stringify(message.params);
          if (message.id !== undefined) {
            acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "skipped", reason: "harness" } } })}\n`);
          }
        }
      });
      const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
        Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("ACP step timed out")), ms))
        ]);
      try {
        await withTimeout(
          send("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "warrant-live", version: "0.1.0" }
          }),
          60_000
        );
        await withTimeout(send("authenticate", { methodId: "cursor_login" }), 60_000);
        const session = (await withTimeout(send("session/new", { cwd: fixture.repo, mcpServers: [] }), 60_000)) as {
          sessionId?: string;
          session?: { id?: string };
        };
        const sessionId = session.sessionId ?? session.session?.id;
        assert.ok(sessionId, "cursor-agent must create an ACP session");
        await withTimeout(
          send("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Fix calculator add() so the test passes, then report the result." }]
          }),
          60_000
        );
      } finally {
        rl.close();
        acp.kill("SIGTERM");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.match(acpText, new RegExp(SENTINEL), "fusion-synthesized answer must reach cursor-agent via session/update");
    } finally {
      bridge.kill("SIGTERM");
      await liveGateway.close();
    }
  }
);
