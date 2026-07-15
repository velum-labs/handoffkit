/**
 * The fusionkit tool registry: the single place that knows every tool package.
 * Importing this module also wires the ensemble harness gateway to resolve
 * tool-backed adapters (codex / claude-code / cursor) from the registry, so
 * `@fusionkit/ensemble` itself stays free of any per-tool dependency.
 *
 * Adding a new tool is one new `@routekit/tool-*` package plus one entry here.
 */
import { setToolDriverRegistry } from "@fusionkit/ensemble";
import { claudeTool } from "@routekit/tool-claude";
import { codexTool } from "@routekit/tool-codex";
import { cursorTool } from "@routekit/tool-cursor";
import { opencodeTool } from "@routekit/tool-opencode";
import { createToolRegistry } from "@routekit/tools";
import type { ToolRegistry } from "@routekit/tools";

export const toolRegistry: ToolRegistry = createToolRegistry([
  codexTool,
  claudeTool,
  cursorTool,
  opencodeTool
]);

setToolDriverRegistry(toolRegistry);
