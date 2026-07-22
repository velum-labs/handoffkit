/**
 * Canonical registry of the coding-tool integrations shipped by RouteKit.
 *
 * Add a new integration to `toolIntegrations`; consumers receive it through
 * `toolRegistry` without maintaining their own package imports or lists.
 */
import { claudeTool } from "@routekit/tool-claude";
import { codexTool } from "@routekit/tool-codex";
import { cursorTool } from "@routekit/tool-cursor";
import { opencodeTool } from "@routekit/tool-opencode";
import { createToolRegistry } from "@routekit/tools";
import type { ToolIntegration, ToolRegistry } from "@routekit/tools";

export {
  codexIntegrationBlock,
  installCodexIntegration,
  uninstallCodexIntegration
} from "@routekit/tool-codex";
export type {
  CodexInstallInput,
  CodexInstallOwner,
  CodexInstallProfile,
  CodexInstallResult
} from "@routekit/tool-codex";

export const toolIntegrations: readonly ToolIntegration[] = [
  codexTool,
  claudeTool,
  cursorTool,
  opencodeTool
];

export const toolRegistry: ToolRegistry = createToolRegistry(toolIntegrations);
