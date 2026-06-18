/**
 * Fusion Harness Gateway CLI wiring. Builds the front-door runner that turns a
 * single tool prompt into a unified HandoffKit/FusionKit harness ensemble run,
 * and exposes it over the provider wire protocols (Codex Responses, Claude
 * Messages, Cursorkit chat), the generic ACP local agent, and the unified
 * front-door acceptance suite.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runFusionPanels, runUnifiedHarnessE2E } from "@warrant/ensemble";
import type {
  EnsembleModel,
  UnifiedHarnessE2EResult,
  UnifiedHarnessKind
} from "@warrant/ensemble";
import { emitTrace, newSpanId, newTraceId } from "@warrant/protocol";
import {
  FusionBackend,
  installAcpAdapters,
  runAcpAgent,
  runFrontDoorAcceptance,
  startFusionGateway,
  startGateway
} from "@warrant/model-gateway";
import type {
  AcpRunner,
  FrontDoorRunner,
  FrontDoorRunnerResult,
  FusionGateway,
  Gateway,
  PanelRunner,
  WireTrajectory
} from "@warrant/model-gateway";

export type GatewayRunnerConfig = {
  fusionBackendUrl: string;
  repo: string;
  outputRoot: string;
  harnesses: UnifiedHarnessKind[];
  models: EnsembleModel[];
  command?: string;
  timeoutMs?: number;
  judgeModel?: string;
  cursorKitDir?: string;
  fusionApiKey?: string;
  modelEndpoints?: Record<string, string>;
};

function mapStatus(status: string): FrontDoorRunnerResult["status"] {
  if (status === "succeeded") return "succeeded";
  if (status === "skipped") return "skipped";
  return "failed";
}

function summarize(report: UnifiedHarnessE2EResult, primary: UnifiedHarnessKind): FrontDoorRunnerResult {
  const row = report.results.find((entry) => entry.harness === primary) ?? report.results[0];
  const ensemble = row?.ensemble;
  const finalOutput =
    ensemble?.judgeSynthesisRecord?.final_output ??
    ensemble?.harnessRunResult.output_summary ??
    row?.message ??
    "";
  const evidence: string[] = [];
  if (ensemble !== undefined) {
    if (ensemble.artifacts.some((artifact) => artifact.kind === "patch")) {
      evidence.push("patch_artifact");
    }
    if (ensemble.toolRecords.length > 0) evidence.push("tool_execution");
    if (ensemble.judgeSynthesisRecord !== undefined) evidence.push("judge_synthesis");
  }
  return {
    finalOutput,
    runId: report.id,
    status: mapStatus(row?.status ?? "failed"),
    evidence,
    ...(report.reportPath !== undefined ? { reportPath: report.reportPath } : {})
  };
}

export function buildFrontDoorRunner(config: GatewayRunnerConfig): FrontDoorRunner {
  return async (input) => {
    const traceId = input.traceId;
    const sessionSpan = newSpanId();
    emitTrace({
      component: "gateway",
      event_type: "session.started",
      traceId,
      spanId: sessionSpan,
      payload: {
        request_id: input.requestId,
        dialect: input.dialect,
        prompt_preview: input.prompt.slice(0, 600),
        environment: {
          repo: config.repo,
          fusion_backend_url: config.fusionBackendUrl,
          harnesses: config.harnesses,
          judge_model: config.judgeModel ?? null,
          models: config.models.map((model) => ({
            id: model.id,
            model: model.model,
            ...(model.endpointId !== undefined ? { endpoint_id: model.endpointId } : {})
          })),
          ...(config.modelEndpoints !== undefined ? { model_endpoints: config.modelEndpoints } : {})
        }
      }
    });
    try {
      const report = await runUnifiedHarnessE2E({
        id: `gateway_${input.requestId}`,
        fusionBackendUrl: config.fusionBackendUrl,
        repo: config.repo,
        outputRoot: join(config.outputRoot, input.requestId),
        prompt: input.prompt,
        harnesses: config.harnesses,
        models: config.models,
        traceId,
        ...(config.command !== undefined ? { command: config.command } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.judgeModel !== undefined ? { judgeModel: config.judgeModel } : {}),
        ...(config.cursorKitDir !== undefined ? { cursorKitDir: config.cursorKitDir } : {}),
        ...(config.fusionApiKey !== undefined ? { fusionApiKey: config.fusionApiKey } : {}),
        ...(config.modelEndpoints !== undefined ? { modelEndpoints: config.modelEndpoints } : {})
      });
      const summary = summarize(report, config.harnesses[0] ?? "command");
      emitTrace({
        component: "gateway",
        event_type: "session.finished",
        traceId,
        spanId: sessionSpan,
        payload: {
          status: summary.status,
          run_id: summary.runId,
          evidence: summary.evidence,
          final_output_preview: summary.finalOutput.slice(0, 600),
          ...(summary.reportPath !== undefined ? { report_path: summary.reportPath } : {})
        }
      });
      return summary;
    } catch (error) {
      emitTrace({
        component: "gateway",
        event_type: "session.finished",
        traceId,
        spanId: sessionSpan,
        payload: { status: "failed", error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  };
}

export function buildAcpRunner(config: GatewayRunnerConfig): AcpRunner {
  const front = buildFrontDoorRunner(config);
  return async (input) => {
    const result = await front({
      dialect: "openai-chat",
      prompt: input.prompt,
      requestedModel: undefined,
      requestId: input.requestId,
      traceId: newTraceId()
    });
    return {
      finalOutput: result.finalOutput,
      runId: result.runId,
      status: result.status,
      evidence: result.evidence
    };
  };
}

export function codexConfigSnippet(gatewayUrl: string): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  return [
    "# ~/.codex/config.toml (or a temporary CODEX_HOME)",
    `model = "fusion-panel"`,
    `model_provider = "fusion-gateway"`,
    "",
    "[model_providers.fusion-gateway]",
    `name = "Fusion Harness Gateway"`,
    `base_url = "${base}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`
  ].join("\n");
}

export function gatewaySetupSnippets(gatewayUrl: string, cursorKitNote: string): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  return [
    "Front-door setup:",
    "",
    "Codex (OpenAI Responses):",
    codexConfigSnippet(gatewayUrl),
    "",
    "Claude Code (Anthropic Messages); Claude appends /v1/messages, so use the gateway root:",
    `  ANTHROPIC_BASE_URL=${base}`,
    `  ANTHROPIC_AUTH_TOKEN=local`,
    "",
    "Cursor (via Cursorkit backend):",
    `  cursor-agent --endpoint ${cursorKitNote} --model fusion-panel`,
    `  Cursorkit model backend: ${base}/v1/chat/completions`,
    "",
    "Generic ACP local agent:",
    "  warrant ensemble gateway acp --fusion-backend <fusion-backend>",
    "",
    "ACP registry adapters:",
    "  warrant ensemble gateway acp-registry install codex-cli claude-agent"
  ].join("\n");
}

/**
 * The judge-streamed-trajectory front door: the panel runs once per session to
 * produce candidate trajectories, then the judge acts as a streaming tool-calling
 * agent (FusionKit `trajectory:step`) whose trajectory the user's harness executes.
 * Built on the dialect-aware `startGateway` + a {@link FusionBackend}; iteration is
 * the harness's job (no verify/repair here).
 */
export async function startFusionStepGateway(input: {
  config: GatewayRunnerConfig;
  host: string;
  port: number;
  authToken?: string;
  defaultModel?: string;
}): Promise<Gateway> {
  const { config } = input;
  const base = config.fusionBackendUrl.replace(/\/+$/, "");
  const stepUrl = `${base}/v1/fusion/trajectory:step`;
  const defaultModel = input.defaultModel ?? "fusion-panel";

  const runPanels: PanelRunner = async ({ task, traceId, sessionKey }) => {
    emitTrace({
      component: "gateway",
      event_type: "session.started",
      traceId,
      spanId: newSpanId(),
      payload: {
        dialect: "fusion-step",
        prompt_preview: task.slice(0, 600),
        environment: {
          repo: config.repo,
          fusion_backend_url: config.fusionBackendUrl,
          harnesses: ["agent"],
          judge_model: config.judgeModel ?? null,
          models: config.models.map((model) => ({
            id: model.id,
            model: model.model,
            ...(model.endpointId !== undefined ? { endpoint_id: model.endpointId } : {})
          })),
          ...(config.modelEndpoints !== undefined ? { model_endpoints: config.modelEndpoints } : {})
        }
      }
    });
    console.error(`fusion: running panel (${config.models.map((m) => m.id).join(", ")}) for session ${sessionKey}...`);
    try {
      const wire = await runFusionPanels({
        id: `panels_${sessionKey}`,
        repo: config.repo,
        outputRoot: join(config.outputRoot, sessionKey),
        prompt: task,
        models: config.models,
        fusionBackendUrl: config.fusionBackendUrl,
        traceId,
        ...(config.modelEndpoints !== undefined ? { modelEndpoints: config.modelEndpoints } : {}),
        ...(config.fusionApiKey !== undefined ? { fusionApiKey: config.fusionApiKey } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {})
      });
      console.error(
        `fusion: panel produced ${wire.length} candidate trajectories ` +
          `(${wire.map((t) => `${t.model_id}:${t.status}`).join(", ")})`
      );
      return wire as WireTrajectory[];
    } catch (error) {
      console.error(`fusion: panel run failed: ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }
  };

  const backend = new FusionBackend({
    stepUrl,
    runPanels,
    defaultModel
  });
  return await startGateway({
    backend,
    host: input.host,
    port: input.port,
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {})
  });
}

export async function startConfiguredGateway(input: {
  config: GatewayRunnerConfig;
  host: string;
  port: number;
  authToken?: string;
  defaultModel?: string;
}): Promise<FusionGateway> {
  return await startFusionGateway({
    runner: buildFrontDoorRunner(input.config),
    host: input.host,
    port: input.port,
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {})
  });
}

export async function runGatewayAcp(config: GatewayRunnerConfig): Promise<void> {
  await runAcpAgent({ runner: buildAcpRunner(config) });
}

export type GatewayAcceptanceInput = {
  config: GatewayRunnerConfig;
  sentinel: string;
  host: string;
  outPath: string;
  cursorKitUrl?: string;
};

export async function runGatewayAcceptance(input: GatewayAcceptanceInput): Promise<{
  reportPath: string;
  failed: boolean;
}> {
  const gateway = await startConfiguredGateway({
    config: input.config,
    host: input.host,
    port: 0
  });
  try {
    const report = await runFrontDoorAcceptance({
      gatewayUrl: gateway.url(),
      sentinel: input.sentinel,
      acpRunner: buildAcpRunner(input.config)
    });
    mkdirSync(resolve(input.outPath, ".."), { recursive: true });
    writeFileSync(input.outPath, JSON.stringify(report, null, 2) + "\n");
    const failed = report.front_doors.some((door) => door.status === "failed");
    return { reportPath: input.outPath, failed };
  } finally {
    await gateway.close();
  }
}

export async function installRegistryAdapters(input: {
  agentIds: string[];
  installDir: string;
}): Promise<string[]> {
  const installed = await installAcpAdapters({
    agentIds: input.agentIds,
    installDir: input.installDir
  });
  return installed.map((adapter) => `${adapter.id}@${adapter.version} -> ${adapter.metadataPath}`);
}
