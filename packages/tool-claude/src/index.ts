import type { ToolIntegration } from "@fusionkit/tools";

import {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason,
  createClaudeCodeHarness
} from "./harness.js";
import { launchClaude } from "./launch.js";

const LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CLAUDE_LIVE_SMOKE_OK. Do not modify files.";

export const claudeTool: ToolIntegration = {
  id: "claude",
  aliases: ["claude-code"],
  displayName: "Claude Code",
  pickerHint: "Claude Code",
  binary: "claude",
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
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {})
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
    makeMatrixHarness: (env) => claudeCodeHarness({ env }),
    credentialSkipReason: (env) => claudeCodeHarnessCredentialSkipReason(env),
    smoke: {
      taskId: "claude-code-skipped",
      model: { id: "claude", model: "claude-sonnet-4-6" },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "write_file", "apply_patch"],
      makeHarness: () => claudeCodeHarness({ env: {} })
    },
    liveSmoke: {
      taskId: "claude-code-live",
      envName: "FUSIONKIT_CLAUDE_SMOKE",
      prompt: LIVE_SMOKE_PROMPT,
      modelEnvName: "FUSIONKIT_CLAUDE_SMOKE_MODEL",
      defaultModel: "claude-sonnet-4-6",
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
