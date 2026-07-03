/**
 * Claude Code tool integration entry point. It exposes launcher environment helpers and the Claude Code ensemble harness adapter.
 */
import { smokeModelForTool } from "@fusionkit/registry";
import type { ToolIntegration } from "@fusionkit/tools";

import {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  createClaudeCodeHarness
} from "./harness.js";
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
      `  ANTHROPIC_BASE_URL=${gatewayUrl.replace(/\/+$/, "")}`,
      "  ANTHROPIC_AUTH_TOKEN=local"
    ].join("\n"),
  acpAdapterId: "claude-agent",
  modes: ["fusion", "local"],
  harnessKinds: ["claude-code"],
  panelHarnessKind: "claude-code",
  launch: launchClaude,
  createHarness: (_kind, options) =>
    createClaudeCodeHarness({
      execution: "local",
      fusionBackendUrl: options.fusionBackendUrl,
      ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {})
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

export {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  createClaudeCodeHarness
} from "./harness.js";
export type { ClaudeCodeHarnessEnv, ClaudeCodeHarnessOptions } from "./harness.js";
export { claudeEnv, launchClaude } from "./launch.js";
export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
export type { ClaudeDriverConfig } from "./driver.js";
