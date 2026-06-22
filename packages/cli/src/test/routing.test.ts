import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeRoutingProviders, panelSpecToRoutingProvider } from "../fusion/providers/index.js";
import { printRoutingPreview, sampleRoutingBody } from "../fusion/routing.js";
import { parseScenarioRoutes } from "@fusionkit/model-gateway";

test("panelSpecToRoutingProvider maps cloud panel entries", () => {
  const spec = panelSpecToRoutingProvider({
    id: "sonnet",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY"
  });
  assert.deepEqual(spec, {
    id: "sonnet",
    provider: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY"
  });
  assert.equal(panelSpecToRoutingProvider({ id: "local", model: "qwen", provider: "mlx" }), undefined);
});

test("mergeRoutingProviders prefers explicit entries", () => {
  const merged = mergeRoutingProviders(
    [{ id: "sonnet", provider: "anthropic", keyEnv: "KEY" }],
    [{ id: "sonnet", model: "other", provider: "anthropic", keyEnv: "OTHER" }]
  );
  assert.equal(merged[0]?.keyEnv, "KEY");
});

test("printRoutingPreview emits scenario decision", () => {
  const routes = parseScenarioRoutes({ default: "p,m1", webSearch: "p,m2" }, "test");
  const lines: string[] = [];
  const decision = printRoutingPreview(
    routes,
    { ...sampleRoutingBody("search the web"), tools: [{ name: "web_search" }] },
    (line) => lines.push(line)
  );
  assert.equal(decision.scenario, "webSearch");
  assert.match(lines[0] ?? "", /webSearch/);
});
