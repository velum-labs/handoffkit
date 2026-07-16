import assert from "node:assert/strict";
import test from "node:test";

import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  parseFusionConfig
} from "../index.js";

test("v4 accepts only opaque RouteKit endpoint ids", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      router: { config: ".routekit/router.yaml" },
      ensembles: {
        default: {
          members: ["fast", "deep"],
          judge: "deep",
          synthesizer: "deep"
        }
      }
    },
    "fusion.json"
  );
  assert.deepEqual(config.ensembles.default?.members, ["fast", "deep"]);
  assert.equal(config.ensembles.default?.judge, "deep");
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
      error.message.includes("move provider/baseUrl/keyEnv/account settings") &&
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
              members: ["gpt"],
              judge: "gpt",
              provider: "openai"
            }
          }
        },
        "fusion.json"
      ),
    /unsupported field provider/
  );
});
