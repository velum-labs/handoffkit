#!/usr/bin/env bash
# Round 3 driver-topology fused row. BILLED — refuses without --confirm.
set -euo pipefail

ROUND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARM_DIR="$(cd "$ROUND_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ARM_DIR/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:$PATH"

CONFIRM=0
for a in "$@"; do [[ "$a" == "--confirm" ]] && CONFIRM=1; done

mapfile -t INSTANCES < <(rg -v '^#' "$ARM_DIR/2a/instance_manifest.txt")
FILTER="^($(IFS='|'; echo "${INSTANCES[*]}"))\$"
out="$ROUND_DIR/runs/fused-driver"

echo "instances=${#INSTANCES[@]}"
if [[ $CONFIRM -ne 1 ]]; then
  echo "DRY ANNOUNCE ONLY (pass --confirm): fused-driver via config/driver.yaml"
  exit 0
fi
: "${OPENROUTER_API_KEY:?}"
mkdir -p "$out"
export LITELLM_MODEL_REGISTRY_PATH="$ARM_DIR/config/litellm_registry.json"

pushd /tmp >/dev/null
setsid python3 "$ARM_DIR/scripts/logging_proxy.py" "$out/provider_calls.jsonl" 9333 https://openrouter.ai/api \
  > "$out/proxy.log" 2>&1 &
PROXY_PGID=$!
setsid uv run --project "$REPO_ROOT" --package fusionkit fusionkit serve \
  -c "$ROUND_DIR/config/driver.yaml" --host 127.0.0.1 --port 8080 > "$out/serve.log" 2>&1 &
SERVE_PGID=$!
popd >/dev/null
echo "$SERVE_PGID $PROXY_PGID" > "$out/pgids.txt"
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://127.0.0.1:8080/v1/models >/dev/null

MSWEA_COST_TRACKING=ignore_errors mini-extra swebench \
  --subset verified --split test --filter "$FILTER" \
  -m openai/fusionkit/panel \
  -c swebench.yaml -c model.model_kwargs.api_base=http://127.0.0.1:8080/v1 \
  -o "$out/mini" -w 4 2>&1 | tee "$out/mini.log"

kill -- "-$SERVE_PGID" "-$PROXY_PGID" 2>/dev/null || true
sleep 2

(cd "$out/mini" && ~/.venvs/swebench/bin/python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path preds.json --max_workers 3 \
  --run_id "k1-3-driver" 2>&1 | tail -6 | tee "../grade.log")
echo "driver row complete."
