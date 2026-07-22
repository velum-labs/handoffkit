# Fusion Stabilization — Living Document

> **Internal - not product documentation:** Design archive for maintainers; do not treat this as current user-facing product guidance.


> **Status: living.** This document tracks the stabilization of the current fusion
> implementation *before* the full refactor toward `FUSION_ARCHITECTURE_V2.md`.
> Update it as facts change; every substantive edit should touch the change log
> at the bottom. The architecture doc says where we are going; this doc says
> what exists, what is fragile, and what must be true before we start moving.
>
> Last updated: 2026-07-04

## 1. Current state (as-built)

The shipped mechanism is the **defect-5 form** named in V2 §10: unconditional
per-turn trajectory fanout. Every user turn, each panel member produces a full
trajectory and the judge emits the one the user's tool executes (see the
"judge-streamed-trajectory front door" in `packages/cli/src/fusion/stack.ts`,
`startFusionStack`).

Structurally, the branch substrate is already a **process-level fork with
protocol-level interposition** — a hybrid of the two substrates described in §3:

- **Process fork**: each panel member is a real headless Codex
  (`codex exec --json --skip-git-repo-check -`, prompt via stdin), sovereign over
  its own loop, in its own worktree, with an ephemeral `CODEX_HOME`, generated
  `config.toml`, allowlisted child env, and the CLI auth store symlinked (never
  copied). All in `packages/tool-codex/src/harness.ts`.
- **Protocol interposition**: each instance's model traffic routes through a
  per-member in-process capture gateway (`runProvider` -> `startGateway` with
  `onModelCall` / `onModelCallRaw` provenance sinks). The member's native
  trajectory is reconstructed from captured wire traffic
  (`createTrajectoryCapture`), **not** parsed from transcripts. The stdout event
  stream is used only for end-reason attribution (`codexEndReason`).

Supporting stack (`packages/cli/src/fusion/stack.ts`):

- One `fusionkit serve` router fronts every panel model (routing by namespaced model ID)
  plus judge/synthesis; discover-or-spawn with identity token for warm reuse.
- MLX members get in-process loopback gateways; cloud members call providers
  directly. Narration writer, budget caps (WS7), rate-limit failover (WS5),
  durable sessions (WS4) hang off the same gateway.
- Sub-agents inside members: pinned multi-agent config, per-release model
  catalog template (`readCodexCatalogTemplate`), fused sub-agent access routed
  back to the front door with a panel-depth header.

### Known fragilities (stabilization targets)

| # | Fragility | Where | Notes |
| - | --------- | ----- | ----- |
| F-1 | End-reason derived from heuristic event-stream scan (`turn.completed` / legacy `task_complete`) | `tool-codex/src/harness.ts` `codexEndReason` | Vendor event names drift per release |
| F-2 | Permanent-failure detection is a regex over logs (`looksPermanentFailure`) | `cli/src/fusion/stack.ts` | Marked TODO in-code: replace with structured provider-error classification |
| F-3 | Codex model-catalog schema varies per release; absence silently disables sub-agents | `tool-codex/src/launch.ts` / `harness.ts` | Graceful, but coverage should be asserted in CI per pinned Codex version |
| F-4 | `shell_command` capability marked `degraded` with an unresolved TODO | `tool-codex/src/harness.ts` `capabilities()` | Needs a documented source of truth |
| F-5 | Unconditional fanout: every turn pays full panel + judge | gateway (`startFusionStepGateway`) | The V2 gate/F6 re-scoping is the fix; until then cost/latency exposure is maximal |
| F-6 | Judge consumes prose-truncated candidates (defect-5 join) | gateway | V2 Inv. 8 requires full structured patches + transcripts at the join |

## 2. Target delta (summary of V2, post gate-merge)

Where the refactor is headed — recorded here so stabilization work is aimed:

- **Gate is binary**: `GATE -> leader_only | deliberate` (V2 §8.1). Fleet
  dispatch is **not** a gate outcome.
- **F6 escalation**: within a deliberate step, observed *plan-level* divergence
  plus the §10.4 admission conditions (`dispersed`, `autonomous`, `verifiable`,
  `separable`, `worth it`) escalates to fleet dispatch. Escalation ladder:
  leader -> panel -> fleet, each rung paid for by evidence from the rung below,
  never bought on a forecast.
- **Join is selection-first** on each branch's own execution evidence; the
  winner's patch re-enters the parent session as ordinary tool calls.
- Step fusion (shadow panel, Hedge weights, probes) replaces per-turn
  trajectory fanout as the resident default.

## 3. Branch substrates (decision record)

Two legitimate implementations of the F6 fork operator, with a
fidelity/portability trade:

| | Process fork (current, premium) | Protocol fork (planned fallback) |
| --- | --- | --- |
| Loop owner per branch | vendor harness (sovereign) | FusionKit (R2 machinery) |
| Works with | spawnable harnesses only (Codex today) | any harness pointing at the endpoint |
| Tool semantics | inherited, always current | emulated core set; drift risk |
| Evidence | the user's real tool's own runs | FusionKit sandbox runs |
| Needs | per-vendor headless integration | local workspace access + executor |
| Observability | capture gateway (wire-level), already built | native (FusionKit is the loop) |

**Decision**: keep process fork as the default substrate; spec protocol fork as
the universal fallback. Both plug into the same F6 admission and the same
evidence-based join, so substrate fidelity affects candidate quality, never
decision soundness.

Key constraint for protocol fork: prompts and tool *schemas* travel in every
request (free); tool *semantics* and the *loop* do not (must be re-implemented —
this is R2's executor + stopping machinery wearing the harness's interface).
Branches must only ever touch clones, never the user's live workspace.

## 4. De-risking playbook

1. **Capture corpus as ground truth.** Every vendor-loop run already records
   full wire traffic (`ModelCallRecordV1`, `CapturedTrajectory`). Treat it as a
   corpus: record/replay differential tests validate any impersonated loop
   against what the real harness actually did. Never guess semantics.
2. **Bound the semantics surface.** Emulate the core tool set (shell/read/edit)
   only. Any branch calling an unemulatable tool (harness sub-agents,
   user-interaction tools) is **detected and parked** (same shape as V2 §10.5
   parked instances). Coverage becomes a metric, not a correctness cliff.
3. **Versioned adapters, degrade-not-fail.** Already the house style
   (catalog-template probing, dual end-reason event names). Extend: pin a Codex
   version in CI, assert capability coverage per release, degrade loudly.
4. **Substrate-agnostic join.** Selection strictly on executed evidence (branch's
   own test runs), so vendor-loop and impersonated branches are equally
   admissible and fidelity gaps cost candidate quality only.
5. **F6 gating is the biggest de-risk.** Escalation-only dispatch shrinks
   exposure by orders of magnitude vs today's per-turn fanout. Most protocol-fork
   risk scales with dispatch frequency.

## 5. Stabilization checklist (pre-refactor)

Do these while the current shape is still in place, so the refactor lands on
measured, regression-guarded ground. Roughly ordered.

- [ ] **Baseline benchmark before touching anything**: paired session-level run
      (harness + fusion vs harness + best member) on the current unconditional
      fanout. This is the number the refactor must not regress and V2 §13's
      falsifier needs a "before" anyway.
- [ ] **Lock the capture format**: treat `ModelCallRecordV1` /
      `CapturedTrajectory` as a versioned contract (schema test). The de-risking
      playbook depends on this corpus being stable and replayable.
- [ ] **Golden-task fidelity suite**: a small set of tasks run through the
      vendor-loop substrate with capture on, committed as replay fixtures; CI
      replays and diffs loop decisions + tool results. (Foundation for the
      protocol-fork differential tests later.)
- [ ] **F-1**: replace `codexEndReason` heuristics with a versioned event-schema
      adapter (pin the Codex release in CI; fail loudly on unknown stream shape).
- [ ] **F-2**: replace `looksPermanentFailure` regex with structured
      provider-error classification (in-code TODO already points at
      `classify_provider_error` / `ProviderCallError`).
- [ ] **F-3**: CI assertion that the pinned Codex version yields a usable catalog
      template (sub-agents silently off is acceptable at runtime, invisible in CI
      is not).
- [ ] **F-4**: resolve or document the `shell_command: "degraded"` capability;
      adapter capability metadata becomes the source of truth.
- [ ] **Straggler/abort/timeout paths under test**: abort-signal propagation,
      `straggler_abandoned` attribution, and worktree cleanup on every end-reason
      kind.
- [ ] **Join evidence audit (F-6 prep)**: verify what the judge actually receives
      today per candidate (prose vs structured patch + transcript) and record the
      gap against V2 Inv. 8.
- [ ] **Cost/latency telemetry per turn**: per-member spend, judge spend, wall
      clock — the data the future gate's `worth it` and posture thresholds will
      be tuned from (V2 §12).

Exit criterion: baseline benchmark recorded, capture contract locked, fidelity
suite green in CI, F-1..F-4 closed or explicitly waived. Then the refactor
(binary gate, step fusion, F6 re-scoping) starts.

## 6. Change log

- **2026-07-04** — Initial version. Captured as-built state (defect-5 fanout on a
  process-fork + capture-gateway substrate), the substrate decision record, the
  de-risking playbook, and the pre-refactor stabilization checklist. Context: the
  V2 gate merge (binary gate, F6 escalation) landed in
  `FUSION_ARCHITECTURE_V2.md` the same day.
