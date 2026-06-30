// Real end-to-end driver using the codex CLI as the front-door harness.
//
// Stands up the real stack (cloud gpt + opus panel, FusionKit synthesis/step
// server, the new FusionBackend gateway) and points `codex exec` at it. Codex
// executes the judge's streamed trajectory against a real buggy repo; success =
// the repo's tests pass out of the box. Trace events are captured for analysis.
//
// Usage: node scripts/fusion-codex-e2e.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFusionStack } from "../packages/cli/dist/fusion-quickstart.js";

const FK_DIR = process.env.WARRANT_FUSION_FK_DIR ?? fileURLToPath(new URL("..", import.meta.url));

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
    JSON.stringify({ name: "fusion-codex-sample", private: true, scripts: { test: "node --test" } }, null, 2) + "\n"
  );
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
      "assert.equal(total([100, 50], 10), 135);",
      ""
    ].join("\n")
  );
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "failing cart discount sample"]);
  return root;
}

function writeCodexHome(home, gatewayUrl) {
  mkdirSync(home, { recursive: true });
  const base = gatewayUrl.replace(/\/+$/, "");
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "fusion-panel"',
      'model_provider = "fusion-gateway"',
      "",
      "[model_providers.fusion-gateway]",
      'name = "Fusion Harness Gateway"',
      `base_url = "${base}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      ""
    ].join("\n")
  );
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
  const root = mkdtempSync(join(tmpdir(), "fusion-codex-e2e-"));
  const repo = materializeRepo(join(root, "repo"));
  const traceDir = join(root, "trace");
  const codexHome = join(root, "codex-home");
  mkdirSync(traceDir, { recursive: true });
  process.env.FUSION_TRACE_DIR = traceDir;

  log(`repo: ${repo}`);
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
  writeCodexHome(codexHome, stack.fusionUrl);

  try {
    const task =
      "The `total` function in cart.js should sum the line items then apply the given percentage discount, " +
      "but `npm test` fails. Find and fix the bug, then run the tests to confirm they pass.";
    log("\n=== running codex exec (async; gateway stays responsive) ===");
    // IMPORTANT: spawn async (not spawnSync) — the gateway runs in this same
    // process, so a synchronous child would block the event loop and deadlock.
    const codexExit = await new Promise((resolveExit) => {
      const child = spawn(
        "codex",
        ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", repo, task],
        {
          cwd: repo,
          env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "local-not-needed" },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let out = "";
      child.stdout?.on("data", (chunk) => (out += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => (out += chunk.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        log(`codex exit_code=${code}`);
        log(out.slice(-1800));
        resolveExit(code);
      });
    });
    void codexExit;

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
