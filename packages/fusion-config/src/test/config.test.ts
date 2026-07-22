import assert from "node:assert/strict";
import test from "node:test";

import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  parseFusionConfig
} from "../index.js";

test("v4 accepts namespaced RouteKit model ids", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      router: { config: ".routekit/router.yaml" },
      ensembles: {
        default: {
          members: ["openai/fast", "anthropic/deep"],
          judge: "anthropic/deep",
          synthesizer: "anthropic/deep"
        }
      }
    },
    "fusion.json"
  );
  assert.deepEqual(config.ensembles.default?.members, ["openai/fast", "anthropic/deep"]);
  assert.equal(config.ensembles.default?.judge, "anthropic/deep");
});

test("v4 rejects unqualified model ids", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        {
          version: FUSION_CONFIG_VERSION,
          router: { url: "http://127.0.0.1:8080" },
          ensembles: {
            default: {
              members: ["fast"],
              judge: "fast"
            }
          }
        },
        "fusion.json"
      ),
    /namespaced RouteKit model ids/
  );
});

test("v3 returns actionable RouteKit migration guidance", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        {
          version: "fusionkit.fusion.v3",
          panel: [{ id: "gpt", provider: "openai", model: "gpt" }]
        },
        "fusion.json"
      ),
    (error: unknown) =>
      error instanceof FusionConfigError &&
      error.message.includes("move provider settings") &&
      error.message.includes("provider/model") &&
      error.message.includes(".routekit/router.yaml")
  );
});

test("v4 rejects provider configuration on ensembles", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        {
          version: FUSION_CONFIG_VERSION,
          router: { url: "http://127.0.0.1:8080" },
          ensembles: {
            default: {
              members: ["openai/gpt"],
              judge: "openai/gpt",
              provider: "openai"
            }
          }
        },
        "fusion.json"
      ),
    /unsupported field provider/
  );
});
