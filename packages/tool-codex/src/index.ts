import type { ToolIntegration } from "@fusionkit/tools";

import { codexHarness, codexHarnessCredentialSkipReason, createCodexHarness } from "./harness.js";

import { launchCodex } from "./launch.js";

const LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CODEX_LIVE_SMOKE_OK. Do not modify files.";

export const codexTool: ToolIntegration = {
  id: "codex",
  displayName: "Codex",
  pickerHint: "OpenAI Codex CLI",
  binary: "codex",
  modes: ["fusion", "local"],
  harnessKinds: ["codex"],
  panelHarnessKind: "codex",
  launch: launchCodex,
  createHarness: (_kind, options) =>
    createCodexHarness({
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
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
    makeMatrixHarness: (env) => codexHarness({ env, provider: { kind: "ambient" } }),
    credentialSkipReason: (env) => codexHarnessCredentialSkipReason(env),
    smoke: {
      taskId: "codex-skipped",
      model: { id: "codex", model: "gpt-5.5-codex" },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "apply_patch"],
      makeHarness: () => codexHarness({ env: {}, provider: { kind: "ambient" } })
    },
    liveSmoke: {
      taskId: "codex-live",
      envName: "FUSIONKIT_CODEX_SMOKE",
      prompt: LIVE_SMOKE_PROMPT,
      modelEnvName: "FUSIONKIT_CODEX_SMOKE_MODEL",
      defaultModel: "gpt-5.5-codex",
      makeHarness: (env) => codexHarness({ env })
    }
  }
};

export {
  codexConfigToml,
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
