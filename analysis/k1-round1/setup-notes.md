# Round-1 setup validation record (2026-07-07)

Everything below was verified on the Cloud VM before freezing the
preregistration; no task from the frozen manifest was run.

## Environment

- Docker 29.6.1 via the AGENTS.md Firecracker workarounds (fuse-overlayfs
  storage driver, containerd-snapshotter off, iptables-legacy, manual
  `dockerd`). `hello-world` container OK. Note: `dockerd` must be restarted
  each session — `scripts/setup_env.sh` handles it.
- Harness: `terminal-bench` (`tb`) installed via `uv tool install`.
- Round-2 tooling preinstalled: `mini-swe-agent` 2.4.5 (native tool-calling
  scaffold), `sb-cli` (reinstalled `--with typing_extensions` to fix a
  packaging bug). `sb-cli` needs `SWEBENCH_API_KEY` (free signup) before
  round 2 cloud grading — not required for round 1.

## Harness validation (zero model calls)

- `tb run --agent oracle --dataset terminal-bench-core==0.1.1 --task-id
  hello-world` → 1/1 resolved. Validates Docker + dataset + grading
  end-to-end without any LLM.

## Fused endpoint validation (billed, ~cents; outside the frozen manifest)

- `fusionkit serve -c config/panel.yaml` boots; `/v1/models` lists
  `fusionkit/panel` plus passthrough ids.
- Tools smoke: a `tools`-carrying chat request to `fusionkit/panel`
  returned `finish_reason=tool_calls` with a single well-formed
  `run_command` call — the step-mode fuse path (tools present) works.
- Text smoke: a terminus-2-style JSON-protocol prompt returned valid
  parseable JSON with a `commands` batch — the tools-absent per-step path
  works.
- Integration smoke: `tb run --agent terminus-2 --model
  openai/fusionkit/panel --agent-kwarg api_base=http://127.0.0.1:8080/v1
  --task-id hello-world` → **1/1 resolved (100%)** through the fused N=2
  panel. `hello-world` is not in the frozen 12-task manifest, so the round-1
  slice is uncontaminated.

## Known quirks recorded for the run

- The server does not return `usage` token counts on the text path
  (returned `None` in the text smoke); cost accounting therefore uses the
  OpenRouter activity export, not harness-side usage fields.
- `terminus-2` is text-protocol (no `tools` field): round 1 exercises the
  tools-absent per-step fuse. The step-prompt arm is round 2's job
  (mini-SWE-agent v2 uses native tool calling).
