import assert from "node:assert/strict";
import { test } from "node:test";

import { createMockDriver } from "@routekit/harness-core/testing";

import { createToolCapabilityMatrix, createToolRegistry } from "../registry.js";
import type { ToolIntegration } from "../types.js";

function integration(id: string, kind: "codex" | "claude_code"): ToolIntegration {
  const driver = { ...createMockDriver(), kind };
  return {
    id,
    aliases: [`${id}-alias`],
    displayName: id,
    pickerHint: `${id} hint`,
    packageName: `@routekit/tool-${id}`,
    launch: async () => 0,
    driver: {
      kind,
      driver,
      configForRoute: () => ({})
    },
    capabilities: {
      streaming: "full",
      tools: "full",
      images: "degraded",
      reasoning_controls: "unsupported"
    }
  };
}

test("registry resolves aliases and canonical drivers", () => {
  const codex = integration("codex", "codex");
  const claude = integration("claude", "claude_code");
  const registry = createToolRegistry([codex, claude]);

  assert.equal(registry.get("codex-alias"), codex);
  assert.equal(registry.driverForKind("claude_code"), claude);
  assert.deepEqual(registry.list(), [codex, claude]);
  assert.deepEqual(registry.drivers(), [codex, claude]);
});

test("registry rejects duplicate ids, aliases, and driver kinds", () => {
  const codex = integration("codex", "codex");
  assert.throws(() => createToolRegistry([codex, integration("codex", "claude_code")]));
  assert.throws(() =>
    createToolRegistry([
      codex,
      { ...integration("other", "claude_code"), aliases: ["codex-alias"] }
    ])
  );
  assert.throws(() => createToolRegistry([codex, integration("other", "codex")]));
});

test("capability matrix grades every opaque model and harness feature", () => {
  const registry = createToolRegistry([
    integration("codex", "codex"),
    integration("claude", "claude_code")
  ]);
  const matrix = createToolCapabilityMatrix(registry, [
    { id: "opaque-a" },
    {
      id: "opaque-b",
      features: {
        streaming: "full",
        tools: "full",
        images: "unsupported",
        reasoning_controls: "full"
      }
    }
  ]);
  assert.equal(matrix.length, 16);
  assert.equal(
    matrix.find(
      (cell) =>
        cell.modelId === "opaque-b" && cell.toolId === "claude" && cell.feature === "images"
    )?.grade,
    "unsupported"
  );
  assert.equal(
    matrix.find(
      (cell) =>
        cell.modelId === "opaque-a" && cell.toolId === "codex" && cell.feature === "streaming"
    )?.grade,
    "degraded"
  );
  assert.equal(
    matrix.find(
      (cell) =>
        cell.modelId === "opaque-b" && cell.toolId === "codex" && cell.feature === "streaming"
    )?.grade,
    "full"
  );
});
