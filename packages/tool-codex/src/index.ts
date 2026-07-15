/**
 * Codex tool integration entry point. It exposes the Codex launcher and ensemble harness adapter used by the FusionKit CLI.
 */
import { smokeModelForTool } from "@fusionkit/registry";
import {
  FUSION_PANEL_MODEL,
  harnessDriversEnabled,
  trimTrailingSlashes
} from "@fusionkit/tools";
import type { ToolIntegration } from "@fusionkit/tools";
import { createDriverHarness } from "@fusionkit/ensemble";
import type { HarnessAdapter, ToolHarnessResolveOptions } from "@fusionkit/ensemble";

import { codexHarness, codexHarnessCredentialSkipReason, createCodexHarness } from "./harness.js";
import { codexDriverConfigSchema, createCodexDriver } from "./driver.js";

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
  modes: ["fusion", "local"],
  harnessKinds: ["codex"],
  panelHarnessKind: "codex",
  launch: launchCodex,
  createHarness: (_kind, options) =>
    harnessDriversEnabled() ? codexDriverHarness(options) : createCodexHarness({
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
      ...(options.trace !== undefined ? { trace: options.trace } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {}),
      ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
      ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
      ...(options.fusedSubagents !== undefined ? { fusedSubagents: options.fusedSubagents } : {}),
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

/**
 * The panel harness backed by the codex-sdk driver (native `codex app-server`
 * threads, typed events, resume cursors), used when the harness-driver cutover
 * flag is set. Each panel model routes to its own endpoint via the driver
 * bridge; codex requests the endpoint id as its model there.
 */
function codexDriverHarness(options: ToolHarnessResolveOptions): HarnessAdapter {
  return createDriverHarness({
    driver: createCodexDriver(),
    fusionBackendUrl: options.fusionBackendUrl,
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.resumeCursors !== undefined ? { resumeCursors: options.resumeCursors } : {}),
    configForModel: (route) =>
      codexDriverConfigSchema.parse({
        model: route.model,
        // Panel candidates run unattended in disposable worktrees: default to
        // maximum autonomy unless the caller asked for guarded trust.
        sandboxMode: options.panelTrust === "guarded" ? "workspace-write" : "danger-full-access",
        approvalPolicy: "never",
        provider: {
          // codex-sdk appends `/responses`; the per-member dialect gateway's
          // Responses route lives under `/v1`.
          baseUrl: `${trimTrailingSlashes(route.endpointUrl)}/v1`,
          ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {})
        }
      })
  });
}

export {
  codexConfigToml,
  codexEndReason,
  codexHarness,
  codexHarnessCredentialSkipReason,
  codexMemberCatalogJson,
  createCodexHarness,
  defaultCodexRunner,
  memberChatBackend
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
  codexAgentRoles,
  codexAgentRoleToml,
  codexAuthPath,
  codexCatalogEntries,
  codexLaunchConfigToml,
  codexListedStockSlugs,
  codexModelCatalogJson,
  codexProfileFiles,
  codexProfileFileToml,
  codexRoleDescription,
  hasCodexLogin,
  isCodexConfigFailure,
  launchCodex,
  readCodexCatalogTemplate,
  readCodexModelsCache
} from "./launch.js";
export type { CodexAgentRole, CodexModelPreset } from "./launch.js";
export {
  CODEX_INSTALL_BEGIN,
  CODEX_INSTALL_END,
  CODEX_INSTALL_PROVIDER,
  codexIntegrationBlock,
  installCodexIntegration,
  uninstallCodexIntegration
} from "./install.js";
export type { CodexInstallInput, CodexInstallProfile, CodexInstallResult } from "./install.js";
export { codexDriverConfigSchema, createCodexDriver } from "./driver.js";
export type { CodexDriverConfig } from "./driver.js";
