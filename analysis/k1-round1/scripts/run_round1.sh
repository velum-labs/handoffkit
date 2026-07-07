#!/usr/bin/env bash
# k=1 round-1 executor. BILLED RUNS — refuses to start without --confirm.
#
# Usage:
#   analysis/k1-round1/scripts/run_round1.sh [--phase solo|fused|all] --confirm
#
# Rows produced (all through the benchmark's own harness, terminus-2):
#   solo-terminus : tb + openrouter/deepseek/deepseek-v3.1-terminus  (baseline)
#   solo-qwen3    : tb + openrouter/qwen/qwen3-coder                 (baseline)
#   fused         : tb + fusionkit/panel via local `fusionkit serve` (N=2, k=1)
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

DATASET="terminal-bench-core==0.1.1"
AGENT="terminus-2"
SERVE_PORT=8080
SERVE_URL="http://127.0.0.1:${SERVE_PORT}"
RUNS_DIR="$ROUND_DIR/runs"
mkdir -p "$RUNS_DIR"

mapfile -t TASKS < <(rg -v '^#' "$ROUND_DIR/task_manifest.txt")
TASK_ARGS=()
for t in "${TASKS[@]}"; do TASK_ARGS+=(--task-id "$t"); done

echo "phase=$PHASE tasks=${#TASKS[@]} dataset=$DATASET agent=$AGENT"
if [[ $CONFIRM -ne 1 ]]; then
  echo
  echo "DRY ANNOUNCE ONLY (pass --confirm to execute billed runs):"
  echo "  solo-terminus -> tb run -a $AGENT -m openrouter/deepseek/deepseek-v3.1-terminus"
  echo "  solo-qwen3    -> tb run -a $AGENT -m openrouter/qwen/qwen3-coder"
  echo "  fused         -> tb run -a $AGENT -m openai/fusionkit/panel (api_base=$SERVE_URL/v1)"
  exit 0
fi

: "${OPENROUTER_API_KEY:?}"
git -C "$REPO_ROOT" rev-parse HEAD > "$RUNS_DIR/git_sha.txt"
uv tool list | rg terminal-bench > "$RUNS_DIR/tb_version.txt" || true

run_tb() { # run_tb <run-name> <litellm-model> [extra tb args...]
  local name="$1" model="$2"; shift 2
  echo "=== $name ($model) ==="
  tb run \
    --agent "$AGENT" \
    --model "$model" \
    --dataset "$DATASET" \
    "${TASK_ARGS[@]}" \
    --n-concurrent 2 \
    --output-path "$RUNS_DIR/$name" \
    "$@" 2>&1 | tee "$RUNS_DIR/$name.log"
}

if [[ "$PHASE" == "solo" || "$PHASE" == "all" ]]; then
  run_tb solo-terminus "openrouter/deepseek/deepseek-v3.1-terminus"
  run_tb solo-qwen3 "openrouter/qwen/qwen3-coder"
fi

if [[ "$PHASE" == "fused" || "$PHASE" == "all" ]]; then
  # Boot the fused endpoint unless one is already serving. setsid gives the
  # server its own process group so teardown kills the whole tree (uv +
  # uvicorn), not just the launcher.
  SERVE_PGID=""
  if ! curl -sf "$SERVE_URL/v1/models" >/dev/null 2>&1; then
    echo "starting fusionkit serve..."
    pushd "$REPO_ROOT" >/dev/null
    setsid uv run --package fusionkit fusionkit serve \
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
  # litellm's `openai/` prefix -> OpenAI-compatible endpoint at api_base; the
  # server receives model id `fusionkit/panel` (panel fanout + fusion).
  run_tb fused "openai/fusionkit/panel" --agent-kwarg "api_base=$SERVE_URL/v1"
  if [[ -n "$SERVE_PGID" ]]; then
    kill -- "-$SERVE_PGID" 2>/dev/null || true
  fi
fi

echo "done. results under $RUNS_DIR/<run-name>/<run-id>/results.json"
