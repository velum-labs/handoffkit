/**
 * Cursor tool integration entry point. It exposes Cursor launcher helpers, the Cursorkit bridge, and the Cursor ensemble harness adapter.
 */
import { FUSION_PANEL_MODEL } from "@fusionkit/tools";
import type { ToolIntegration } from "@fusionkit/tools";

import { createCursorHarness, cursorHarnessUnavailableReason } from "./harness.js";
import { launchCursor } from "./launch.js";

const LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CURSOR_LIVE_SMOKE_OK. Do not modify files.";

export const cursorTool: ToolIntegration = {
  id: "cursor",
  displayName: "Cursor",
  pickerHint: "needs a logged-in cursor-agent CLI",
  binary: "cursor-agent",
  packageName: "@fusionkit/tool-cursor",
  installHint: "install the Cursor CLI: https://cursor.com/cli",
  authSummary: "cursor auth: logged-in cursor-agent CLI -> bundled Cursorkit backend",
  setupSnippet: ({ gatewayUrl, note }) =>
    [
      "Cursor (via Cursorkit backend):",
      `  cursor-agent --endpoint ${note ?? gatewayUrl} --model ${FUSION_PANEL_MODEL}`,
      `  Cursorkit model backend: ${gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`
    ].join("\n"),
  modes: ["fusion", "local"],
  harnessKinds: ["cursor-acp", "cursor-desktop"],
  panelHarnessKind: "cursor-acp",
  launch: launchCursor,
  createHarness: (kind, options) =>
    createCursorHarness({
      id: kind,
      fusionBackendUrl: options.fusionBackendUrl,
      ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {})
    }),
  harness: {
    harnessKind: "cursor",
    sideEffects: "writes_workspace",
    responseShape: "Return text suitable for Cursor ACP session/update plus route evidence notes."
  },
  dashboard: {
    id: "cursor",
    harnessKind: "cursor",
    displayName: "Cursor",
    availability: "credential_gated",
    capabilities: {
      model_override: "supported",
      transcript_capture: "supported",
      diff_capture: "supported",
      tool_loop_capture: "supported",
      patch_apply_visibility: "supported",
      route_model_observation: "supported",
      verification_hint: "supported",
      replay_support: "degraded"
    },
    notes: ["Credential-gated; requires a logged-in Cursor CLI (Cursorkit is bundled)."],
    makeMatrixHarness: ({ env, timeoutMs }) =>
      createCursorHarness({
        env,
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      }),
    credentialSkipReason: (env) => cursorHarnessUnavailableReason(env),
    smoke: {
      taskId: "cursor-skipped",
      model: { id: "cursor", model: FUSION_PANEL_MODEL },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "write_file", "apply_patch", "run_shell"],
      makeHarness: () => createCursorHarness({ env: {} })
    },
    liveSmoke: {
      taskId: "cursor-live",
      envName: "FUSIONKIT_CURSOR_SMOKE",
      prompt: LIVE_SMOKE_PROMPT,
      modelEnvName: "FUSIONKIT_CURSOR_SMOKE_MODEL",
      defaultModel: FUSION_PANEL_MODEL,
      makeHarness: (env) => createCursorHarness({ env, skipWhenUnavailable: false })
    }
  }
};

export {
  createCursorHarness,
  cursorHarness,
  cursorHarnessUnavailableReason,
  defaultCursorRunner
} from "./harness.js";
export type {
  CursorExecInput,
  CursorExecResult,
  CursorExecRunner,
  CursorHarnessOptions,
  CursorRunMode
} from "./harness.js";
export { buildCursorAcpProducer } from "./acp.js";
export { startCursorBridge } from "./bridge.js";
export {
  CURSOR_AGENT_TOOL_MAX_ITERATIONS,
  CURSOR_AGENT_TOOL_POLICY,
  cursorBridgeEnv,
  cursorBridgeModelEnv,
  cursorIdeEnv,
  cursorIdeModelsJson
} from "./bridge-config.js";
export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";
export { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";
export type { CursorDriverConfig } from "./driver.js";
