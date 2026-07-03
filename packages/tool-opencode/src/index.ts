/**
 * opencode tool integration entry point. It exposes launcher configuration helpers for local-model and gateway-backed opencode sessions.
 */
import type { ToolIntegration } from "@fusionkit/tools";

import { launchOpencode } from "./launch.js";

// opencode joins the panel via the harness-core driver (`createOpencodeDriver`
// + ensemble's `createDriverHarness`). Its front-door ToolIntegration stays
// launcher-focused until the harness-kind vocabulary is unified (so the
// UnifiedHarnessKind switches stay exhaustive); the driver is the panel path.
export const opencodeTool: ToolIntegration = {
  id: "opencode",
  displayName: "opencode",
  pickerHint: "opencode CLI (local model only)",
  binary: "opencode",
  packageName: "@fusionkit/tool-opencode",
  installHint: "install opencode: https://opencode.ai/docs",
  modes: ["local"],
  harnessKinds: [],
  launch: launchOpencode
};

export { launchOpencode, opencodeConfig, opencodeModelArg } from "./launch.js";
export { createOpencodeDriver, opencodeDriverConfigSchema } from "./driver.js";
export type {
  OpencodeBackend,
  OpencodeBackendFactory,
  OpencodeDriverConfig,
  OpencodeDriverOptions,
  OpencodeTurnPart,
  OpencodeTurnResult
} from "./driver.js";
