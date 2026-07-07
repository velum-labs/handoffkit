#!/usr/bin/env bash
# Round 2A' executor: frozen v2-strict-commit fused row + solo baselines on
# the fresh 30-instance slice. BILLED — refuses to run without --confirm.
set -euo pipefail

ROUND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARM_DIR="$(cd "$ROUND_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ARM_DIR/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:$PATH"

PHASE="all"
CONFIRM=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mapfile -t INSTANCES < <(rg -v '^#' "$ROUND_DIR/instance_manifest.txt")
FILTER="^($(IFS='|'; echo "${INSTANCES[*]}"))\$"
RUNS_DIR="$ROUND_DIR/runs"
mkdir -p "$RUNS_DIR"

echo "phase=$PHASE instances=${#INSTANCES[@]}"
if [[ $CONFIRM -ne 1 ]]; then
  echo "DRY ANNOUNCE ONLY (pass --confirm): solo-terminus, solo-qwen3, fused(v2-strict-commit), grade"
  exit 0
fi
: "${OPENROUTER_API_KEY:?}"
git -C "$REPO_ROOT" rev-parse HEAD > "$RUNS_DIR/git_sha.txt"
export LITELLM_MODEL_REGISTRY_PATH="$ARM_DIR/config/litellm_registry.json"

run_mini() { # run_mini <row> <output-dir> <model> [extra -c overrides...]
  local name="$1" outdir="$2" model="$3"; shift 3
  echo "=== $name ($model) ==="
  mini-extra swebench \
    --subset verified --split test \
    --filter "$FILTER" \
    -m "$model" \
    -c swebench.yaml "$@" \
    -o "$outdir" \
    -w 4 2>&1 | tee "$RUNS_DIR/$name.log"
}

if [[ "$PHASE" == "solo" || "$PHASE" == "all" ]]; then
  run_mini solo-terminus "$RUNS_DIR/solo-terminus" "openrouter/deepseek/deepseek-v3.1-terminus"
  run_mini solo-qwen3 "$RUNS_DIR/solo-qwen3" "openrouter/qwen/qwen3-coder"
fi

if [[ "$PHASE" == "fused" || "$PHASE" == "all" ]]; then
  out="$RUNS_DIR/fused"
  mkdir -p "$out"
  pushd /tmp >/dev/null
  setsid python3 "$ARM_DIR/scripts/logging_proxy.py" "$out/provider_calls.jsonl" 9333 https://openrouter.ai/api \
    > "$out/proxy.log" 2>&1 &
  PROXY_PGID=$!
  setsid uv run --project "$REPO_ROOT" --package fusionkit fusionkit serve \
    -c "$ARM_DIR/2c/configs/v2-strict-commit.yaml" --host 127.0.0.1 --port 8080 \
    > "$out/serve.log" 2>&1 &
  SERVE_PGID=$!
  popd >/dev/null
  echo "$SERVE_PGID $PROXY_PGID" > "$out/pgids.txt"
  for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf http://127.0.0.1:8080/v1/models >/dev/null
  MSWEA_COST_TRACKING=ignore_errors run_mini fused "$out/mini" "openai/fusionkit/panel" \
    -c "model.model_kwargs.api_base=http://127.0.0.1:8080/v1"
  kill -- "-$SERVE_PGID" "-$PROXY_PGID" 2>/dev/null || true
fi

if [[ "$PHASE" == "grade" || "$PHASE" == "all" ]]; then
  for name in solo-terminus solo-qwen3 fused; do
    dir="$RUNS_DIR/$name"
    [[ "$name" == "fused" ]] && dir="$RUNS_DIR/fused/mini"
    preds="$dir/preds.json"
    [[ -f "$preds" ]] || { echo "missing $preds" >&2; continue; }
    echo "=== grading $name ==="
    (cd "$dir" && ~/.venvs/swebench/bin/python -m swebench.harness.run_evaluation \
      --dataset_name princeton-nlp/SWE-bench_Verified \
      --predictions_path preds.json \
      --max_workers 3 \
      --run_id "k1-2a-$name" 2>&1 | tail -6)
  done
fi
echo "2A rows complete."
