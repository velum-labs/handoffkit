import type { ToolIntegration } from "@velum-labs/routekit-tools";

import { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";
import { launchCursor } from "./launch.js";

const driver = createCursorDriver();

export const cursorTool: ToolIntegration = {
  id: "cursor",
  displayName: "Cursor",
  pickerHint: "Cursor CLI or desktop",
  binary: "cursor-agent",
  packageName: "@velum-labs/routekit-tool-cursor",
  installHint: "install the Cursor CLI: https://cursor.com/cli",
  authSummary: "Cursor uses a logged-in cursor-agent CLI and a local bridge.",
  setupSnippet: ({ gatewayUrl, model = "gateway-model", note }) =>
    `cursor-agent --endpoint ${note === undefined || note.length === 0 ? gatewayUrl : note} --model ${model}`,
  launch: launchCursor,
  driver: {
    kind: driver.kind,
    driver,
    configForRoute: (route) =>
      cursorDriverConfigSchema.parse({ endpoint: route.gatewayUrl, model: route.model })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "degraded",
    reasoning_controls: "degraded"
  }
};

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
export { resolveCursorkitCli } from "./cursorkit-path.js";
export type { CursorkitCli } from "./cursorkit-path.js";
export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";
export {
  CURSOR_AGENTS_DIRNAME,
  cursorSubagentMarkdown,
  scaffoldCursorSubagents
} from "./subagents.js";
export { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";
export type { CursorDriverConfig } from "./driver.js";
