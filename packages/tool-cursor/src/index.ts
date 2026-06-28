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
    makeMatrixHarness: (env) => createCursorHarness({ env }),
    credentialSkipReason: (env) => cursorHarnessUnavailableReason(env),
    smoke: {
      taskId: "cursor-skipped",
      model: { id: "cursor", model: "fusion-panel" },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "write_file", "apply_patch", "run_shell"],
      makeHarness: () => createCursorHarness({ env: {} })
    },
    liveSmoke: {
      taskId: "cursor-live",
      envName: "FUSIONKIT_CURSOR_SMOKE",
      prompt: LIVE_SMOKE_PROMPT,
      modelEnvName: "FUSIONKIT_CURSOR_SMOKE_MODEL",
      defaultModel: "fusion-panel",
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
export { startCursorBridge } from "./bridge.js";
export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";
