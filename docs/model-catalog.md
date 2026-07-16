# Model catalog

Provider model discovery and endpoint routing belong to RouteKit. Define each
model in `.routekit/router.yaml` with an opaque `endpointId`, then compose those
IDs in Fusion v4:

```yaml
endpoints:
  - endpointId: fast
    model: provider-fast-model
    provider: openai-compatible
    baseUrl: https://provider.example/v1
    dialect: openai
    apiKeyEnv: PROVIDER_API_KEY
```

```json
{
  "version": "fusionkit.fusion.v4",
  "router": { "config": ".routekit/router.yaml" },
  "ensembles": {
    "default": {
      "members": ["fast", "deep"],
      "judge": "deep"
    }
  }
}
```

Use models from different vendors or families when you want decorrelated
candidates. FusionKit does not accept provider/model/key launch flags.

## Local MLX cache

FusionKit retains local-panel cache lifecycle commands:

```sh
fusionkit models
fusionkit models download mlx-community/Qwen3-1.7B-4bit
fusionkit models download <repo> --force
fusionkit models rm mlx-community/Qwen3-1.7B-4bit
```

`fusionkit models list` reports size, downloaded state, and a conservative RAM
floor. To use a local model in an ensemble, expose it as a RouteKit endpoint and
reference that endpoint ID. Use RouteKit directly for single-model launches.
