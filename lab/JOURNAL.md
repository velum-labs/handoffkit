# Experiment Journal

## 2026-07-15 — alen (via agent)
Deep e2e audit found the dominant flaw: shared max_tokens=16384 truncated
reasoning models to EMPTY code on most shards (r1 72%, kimi26 68%, glm52 61%,
kimikt 59%, nemotron3s 52%, dsv4pro 40%, qwen3t 28% — finish_reason=length).
e002's open floor + complementarity matrix are invalid for those seven; e003's
pair kernels inherited a crippled r1 partner, so only its self-diversity
no-gain finding stands. Still valid: q37max~GPT-5.5 parity (both untruncated).
Any re-screen must use registry per-endpoint budgets (32k/64k) and adapter v2.
The thinking-32k report had already flagged kimi truncation — check priors.

## 2026-07-15 — alen (via agent)
Grading audit after e003's suspicious zero-headroom result: the 8 s wall clock
undercut the 12 s CPU rlimit (environment-sensitive TLE of correct code), and
12 manifest instances are exact-match-unfair special-judge problems. A
zero-spend 30 s re-grade flipped only 10/478 unresolved shards, symmetrically:
e002 parity and e003 no-headroom conclusions both survive. Adapter v2 (30 s
wall, parallel sample draws, version bump) ships with
manifests/special_judge_exclusions.txt — use both for all future sweeps;
v1/v2 shard results must not be mixed in paired tests.

## 2026-07-15 — alen (via agent)
e003 analyzed at ~$22: every kernel (exec-select, repair, self-MoA,
judge-select, judge-synth on q37+r1) reproduced solo qwen3.7-max's exact pass
pattern — zero discordant wins at rung 25, all p=1.0. Fusion has no headroom
on the >=2024-08 dev slice; solo failures are capability-hard, not variance.
Do not spend on compound search here. Remaining honest final: holdout parity
validation (solo q37max vs anchors) from the reserve, or re-scope the slice.

## 2026-07-13 — alen (via agent)
e002 analyzed at $52.40: qwen3.7-max reached GPT-5.5 parity on the dev slice
(73.6% vs 73.3%, McNemar p=1.0), so the <2pp saturation rule fired. The
fusion question moves to multi-sample kernels on qwen3.7-max (r1 is the only
complementary partner worth pairing); panel breadth over the weaker solos is
dead. Anchor results are frozen in the e002 store — do not re-bill.

## 2026-07-13 — alen (via agent)
e001 abandoned after environment restart at $5.10. AWS Batch and tailnet
observability are now validated; e002 should re-run the anchor/open solo screen
under the lab process before kernel work.
