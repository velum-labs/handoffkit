// Full-stack verification: boot the scope dashboard, run a real codex session
// through the judge-streamed-trajectory front door with real billed models, and
// confirm the dashboard's collector captured a complete, correlated session.
// Leaves the dashboard running on :4317 for a screenshot.
//
// Usage: node scripts/fusion-observe-verify.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFusionStack, startObservability } from "../packages/cli/dist/fusion-quickstart.js";

const FK_DIR = process.env.WARRANT_FUSION_FK_DIR ?? "/Users/alen/Documents/Development/fusionkit";
const log = (line) => process.stderr.write(`${line}\n`);

function materializeRepo(root) {
  mkdirSync(root, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: root });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "fusion@test.local"]);
  git(["config", "user.name", "fusion-test"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fusion-observe-sample", private: true, scripts: { test: "node --test" } }, null, 2) + "\n"
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

async function main() {
  const root = mkdtempSync(join(tmpdir(), "fusion-observe-"));
  const repo = materializeRepo(join(root, "repo"));
  const codexHome = join(root, "codex-home");

  log("building + starting scope dashboard...");
  const obs = await startObservability({ log });
  process.env.FUSION_TRACE_URL = obs.ingestUrl;
  process.env.FUSION_TRACE_DIR = obs.traceDir;
  log(`dashboard: ${obs.url}`);

  log("starting fusion stack (gpt + opus panel)...");
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

  const task =
    "The `total` function in cart.js should sum the line items then apply the given percentage discount, " +
    "but `npm test` fails. Find and fix the bug, then run the tests to confirm they pass.";
  log("running codex exec...");
  await new Promise((resolveExit) => {
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
    child.stdout?.on("data", (c) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c) => (out += c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      log(`codex exit_code=${code}`);
      log(out.slice(-700));
      resolveExit(code);
    });
  });

  const test = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
  log(`\nOUT-OF-THE-BOX npm test exit_code=${test.status}`);

  // Give fire-and-forget trace POSTs a moment to drain into the collector.
  await new Promise((r) => setTimeout(r, 1500));

  log("\n=== DASHBOARD COLLECTOR VERIFICATION ===");
  const sessions = await (await fetch(`${obs.url}/api/sessions`)).json();
  log(`sessions: ${sessions.sessions.length}`);
  const session = sessions.sessions[0];
  if (session) {
    log(`session ${session.traceId}: status=${session.status} repo=${session.repo} events=${session.eventCount}`);
    const detail = (await (await fetch(`${obs.url}/api/sessions/${session.traceId}`)).json()).session;
    log(`  candidates=${detail.candidates.length} modelCalls=${detail.modelCalls.length}`);
    log(`  judge: thinking=${detail.judge.thinking !== undefined} final=${detail.judge.final !== undefined}`);
    log(`  finalOutput=${(detail.finalOutput ?? "").slice(0, 120)}`);
    log(`  eventCounts=${JSON.stringify(detail.eventCounts)}`);
  }

  log(`\nRESULT: ${test.status === 0 ? "GREEN" : "RED"} — dashboard at ${obs.url} (trace ${session?.traceId ?? "none"})`);
  // Close the stack (panel servers) but LEAVE the dashboard running for a screenshot.
  await stack.close().catch(() => {});
  log("stack closed; dashboard still running. Ctrl+C to stop.");
}

main().catch((error) => {
  log(`FATAL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
