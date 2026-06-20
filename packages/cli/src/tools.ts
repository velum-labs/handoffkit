/**
 * The fusionkit tool registry: the single place that knows every tool package.
 * Importing this module also wires the ensemble harness gateway to resolve
 * tool-backed adapters (codex / claude-code / cursor) from the registry, so
 * `@fusionkit/ensemble` itself stays free of any per-tool dependency.
 *
 * Adding a new tool is one new `@fusionkit/tool-*` package plus one entry here.
 */
import { setToolHarnessProvider } from "@fusionkit/ensemble";
import { createToolRegistry } from "@fusionkit/tools";
import type { ToolRegistry } from "@fusionkit/tools";
import { claudeTool } from "@fusionkit/tool-claude";
import { codexTool } from "@fusionkit/tool-codex";
import { cursorTool } from "@fusionkit/tool-cursor";
import { opencodeTool } from "@fusionkit/tool-opencode";

export const toolRegistry: ToolRegistry = createToolRegistry([
  codexTool,
  claudeTool,
  cursorTool,
  opencodeTool
]);

setToolHarnessProvider({
  adapter: (kind, options) => toolRegistry.harnessForKind(kind, options),
  sideEffects: (kind) => toolRegistry.sideEffectsForKind(kind),
  responseShape: (kind) => toolRegistry.responseShapeForKind(kind)
});
