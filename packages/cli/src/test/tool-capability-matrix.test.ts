import assert from "node:assert/strict";
import { test } from "node:test";

import { createToolCapabilityMatrix } from "@routekit/tools";

import { toolRegistry } from "../tools.js";

test("model by harness capability matrix covers every canonical routed tool", () => {
  const toolIds = toolRegistry.list().map((tool) => tool.id);
  const matrix = createToolCapabilityMatrix(toolRegistry, [
    { id: "endpoint:opaque/a" },
    {
      id: "endpoint:opaque/b",
      features: { images: "unsupported", reasoning_controls: "unsupported" }
    }
  ]);
  assert.deepEqual(
    [...new Set(matrix.map((cell) => cell.toolId))],
    toolIds
  );
  assert.deepEqual(
    [...new Set(matrix.map((cell) => cell.modelId))],
    ["endpoint:opaque/a", "endpoint:opaque/b"]
  );
  assert.equal(matrix.length, 2 * toolIds.length * 4);
  for (const toolId of toolIds) {
    assert.equal(
      matrix.find(
        (cell) =>
          cell.modelId === "endpoint:opaque/b" &&
          cell.toolId === toolId &&
          cell.feature === "images"
      )?.grade,
      "unsupported"
    );
  }
});
