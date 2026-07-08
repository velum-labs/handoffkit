// Real end-to-end driver for the judge-streamed-trajectory front door.
//
// Stands up the real stack (cloud gpt + opus panel, FusionKit synthesis/step
// server, and the new FusionBackend gateway) and drives it with a minimal but
// real tool-loop harness against a buggy git repo. The harness executes the
// judge's streamed tool calls against the repo and loops; success = the repo's
// tests pass out of the box. Trace events are captured to a JSONL dir for
// data-flow analysis.
//
// Usage: node scripts/fusion-step-e2e.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { initFusionTracing, shutdownFusionTracing } from "../packages/tracing/dist/index.js";

import { startOtlpCapture } from "./otlp-capture.mjs";
import { startFusionStack } from "../packages/cli/dist/fusion-quickstart.js";
import { BENCHMARK_PANEL_PRESETS } from "../packages/registry/dist/index.js";

const FK_DIR = process.env.FUSIONKIT_FUSION_FK_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const E2E_PANEL = BENCHMARK_PANEL_PRESETS["gpt-opus-smoke"];
if (E2E_PANEL === undefined) throw new Error("missing gpt-opus-smoke benchmark panel preset");
const E2E_JUDGE_MODEL = E2E_PANEL.members.find((member) => member.id === E2E_PANEL.judgeId)?.model;
if (E2E_JUDGE_MODEL === undefined) throw new Error("gpt-opus-smoke judgeId must reference a member");

function log(line) {
  process.stderr.write(`${line}\n`);
}

function materializeRepo(root) {
  mkdirSync(root, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: root });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "fusion@test.local"]);
  git(["config", "user.name", "fusion-test"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fusion-step-sample", private: true, scripts: { test: "node --test" } }, null, 2) + "\n"
  );
  // A small multi-file bug: total() should sum line items after discount, but
  // applyDiscount multiplies instead of subtracting the percentage.
  writeFileSync(
    join(root, "pricing.js"),
    [
      "function applyDiscount(amount, percent) {",
      "  // BUG: should reduce amount by percent, not multiply by it",
      "  return amount * percent;",
      "}",
      "module.exports = { applyDiscount };",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "cart.js"),
    [
      "const { applyDiscount } = require('./pricing.js');",
      "function total(items, percent) {",
      "  const sum = items.reduce((acc, n) => acc + n, 0);",
      "  return applyDiscount(sum, percent);",
      "}",
      "module.exports = { total };",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "cart.test.js"),
    [
      "const assert = require('node:assert/strict');",
      "const { total } = require('./cart.js');",
      "// 100 + 50 = 150, with a 10% discount => 135",
      "assert.equal(total([100, 50], 10), 135);",
      ""
    ].join("\n")
  );
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "failing cart discount sample"]);
  return root;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file relative to the repo root.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (overwrite) a UTF-8 file relative to the repo root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run",
      description: "Run a shell command in the repo root and return combined output + exit code.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  }
];

function execTool(repo, name, args) {
  try {
    if (name === "read_file") {
      return readFileSync(join(repo, args.path), "utf8").slice(0, 4000);
    }
    if (name === "write_file") {
      writeFileSync(join(repo, args.path), String(args.content ?? ""));
      return `wrote ${args.path}`;
    }
    if (name === "run") {
      const result = spawnSync(args.command, { cwd: repo, shell: true, encoding: "utf8", timeout: 60_000 });
      return `exit_code=${result.status ?? "null"}\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`.slice(0, 4000);
    }
    return `unknown tool ${name}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function driveHarness(gatewayUrl, repo, task) {
  const url = `${gatewayUrl}/v1/chat/completions`;
  const messages = [
    {
      role: "system",
      content:
        "You are a coding agent working in a real repository. Use the provided tools to inspect and edit " +
        "files and to run the test suite. Keep going until `npm test` passes, then reply with a short final summary."
    },
    { role: "user", content: task }
  ];
  for (let turn = 0; turn < 10; turn++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fusion-panel", messages, tools: TOOLS, stream: false })
    });
    if (!response.ok) throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json();
    const choice = body.choices?.[0];
    const message = choice?.message ?? {};
    messages.push(message);
    const toolCalls = message.tool_calls ?? [];
    log(`harness turn ${turn}: finish=${choice?.finish_reason} tool_calls=${toolCalls.length} content=${(message.content ?? "").slice(0, 120)}`);
    if (toolCalls.length === 0) {
      return message.content ?? "";
    }
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        args = {};
      }
      const output = execTool(repo, call.function?.name ?? "", args);
      log(`  tool ${call.function?.name} -> ${output.split("\n")[0]}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
  return "(max turns reached)";
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "fusion-step-e2e-"));
  const repo = materializeRepo(join(root, "repo"));
  // Capture the run's spans + events with an in-script OTLP collector: the
  // in-process gateway/ensemble tracer and every spawned child (panel
  // servers, the Python synthesis engine) export to it over standard OTLP/HTTP.
  const capture = await startOtlpCapture();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = capture.baseEndpoint;
  initFusionTracing({ serviceName: "fusion-e2e" });

  log(`repo: ${repo}`);
  log(`otlp capture: ${capture.baseEndpoint}`);
  log(`starting fusion stack (${E2E_PANEL.panelId}, judge ${E2E_JUDGE_MODEL})...`);
  const stack = await startFusionStack({
    repo,
    outputRoot: join(root, "runs"),
    models: E2E_PANEL.members,
    fusionkitDir: FK_DIR,
    harness: "agent",
    judgeModel: E2E_JUDGE_MODEL,
    timeoutMs: 240_000,
    log
  });
  log(`gateway: ${stack.fusionUrl}`);

  try {
    const task =
      "The `total` function in cart.js should sum the line items and then apply the given percentage discount, " +
      "but `npm test` fails. Find and fix the bug so the test passes.";
    const final = await driveHarness(stack.fusionUrl, repo, task);
    log("\n=== FINAL HARNESS OUTPUT ===");
    log(final.slice(0, 800));

    log("\n=== OUT-OF-THE-BOX CHECK (npm test on the real repo) ===");
    const test = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
    log(`npm test exit_code=${test.status}`);
    log((test.stdout + test.stderr).slice(-600));

    log("\n=== TRACE DATA FLOW ===");
    await shutdownFusionTracing();
    await new Promise((resolve) => setTimeout(resolve, 750));
    const trace = capture.analyze();
    log(`trace_ids: ${trace.traceIds.join(", ")}`);
    log(`scopes: ${JSON.stringify(trace.scopes)}`);
    log(`span_names: ${JSON.stringify(trace.counts)}`);
    log(`event_names: ${JSON.stringify(trace.eventCounts)}`);

    log(`\nRESULT: ${test.status === 0 ? "GREEN (tests pass out of the box)" : "RED (tests still failing)"}`);
    process.exitCode = test.status === 0 ? 0 : 1;
  } finally {
    await stack.close().catch(() => {});
  }
}

main().catch((error) => {
  log(`FATAL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
