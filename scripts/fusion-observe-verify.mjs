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
import { fileURLToPath } from "node:url";

import { initFusionTracing } from "../packages/tracing/dist/index.js";

import { startFusionStack, startObservability } from "../packages/cli/dist/fusion-quickstart.js";
import { BENCHMARK_PANEL_PRESETS, FUSION_PANEL_MODEL } from "../packages/registry/dist/index.js";
import { codexLaunchConfigToml } from "../packages/tool-codex/dist/index.js";

const FK_DIR = process.env.FUSIONKIT_FUSION_FK_DIR ?? fileURLToPath(new URL("..", import.meta.url));
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
  writeFileSync(
    join(home, "config.toml"),
    `${codexLaunchConfigToml(gatewayUrl.replace(/\/+$/, ""), FUSION_PANEL_MODEL).trimEnd()}\n`
  );
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "fusion-observe-"));
  const repo = materializeRepo(join(root, "repo"));
  const codexHome = join(root, "codex-home");

  log("building + starting scope dashboard...");
  const obs = await startObservability({ log });
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = obs.otlpUrl;
  initFusionTracing({ serviceName: "fusion-observe-verify" });
  log(`dashboard: ${obs.url}`);

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
    log(`session ${session.traceId}: status=${session.status} repo=${session.repo} spans=${session.spanCount}`);
    const detail = (await (await fetch(`${obs.url}/api/sessions/${session.traceId}`)).json()).session;
    log(`  candidates=${detail.candidates.length} modelCalls=${detail.modelCalls.length}`);
    log(`  judge: thinking=${detail.judge.thinking !== undefined} final=${detail.judge.final !== undefined}`);
    log(`  finalOutput=${(detail.finalOutput ?? "").slice(0, 120)}`);
    log(`  spanCounts=${JSON.stringify(detail.spanCounts)}`);
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
