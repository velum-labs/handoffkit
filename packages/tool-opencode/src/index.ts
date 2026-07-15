import type { ToolIntegration } from "@routekit/tools";

import { createOpencodeDriver, opencodeDriverConfigSchema } from "./driver.js";
import { launchOpencode } from "./launch.js";

const driver = createOpencodeDriver();

export const opencodeTool: ToolIntegration = {
  id: "opencode",
  displayName: "OpenCode",
  pickerHint: "OpenCode CLI",
  binary: "opencode",
  packageName: "@routekit/tool-opencode",
  installHint: "install OpenCode: https://opencode.ai/docs",
  authSummary: "OpenCode uses an OpenAI-compatible gateway provider.",
  setupSnippet: ({ gatewayUrl, model = "gateway-model" }) =>
    `OpenCode gateway: ${gatewayUrl} (model: ${model})`,
  launch: launchOpencode,
  driver: {
    kind: driver.kind,
    driver,
    configForRoute: (route) =>
      opencodeDriverConfigSchema.parse({
        gatewayUrl: route.gatewayUrl,
        model: route.model,
        providerId: "routekit",
        ...(route.authToken !== undefined ? { authToken: route.authToken } : {})
      })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "full",
    reasoning_controls: "full"
  }
};

export {
  launchOpencode,
  opencodeConfig,
  opencodeModelArg,
  opencodeProviderConfig
} from "./launch.js";
export { createOpencodeDriver, opencodeDriverConfigSchema } from "./driver.js";
export type {
  OpencodeBackend,
  OpencodeBackendFactory,
  OpencodeDriverConfig,
  OpencodeDriverOptions,
  OpencodeTurnPart,
  OpencodeTurnResult
} from "./driver.js";
