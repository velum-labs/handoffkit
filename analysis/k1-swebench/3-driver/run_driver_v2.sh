#!/usr/bin/env bash
# Round 3 hill-climb runner. Direct-to-OpenRouter (no proxy), memory-safe
# worker count. BILLED — refuses without --confirm.
#   run_driver_v2.sh <config-name> [--confirm] [--filter REGEX]
# config-name: a file stem under config/ (e.g. driver-v2). run id / out dir
# derive from it.
set -euo pipefail
ROUND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARM_DIR="$(cd "$ROUND_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ARM_DIR/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:$PATH"

CFG_NAME="${1:?config stem, e.g. driver-v2}"; shift || true
CONFIRM=0; FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) CONFIRM=1; shift;;
    --filter) FILTER="$2"; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
cfg="$ROUND_DIR/config/$CFG_NAME.yaml"
[[ -f "$cfg" ]] || { echo "no config $cfg" >&2; exit 1; }

mapfile -t INSTANCES < <(rg -v '^#' "$ARM_DIR/2a/instance_manifest.txt")
[[ -z "$FILTER" ]] && FILTER="^($(IFS='|'; echo "${INSTANCES[*]}"))\$"
out="$ROUND_DIR/runs/$CFG_NAME"

if [[ $CONFIRM -ne 1 ]]; then echo "DRY: $CFG_NAME, filter=$FILTER"; exit 0; fi
: "${OPENROUTER_API_KEY:?}"
mkdir -p "$out"
export LITELLM_MODEL_REGISTRY_PATH="$ARM_DIR/config/litellm_registry.json"

pushd /tmp >/dev/null
setsid uv run --project "$REPO_ROOT" --package fusionkit fusionkit serve \
  -c "$cfg" --host 127.0.0.1 --port 8080 > "$out/serve.log" 2>&1 &
SERVE_PGID=$!
popd >/dev/null
echo "$SERVE_PGID" > "$out/pgid.txt"
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://127.0.0.1:8080/v1/models >/dev/null

# 4 workers = memory-safe on this 15GB box (8 caused container OOM).
MSWEA_COST_TRACKING=ignore_errors mini-extra swebench \
  --subset verified --split test --filter "$FILTER" \
  -m openai/fusionkit/panel \
  -c swebench.yaml -c model.model_kwargs.api_base=http://127.0.0.1:8080/v1 \
  -o "$out/mini" -w "${WORKERS:-4}" 2>&1 | tee -a "$out/mini.log"

kill -- "-$SERVE_PGID" 2>/dev/null || true
sleep 2
(cd "$out/mini" && ~/.venvs/swebench/bin/python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified --predictions_path preds.json \
  --max_workers 3 --run_id "k1-3-$CFG_NAME" 2>&1 | tail -6 | tee "../$CFG_NAME.grade.log")
echo "$CFG_NAME complete."
