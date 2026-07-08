#!/usr/bin/env bash
# Round 3 confirmation: solo-terminus + driver-v2 on the FRESH confirm slice.
# BILLED — refuses without --confirm.  run_confirm.sh <solo|driver|grade|all> --confirm
set -euo pipefail
ROUND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARM_DIR="$(cd "$ROUND_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ARM_DIR/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:$PATH"
PHASE="${1:?solo|driver|grade|all}"; shift || true
CONFIRM=0; for a in "$@"; do [[ "$a" == "--confirm" ]] && CONFIRM=1; done
mapfile -t INSTANCES < <(rg -v '^#' "$ROUND_DIR/confirm_manifest.txt")
FILTER="^($(IFS='|'; echo "${INSTANCES[*]}"))\$"
RUNS="$ROUND_DIR/runs-confirm"; mkdir -p "$RUNS"
[[ $CONFIRM -ne 1 ]] && { echo "DRY: phase=$PHASE n=${#INSTANCES[@]}"; exit 0; }
: "${OPENROUTER_API_KEY:?}"
export LITELLM_MODEL_REGISTRY_PATH="$ARM_DIR/config/litellm_registry.json"

if [[ "$PHASE" == "solo" || "$PHASE" == "all" ]]; then
  MSWEA_COST_TRACKING=ignore_errors mini-extra swebench --subset verified --split test \
    --filter "$FILTER" -m openrouter/deepseek/deepseek-v3.1-terminus \
    -c swebench.yaml -o "$RUNS/solo-terminus" -w "${WORKERS:-2}" 2>&1 | tee -a "$RUNS/solo-terminus.log"
fi
if [[ "$PHASE" == "driver" || "$PHASE" == "all" ]]; then
  out="$RUNS/driver-v2"; mkdir -p "$out"
  pushd /tmp >/dev/null
  setsid uv run --project "$REPO_ROOT" --package fusionkit fusionkit serve \
    -c "$ROUND_DIR/config/driver-v2.yaml" --host 127.0.0.1 --port 8080 > "$out/serve.log" 2>&1 &
  SERVE_PGID=$!; popd >/dev/null; echo "$SERVE_PGID" > "$out/pgid.txt"
  for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break; sleep 1; done
  curl -sf http://127.0.0.1:8080/v1/models >/dev/null
  MSWEA_COST_TRACKING=ignore_errors mini-extra swebench --subset verified --split test \
    --filter "$FILTER" -m openai/fusionkit/panel \
    -c swebench.yaml -c model.model_kwargs.api_base=http://127.0.0.1:8080/v1 \
    -o "$out/mini" -w "${WORKERS:-2}" 2>&1 | tee -a "$out/mini.log"
  kill -- "-$SERVE_PGID" 2>/dev/null || true; sleep 2
fi
if [[ "$PHASE" == "grade" || "$PHASE" == "all" ]]; then
  for name in solo-terminus driver-v2; do
    dir="$RUNS/$name"; [[ "$name" == driver-v2 ]] && dir="$RUNS/driver-v2/mini"
    [[ -f "$dir/preds.json" ]] || { echo "no preds $name"; continue; }
    (cd "$dir" && ~/.venvs/swebench/bin/python -m swebench.harness.run_evaluation \
      --dataset_name princeton-nlp/SWE-bench_Verified --predictions_path preds.json \
      --max_workers 3 --run_id "k1-3c-$name" 2>&1 | tail -5)
  done
fi
echo "confirm $PHASE done."
