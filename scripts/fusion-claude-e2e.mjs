// Real end-to-end driver using Claude Code as the front-door harness.
//
// Stands up the real stack (cloud gpt + opus panel, FusionKit synthesis/step
// server, the new FusionBackend gateway) and points Claude Code at it via the
// Anthropic Messages dialect (ANTHROPIC_BASE_URL=<gateway>). Claude executes the
// judge's streamed trajectory against a real buggy repo; success = the repo's
// tests pass out of the box. Exercises the Anthropic streaming keepalive fix.
//
// Usage: node scripts/fusion-claude-e2e.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFusionStack } from "../packages/cli/dist/fusion-quickstart.js";
import { BENCHMARK_PANEL_PRESETS } from "../packages/registry/dist/index.js";

const FK_DIR = process.env.WARRANT_FUSION_FK_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const log = (line) => process.stderr.write(`${line}\n`);
const E2E_PANEL = BENCHMARK_PANEL_PRESETS["gpt-opus-smoke"];
if (E2E_PANEL === undefined) throw new Error("missing gpt-opus-smoke benchmark panel preset");
const E2E_JUDGE_MODEL = E2E_PANEL.members.find((member) => member.id === E2E_PANEL.judgeId)?.model;
if (E2E_JUDGE_MODEL === undefined) throw new Error("gpt-opus-smoke judgeId must reference a member");

function materializeRepo(root) {
  mkdirSync(root, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: root });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "fusion@test.local"]);
  git(["config", "user.name", "fusion-test"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fusion-claude-sample", private: true, scripts: { test: "node --test" } }, null, 2) + "\n"
  );
  writeFileSync(
    join(root, "pricing.js"),
    "function applyDiscount(amount, percent) {\n  return amount * percent;\n}\nmodule.exports = { applyDiscount };\n"
  );
  writeFileSync(
    join(root, "cart.js"),
    "const { applyDiscount } = require('./pricing.js');\nfunction total(items, percent) {\n  const sum = items.reduce((a, n) => a + n, 0);\n  return applyDiscount(sum, percent);\n}\nmodule.exports = { total };\n"
  );
  writeFileSync(
    join(root, "cart.test.js"),
    "const assert = require('node:assert/strict');\nconst { total } = require('./cart.js');\nassert.equal(total([100, 50], 10), 135);\n"
  );
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "failing cart discount sample"]);
  return root;
}

function analyzeTrace(dir) {
  const counts = {};
  const components = {};
  const traceIds = new Set();
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
  const root = mkdtempSync(join(tmpdir(), "fusion-claude-e2e-"));
  const repo = materializeRepo(join(root, "repo"));
  const traceDir = join(root, "trace");
  mkdirSync(traceDir, { recursive: true });
  process.env.FUSION_TRACE_DIR = traceDir;

  log(`repo: ${repo}`);
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
      "The `total` function in cart.js should sum the line items then apply the given percentage discount, " +
      "but `npm test` fails. Find and fix the bug, then run the tests to confirm they pass.";
    log("\n=== running claude -p (async; gateway stays responsive) ===");
    const claudeExit = await new Promise((resolveExit) => {
      const child = spawn(
        "claude",
        ["-p", "--dangerously-skip-permissions", "--model", "claude-warrant-local", task],
        {
          cwd: repo,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: stack.fusionUrl,
            ANTHROPIC_AUTH_TOKEN: "warrant-local",
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let out = "";
      child.stdout?.on("data", (c) => (out += c.toString("utf8")));
      child.stderr?.on("data", (c) => (out += c.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        log(`claude exit_code=${code}`);
        log(out.slice(-1800));
        resolveExit(code);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        log(`claude spawn error: ${error instanceof Error ? error.message : String(error)}`);
        resolveExit(1);
      });
    });
    void claudeExit;

    log("\n=== OUT-OF-THE-BOX CHECK (npm test on the real repo) ===");
    const test = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
    log(`npm test exit_code=${test.status}`);
    log((test.stdout + test.stderr).slice(-500));

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
