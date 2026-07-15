import type { ToolIntegration } from "@routekit/tools";

import { codexDriverConfigSchema, createCodexDriver } from "./driver.js";
import { codexLaunchConfigToml, launchCodex } from "./launch.js";

const driver = createCodexDriver();

export const codexTool: ToolIntegration = {
  id: "codex",
  displayName: "Codex",
  pickerHint: "OpenAI Codex CLI",
  binary: "codex",
  packageName: "@routekit/tool-codex",
  installHint: "install the Codex CLI: https://github.com/openai/codex",
  authSummary: "Codex uses an ephemeral gateway-backed provider.",
  setupSnippet: ({ gatewayUrl }) =>
    codexLaunchConfigToml({
      gatewayUrl,
      defaultModel: "gateway-model"
    }),
  launch: launchCodex,
  driver: {
    kind: driver.kind,
    driver,
    configForRoute: (route) =>
      codexDriverConfigSchema.parse({
        model: route.model,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        provider: {
          baseUrl: `${route.gatewayUrl.replace(/\/+$/, "")}/v1`,
          ...(route.authToken !== undefined ? { apiKey: route.authToken } : {})
        }
      })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "degraded",
    reasoning_controls: "full"
  }
};

export {
  codexDriverConfigSchema,
  createCodexDriver
} from "./driver.js";
export type { CodexDriverConfig } from "./driver.js";
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
  hasCodexLogin,
  isCodexConfigFailure,
  launchCodex,
  readCodexCatalogTemplate,
  readCodexModelsCache
} from "./launch.js";
export type { CodexAgentRole, CodexModelPreset } from "./launch.js";
export {
  codexIntegrationBlock,
  installCodexIntegration,
  uninstallCodexIntegration
} from "./install.js";
export type {
  CodexInstallInput,
  CodexInstallOwner,
  CodexInstallProfile,
  CodexInstallResult
} from "./install.js";
