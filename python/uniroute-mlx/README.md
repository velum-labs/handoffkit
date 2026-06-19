# uniroute-mlx

UniRoute routing ([arXiv:2502.08773](https://arxiv.org/abs/2502.08773)) for locally
served models — mlx-lm and anything else that speaks the OpenAI-compatible API
(Ollama, LM Studio, vLLM, cloud providers).

All routing math lives in the sibling [`uniroute`](../uniroute) package and is reused
unchanged. This package is the bridge to running models:

1. **Evaluate** each candidate once over a small labelled validation set, through its
   OpenAI-compatible endpoint. One resumable file per model — adding a new model to
   the pool never re-runs the others (the paper's dynamic-pool property).
2. **Fit** a router on training prompts (embedded via any `/v1/embeddings` endpoint)
   and freeze it into a portable **router card** (`uniroute.router.v1` JSON):
   centroids, each model's per-cluster error vector Ψ, and costs.
3. **Route** anywhere. The card is pure data; the online rule (embed → assign →
   cost-adjusted argmin) runs in this package's CLI or in the repository's
   TypeScript `routedModel` (`@fusionkit/adapter-ai-sdk`), which delegates to
   `mlxServer(...)`-managed processes.

## Usage

```sh
# 1. one pass per candidate over the validation set (resumable)
uv run uniroute-mlx evaluate \
  --endpoint http://127.0.0.1:8080 \
  --model mlx-community/Qwen3-1.7B-4bit --model mlx-community/Qwen3-8B-4bit \
  --val val.jsonl --out evals/

# 2. fit the router and freeze the card
uv run uniroute-mlx fit \
  --train-prompts train.jsonl --val val.jsonl --evals evals/ \
  --embed-endpoint http://127.0.0.1:8081 --embed-model my-embedder \
  --clusters 16 --out router-card.json

# 3. route (CLI smoke; production routing lives in routedModel on the TS side)
uv run uniroute-mlx route --card router-card.json \
  --embed-endpoint http://127.0.0.1:8081 "prove this identity"
```

Validation JSONL is one object per line:

```json
{"prompt": "what is 6 * 7?", "target": "42", "match": "numeric"}
```

`match` is `exact` (default), `contains`, or `numeric`. Training prompts are JSONL
objects with a `prompt` key or plain text lines (no labels needed — the K-means
variant is unsupervised).

Costs default to each model's **measured mean latency** during evaluation — a
meaningful local cost where API prices do not exist — and can be overridden per
model with `--cost MODEL=VALUE` (e.g. parameter count or energy).

## Notes

- The embedder is pinned in the card (`embedder.model`); routing with a different
  embedder is rejected, because Ψ only means something in the embedding space the
  clusters were built in.
- The card stores either hard centroids (`UniRouteKMeans`, §5.1) or a learned
  softmax map (`UniRouteLearnedMap`, §5.2) — both route identically through
  `RouterCard.decide`.
- Tests run against an in-process fake OpenAI-compatible server: no MLX, no
  network, no Apple Silicon required.
