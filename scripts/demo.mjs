#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const DEMOS = [
  {
    "id": "01",
    "directory": "governed-run",
    "title": "governed run",
    "summary": "Run an agent harness on a runner you control, under a signed contract, and get a receipt that answers the five questions.",
    "interactive": false
  },
  {
    "id": "02",
    "directory": "dry-run",
    "title": "dry run — what would move?",
    "summary": "dryRun is a security feature: the complete disclosure report, with nothing uploaded, issued, or executed.",
    "interactive": false
  },
  {
    "id": "03",
    "directory": "consent-secrets",
    "title": "consent and brokered secrets",
    "summary": "A run requesting a production secret blocks on human approval; the value is injected into the session and never appears in any contract, event, or receipt.",
    "interactive": false
  },
  {
    "id": "04",
    "directory": "egress-policy",
    "title": "deny-by-default egress",
    "summary": "Network policy is decided at contract time and enforced at the session boundary; every attempted connection is recorded in the receipt.",
    "interactive": false
  },
  {
    "id": "05",
    "directory": "offline-verify",
    "title": "offline verification and tamper evidence",
    "summary": "Receipts verify against nothing but published schemas and keys. Rewriting history — or quietly dropping a secret release — breaks the math.",
    "interactive": false
  },
  {
    "id": "06",
    "directory": "handoff",
    "title": "handoff — continue local work on a governed runner",
    "summary": "The continuation SDK: checkpoint local state, hand it to a runner pool under policy, and pull the results (and the proof) back. One gesture, full provenance.",
    "interactive": false
  },
  {
    "id": "07",
    "directory": "parallel-fanout",
    "title": "parallel fan-out and review",
    "summary": "Fork one checkpoint into isolated attempts, each with its own contract and receipt, then choose deterministically. Topology, not an agent tournament.",
    "interactive": false
  },
  {
    "id": "08",
    "directory": "control-panel",
    "title": "control panel",
    "summary": "Boot a plane + runner, seed realistic runs (a continuation, a success, a failure, a cancellation, and one awaiting approval), and leave the control panel up for you to explore.",
    "interactive": true
  },
  {
    "id": "09",
    "directory": "ai-sdk-loop",
    "title": "AI SDK app-owned loop with governed remote tools",
    "summary": "Your generateText loop, your model — Warrant governs the tool boundary: every tool call is a signed contract executed on a runner, returned with a verifiable receipt. Honestly labeled: no durability claim attaches to the loop itself.",
    "interactive": false
  },
  {
    "id": "10",
    "directory": "compute-sandbox",
    "title": "ComputeSDK-shaped sandbox over governed sessions",
    "summary": "The sandbox shape developers already write — create, runCommand, filesystem — where every command is a signed contract with a receipt, and continuity flows through the workspace.",
    "interactive": false
  },
  {
    "id": "11",
    "directory": "golden-interface",
    "title": "the golden interface",
    "summary": "The predecessor spec's golden shape, built on Warrant primitives: h.tools wraps your AI SDK tools (journaled semantic state), h.needs gates the boundary, h.continueIn moves the work, h.compute is the sandbox surface, h.summary explains it all.",
    "interactive": false
  },
  {
    "id": "12",
    "directory": "model-escalation",
    "title": "model escalation",
    "summary": "h.model starts on the local model and escalates to cloud under deterministic conditions — here, a prompt-size threshold standing in for 'context too large'. Every routing decision lands in the trace, and escalation makes continuation 'needed'.",
    "interactive": false
  },
  {
    "id": "13",
    "directory": "hermetic-session",
    "title": "hermetic session isolation",
    "summary": "Run the command harness inside a simulated bash interpreter (just-bash) with a virtual filesystem and interpreter-enforced egress. No real process, no real socket — nothing to escape with. The receipt records isolation: hermetic.",
    "interactive": false
  }
];

const bold = (text) => process.stdout.isTTY && process.env.NO_COLOR === undefined ? `\u001b[1m${text}\u001b[0m` : text;
const dim = (text) => process.stdout.isTTY && process.env.NO_COLOR === undefined ? `\u001b[2m${text}\u001b[0m` : text;

function list() {
  console.log(bold("warrant examples"));
  console.log("");
  for (const demo of DEMOS) {
    console.log(`  ${bold(demo.id)}  ${demo.title}${demo.interactive ? dim("  (interactive)") : ""}`);
    console.log(`      ${dim(demo.summary)}`);
  }
  console.log("");
  console.log(`run one:  ${bold("pnpm demo 01")}`);
  console.log(`run all:  ${bold("pnpm demo all")} ${dim("(skips interactive examples)")}`);
}

function runDemo(demo) {
  const entry = `examples/${demo.directory}/dist/run.js`;
  if (!existsSync(entry)) {
    console.error(`missing built example: ${entry}`);
    console.error("run pnpm build before running demos");
    return 1;
  }
  const result = spawnSync(process.execPath, [entry], { stdio: "inherit" });
  return result.status ?? 1;
}

const selector = process.argv[2];
if (!selector || selector === "list") {
  list();
  process.exit(0);
}

if (selector === "all") {
  for (const demo of DEMOS) {
    if (demo.interactive) continue;
    const status = runDemo(demo);
    if (status !== 0) process.exit(status);
  }
  process.exit(0);
}

const normalized = selector.padStart(2, "0");
const demo = DEMOS.find((candidate) => candidate.id === selector || candidate.id === normalized);
if (!demo) {
  console.error(`unknown demo "${selector}"`);
  list();
  process.exit(1);
}

process.exit(runDemo(demo));
