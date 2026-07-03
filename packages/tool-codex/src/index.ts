/**
 * Codex tool integration entry point. It exposes the Codex launcher and ensemble harness adapter used by the FusionKit CLI.
 */
import { smokeModelForTool } from "@fusionkit/registry";
import { FUSION_PANEL_MODEL } from "@fusionkit/tools";
import type { ToolIntegration } from "@fusionkit/tools";

import { codexHarness, codexHarnessCredentialSkipReason, createCodexHarness } from "./harness.js";

import { codexLaunchConfigToml, launchCodex } from "./launch.js";

const LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CODEX_LIVE_SMOKE_OK. Do not modify files.";

/** Codex smoke model, from the registry's model catalog. */
const SMOKE_MODEL = smokeModelForTool("codex") ?? FUSION_PANEL_MODEL;

export const codexTool: ToolIntegration = {
  id: "codex",
  displayName: "Codex",
  pickerHint: "OpenAI Codex CLI",
  binary: "codex",
  packageName: "@fusionkit/tool-codex",
  installHint: "install the Codex CLI: https://github.com/openai/codex",
  authSummary:
    "codex auth: ephemeral CODEX_HOME -> FusionKit local provider (Responses; requires_openai_auth=false)",
  setupSnippet: ({ gatewayUrl }) =>
    [
      "Codex (OpenAI Responses):",
      "# ~/.codex/config.toml (or a temporary CODEX_HOME)",
      codexLaunchConfigToml(gatewayUrl, FUSION_PANEL_MODEL).trimEnd()
    ].join("\n"),
  acpAdapterId: "codex-cli",
  modes: ["fusion", "local"],
  harnessKinds: ["codex"],
  panelHarnessKind: "codex",
  launch: launchCodex,
  createHarness: (_kind, options) =>
    createCodexHarness({
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {}),
      ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
      // Panel candidates run unattended in disposable worktrees, so default to
      // maximum autonomy. `guarded` falls back to the side-effects-derived
      // sandbox (workspace-write), which `sandboxModeFor` picks when unset.
      ...(options.panelTrust === "guarded" ? {} : { sandboxMode: "danger-full-access" as const }),
      provider: {
        kind: "openai-compatible",
        baseUrl: options.fusionBackendUrl,
        ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {})
      }
    }),
  harness: {
    harnessKind: "codex",
    sideEffects: "writes_workspace",
    responseShape: "Return a Codex-style result summary with patch and verification evidence."
  },
  dashboard: {
    id: "codex",
    harnessKind: "codex",
    displayName: "Codex",
    availability: "credential_gated",
    capabilities: {
      model_override: "supported",
      transcript_capture: "supported",
      diff_capture: "supported",
      tool_loop_capture: "degraded",
      patch_apply_visibility: "supported",
      route_model_observation: "supported",
      verification_hint: "supported",
      replay_support: "degraded"
    },
    notes: ["Credential-gated; dashboard smoke uses an empty env skip path."],
    makeMatrixHarness: ({ env, repo, timeoutMs }) =>
      codexHarness({
        env,
        provider: { kind: "ambient" },
        ...(repo !== undefined ? { cwd: repo } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      }),
    credentialSkipReason: (env) => codexHarnessCredentialSkipReason(env),
    smoke: {
      taskId: "codex-skipped",
      model: { id: "codex", model: SMOKE_MODEL },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "apply_patch"],
      makeHarness: () => codexHarness({ env: {}, provider: { kind: "ambient" } })
    },
    liveSmoke: {
      taskId: "codex-live",
      envName: "FUSIONKIT_CODEX_SMOKE",
      prompt: LIVE_SMOKE_PROMPT,
      modelEnvName: "FUSIONKIT_CODEX_SMOKE_MODEL",
      defaultModel: SMOKE_MODEL,
      makeHarness: (env) => codexHarness({ env })
    }
  }
};

export {
  codexConfigToml,
  codexEndReason,
  codexHarness,
  codexHarnessCredentialSkipReason,
  createCodexHarness,
  defaultCodexRunner
} from "./harness.js";
export type {
  CodexAmbientProvider,
  CodexApprovalPolicy,
  CodexConfigTomlInput,
  CodexExecInput,
  CodexExecResult,
  CodexExecRunner,
  CodexHarnessEnv,
  CodexHarnessOptions,
  CodexOpenAiCompatibleProvider,
  CodexProvider,
  CodexResponsesProvider,
  CodexSandboxMode
} from "./harness.js";
export {
  codexLaunchConfigToml,
  codexModelCatalogJson,
  launchCodex,
  readCodexCatalogTemplate
} from "./launch.js";
export { codexDriverConfigSchema, createCodexDriver } from "./driver.js";
export type { CodexDriverConfig } from "./driver.js";
