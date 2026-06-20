import type { ToolIntegration } from "@fusionkit/tools";

import { launchOpencode } from "./launch.js";

export const opencodeTool: ToolIntegration = {
  id: "opencode",
  displayName: "opencode",
  pickerHint: "opencode CLI (local model only)",
  binary: "opencode",
  modes: ["local"],
  harnessKinds: [],
  launch: launchOpencode
};

export { launchOpencode, opencodeConfig, opencodeModelArg } from "./launch.js";
