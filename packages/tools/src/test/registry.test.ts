import assert from "node:assert/strict";
import { test } from "node:test";

import type { HarnessAdapter, ToolHarnessResolveOptions, UnifiedHarnessKind } from "@fusionkit/ensemble";

import { createToolRegistry } from "../registry.js";
import type { ToolIntegration } from "../types.js";

function fakeHarness(id: string): HarnessAdapter {
  return {
    id,
    prepare: () => undefined,
    run: () => ({
      model: { id: "m", model: "model" },
      status: "succeeded",
      artifacts: []
    }),
    collectArtifacts: () => [],
    verificationProfile: () => ({ id: "none", requiredEvidence: [] }),
    capabilities: () => ({})
  };
}

function integration(input: {
  id: string;
  aliases?: readonly string[];
  modes: readonly ("fusion" | "local")[];
  harnessKinds: readonly UnifiedHarnessKind[];
  panelHarnessKind?: UnifiedHarnessKind;
  withHarness?: boolean;
}): ToolIntegration {
  return {
    id: input.id,
    aliases: input.aliases,
    displayName: input.id,
    pickerHint: `${input.id} hint`,
    modes: input.modes,
    harnessKinds: input.harnessKinds,
    panelHarnessKind: input.panelHarnessKind,
    launch: async () => 0,
    ...(input.withHarness
      ? {
          createHarness: (kind: UnifiedHarnessKind, _options: ToolHarnessResolveOptions) =>
            fakeHarness(`${input.id}:${kind}`),
          harness: {
            harnessKind: "codex",
            sideEffects: "writes_workspace",
            responseShape: `${input.id} response`
          }
        }
      : {})
  };
}

test("registry resolves ids and aliases and preserves registration order", () => {
  const codex = integration({
    id: "codex",
    aliases: ["cx"],
    modes: ["fusion", "local"],
    harnessKinds: ["codex"],
    panelHarnessKind: "codex",
    withHarness: true
  });
  const serve = integration({ id: "serve", modes: ["local"], harnessKinds: [] });
  const registry = createToolRegistry([codex, serve]);

  assert.equal(registry.get("codex"), codex);
  assert.equal(registry.get("cx"), codex);
  assert.equal(registry.get("missing"), undefined);
  assert.deepEqual(registry.list(), [codex, serve]);
});

test("registry filters launch modes and reports panel harness kinds", () => {
  const codex = integration({
    id: "codex",
    modes: ["fusion", "local"],
    harnessKinds: ["codex"],
    panelHarnessKind: "codex",
    withHarness: true
  });
  const localOnly = integration({ id: "solo", modes: ["local"], harnessKinds: [] });
  const registry = createToolRegistry([codex, localOnly]);

  assert.deepEqual(registry.launchableFusion(), [codex]);
  assert.deepEqual(registry.launchableLocal(), [codex, localOnly]);
  assert.equal(registry.panelHarnessKindFor("codex"), "codex");
  assert.equal(registry.panelHarnessKindFor("solo"), undefined);
});

test("registry delegates harness factories and metadata by unified harness kind", () => {
  const codex = integration({
    id: "codex",
    modes: ["fusion"],
    harnessKinds: ["codex"],
    panelHarnessKind: "codex",
    withHarness: true
  });
  const registry = createToolRegistry([codex]);

  assert.equal(registry.harnessForKind("codex", { fusionBackendUrl: "http://127.0.0.1" }).id, "codex:codex");
  assert.equal(registry.sideEffectsForKind("codex"), "writes_workspace");
  assert.equal(registry.responseShapeForKind("codex"), "codex response");
  assert.deepEqual(registry.harnessKinds(), ["codex"]);
});

test("registry errors clearly for unknown or incomplete harness integrations", () => {
  const noFactory = integration({ id: "cursor", modes: ["fusion"], harnessKinds: ["cursor-acp"] });
  const registry = createToolRegistry([noFactory]);

  assert.throws(() => registry.harnessForKind("codex", { fusionBackendUrl: "http://127.0.0.1" }), /no tool integration/);
  assert.throws(
    () => registry.harnessForKind("cursor-acp", { fusionBackendUrl: "http://127.0.0.1" }),
    /no harness factory/
  );
  assert.throws(() => registry.sideEffectsForKind("cursor-acp"), /no harness metadata/);
});
