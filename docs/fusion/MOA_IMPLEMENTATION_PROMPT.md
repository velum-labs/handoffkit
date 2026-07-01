# Cloud Agent Prompt: Implement FusionKit MoA Runtime Kernel

> Status note: this was the implementation prompt that started the runtime-kernel work.
> For current implementation status, use `docs/fusion/MOA_IMPLEMENTATION_STATUS.md`.
> For developer-facing docs, use `docs/fusion/runtime-kernel.md` and
> `docs/fusion/runtime-recipes.md`.

You are working in the `handoffkit` repository. FusionKit has been merged into this repo, so do not
work in the old standalone `fusionkit` checkout.

## Goal

Implement the first production-grade slice of the FusionKit model-fusion architecture described in:

- `docs/fusion/MOA_DESIGN.md`

The design's core idea is:

> FusionKit is a model-fusion runtime kernel for executing typed operator graphs under
> interchangeable schedulers. Do not build one monolithic MoA controller. Build a small runtime
> substrate with typed artifacts, operators, graphs, schedulers, budgets, traces, and outcomes.

## Important Context

This design went through several iterations. The final direction is **not** "everything is a
controller loop" and **not** "verification is the root abstraction." The final direction is:

```text
TaskSpec
  -> Artifact contracts
  -> Operators
  -> OperatorGraph / WorkflowSpec
  -> Scheduler family
  -> RuntimeState (only when needed)
  -> Evidence / Signals
  -> Budget / Trace / OutcomeRecord
```

This should be able to express, without special-casing:

- direct single-model calls,
- classic MoA,
- Self-MoA,
- OpenRouter-style panel -> judge -> synth,
- LLM-Blender-style rank -> fuse,
- execution-guided selection/repair,
- Devin-style main/sidekick routing with single-writer discipline,
- Sakana TreeQuest / AB-MCTS-style wider-vs-deeper search,
- Fugu/TRINITY/Conductor-style learned orchestration later,
- Archon-style offline architecture search later,
- offline model merge as a separate lifecycle.

## Existing Work / Empirical Constraints

Previous local experiments established:

- Blind judge-fusion can regress. On a polyglot coding suite, fused output trailed the best single
  model.
- Execution-guided selection can win. On LiveCodeBench, public-test selection with private grading
  produced fused pass@1 0.593 vs 0.477 for each individual model, McNemar 10-0 significant.
- Therefore, the architecture must treat evidence and success metrics carefully:
  - public signals can guide runtime selection;
  - private/held-out signals grade only;
  - evidence is not the same as success;
  - verifiers are evidence sources, not the whole system.

## Implementation Principles

1. **Keep the runtime kernel boring.** It should execute typed operators, manage artifacts, enforce
   budgets, record traces, and emit outcomes.
2. **Schedulers are where behavior lives.** Static DAG, best-of-N, fixed MoA, adaptive routing, and
   tree search should be scheduler families, not branches inside a god object.
3. **Degree-1 must be fast.** A direct model call path must not pay hidden fanout, judge, synth, or
   verifier overhead.
4. **Artifacts are immutable and typed.** Every operator consumes artifact IDs and emits artifact IDs.
5. **Operators declare side effects.** Agentic/coding paths must preserve single-writer discipline.
6. **Evidence carries leakage metadata.** Private grading data must never enter runtime scheduler
   state.
7. **OutcomeRecords are required.** Learned coordination is out of scope until we have clean replayable
   outcome data.

## Suggested First Slice

Implement the minimal substrate, not the full SOTA stack:

1. Define core types:
   - `Artifact`
   - `OperatorSpec`
   - `Operator`
   - `OperatorGraph`
   - `Scheduler`
   - `BudgetPolicy`
   - `TraceEvent` / provenance payload
   - `OutcomeRecord`

2. Implement two scheduler families:
   - `DirectFastPathScheduler`
   - `StaticDAGScheduler`

3. Implement enough operators to express current FusionKit/OpenRouter-style fusion:
   - `ModelGenerateOperator`
   - `PanelGenerateOperator`
   - `JudgeCompareOperator`
   - `SynthesizeOperator`

4. Add tests proving the abstraction can express:
   - direct single-model call,
   - panel -> judge -> synth,
   - no hidden work in degree-1 mode,
   - artifact lineage is recorded,
   - budgets are enforced.

5. Do not implement learned coordination, AB-MCTS, or execution-guided repair in this first slice.
   Those come after the kernel and scheduler boundaries are solid.

## Files To Inspect First

Start by reading:

- `docs/fusion/MOA_DESIGN.md`
- `packages/ensemble/src/unified.ts`
- `packages/ensemble/src/harness.ts`
- `packages/model-gateway/src/fusion-backend.ts`
- `packages/cli/src/gateway.ts`
- `packages/cli/src/fusion/stack.ts`

The repo currently has existing ensemble/gateway abstractions. Prefer integrating with those rather
than inventing a parallel runtime if they already supply the right boundary.

## Output Expectations

When done, provide:

- summary of new abstractions,
- how existing fusion flows map to them,
- tests run,
- any deferred work,
- risks or design tensions discovered.

Keep the implementation focused and reviewable. Avoid sweeping rewrites unless the existing boundary
is actively blocking the kernel abstraction.
