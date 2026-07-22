# SWE-bench arm setup validation record (2026-07-07)

Everything below was verified before freezing the preregistration; the only
billed work was one smoke instance, `astropy__astropy-12907`, which is
excluded from the frozen manifest by construction.

## Why this is the primary arm

mini-SWE-agent v2 sends native tool calls (`tools=[BASH_TOOL]` on every
request — verified in `minisweagent/models/litellm_model.py`), so the fused
endpoint takes the engine's step-mode path with the **product's built-in
step prompts**: no prompt pinning, no adaptation. This is the direct
measurement of the shipped k=1 fusion unit; the Terminal-Bench arm keeps
text-protocol robustness coverage.

## Environment

- Scaffold: mini-SWE-agent 2.4.5 (`mini-extra swebench`, stock
  `swebench.yaml`, `environment_class: docker`).
- Grading: official SWE-bench harness installed in a dedicated venv
  (`~/.venvs/swebench`); runs locally over Docker, no API key needed
  (sb-cli/cloud grading not required).
- Dataset enumerated from HF (`princeton-nlp/SWE-bench_Verified`, 500
  instances, sorted-id SHA-256
  `fad0fdea4fc2315e9b78cdf80882a32e32393297052e502e0e63c79ad648fb85`);
  10-instance manifest drawn with seed 42.
- Disk: 234G free before smoke; per-instance images are ~GB-scale.

## The CWD prompt-file gotcha (verified empirically)

`load_config` on this arm's `panel.yaml` from the **repo root** binds the
committed `.fusionkit/prompts/*.md` (trajectory prompts) into the config —
which would silently replace the built-in step prompts under test. Loading
the identical file with cwd=`/tmp` leaves both override fields `None`
(built-ins apply). The runner therefore serves from `/tmp` via
`uv run --project`; verified both behaviors programmatically.

## End-to-end billed smoke (excluded instance, step_limit=25)

- `mini-extra swebench --filter '^astropy__astropy-12907$' -m
  openai/fusionkit/panel -c swebench.yaml -c
  model.model_kwargs.api_base=http://127.0.0.1:8080/v1` against the fused
  N=2 panel served from `/tmp`:
  instance **submitted** with a 504-byte patch in ~3m22s.
- Official harness grading (`swebench.harness.run_evaluation`, local
  Docker): **1 submitted, 1 completed, 1 resolved, 0 errors** — the fused
  ensemble solved the instance through the product step path, and the
  grading loop closes end-to-end.

## Known quirks recorded for the run

- litellm cannot price `fusionkit/panel`: fused row runs with
  `MSWEA_COST_TRACKING=ignore_errors`, so mini's $3/instance cost_limit is
  inert for the fused row (live for solo rows). Recorded in the
  preregistration; spend is accounted from the OpenRouter activity export.
- The smoke used `agent.step_limit=25` to bound smoke cost; the real runs
  use the stock limit (250) per the preregistration.
