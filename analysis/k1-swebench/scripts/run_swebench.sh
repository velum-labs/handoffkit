#!/usr/bin/env bash
# k=1 SWE-bench arm executor. BILLED RUNS — refuses to start without --confirm.
#
# Usage:
#   analysis/k1-swebench/scripts/run_swebench.sh [--phase solo|fused|grade|all] --confirm
#
# Rows (all driven by mini-SWE-agent v2 — the benchmark's bash-only
# leaderboard scaffold, native tool calling — and graded by the official
# SWE-bench harness locally):
#   solo-terminus : mini + openrouter/deepseek/deepseek-v3.1-terminus
#   solo-qwen3    : mini + openrouter/qwen/qwen3-coder
#   fused         : mini + fusionkit/panel via local `fusionkit serve` (N=2, k=1)
set -euo pipefail

ROUND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROUND_DIR/../.." && pwd)"
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

SERVE_PORT=8080
SERVE_URL="http://127.0.0.1:${SERVE_PORT}"
RUNS_DIR="$ROUND_DIR/runs"
mkdir -p "$RUNS_DIR"

mapfile -t INSTANCES < <(rg -v '^#' "$ROUND_DIR/instance_manifest.txt")
FILTER="^($(IFS='|'; echo "${INSTANCES[*]}"))\$"

echo "phase=$PHASE instances=${#INSTANCES[@]} subset=verified split=test"
if [[ $CONFIRM -ne 1 ]]; then
  echo
  echo "DRY ANNOUNCE ONLY (pass --confirm to execute billed runs):"
  echo "  solo-terminus -> mini-extra swebench -m openrouter/deepseek/deepseek-v3.1-terminus"
  echo "  solo-qwen3    -> mini-extra swebench -m openrouter/qwen/qwen3-coder"
  echo "  fused         -> mini-extra swebench -m openai/fusionkit/panel (api_base=$SERVE_URL/v1)"
  echo "  grade         -> swebench.harness.run_evaluation on each row's preds.json"
  exit 0
fi

: "${OPENROUTER_API_KEY:?}"
git -C "$REPO_ROOT" rev-parse HEAD > "$RUNS_DIR/git_sha.txt"
mini --help 2>&1 | rg -o 'version [0-9.]+' > "$RUNS_DIR/mini_version.txt" || true

# litellm's built-in registry doesn't price these OpenRouter ids; without
# this, mini's cost tracking hard-fails on the first solo call. Prices are
# pinned from the OpenRouter models endpoint (2026-07-07) in the committed
# registry file, keeping stock cost display + the $3/instance cost_limit
# live for the solo rows.
export LITELLM_MODEL_REGISTRY_PATH="$ROUND_DIR/config/litellm_registry.json"

run_mini() { # run_mini <run-name> <litellm-model> [extra -c overrides...]
  local name="$1" model="$2"; shift 2
  echo "=== $name ($model) ==="
  mini-extra swebench \
    --subset verified --split test \
    --filter "$FILTER" \
    -m "$model" \
    -c swebench.yaml "$@" \
    -o "$RUNS_DIR/$name" \
    -w "${WORKERS:-2}" 2>&1 | tee -a "$RUNS_DIR/$name.log"
}

if [[ "$PHASE" == "solo" || "$PHASE" == "all" ]]; then
  run_mini solo-terminus "openrouter/deepseek/deepseek-v3.1-terminus"
  run_mini solo-qwen3 "openrouter/qwen/qwen3-coder"
fi

if [[ "$PHASE" == "fused" || "$PHASE" == "all" ]]; then
  SERVE_PGID=""
  if ! curl -sf "$SERVE_URL/v1/models" >/dev/null 2>&1; then
    echo "starting fusionkit serve (cwd=/tmp: avoids the repo's .fusionkit/prompts CWD override)..."
    pushd /tmp >/dev/null
    setsid uv run --project "$REPO_ROOT" --package fusionkit fusionkit serve \
      -c "$ROUND_DIR/config/panel.yaml" \
      --host 127.0.0.1 --port "$SERVE_PORT" \
      > "$RUNS_DIR/serve.log" 2>&1 &
    SERVE_PGID=$!
    popd >/dev/null
    for _ in $(seq 1 60); do
      curl -sf "$SERVE_URL/v1/models" >/dev/null 2>&1 && break
      sleep 1
    done
    curl -sf "$SERVE_URL/v1/models" >/dev/null
  fi
  # litellm can't price the fused model id -> ignore cost-tracking errors.
  # (Recorded asymmetry: mini's $3/instance cost_limit is live for solo rows
  # but inert for the fused row; the step_limit and our spend cap govern it.)
  MSWEA_COST_TRACKING=ignore_errors run_mini fused "openai/fusionkit/panel" \
    -c "model.model_kwargs.api_base=$SERVE_URL/v1"
  if [[ -n "$SERVE_PGID" ]]; then
    kill -- "-$SERVE_PGID" 2>/dev/null || true
  fi
fi

if [[ "$PHASE" == "grade" || "$PHASE" == "all" ]]; then
  for name in solo-terminus solo-qwen3 fused; do
    preds="$RUNS_DIR/$name/preds.json"
    if [[ ! -f "$preds" ]]; then
      echo "missing $preds — skipping grade for $name" >&2
      continue
    fi
    echo "=== grading $name ==="
    (cd "$RUNS_DIR/$name" && ~/.venvs/swebench/bin/python -m swebench.harness.run_evaluation \
      --dataset_name princeton-nlp/SWE-bench_Verified \
      --predictions_path preds.json \
      --max_workers 2 \
      --run_id "k1-$name" 2>&1 | tee "../$name.grade.log")
  done
fi

echo "done. mini outputs under $RUNS_DIR/<row>/, grading reports written by swebench harness."
