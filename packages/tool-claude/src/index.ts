import type { ToolIntegration } from "@routekit/tools";
import { trimTrailingSlashes } from "@routekit/runtime";

import { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
import { claudeEnv, launchClaude } from "./launch.js";

const driver = createClaudeDriver();

export const claudeTool: ToolIntegration = {
  id: "claude",
  aliases: ["claude-code"],
  displayName: "Claude Code",
  pickerHint: "Claude Code",
  binary: "claude",
  packageName: "@routekit/tool-claude",
  installHint: "install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview",
  authSummary: "Claude Code uses the gateway's Anthropic-compatible surface.",
  setupSnippet: ({ gatewayUrl, model = "gateway-model" }) =>
    [
      `ANTHROPIC_BASE_URL=${trimTrailingSlashes(gatewayUrl)}`,
      "ANTHROPIC_AUTH_TOKEN=routekit",
      `ANTHROPIC_MODEL=${model}`
    ].join("\n"),
  launch: launchClaude,
  driver: {
    kind: driver.kind,
    driver,
    configForRoute: (route) =>
      claudeDriverConfigSchema.parse({ model: route.model, baseUrl: route.gatewayUrl })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "full",
    reasoning_controls: "degraded"
  }
};

export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
export type {
  ClaudeDriverConfig,
  ClaudeDriverOptions,
  ClaudeQueryFn
} from "./driver.js";
export {
  installClaudeIntegration,
  uninstallClaudeIntegration
} from "./install.js";
export type {
  ClaudeInstallInput,
  ClaudeInstallOwner,
  ClaudeInstallResult
} from "./install.js";
export {
  claudeAgentsJson,
  claudeEnv,
  claudeLaunchArgs,
  launchClaude
} from "./launch.js";
