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

import { startFusionStack } from "../packages/cli/dist/fusion-quickstart.js";

const FK_DIR = process.env.WARRANT_FUSION_FK_DIR ?? "/Users/alen/Documents/Development/fusionkit";

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

function analyzeTrace(dir) {
  const counts = {};
  const components = {};
  let traceIds = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed);
      counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
      components[event.component] = (components[event.component] ?? 0) + 1;
      traceIds.add(event.trace_id);
    }
  }
  return { counts, components, traceIds: [...traceIds] };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "fusion-step-e2e-"));
  const repo = materializeRepo(join(root, "repo"));
  const traceDir = join(root, "trace");
  mkdirSync(traceDir, { recursive: true });
  process.env.FUSION_TRACE_DIR = traceDir;

  log(`repo: ${repo}`);
  log(`trace dir: ${traceDir}`);
  log("starting fusion stack (gpt + opus panel, judge gpt-5.5)...");

  const stack = await startFusionStack({
    repo,
    outputRoot: join(root, "runs"),
    models: [
      { id: "gpt", model: "gpt-5.5", provider: "openai" },
      { id: "opus", model: "claude-opus-4-8", provider: "anthropic" }
    ],
    fusionkitDir: FK_DIR,
    harness: "agent",
    judgeModel: "gpt-5.5",
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
    const trace = analyzeTrace(traceDir);
    log(`trace_ids: ${trace.traceIds.join(", ")}`);
    log(`components: ${JSON.stringify(trace.components)}`);
    log(`event_types: ${JSON.stringify(trace.counts)}`);

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
