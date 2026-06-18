#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createCommandHarness,
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  codexHarness,
  codexHarnessCredentialSkipReason,
  createMockHarness,
  createMockJudgeSynthesizer,
  runEnsemble,
  runUnifiedHarnessE2E,
  runHarnessSmokeDashboard
} from "@warrant/ensemble";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  EnsembleRunResult,
  HarnessAdapter,
  HarnessLiveSmokeTarget,
  HarnessSmokeDashboard,
  UnifiedHarnessKind
} from "@warrant/ensemble";
import { agents, handoff, targets } from "@warrant/handoff";
import { Plane, startPlaneServer } from "@warrant/plane";
import {
  AGENT_KINDS,
  assertBenchmarkTaskRecordV1,
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  assertJudgeSynthesisRecordV1,
  assertModelCallRecordV1,
  assertModelFusionRecord,
  assertToolExecutionRecordV1,
  isTerminalStatus,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  PolicyDeniedError,
  SESSION_ISOLATIONS,
  verifyReceiptBundle
} from "@warrant/protocol";
import type {
  AgentKind,
  AgentSpec,
  BenchmarkTaskRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  ModelFusionSideEffects,
  ModelFusionHarnessKind,
  ModelFusionRecordV1,
  ToolExecutionRecordV1,
  ReceiptBundle,
  RunRequestInput,
  SessionIsolation
} from "@warrant/protocol";
import { Runner } from "@warrant/runner";
import { PlaneClient } from "@warrant/sdk";
import { captureWorkspace, gitText, pullRun } from "@warrant/workspace";

import { initHome, loadHome, secretStoreFor } from "./config.js";
import {
  codexConfigSnippet,
  gatewaySetupSnippets,
  installRegistryAdapters,
  runGatewayAcceptance,
  runGatewayAcp,
  startConfiguredGateway
} from "./gateway.js";
import type { GatewayRunnerConfig } from "./gateway.js";
import { LOCAL_TOOLS, runLocal } from "./local.js";
import type { LocalTool } from "./local.js";
import { FUSION_TOOLS, pickTool, runFusion } from "./fusion-quickstart.js";
import type { FusionTool, PanelModelSpec, PanelProvider, RunFusionOptions } from "./fusion-quickstart.js";
import {
  renderDisclosure,
  renderReceipt,
  renderRunList,
  renderTrace
} from "./render.js";

// Built on node:util parseArgs rather than a CLI framework: the command
// surface is small and fully enumerated in USAGE, and the parsing below is
// plain data — a framework would add a dependency without removing code.

/** Poll interval while watching a run from the terminal. */
const WATCH_POLL_MS = 500;
/** How long `warrant continue` waits for the run before returning. */
const CONTINUE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const USAGE = `warrant — the governed execution and provenance plane for AI agents

usage:
  warrant init [--port N] [--host H] [--plane-url URL]
                                                 initialize org keys, config, policy
  warrant plane start [--port N] [--host H]      start the control plane + control panel
  warrant runner start --pool P [--plane URL]    start an outbound-only runner
  warrant secrets set NAME VALUE                 store a secret in the org store
  warrant secrets list                           list stored secret names
  warrant run --agent KIND [opts] "task"         request a governed run
      --pool P            runner pool (default: default)
      --secret NAME       release a secret into the session (repeatable)
      --allow-host H      allow egress to host (repeatable)
      --allow-untracked G include untracked files matching glob (repeatable)
      --repo DIR          workspace repository (default: .)
      --isolation TIER    session isolation: process | hermetic | vercel-sandbox
      --dry-run           show what would move; move nothing
      --no-watch          do not wait for completion
  warrant continue --agent KIND [opts] "task"    hand local work to a governed runner
      --pool P            target runner pool (default: default)
      --transcript FILE   carry a session transcript as semantic state
      --reason TEXT       why the runtime boundary changes
      (plus --secret/--allow-host/--allow-untracked/--repo/--dry-run/--no-watch)
  warrant runs                                   list runs
  warrant approve RUN_ID                         grant required consent
  warrant cancel RUN_ID                          cancel an unclaimed run
  warrant watch RUN_ID                           stream run status
  warrant receipt RUN_ID                         one screen, five questions
  warrant bundle RUN_ID [--out FILE]             save offline-verifiable bundle
  warrant verify FILE                            verify a bundle offline
  warrant pull RUN_ID [--repo DIR]               divergence-safe pull of results
  warrant export [--since ISO]                   audit JSONL export
  warrant ui                                     control panel URL and login token
  warrant local <tool> [args...]                 back a vendor agent with a local model
      tools: claude | codex | opencode | cursor | serve
      --public-url URL    public tunnel URL for Cursor (or WARRANT_PUBLIC_URL)
      --auth-token TOKEN  require a bearer token on the gateway
      (model backend via WARRANT_LOCAL_MODEL_URL / WARRANT_MLX_MODEL; mlx by default)
  warrant fusion [tool] [args...]                one command: real model fusion backs a coding agent
      tool: codex | claude | cursor | serve   (omit on a TTY to pick interactively)
      --model ID=MODEL        local panel model (repeatable; default: Qwen+Gemma+Llama trio)
      --model ID=PROVIDER:MODEL  cloud panel model, e.g. gpt=openai:gpt-5.5, opus=anthropic:claude-opus-4-8
      --key-env ID=ENV        env var holding that model's API key (default: OPENAI_API_KEY / ANTHROPIC_API_KEY)
      --harness agent|command per-candidate harness (default: agent = trajectory fusion)
      --fusionkit-dir DIR     FusionKit checkout (fronts cloud models + runs trajectory synthesis; or WARRANT_FUSIONKIT_DIR)
      --synthesis-url URL     pre-running fusionkit serve for synthesis (skips auto-spawn)
      --model-endpoint ID=URL pre-running OpenAI-compatible endpoint for a panel model (repeatable)
      --judge-model MODEL     model used for judge synthesis
      --judge-endpoint URL    OpenAI-compatible endpoint for judge synthesis
      --repo DIR              coding workspace (default: a bundled real sample repo)
      --command CMD           per-candidate solve command (default: shipped model-backed solve agent)
      --cursor-kit-dir DIR    built Cursorkit checkout for the cursor tool (or WARRANT_CURSORKIT_DIR)
      --observe               boot the local scope dashboard (http://127.0.0.1:4317) and stream live trace events into it
      --auth-token TOKEN      require a bearer token on the gateway
      --port N                gateway port (default: ephemeral)
  warrant ensemble run [opts] "task"             run local ensemble smoke
      --harness mock|command  harness to run (default: mock)
      --command CMD           shell command for command harness
      --model ID=MODEL        candidate model mapping (repeatable)
      --repo DIR              workspace repository (default: .)
      --out DIR               output directory (default: ./.warrant/ensemble-cli)
      --task-file FILE        read task prompt from file
      --judge ID              judge id (default: mock)
      --policy ID             policy id (default: local-smoke)
      --timeout-ms N          command timeout (default: 30000)
  warrant ensemble handoff [opts] < payload.json
                                                 FusionKit stdin/stdout handoff executor
      --harness mock|command|claude-code|codex
      --command CMD           shell command for command harness
      --model ID=MODEL        candidate model mapping (repeatable)
      --repo DIR              workspace repository (default: .)
      --out DIR               output directory (default: ./.warrant/ensemble-handoff)
      --id ID                 descriptor id (default: handoff_<task_id>)
      --timeout-ms N          command/coding harness timeout (default: 30000)
  warrant ensemble dashboard [opts]              generate harness smoke dashboard
      --repo DIR              workspace repository (default: .)
      --out DIR               output directory (default: ./.warrant/ensemble-dashboard)
      --timeout-ms N          command timeout (default: 30000)
      --live-smoke TARGET     include env-gated live smoke: claude-code | codex (repeatable)
  warrant ensemble e2e [opts] "task"             unified FusionKit-backed harness matrix
      --fusion-backend URL    FusionKit/OpenAI-compatible backend URL
      --harness TARGET        mock | command | codex | claude-code | cursor-acp | cursor-desktop
      --model ID=MODEL        panel model mapping (repeatable)
      --command CMD           command harness script
      --repo DIR              workspace repository (default: .)
      --out DIR               output directory (default: ./.warrant/ensemble-e2e)
      --cursor-kit-dir DIR    Cursorkit repo for cursor ACP/desktop scenarios
      --timeout-ms N          candidate timeout (default: 30000)
  warrant ensemble gateway [serve] [opts]        front door: tools drive the fusion ensemble
      --fusion-backend URL    FusionKit/OpenAI-compatible backend URL
      --harness TARGET        mock | command | codex | claude-code | cursor-acp (repeatable)
      --model ID=MODEL        panel model mapping (repeatable)
      --command CMD           command harness script
      --repo DIR              workspace repository (default: .)
      --out DIR               output directory (default: ./.warrant/gateway)
      --host H                bind host (default: 127.0.0.1)
      --port N                bind port (default: 8787)
      --auth-token TOKEN      require a bearer token on the gateway
  warrant ensemble gateway acp [opts]            ACP local agent over JSON-RPC stdio
  warrant ensemble gateway acp-registry install <id...>
                                                 install registry-backed ACP adapters
      --install-dir DIR       adapter metadata dir (default: ./.warrant/acp-registry)
  warrant ensemble gateway test [opts]           unified front-door acceptance suite
      --sentinel TEXT         expected substring (default: FUSION_OK)
      --out FILE              report path (default: ./.warrant/front-door-e2e/front-door-report.json)
  warrant ensemble gateway codex-config [opts]   print Codex provider config snippet

global:
  --dir DIR    warrant home (default: ./.warrant)
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function agentSpecFor(kind: string): AgentSpec {
  switch (kind as AgentKind) {
    case "claude-code":
      return agents.claudeCode();
    case "codex":
      return agents.codex();
    case "pi":
      return agents.pi();
    case "mock":
      return agents.mock();
    case "command":
      return agents.command();
    default:
      fail(`unknown agent kind "${kind}" (expected ${AGENT_KINDS.join(" | ")})`);
  }
}

function clientFor(dir: string): PlaneClient {
  const home = loadHome(dir);
  return new PlaneClient(home.config.planeUrl, home.config.adminToken);
}

async function waitForTerminal(
  client: PlaneClient,
  runId: string,
  onStatus: (status: string) => void
): Promise<string> {
  let last = "";
  for (;;) {
    const view = await client.getRun(runId);
    if (view.status !== last) {
      last = view.status;
      onStatus(view.status);
    }
    if (isTerminalStatus(view.status)) {
      return view.status;
    }
    if (view.status === "awaiting_approval") {
      onStatus(
        `awaiting approval (${view.consentRequirements.join("; ")}) — run: warrant approve ${runId}`
      );
      return view.status;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, WATCH_POLL_MS));
  }
}

type RunFlags = {
  agent?: string;
  pool?: string;
  secret?: string[];
  "allow-host"?: string[];
  "allow-untracked"?: string[];
  repo?: string;
  "dry-run"?: boolean;
  "no-watch"?: boolean;
  transcript?: string;
  reason?: string;
  isolation?: string;
};

type EnsembleFlags = {
  harness?: string;
  command?: string;
  repo?: string;
  out?: string;
  id?: string;
  model?: string[];
  judge?: string;
  policy?: string;
  "timeout-ms"?: string;
  "task-file"?: string;
};

type EnsembleDashboardFlags = {
  repo?: string;
  out?: string;
  "timeout-ms"?: string;
  "live-smoke"?: string[];
};

type EnsembleE2EFlags = {
  "fusion-backend"?: string;
  harness?: string[];
  command?: string;
  repo?: string;
  out?: string;
  id?: string;
  model?: string[];
  "judge-model"?: string;
  "cursor-kit-dir"?: string;
  "timeout-ms"?: string;
  "task-file"?: string;
};

function parseRunArgs(argv: string[]): { values: RunFlags; prompt: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      pool: { type: "string", default: "default" },
      secret: { type: "string", multiple: true },
      "allow-host": { type: "string", multiple: true },
      "allow-untracked": { type: "string", multiple: true },
      repo: { type: "string", default: "." },
      "dry-run": { type: "boolean", default: false },
      "no-watch": { type: "boolean", default: false },
      transcript: { type: "string" },
      reason: { type: "string" },
      isolation: { type: "string" }
    },
    allowPositionals: true
  });
  return { values, prompt: positionals.join(" ").trim() };
}

function parseEnsembleArgs(argv: string[]): { values: EnsembleFlags; prompt: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      harness: { type: "string", default: "mock" },
      command: { type: "string" },
      repo: { type: "string", default: "." },
      out: { type: "string" },
      id: { type: "string" },
      model: { type: "string", multiple: true },
      judge: { type: "string", default: "mock" },
      policy: { type: "string", default: "local-smoke" },
      "timeout-ms": { type: "string" },
      "task-file": { type: "string" }
    },
    allowPositionals: true
  });
  const prompt =
    values["task-file"] !== undefined
      ? readFileSync(values["task-file"], "utf8")
      : positionals.join(" ").trim();
  return { values, prompt };
}

function parseEnsembleHandoffArgs(argv: string[]): EnsembleFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      harness: { type: "string", default: "mock" },
      command: { type: "string" },
      repo: { type: "string", default: "." },
      out: { type: "string" },
      id: { type: "string" },
      model: { type: "string", multiple: true },
      judge: { type: "string", default: "mock" },
      policy: { type: "string", default: "local-smoke" },
      "timeout-ms": { type: "string" }
    },
    allowPositionals: true
  });
  if (positionals.length > 0) fail("ensemble handoff reads task payload from stdin and does not accept positional arguments");
  return values;
}

function parseEnsembleDashboardArgs(argv: string[]): EnsembleDashboardFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string", default: "." },
      out: { type: "string" },
      "timeout-ms": { type: "string" },
      "live-smoke": { type: "string", multiple: true }
    },
    allowPositionals: true
  });
  if (positionals.length > 0) fail("ensemble dashboard does not accept positional arguments");
  return values;
}

function parseEnsembleE2EArgs(argv: string[]): { values: EnsembleE2EFlags; prompt: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "fusion-backend": { type: "string" },
      harness: { type: "string", multiple: true },
      command: { type: "string" },
      repo: { type: "string", default: "." },
      out: { type: "string" },
      id: { type: "string" },
      model: { type: "string", multiple: true },
      "judge-model": { type: "string" },
      "cursor-kit-dir": { type: "string" },
      "timeout-ms": { type: "string" },
      "task-file": { type: "string" }
    },
    allowPositionals: true
  });
  const prompt =
    values["task-file"] !== undefined
      ? readFileSync(values["task-file"], "utf8")
      : positionals.join(" ").trim();
  return { values, prompt };
}

function ensembleModels(values: EnsembleFlags): EnsembleModel[] {
  const specs =
    values.model ??
    (values.harness === "command"
      ? ["command=local-shell"]
      : ["fast=fake-fast", "writer=fake-writer"]);
  return specs.map((spec) => {
    const separator = spec.indexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      fail(`--model must be ID=MODEL, got "${spec}"`);
    }
    return {
      id: spec.slice(0, separator),
      model: spec.slice(separator + 1)
    };
  });
}

function liveSmokeTargets(values: EnsembleDashboardFlags): HarnessLiveSmokeTarget[] {
  const targets = values["live-smoke"] ?? [];
  return targets.map((target) => {
    switch (target) {
      case "claude-code":
      case "codex":
        return target;
      default:
        fail('--live-smoke must be "claude-code" or "codex"');
    }
  });
}

function unifiedHarnessKinds(values: EnsembleE2EFlags): UnifiedHarnessKind[] {
  const targets = values.harness ?? ["mock", "command"];
  return targets.flatMap((target) => target.split(",")).map((target): UnifiedHarnessKind => {
    switch (target) {
      case "mock":
      case "command":
      case "agent":
      case "codex":
      case "claude-code":
      case "cursor-acp":
      case "cursor-desktop":
        return target;
      default:
        fail(`--harness must be mock, command, agent, codex, claude-code, cursor-acp, or cursor-desktop; got "${target}"`);
    }
  });
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeEnsembleOutput(outDir: string, result: EnsembleRunResult): void {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "candidates"), { recursive: true });
  mkdirSync(join(outDir, "model-call-records"), { recursive: true });
  writeJson(join(outDir, "summary.json"), result.summary ?? {});
  writeJson(join(outDir, "harness-run-request.json"), result.harnessRunRequest);
  writeJson(join(outDir, "harness-run-result.json"), result.harnessRunResult);
  for (const candidate of result.candidates) {
    assertHarnessCandidateRecordV1(candidate);
    writeJson(
      join(outDir, "candidates", `${safeId(candidate.candidate_id)}.json`),
      candidate
    );
  }
  for (const record of result.modelCallRecords) {
    assertModelCallRecordV1(record);
    writeJson(
      join(outDir, "model-call-records", `${safeId(record.call_id)}.json`),
      record
    );
  }
  if (result.judgeSynthesisRecord !== undefined) {
    assertJudgeSynthesisRecordV1(result.judgeSynthesisRecord);
    writeJson(join(outDir, "judge-synthesis-record.json"), result.judgeSynthesisRecord);
  }
}


type HandoffPayload = {
  category?: string;
  manifest_path?: string;
  task?: unknown;
};

type HandoffHarnessSelection =
  | { harness: HarnessAdapter; harnessKind: ModelFusionHarnessKind }
  | { skipReason: string; harnessKind: ModelFusionHarnessKind; harnessId: string };

function readStdinJson(): unknown {
  const input = readFileSync(0, "utf8").trim();
  if (!input) fail("handoff payload is required on stdin");
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    fail(`handoff payload must be valid JSON: ${(error as Error).message}`);
  }
}

function parseHandoffTask(payload: unknown): BenchmarkTaskRecordV1 {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    fail("handoff payload must be a JSON object");
  }
  const task = (payload as HandoffPayload).task;
  assertBenchmarkTaskRecordV1(task);
  return task;
}

function baseGitSha(repo: string): string {
  try {
    return gitText(repo, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "0".repeat(40);
  }
}

function metadata<S extends ModelFusionRecordV1["schema"]>(schema: S, createdAt: string) {
  return {
    schema,
    schema_version: "v1" as const,
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "handoffkit-cli",
    producer_version: "0.1.0",
    producer_git_sha: "0".repeat(40),
    created_at: createdAt
  };
}

function recordsForResult(
  task: BenchmarkTaskRecordV1,
  result: EnsembleRunResult
): ModelFusionRecordV1[] {
  const toolRecords = toolRecordsForResult(result);
  const records: ModelFusionRecordV1[] = [
    task,
    result.harnessRunRequest,
    result.harnessRunResult,
    ...result.candidates,
    ...result.modelCallRecords,
    ...toolRecords
  ];
  if (result.judgeSynthesisRecord !== undefined) records.push(result.judgeSynthesisRecord);
  for (const record of records) assertModelFusionRecord(record);
  return records;
}

function toolRecordsForResult(result: EnsembleRunResult): ToolExecutionRecordV1[] {
  return result.toolRecords.map((record): ToolExecutionRecordV1 => {
    const toolRecord: ToolExecutionRecordV1 = {
      ...metadata("tool-execution-record.v1", result.harnessRunResult.created_at),
      execution_id: record.execution_id,
      plan_id: record.plan_id,
      status: record.status,
      ...(record.output_hash !== undefined ? { output_hash: record.output_hash } : {}),
      ...(record.error !== undefined ? { error: record.error } : {})
    };
    assertToolExecutionRecordV1(toolRecord);
    return toolRecord;
  });
}

function skippedHandoffRecords(input: {
  task: BenchmarkTaskRecordV1;
  descriptorId: string;
  repo: string;
  harnessKind: ModelFusionHarnessKind;
  harnessId: string;
  reason: string;
}): ModelFusionRecordV1[] {
  const createdAt = new Date().toISOString();
  const request: HarnessRunRequestV1 = {
    ...metadata("harness-run-request.v1", createdAt),
    request_id: `ensemble_req_${input.descriptorId}`,
    harness_kind: input.harnessKind,
    source_repo: "handoffkit",
    base_git_sha: baseGitSha(input.repo),
    prompt: input.task.prompt ?? "",
    prompt_hash: input.task.prompt_hash,
    allowed_tools: input.task.allowed_tools,
    side_effects: "unknown",
    requested_capabilities: { coding_harness: "unsupported" },
    metadata: {
      harness_id: input.harnessId,
      skipped: true,
      skip_reason: input.reason
    }
  };
  const result: HarnessRunResultV1 = {
    ...metadata("harness-run-result.v1", createdAt),
    result_id: `ensemble_result_${input.descriptorId}`,
    request_id: request.request_id,
    harness_kind: input.harnessKind,
    status: "skipped",
    candidate_ids: [],
    output_summary: input.reason,
    capabilities: { coding_harness: "unsupported" },
    started_at: createdAt,
    finished_at: createdAt,
    errors: [{ kind: "capability_missing", message: input.reason, retryable: false }],
    metadata: {
      descriptor_id: input.descriptorId,
      harness_id: input.harnessId,
      skipped: true
    }
  };
  const records: ModelFusionRecordV1[] = [input.task, request, result];
  for (const record of records) assertModelFusionRecord(record);
  return records;
}

function selectHandoffHarness(
  values: EnsembleFlags,
  repo: string,
  timeoutMs: number
): HandoffHarnessSelection {
  const harnessId = values.harness ?? "mock";
  switch (harnessId) {
    case "mock":
      return { harness: createMockHarness(), harnessKind: "generic" };
    case "command":
      if (!values.command) fail("--command is required when --harness command");
      return {
        harness: createCommandHarness({ command: values.command, cwd: repo, timeoutMs }),
        harnessKind: "generic"
      };
    case "claude-code": {
      const reason = claudeCodeHarnessCredentialSkipReason();
      if (reason !== undefined) {
        return { skipReason: reason, harnessKind: "claude_code", harnessId };
      }
      return { harness: claudeCodeHarness({ timeoutMs }), harnessKind: "claude_code" };
    }
    case "codex": {
      const reason = codexHarnessCredentialSkipReason();
      if (reason !== undefined) {
        return { skipReason: reason, harnessKind: "codex", harnessId };
      }
      return { harness: codexHarness({ cwd: repo, timeoutMs }), harnessKind: "codex" };
    }
    default:
      fail('--harness must be "mock", "command", "claude-code", or "codex"');
  }
}

function handoffModels(values: EnsembleFlags): EnsembleModel[] {
  return ensembleModels(values);
}

function handoffSideEffects(values: EnsembleFlags, task: BenchmarkTaskRecordV1): ModelFusionSideEffects {
  if (values.harness === "command") return "tool_execution";
  const writeTools = new Set(["apply_patch", "write_file", "run_tests", "shell_command"]);
  return task.allowed_tools.some((tool) => writeTools.has(tool)) ? "writes_workspace" : "read_only";
}

async function cmdEnsembleHandoff(argv: string[]): Promise<void> {
  const values = parseEnsembleHandoffArgs(argv);
  const payload = readStdinJson();
  const task = parseHandoffTask(payload);
  const repo = resolve(values.repo ?? ".");
  const outDir = resolve(values.out ?? ".warrant/ensemble-handoff");
  const timeoutMs = Number(values["timeout-ms"] ?? "30000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be positive");
  const id = values.id ?? `handoff_${safeId(task.task_id)}`;
  const selection = selectHandoffHarness(values, repo, timeoutMs);
  if ("skipReason" in selection) {
    process.stdout.write(
      JSON.stringify({
        records: skippedHandoffRecords({
          task,
          descriptorId: id,
          repo,
          harnessKind: selection.harnessKind,
          harnessId: selection.harnessId,
          reason: selection.skipReason
        })
      }) + "\n"
    );
    return;
  }

  const descriptor: EnsembleDescriptor = {
    id,
    harness: selection.harness,
    models: handoffModels(values),
    runtime: { id: "handoff-local" },
    judge: {
      id: values.judge ?? "mock",
      synthesizer: createMockJudgeSynthesizer({
        output: {
          decision: "synthesize",
          finalOutput: "CI-safe handoff synthesis",
          rationale: "synthetic handoff smoke run",
          patch: { content: "", author: "judge" }
        }
      })
    },
    policy: {
      id: values.policy ?? "handoff-smoke",
      allowedTools: task.allowed_tools,
      sideEffects: handoffSideEffects(values, task),
      timeoutMs
    },
    prompt: task.prompt ?? "",
    sourceRepo: "handoffkit",
    baseGitSha: baseGitSha(repo),
    workspace: repo,
    outputRoot: outDir,
    cleanupWorktrees: true,
    metadata: {
      handoff_protocol: "fusionkit-command-v1",
      benchmark_task_id: task.task_id,
      ...(typeof (payload as HandoffPayload).manifest_path === "string"
        ? { benchmark_manifest_path: (payload as HandoffPayload).manifest_path }
        : {}),
      ...(typeof (payload as HandoffPayload).category === "string"
        ? { benchmark_category: (payload as HandoffPayload).category }
        : {})
    }
  };
  const result = await runEnsemble(descriptor);
  writeEnsembleOutput(outDir, result);
  process.stdout.write(JSON.stringify({ records: recordsForResult(task, result) }) + "\n");
}

function renderEnsembleSummary(outDir: string, result: EnsembleRunResult): string {
  const lines = [
    `ensemble ${result.descriptorId} [${result.harnessRunResult.status}]`,
    `candidates: ${result.candidates.length}`,
    ...result.candidates.map(
      (candidate) => `  ${candidate.candidate_id}: ${candidate.status}`
    ),
    `verification: ${result.verification.id}`,
    result.judgeSynthesisRecord
      ? `judge: ${result.judgeSynthesisRecord.status}/${result.judgeSynthesisRecord.decision}`
      : "judge: none",
    `output: ${outDir}`,
    `summary: ${join(outDir, "summary.json")}`
  ];
  return lines.join("\n");
}

function renderHarnessSmokeDashboardSummary(dashboard: HarnessSmokeDashboard): string {
  const counts = new Map<string, number>();
  for (const record of dashboard.records) {
    counts.set(record.result.status, (counts.get(record.result.status) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  return [
    `harness dashboard [${countText}]`,
    `records: ${dashboard.records.length}`,
    `dashboard: ${dashboard.dashboardPath}`,
    `output: ${dashboard.outputRoot}`
  ].join("\n");
}

async function cmdEnsembleE2E(argv: string[]): Promise<void> {
  const { values, prompt } = parseEnsembleE2EArgs(argv);
  if (!prompt.trim()) fail("a task prompt or --task-file is required");
  const fusionBackendUrl = values["fusion-backend"];
  if (!fusionBackendUrl) fail("--fusion-backend is required");
  const timeoutMs = Number(values["timeout-ms"] ?? "30000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be positive");
  const repo = resolve(values.repo ?? ".");
  const outDir = resolve(values.out ?? ".warrant/ensemble-e2e");
  const models = ensembleModels({ model: values.model });
  const result = await runUnifiedHarnessE2E({
    id: values.id ?? `unified_${Date.now()}`,
    fusionBackendUrl,
    repo,
    outputRoot: outDir,
    prompt,
    harnesses: unifiedHarnessKinds(values),
    models,
    ...(values.command !== undefined ? { command: values.command } : {}),
    timeoutMs,
    ...(values["judge-model"] !== undefined ? { judgeModel: values["judge-model"] } : {}),
    ...(values["cursor-kit-dir"] !== undefined
      ? { cursorKitDir: resolve(values["cursor-kit-dir"]) }
      : {})
  });
  const counts = new Map<string, number>();
  for (const row of result.results) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  console.log(`unified e2e [${countText}]`);
  console.log(`results: ${result.results.length}`);
  console.log(`report: ${result.reportPath}`);
  for (const row of result.results) {
    console.log(`  ${row.harness}: ${row.status} (${row.message})`);
  }
  if (result.results.some((row) => row.status === "failed")) {
    process.exitCode = 1;
  }
}

const GATEWAY_SUBCOMMANDS = ["serve", "acp", "acp-registry", "test", "codex-config"] as const;

function gatewayConfigFromFlags(values: {
  "fusion-backend"?: string;
  harness?: string[];
  command?: string;
  repo?: string;
  out?: string;
  model?: string[];
  "judge-model"?: string;
  "cursor-kit-dir"?: string;
  "timeout-ms"?: string;
  "fusion-api-key"?: string;
}): GatewayRunnerConfig {
  const fusionBackendUrl = values["fusion-backend"];
  if (!fusionBackendUrl) fail("--fusion-backend is required");
  const timeoutMs = Number(values["timeout-ms"] ?? "120000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be positive");
  return {
    fusionBackendUrl,
    repo: resolve(values.repo ?? "."),
    outputRoot: resolve(values.out ?? ".warrant/gateway"),
    harnesses: unifiedHarnessKinds({ harness: values.harness }),
    models: ensembleModels({ model: values.model }),
    timeoutMs,
    ...(values.command !== undefined ? { command: values.command } : {}),
    ...(values["judge-model"] !== undefined ? { judgeModel: values["judge-model"] } : {}),
    ...(values["cursor-kit-dir"] !== undefined
      ? { cursorKitDir: resolve(values["cursor-kit-dir"]) }
      : {}),
    ...(values["fusion-api-key"] !== undefined ? { fusionApiKey: values["fusion-api-key"] } : {})
  };
}

function parseGatewayArgs(argv: string[]): {
  values: {
    "fusion-backend"?: string;
    harness?: string[];
    command?: string;
    repo?: string;
    out?: string;
    model?: string[];
    "judge-model"?: string;
    "cursor-kit-dir"?: string;
    "timeout-ms"?: string;
    "fusion-api-key"?: string;
    host?: string;
    port?: string;
    "auth-token"?: string;
    sentinel?: string;
    "install-dir"?: string;
  };
  positionals: string[];
} {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "fusion-backend": { type: "string" },
      harness: { type: "string", multiple: true },
      command: { type: "string" },
      repo: { type: "string", default: "." },
      out: { type: "string" },
      model: { type: "string", multiple: true },
      "judge-model": { type: "string" },
      "cursor-kit-dir": { type: "string" },
      "timeout-ms": { type: "string" },
      "fusion-api-key": { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      "auth-token": { type: "string" },
      sentinel: { type: "string" },
      "install-dir": { type: "string" }
    },
    allowPositionals: true
  });
  return { values, positionals };
}

async function cmdEnsembleGateway(argv: string[]): Promise<void> {
  const first = argv[0];
  const isSub =
    first !== undefined &&
    !first.startsWith("-") &&
    (GATEWAY_SUBCOMMANDS as readonly string[]).includes(first);
  const sub = isSub ? (first as (typeof GATEWAY_SUBCOMMANDS)[number]) : "serve";
  const rest = isSub ? argv.slice(1) : argv;

  if (sub === "acp-registry") {
    const action = rest[0];
    if (action !== "install") fail("usage: warrant ensemble gateway acp-registry install <id...>");
    const { values, positionals } = parseGatewayArgs(rest.slice(1));
    const agentIds = positionals.length > 0 ? positionals : ["codex-cli", "claude-agent"];
    const installDir = resolve(values["install-dir"] ?? ".warrant/acp-registry");
    const installed = await installRegistryAdapters({ agentIds, installDir });
    console.log(`installed ${installed.length} ACP registry adapter(s):`);
    for (const line of installed) console.log(`  ${line}`);
    return;
  }

  const { values } = parseGatewayArgs(rest);

  if (sub === "codex-config") {
    const base = values["fusion-backend"] ?? `http://${values.host}:${values.port}`;
    console.log(codexConfigSnippet(base));
    return;
  }

  const config = gatewayConfigFromFlags(values);

  if (sub === "acp") {
    await runGatewayAcp(config);
    return;
  }

  if (sub === "test") {
    const sentinel = values.sentinel ?? "FUSION_OK";
    const outPath = resolve(values.out ?? ".warrant/front-door-e2e/front-door-report.json");
    // The report path and the per-run gateway output root must not collide.
    const acceptanceConfig: GatewayRunnerConfig = {
      ...config,
      outputRoot: join(resolve(outPath, ".."), "gateway-runs")
    };
    const { reportPath, failed } = await runGatewayAcceptance({
      config: acceptanceConfig,
      sentinel,
      host: values.host ?? "127.0.0.1",
      outPath
    });
    console.log(`front-door acceptance report: ${reportPath}`);
    if (failed) process.exitCode = 1;
    return;
  }

  const host = values.host ?? "127.0.0.1";
  const port = Number(values.port ?? "8787");
  if (!Number.isInteger(port) || port < 0) fail("--port must be a non-negative integer");
  const gateway = await startConfiguredGateway({
    config,
    host,
    port,
    ...(values["auth-token"] !== undefined ? { authToken: values["auth-token"] } : {})
  });
  console.log(`fusion harness gateway listening on ${gateway.url()}`);
  console.log("");
  console.log(gatewaySetupSnippets(gateway.url(), "http://127.0.0.1:<cursorkit-port>"));
}

function parseFusionTool(value: string | undefined): FusionTool {
  if (value === undefined || !(FUSION_TOOLS as readonly string[]).includes(value)) {
    fail(`--tool must be one of ${FUSION_TOOLS.join(" | ")}`);
  }
  return value as FusionTool;
}

const PANEL_PROVIDERS: readonly PanelProvider[] = ["mlx", "openai", "anthropic", "google", "openai-compatible"];

function parseIdValue(flag: string, spec: string): { id: string; value: string } {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) fail(`${flag} must be ID=VALUE, got "${spec}"`);
  return { id: spec.slice(0, separator), value: spec.slice(separator + 1) };
}

/** Parse `id=provider:model` (or `id=model`, defaulting to the local mlx provider). */
function parsePanelModelSpec(spec: string, keyEnvs: Record<string, string>): PanelModelSpec {
  const { id, value } = parseIdValue("--model", spec);
  const colon = value.indexOf(":");
  let provider: PanelProvider = "mlx";
  let model = value;
  if (colon > 0) {
    const maybe = value.slice(0, colon);
    if ((PANEL_PROVIDERS as readonly string[]).includes(maybe)) {
      provider = maybe as PanelProvider;
      model = value.slice(colon + 1);
    }
  }
  return { id, model, provider, ...(keyEnvs[id] !== undefined ? { keyEnv: keyEnvs[id] } : {}) };
}

async function cmdFusion(argv: string[]): Promise<void> {
  const options: RunFusionOptions = {};
  const modelSpecs: string[] = [];
  const endpointSpecs: string[] = [];
  const keyEnvs: Record<string, string> = {};
  const toolArgs: string[] = [];
  let tool: FusionTool | undefined;
  const next = (i: number): string => {
    const value = argv[i];
    if (value === undefined) fail(`${argv[i - 1]} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--tool") tool = parseFusionTool(next(++i));
    else if (token === "--model" || token === "--models") modelSpecs.push(next(++i));
    else if (token === "--model-endpoint") endpointSpecs.push(next(++i));
    else if (token === "--key-env") {
      const { id, value } = parseIdValue("--key-env", next(++i));
      keyEnvs[id] = value;
    }     else if (token === "--judge-model") options.judgeModel = next(++i);
    else if (token === "--judge-endpoint") options.judgeEndpoint = next(++i);
    else if (token === "--synthesis-url") options.synthesisUrl = next(++i);
    else if (token === "--harness") {
      const value = next(++i);
      if (value !== "agent" && value !== "command") fail('--harness must be "agent" or "command"');
      options.harness = value;
    } else if (token === "--fusionkit-dir") options.fusionkitDir = resolve(next(++i));
    else if (token === "--repo") options.repo = resolve(next(++i));
    else if (token === "--command") options.command = next(++i);
    else if (token === "--cursor-kit-dir") options.cursorKitDir = resolve(next(++i));
    else if (token === "--observe") options.observe = true;
    else if (token === "--auth-token") options.authToken = next(++i);
    else if (token === "--port") {
      const port = Number(next(++i));
      if (!Number.isInteger(port) || port < 0) fail("--port must be a non-negative integer");
      options.port = port;
    } else if (tool === undefined && (FUSION_TOOLS as readonly string[]).includes(token)) {
      tool = token as FusionTool;
    } else {
      toolArgs.push(token);
    }
  }
  if (options.fusionkitDir === undefined && process.env.WARRANT_FUSIONKIT_DIR !== undefined) {
    options.fusionkitDir = resolve(process.env.WARRANT_FUSIONKIT_DIR);
  }
  if (modelSpecs.length > 0) options.models = modelSpecs.map((spec) => parsePanelModelSpec(spec, keyEnvs));
  if (endpointSpecs.length > 0) {
    const endpoints: Record<string, string> = {};
    for (const spec of endpointSpecs) {
      const { id, value } = parseIdValue("--model-endpoint", spec);
      endpoints[id] = value;
    }
    options.endpoints = endpoints;
    // Pre-running endpoints define the panel; ignore any --model specs.
    options.models = Object.keys(endpoints).map((id) => ({ id, model: id, provider: "openai-compatible" }));
  }
  const resolvedTool = tool ?? (process.stdin.isTTY ? await pickTool() : "codex");
  const code = await runFusion(resolvedTool, toolArgs, options);
  process.exit(code);
}

async function cmdEnsembleRun(argv: string[]): Promise<void> {
  const { values, prompt } = parseEnsembleArgs(argv);
  if (!prompt.trim()) fail("a task prompt or --task-file is required");
  const harnessId = values.harness ?? "mock";
  if (harnessId !== "mock" && harnessId !== "command") {
    fail('--harness must be "mock" or "command"');
  }
  const repo = resolve(values.repo ?? ".");
  const outDir = resolve(values.out ?? ".warrant/ensemble-cli");
  const timeoutMs = Number(values["timeout-ms"] ?? "30000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be positive");
  if (harnessId === "command" && !values.command) {
    fail("--command is required when --harness command");
  }
  const id = values.id ?? `ensemble_${Date.now()}`;
  const harness =
    harnessId === "command"
      ? createCommandHarness({
          command: values.command ?? "",
          cwd: repo,
          timeoutMs
        })
      : createMockHarness();
  const judgeId = values.judge ?? "mock";
  const descriptor: EnsembleDescriptor = {
    id,
    harness,
    models: ensembleModels(values),
    runtime: { id: "local" },
    judge:
      judgeId === "none"
        ? { id: "none" }
        : {
            id: judgeId,
            synthesizer: createMockJudgeSynthesizer({
              output: {
                decision: "synthesize",
                finalOutput: "CI-safe ensemble smoke synthesis",
                rationale: "synthetic smoke run",
                patch: {
                  content: "",
                  author: "judge"
                }
              }
            })
          },
    policy: {
      id: values.policy ?? "local-smoke",
      allowedTools: harnessId === "command" ? ["shell_command"] : ["read_file"],
      sideEffects: harnessId === "command" ? "tool_execution" : "read_only",
      timeoutMs
    },
    prompt,
    sourceRepo: "handoffkit",
    baseGitSha: gitText(repo, ["rev-parse", "HEAD"]).trim(),
    workspace: repo,
    outputRoot: outDir,
    cleanupWorktrees: true
  };
  const result = await runEnsemble(descriptor);
  assertHarnessRunRequestV1(result.harnessRunRequest);
  assertHarnessRunResultV1(result.harnessRunResult);
  writeEnsembleOutput(outDir, result);
  console.log(renderEnsembleSummary(outDir, result));
  if (result.harnessRunResult.status !== "succeeded" || result.failureSummary) {
    process.exitCode = 1;
  }
}

async function cmdEnsembleDashboard(argv: string[]): Promise<void> {
  const values = parseEnsembleDashboardArgs(argv);
  const timeoutMs = Number(values["timeout-ms"] ?? "30000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be positive");
  const dashboard = await runHarnessSmokeDashboard({
    repo: resolve(values.repo ?? "."),
    ...(values.out !== undefined ? { outputRoot: resolve(values.out) } : {}),
    timeoutMs,
    liveSmoke: liveSmokeTargets(values)
  });
  console.log(renderHarnessSmokeDashboardSummary(dashboard));
  if (
    dashboard.records.some(
      (record) => record.purpose === "live" && record.result.status !== "succeeded"
    )
  ) {
    process.exitCode = 1;
  }
}

function isolationFlag(value: string | undefined): SessionIsolation | undefined {
  if (value === undefined) return undefined;
  if (!SESSION_ISOLATIONS.includes(value as SessionIsolation)) {
    fail(`--isolation must be one of ${SESSION_ISOLATIONS.join(" | ")}`);
  }
  return value as SessionIsolation;
}

async function cmdRun(dir: string, argv: string[]): Promise<void> {
  const { values, prompt } = parseRunArgs(argv);
  if (!values.agent) fail(`--agent is required (${AGENT_KINDS.join(" | ")})`);
  if (!prompt) fail("a task prompt is required");

  const home = loadHome(dir);
  const client = clientFor(dir);
  const repoDir = resolve(values.repo ?? ".");

  const captured = captureWorkspace(repoDir, {
    allowUntracked: values["allow-untracked"] ?? []
  });

  const isolation = isolationFlag(values.isolation);
  const request: RunRequestInput = {
    requestedBy: { kind: "human", id: home.config.requestedBy },
    agentKind: values.agent,
    prompt,
    pool: values.pool ?? "default",
    secretNames: values.secret ?? [],
    workspace: captured.manifest,
    network: {
      defaultDeny: home.policy.network.defaultDeny,
      allowHosts: values["allow-host"] ?? []
    },
    budget: {},
    disclosure: "minimal-context",
    ...(isolation ? { isolation } : {})
  };

  if (values["dry-run"]) {
    const report = await client.dryRun(request);
    console.log(renderDisclosure(report));
    return;
  }

  await client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await client.putBlob(captured.dirtyDiff);
  for (const file of captured.untracked) await client.putBlob(file.content);

  const created = await client.requestRun(request);
  console.log(`run ${created.runId} [${created.status}]`);

  if (values["no-watch"]) return;
  const status = await waitForTerminal(client, created.runId, (s) =>
    console.log(`  ${s}`)
  );
  if (status === "completed" || status === "failed") {
    const bundle = await client.getBundle(created.runId);
    console.log("");
    console.log(renderReceipt(bundle));
  }
}

async function cmdContinue(dir: string, argv: string[]): Promise<void> {
  const { values, prompt } = parseRunArgs(argv);
  if (!values.agent) fail(`--agent is required (${AGENT_KINDS.join(" | ")})`);
  if (!prompt) fail("a task prompt is required");

  const home = loadHome(dir);
  const repoDir = resolve(values.repo ?? ".");
  const target = targets.pool(values.pool ?? "default");
  const transcript = values.transcript
    ? readFileSync(values.transcript, "utf8")
    : undefined;

  const h = handoff({
    workspace: repoDir,
    plane: { url: home.config.planeUrl, adminToken: home.config.adminToken },
    actor: { kind: "human", id: home.config.requestedBy },
    agent: agentSpecFor(values.agent),
    secrets: values.secret ?? [],
    allowHosts: values["allow-host"] ?? [],
    allowUntracked: values["allow-untracked"] ?? []
  });

  const isolation = isolationFlag(values.isolation);
  const continueOptions = {
    task: prompt,
    ...(values.reason ? { reason: values.reason } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
    ...(isolation ? { session: isolation } : {})
  };

  if (values["dry-run"]) {
    const { report } = await h.dryRun(target, continueOptions);
    console.log(renderDisclosure(report));
    return;
  }

  const run = await h.continueIn(target, continueOptions);
  console.log(
    `continuation ${run.envelope.envelopeId} → ${target.id} as run ${run.runId}`
  );

  if (values["no-watch"]) return;
  const outcome = await run.wait({ timeoutMs: CONTINUE_WAIT_TIMEOUT_MS });
  if (outcome.status === "awaiting_approval") {
    console.log(
      `awaiting approval (${outcome.consentRequirements.join("; ")}) — run: warrant approve ${run.runId}`
    );
    return;
  }
  console.log("");
  console.log(renderTrace(h.trace()));
  if (outcome.status === "completed" || outcome.status === "failed") {
    console.log("");
    console.log(renderReceipt(await run.receipt()));
    console.log("");
    console.log(`pull results: warrant pull ${run.runId}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirFlagIndex = args.indexOf("--dir");
  let dir = resolve(process.env.WARRANT_HOME ?? ".warrant");
  if (dirFlagIndex !== -1) {
    const value = args[dirFlagIndex + 1];
    if (!value) fail("--dir requires a value");
    dir = resolve(value);
    args.splice(dirFlagIndex, 2);
  }

  const [command, sub, ...rest] = args;

  switch (command) {
    case "init": {
      const { values } = parseArgs({
        args: sub ? [sub, ...rest] : rest,
        options: {
          port: { type: "string" },
          host: { type: "string" },
          "plane-url": { type: "string" }
        }
      });
      const home = initHome(dir, {
        ...(values.port ? { port: Number(values.port) } : {}),
        ...(values.host ? { host: values.host } : {}),
        ...(values["plane-url"] ? { planeUrl: values["plane-url"] } : {})
      });
      console.log(`initialized warrant home at ${home.dir}`);
      console.log(`plane url: ${home.config.planeUrl}`);
      console.log(`policy: ${join(home.dir, "policy.json")}`);
      console.log(`enroll token (for runners): ${home.config.enrollToken}`);
      console.log(`admin token (for the control panel): ${home.config.adminToken}`);
      return;
    }
    case "plane": {
      if (sub !== "start") fail(`unknown plane subcommand: ${sub ?? ""}`);
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" }, host: { type: "string" } }
      });
      const home = loadHome(dir);
      const plane = new Plane({
        dataDir: join(dir, "data"),
        policy: home.policy,
        planePrivateKeyPem: home.planePrivateKeyPem,
        planePublicKeyPem: home.planePublicKeyPem,
        adminToken: home.config.adminToken,
        enrollToken: home.config.enrollToken,
        secretStore: secretStoreFor(home)
      });
      const port = values.port ? Number(values.port) : home.config.port;
      const host = values.host ?? home.config.host;
      const started = await startPlaneServer(plane, { port, host });
      console.log(`warrant plane listening on http://${started.host}:${started.port}`);
      console.log(`control panel: http://${started.host}:${started.port}/ui/`);
      return;
    }
    case "runner": {
      if (sub !== "start") fail(`unknown runner subcommand: ${sub ?? ""}`);
      const { values } = parseArgs({
        args: rest,
        options: {
          pool: { type: "string", default: "default" },
          plane: { type: "string" },
          "enroll-token": { type: "string" },
          "data-dir": { type: "string" }
        }
      });
      let planeUrl = values.plane;
      let enrollToken = values["enroll-token"];
      if (!planeUrl || !enrollToken) {
        const home = loadHome(dir);
        planeUrl = planeUrl ?? home.config.planeUrl;
        enrollToken = enrollToken ?? home.config.enrollToken;
      }
      const runner = new Runner({
        planeUrl,
        pool: values.pool ?? "default",
        dataDir: resolve(values["data-dir"] ?? ".warrant-runner"),
        enrollToken
      });
      const identity = await runner.ensureEnrolled();
      console.log(
        `runner ${identity.runnerId} polling pool "${identity.pool}" (outbound-only)`
      );
      await runner.start();
      return;
    }
    case "secrets": {
      const home = loadHome(dir);
      if (sub === "set") {
        const [name, value] = rest;
        if (!name || value === undefined) fail("usage: warrant secrets set NAME VALUE");
        secretStoreFor(home).set(name, value);
        console.log(`secret "${name}" stored (value encrypted at rest)`);
        return;
      }
      if (sub === "list") {
        const names = secretStoreFor(home).names();
        console.log(names.length > 0 ? names.join("\n") : "no secrets stored");
        return;
      }
      fail(`unknown secrets subcommand: ${sub ?? ""}`);
      return;
    }
    case "run": {
      await cmdRun(dir, sub ? [sub, ...rest] : rest);
      return;
    }
    case "continue": {
      await cmdContinue(dir, sub ? [sub, ...rest] : rest);
      return;
    }
    case "ensemble": {
      if (sub === "run") {
        await cmdEnsembleRun(rest);
        return;
      }
      if (sub === "handoff") {
        await cmdEnsembleHandoff(rest);
        return;
      }
      if (sub === "dashboard") {
        await cmdEnsembleDashboard(rest);
        return;
      }
      if (sub === "e2e") {
        await cmdEnsembleE2E(rest);
        return;
      }
      if (sub === "gateway") {
        await cmdEnsembleGateway(rest);
        return;
      }
      fail(`unknown ensemble subcommand: ${sub ?? ""}`);
      return;
    }
    case "runs": {
      const client = clientFor(dir);
      const { runs } = await client.listRuns();
      console.log(renderRunList(runs));
      return;
    }
    case "approve": {
      if (!sub) fail("usage: warrant approve RUN_ID");
      const home = loadHome(dir);
      const client = clientFor(dir);
      const result = await client.approve(sub, {
        kind: "human",
        id: home.config.requestedBy
      });
      console.log(`run ${result.runId} [${result.status}]`);
      return;
    }
    case "cancel": {
      if (!sub) fail("usage: warrant cancel RUN_ID");
      const home = loadHome(dir);
      const client = clientFor(dir);
      const result = await client.cancel(sub, {
        kind: "human",
        id: home.config.requestedBy
      });
      console.log(`run ${result.runId} [${result.status}]`);
      return;
    }
    case "watch": {
      if (!sub) fail("usage: warrant watch RUN_ID");
      const client = clientFor(dir);
      const status = await waitForTerminal(client, sub, (s) => console.log(s));
      console.log(`final: ${status}`);
      return;
    }
    case "receipt": {
      if (!sub) fail("usage: warrant receipt RUN_ID");
      const client = clientFor(dir);
      console.log(renderReceipt(await client.getBundle(sub)));
      return;
    }
    case "bundle": {
      if (!sub) fail("usage: warrant bundle RUN_ID [--out FILE]");
      const { values } = parseArgs({
        args: rest,
        options: { out: { type: "string" } }
      });
      const client = clientFor(dir);
      const bundle = await client.getBundle(sub);
      const out = values.out ?? `${sub}.bundle.json`;
      writeFileSync(out, JSON.stringify(bundle, null, 2));
      console.log(`bundle written to ${out}`);
      return;
    }
    case "verify": {
      if (!sub) fail("usage: warrant verify FILE");
      const bundle = JSON.parse(readFileSync(sub, "utf8")) as ReceiptBundle;
      const result = verifyReceiptBundle(bundle);
      if (result.ok) {
        console.log("VERIFIED: signatures, event chain, and linkage all check out");
        return;
      }
      console.error("VERIFICATION FAILED:");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
      return;
    }
    case "pull": {
      if (!sub) fail("usage: warrant pull RUN_ID [--repo DIR]");
      const { values } = parseArgs({
        args: rest,
        options: { repo: { type: "string", default: "." } }
      });
      const client = clientFor(dir);
      const bundle = await client.getBundle(sub);
      const diffHash = bundle.receipt.workspaceOut.diffHash;
      if (!diffHash) {
        console.log("run produced no workspace changes; nothing to pull");
        return;
      }
      const diff = await client.getBlob(diffHash);
      const result = pullRun(
        resolve(values.repo ?? "."),
        sub,
        bundle.contract.workspace.baseRef,
        diff
      );
      switch (result.mode) {
        case "applied":
          console.log("applied run output to the working tree (clean fast path)");
          break;
        case "branch":
          console.log(
            `local workspace diverged from the contract base; results are on branch ${result.branch}`
          );
          break;
        case "empty":
          console.log("run produced no workspace changes; nothing to pull");
          break;
        default: {
          const exhausted: never = result;
          throw new Error(`unreachable: ${String(exhausted)}`);
        }
      }
      return;
    }
    case "export": {
      const { values } = parseArgs({
        args: sub ? [sub, ...rest] : rest,
        options: { since: { type: "string" } }
      });
      const client = clientFor(dir);
      process.stdout.write(await client.exportJsonl(values.since));
      return;
    }
    case "ui": {
      const home = loadHome(dir);
      console.log(`control panel: ${home.config.planeUrl}/ui/`);
      console.log(`login token:   ${home.config.adminToken}`);
      return;
    }
    case "local": {
      if (sub === undefined || !(LOCAL_TOOLS as readonly string[]).includes(sub)) {
        fail(`usage: warrant local <${LOCAL_TOOLS.join(" | ")}> [args...]`);
      }
      // Split warrant's own flags from the args forwarded to the tool, stopping
      // at the first token so the tool's own flags pass through untouched.
      const toolArgs: string[] = [];
      const options: { publicUrl?: string; authToken?: string } = {};
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token === "--public-url") {
          options.publicUrl = rest[++i];
        } else if (token === "--auth-token") {
          options.authToken = rest[++i];
        } else {
          toolArgs.push(token as string);
        }
      }
      const code = await runLocal(sub as LocalTool, toolArgs, options);
      process.exit(code);
    }
    case "fusion": {
      await cmdFusion(sub ? [sub, ...rest] : rest);
      return;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof PolicyDeniedError) {
    console.error(`POLICY DENIED (fail closed):`);
    for (const reason of error.reasons) console.error(`  - ${reason}`);
    process.exit(2);
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
