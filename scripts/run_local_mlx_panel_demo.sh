#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${FUSIONKIT_MLX_VENV:-$HOME/.cache/fusionkit/mlx-demo-venv}"
ART="${FUSIONKIT_DEMO_ARTIFACT_DIR:-/tmp/fusionkit-local-mlx-panel-demo-$(date -u +%Y%m%dT%H%M%SZ)}"
HOST="${FUSIONKIT_DEMO_HOST:-127.0.0.1}"
FUSION_PORT="${FUSIONKIT_DEMO_PORT:-8388}"
PORT_QWEN="${FUSIONKIT_QWEN_PORT:-8301}"
PORT_GEMMA="${FUSIONKIT_GEMMA_PORT:-8302}"
PORT_LLAMA="${FUSIONKIT_LLAMA_PORT:-8303}"
mkdir -p "$ART"
exec > >(tee -a "$ART/run.log") 2>&1

cd "$REPO_ROOT"
echo "artifact_dir=$ART"
date -u
hostname
sysctl hw.memsize hw.logicalcpu || true

autoinstall_mlx_env() {
  if [ ! -x "$VENV/bin/python" ]; then
    mkdir -p "$(dirname "$VENV")"
    uv venv --python 3.12 "$VENV"
  fi
  # transformers 5 pre-releases have broken mlx-lm chat server behavior. Keep this demo on <5.
  uv pip install --python "$VENV/bin/python" 'mlx-lm==0.29.1' 'transformers<5'
}

autoinstall_mlx_env
uv sync --all-packages
source "$VENV/bin/activate"
python - <<'PY'
import mlx_lm
import transformers
print('mlx_lm', mlx_lm.__version__)
print('transformers', transformers.__version__)
PY

for port in "$PORT_QWEN" "$PORT_GEMMA" "$PORT_LLAMA" "$FUSION_PORT"; do
  pids=$(lsof -ti tcp:"$port" || true)
  if [ -n "$pids" ]; then echo "killing stale port $port: $pids"; kill $pids 2>/dev/null || true; sleep 1; fi
done

GIT_SHA=$(git rev-parse HEAD)
echo "fusionkit_sha=$GIT_SHA"

cat > "$ART/models.local.yaml" <<YAML
endpoints:
  - id: qwen-judge
    provider: openai-compatible
    model: mlx-community/Qwen3-1.7B-4bit
    base_url: http://$HOST:$PORT_QWEN
    api_key: not-needed
    max_context: 32768
    estimated_memory_gb: 2.0
    timeout_s: 900.0
    capabilities: {structured_output: false, tool_calls: false, streaming: false}
    pricing: {input_per_1m_tokens: null, output_per_1m_tokens: null, currency: USD}
    tags: [local, qwen, judge, simple-mlx]
  - id: gemma-writer
    provider: openai-compatible
    model: mlx-community/gemma-3-1b-it-4bit
    base_url: http://$HOST:$PORT_GEMMA
    api_key: not-needed
    max_context: 8192
    estimated_memory_gb: 1.4
    timeout_s: 900.0
    capabilities: {structured_output: false, tool_calls: false, streaming: false}
    pricing: {input_per_1m_tokens: null, output_per_1m_tokens: null, currency: USD}
    tags: [local, gemma, writer, simple-mlx]
  - id: llama-planner
    provider: openai-compatible
    model: mlx-community/Llama-3.2-1B-Instruct-4bit
    base_url: http://$HOST:$PORT_LLAMA
    api_key: not-needed
    max_context: 8192
    estimated_memory_gb: 1.4
    timeout_s: 900.0
    capabilities: {structured_output: false, tool_calls: false, streaming: false}
    pricing: {input_per_1m_tokens: null, output_per_1m_tokens: null, currency: USD}
    tags: [local, llama, planner, simple-mlx]
default_model: qwen-judge
judge_model: qwen-judge
synthesizer_model: qwen-judge
default_mode: panel
sample_count: 2
self_temperatures: [0.2, 0.5]
panel_models: [qwen-judge, gemma-writer, llama-planner]
sampling: {temperature: 0.15, top_p: 0.9, max_tokens: 420}
budget:
  max_candidates: 4
  wall_clock_s: 1200
  max_cost: null
  max_tool_rounds: 0
  max_tool_calls: 0
YAML

PIDS=()
start_server() {
  local id="$1" model="$2" port="$3"
  echo "starting $id $model on $port"
  SIMPLE_MLX_MAX_TOKENS=460 python scripts/simple_mlx_openai_server.py --model "$model" --host "$HOST" --port "$port" > "$ART/simple-$id.log" 2>&1 &
  PIDS+=("$!")
}
cleanup() {
  echo "cleanup"
  [ -n "${FUSION_PID:-}" ] && kill "$FUSION_PID" 2>/dev/null || true
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

start_server qwen-judge mlx-community/Qwen3-1.7B-4bit "$PORT_QWEN"
start_server gemma-writer mlx-community/gemma-3-1b-it-4bit "$PORT_GEMMA"
start_server llama-planner mlx-community/Llama-3.2-1B-Instruct-4bit "$PORT_LLAMA"

python - <<PY
import sys, time, urllib.request
ports=[int('$PORT_QWEN'), int('$PORT_GEMMA'), int('$PORT_LLAMA')]
deadline=time.time()+1200
pending=set(ports)
while pending and time.time()<deadline:
    for port in list(pending):
        try:
            with urllib.request.urlopen(f'http://$HOST:{port}/v1/models', timeout=5) as r:
                print('ready', port, r.status, r.read().decode()[:300])
            pending.remove(port)
        except Exception as exc:
            print('waiting', port, repr(exc))
    if pending:
        time.sleep(10)
if pending:
    print('not_ready', sorted(pending))
    sys.exit(1)
PY

uv run fusionkit serve --config "$ART/models.local.yaml" --host "$HOST" --port "$FUSION_PORT" > "$ART/fusionkit-server.log" 2>&1 &
FUSION_PID=$!
python - <<PY
import sys, time, urllib.request
deadline=time.time()+120
while time.time()<deadline:
    try:
        with urllib.request.urlopen('http://$HOST:$FUSION_PORT/health', timeout=3) as r:
            print('fusionkit health', r.status, r.read().decode())
        sys.exit(0)
    except Exception as exc:
        print('waiting fusionkit', repr(exc))
        time.sleep(2)
sys.exit(1)
PY

GIT_SHA="$GIT_SHA" python - <<'PY' > "$ART/request.json"
import hashlib, json, os

messages = [
    {
        "role": "system",
        "content": "Write concise warehouse migration plans. Exactly 8 bullets. Each bullet starts with a bold label and includes concrete validation or rollback detail. No preamble.",
    },
    {
        "role": "user",
        "content": "Plan migrating analytics customer_id from integer to UUID in production. Include rollout, validation, risks, and rollback.",
    },
]
request = {
    "schema": "fusion-run-request.v1",
    "schema_version": "v1",
    "schema_bundle_hash": "sha256:3e8388595aefc8e82962d76e822c514db6552f6ee65e62d487534ef825ad87b8",
    "producer": "fusionkit-local-mlx-panel-demo",
    "producer_version": "0.1.0",
    "producer_git_sha": os.environ["GIT_SHA"],
    "created_at": "2026-06-17T03:10:00Z",
    "request_id": "fusion_req_local_mlx_panel_001",
    "mode": "panel",
    "messages": messages,
    "requested_models": ["qwen-judge", "gemma-writer", "llama-planner"],
    "sampling": {"temperature": 0.15, "top_p": 0.9, "max_tokens": 420},
    "sample_count": 2,
    "verify": False,
    "tool_policy": "disabled",
    "request_hash": "sha256:" + hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest(),
}
print(json.dumps(request, indent=2))
PY

curl -fsS "http://$HOST:$FUSION_PORT/v1/models" | tee "$ART/fusionkit-models.json"
for port in "$PORT_QWEN" "$PORT_GEMMA" "$PORT_LLAMA"; do curl -fsS "http://$HOST:$port/v1/models" > "$ART/simple-$port-models.json"; done
curl -fsS "http://$HOST:$FUSION_PORT/v1/fusion/runs" -H 'content-type: application/json' --data-binary @"$ART/request.json" | tee "$ART/run-response.json"
RUN_ID=$(ART="$ART" python - <<'PY'
import json, os
print(json.load(open(os.environ['ART'] + '/run-response.json'))['run_id'])
PY
)
echo "$RUN_ID" | tee "$ART/run_id.txt"
curl -fsS "http://$HOST:$FUSION_PORT/v1/fusion/runs/$RUN_ID" | tee "$ART/run-summary.json"
curl -fsS "http://$HOST:$FUSION_PORT/v1/fusion/runs/$RUN_ID/inspect" | tee "$ART/inspect.json"
curl -fsS "http://$HOST:$FUSION_PORT/v1/fusion/runs/$RUN_ID/events" | tee "$ART/events.json"

ART="$ART" python - <<'PY'
import json, os, pathlib, shutil, sys
art = pathlib.Path(os.environ['ART'])
inspect = json.load(open(art / 'inspect.json'))
events = json.load(open(art / 'events.json'))
run_id = inspect.get('run_id')
run_art = pathlib.Path('.fusionkit/runs') / run_id / 'artifacts'
if run_art.exists():
    shutil.copytree(run_art, art / 'fusionkit-artifacts', dirs_exist_ok=True)
summary = {
    'artifact_dir': str(art),
    'run_id': run_id,
    'state': inspect.get('state'),
    'status': inspect.get('status'),
    'candidate_count': len(inspect.get('candidates', [])),
    'candidate_model_ids': [c.get('model_id') for c in inspect.get('candidates', [])],
    'artifact_count': len(inspect.get('artifacts', [])),
    'model_call_count': len(inspect.get('model_call_ids', [])),
    'event_count': len(events.get('events', [])),
    'final_output': inspect.get('final_output') or '',
    'judge_synthesis_record_present': inspect.get('judge_synthesis_record') is not None,
    'judge_parse_status': (((inspect.get('judge_synthesis_record') or {}).get('metrics') or {}).get('judge_structured_parse_status')),
    'producer_git_sha': json.load(open(art / 'request.json')).get('producer_git_sha'),
}
(art / 'summary.json').write_text(json.dumps(summary, indent=2))
(art / 'DEMO.md').write_text(
    '# FusionKit local MLX panel demo\n\n'
    f"Status: {summary['status']}  \n"
    f"Run: `{run_id}`  \n"
    f"Artifact dir: `{art}`  \n"
    f"FusionKit SHA: `{summary['producer_git_sha']}`\n\n"
    '## What ran\n\n'
    '- Apple Silicon local MLX via `scripts/simple_mlx_openai_server.py`\n'
    '- FusionKit `/v1/fusion/runs` in `panel` mode\n'
    f"- Models: {', '.join(summary['candidate_model_ids'])}\n"
    f"- Events: {summary['event_count']}\n"
    f"- Candidates: {summary['candidate_count']}\n"
    f"- Artifacts: {summary['artifact_count']}\n"
    f"- Judge structured parse: {summary['judge_parse_status']}\n\n"
    '## Final output\n\n'
    + summary['final_output']
    + '\n'
)
print(json.dumps(summary, indent=2))
if summary['status'] != 'succeeded':
    sys.exit(1)
PY

echo "DONE artifact_dir=$ART"
