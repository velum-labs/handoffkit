# Judge autopsy preregistration (round 2B)

Frozen before the billed rerun. Scope: diagnosis only — no hill-climb
claims will be made from these three instances (they are the dev set).

## Question

At the commits that decided round 1's two losses and one fused-only win,
was the judge (a) choosing between materially different proposals, and
(b) near-tied or confident? What evidence did it see and what did it cite?

## Method

- Instances: `pylint-dev__pylint-7080`, `astropy__astropy-14508` (round-1
  losses), `django__django-12125` (round-1 fused-only win). Reruns are
  fresh rolls (members at temperature 0.2); outcomes may differ from
  round 1 — recorded either way, and the autopsy analyzes the rerun's own
  commits.
- Capture: a logging reverse proxy (`scripts/logging_proxy.py`) between
  `fusionkit serve` and OpenRouter records every provider call verbatim
  (member fanout requests/responses, judge request with packed candidates
  + raw analysis response, synthesizer commits). No engine or scaffold
  changes; the panel config's `base_url` points at the proxy.
  (The OTLP tracing path was tried first and found dead for
  `/v1/chat/completions` — that route never constructs a trace context;
  recorded as an upstream gap.)
- Runner: same mini-SWE-agent v2 stock config, `-w 1` (sequential, for
  clean call attribution), fresh output dir; graded by the official
  harness.
- Analysis (`scripts/analyze_autopsy.py`): reconstruct per-step records
  (member proposals, judge verdict + analysis fields, committed batch);
  identify the decisive divergence steps; classify each as
  agreement (members proposed equivalent steps), near-tie, or confident
  selection, using the judge's own analysis text and the proposal diff.

## Spend

Cap $5 for the rerun (expected ~$0.50-1.50). Same $25 arm budget.
