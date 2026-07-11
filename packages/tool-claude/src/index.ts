/**
 * Claude Code tool integration entry point. It exposes launcher environment helpers and the Claude Code ensemble harness adapter.
 */
import { smokeModelForTool } from "@fusionkit/registry";
import { harnessDriversEnabled, trimTrailingSlashes } from "@fusionkit/tools";
import type { ToolIntegration } from "@fusionkit/tools";
import { createDriverHarness } from "@fusionkit/ensemble";
import type { HarnessAdapter, ToolHarnessResolveOptions } from "@fusionkit/ensemble";

import {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  createClaudeCodeHarness
} from "./harness.js";
import { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
import { launchClaude } from "./launch.js";

const LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CLAUDE_LIVE_SMOKE_OK. Do not modify files.";

/** Claude smoke model, from the registry's model catalog. */
const SMOKE_MODEL = smokeModelForTool("claude") ?? "claude-sonnet-4-6";

export const claudeTool: ToolIntegration = {
  id: "claude",
  aliases: ["claude-code"],
  displayName: "Claude Code",
  pickerHint: "Claude Code",
  binary: "claude",
  packageName: "@fusionkit/tool-claude",
  installHint: "install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview",
  authSummary: "claude auth: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN -> FusionKit gateway",
  setupSnippet: ({ gatewayUrl }) =>
    [
      "Claude Code (Anthropic Messages); Claude appends /v1/messages, so use the gateway root:",
      `  ANTHROPIC_BASE_URL=${trimTrailingSlashes(gatewayUrl)}`,
      "  ANTHROPIC_AUTH_TOKEN=local"
    ].join("\n"),
  acpAdapterId: "claude-agent",
  modes: ["fusion", "local"],
  harnessKinds: ["claude-code"],
  panelHarnessKind: "claude-code",
  launch: launchClaude,
  createHarness: (_kind, options) =>
    harnessDriversEnabled() ? claudeDriverHarness(options) : createClaudeCodeHarness({
      fusionBackendUrl: options.fusionBackendUrl,
      ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
      ...(options.trace !== undefined ? { trace: options.trace } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {}),
      ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
      ...(options.fusedSubagents !== undefined ? { fusedSubagents: options.fusedSubagents } : {})
    }),
  harness: {
    harnessKind: "claude_code",
    sideEffects: "writes_workspace",
    responseShape: "Return a Claude Code-style transcript summary with patch/worktree evidence."
  },
  dashboard: {
    id: "claude-code",
    harnessKind: "claude_code",
    displayName: "Claude Code",
    availability: "credential_gated",
    capabilities: {
      model_override: "supported",
      transcript_capture: "supported",
      diff_capture: "supported",
      tool_loop_capture: "supported",
      patch_apply_visibility: "supported",
      route_model_observation: "degraded",
      verification_hint: "supported",
      replay_support: "degraded"
    },
    notes: ["Credential-gated; dashboard smoke uses an empty env skip path."],
    makeMatrixHarness: ({ env, timeoutMs }) =>
      claudeCodeHarness({
        env,
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      }),
    credentialSkipReason: (env) => claudeCodeHarnessCredentialSkipReason(env),
    smoke: {
      taskId: "claude-code-skipped",
      model: { id: "claude", model: SMOKE_MODEL },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "write_file", "apply_patch"],
      makeHarness: () => claudeCodeHarness({ env: {} })
    },
    liveSmoke: {
      taskId: "claude-code-live",
      envName: "FUSIONKIT_CLAUDE_SMOKE",
      prompt: LIVE_SMOKE_PROMPT,
      modelEnvName: "FUSIONKIT_CLAUDE_SMOKE_MODEL",
      defaultModel: SMOKE_MODEL,
      makeHarness: (env) => claudeCodeHarness({ env, skipWhenUnavailable: false })
    }
  }
};

/**
 * The panel harness backed by the Agent SDK driver (native `claude` sessions
 * via `query()`, `canUseTool` approvals, session resume), used when the
 * harness-driver cutover flag is set. The driver points `ANTHROPIC_BASE_URL`
 * at the gateway's Anthropic-Messages surface.
 *
 * Note: per-model endpoints are intentionally not forwarded here — those are
 * OpenAI-compatible router endpoints, whereas the claude CLI speaks the
 * Anthropic dialect, so every candidate routes through the shared gateway
 * Anthropic surface with its real claude model id. Driving a non-Anthropic
 * panel member through the claude CLI (the legacy translation-gateway trick)
 * stays on the legacy harness until the gateway exposes a per-endpoint
 * Anthropic surface.
 */
function claudeDriverHarness(options: ToolHarnessResolveOptions): HarnessAdapter {
  return createDriverHarness({
    driver: createClaudeDriver(),
    fusionBackendUrl: options.fusionBackendUrl,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.resumeCursors !== undefined ? { resumeCursors: options.resumeCursors } : {}),
    configForModel: (route) =>
      claudeDriverConfigSchema.parse({ model: route.model, baseUrl: route.endpointUrl })
  });
}

export {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  createClaudeCodeHarness
} from "./harness.js";
export type { ClaudeCodeHarnessEnv, ClaudeCodeHarnessOptions } from "./harness.js";
export { claudeAgentsJson, claudeEnv, claudeLaunchArgs, launchClaude } from "./launch.js";
export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
export type { ClaudeDriverConfig } from "./driver.js";
