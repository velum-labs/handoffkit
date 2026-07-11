# Driver topology: deliberation-stage synthesis — formal specification

**Status:** design specification, 2026-07. Derived from the k=1
official-harness program's measurements (`analysis/k1-swebench/`), the
ensemble literature (`ensemble-literature-review-2026-07.md`), and the
production-system convergence (OpenRouter Fusion, Devin Fusion, Sakana
Fugu). Not yet implemented.

## 1. Setting and notation

A tool-using agent task proceeds in discrete steps. At step *t*:

- `H_t` — the shared committed history: task text, committed steps
  `s_1 … s_{t-1}`, and their execution observations `o_1 … o_{t-1}`.
  There is exactly one `H_t` (one real workspace). This is the k=1 regime.
- `M = {m_1, …, m_N}` — the panel; one designated **driver** `d ∈ M`, the
  remaining `A = M \ {d}` are **advisors**.
- `T` — the harness tool set. `J` — the judge (need not be in `M`).
- A **step** `s = (r, c)` is a reasoning span `r` plus a **commit payload**
  `c`, where `c` is either a tool-call batch `[τ_1..τ_k]` (an *act* step)
  or a final text answer (an *answer* step). The harness executes `c`
  verbatim; `r` is never executed.

## 2. The core distinction: two joints

Fusion can combine model outputs at exactly two joints in a step:

- **Deliberation joint** (before `c` is produced): information from
  advisors is placed into the context from which a step is *generated*.
- **Commit joint** (when `c` becomes the executed action): a chosen or
  constructed payload is emitted to the harness.

**Invariant D (deliberation-only synthesis).**
Cross-model *combination* occurs only at the deliberation joint. The commit
joint performs only *copy* — it emits some single author's `c` unmodified.

Rationale, made precise below: a commit payload is an executable object
whose sub-parts carry dependencies on the generating context
(`τ_i` references state its author observed). Combination = choosing a
subset/spY of `{c}` across authors and concatenating. For prose, the
concatenation operator is closed under validity (a merged paragraph is a
valid paragraph). For an executable batch it is **not**: a splice of
`τ_i^{(A)}` and `τ_j^{(B)}` is a batch no author validated and, mid-flight,
no oracle can validate (AgentProcessBench: step-fragment correctness is not
reliably judgeable). So combination is safe at the deliberation joint
(a model re-derives a coherent `c` from advice) and unsafe at the commit
joint (mechanical splice). Invariant D is exactly this.

## 3. The step function

Let `propose(m, H_t)` → `(r_m, c_m)` be a single model completion, and
`analyze(J, H_t, {c_m})` → `α_t` the judge analysis (structured:
consensus, contradictions, unique_insights, coverage_gaps, likely_errors,
best_author). Define the driver-topology step:

```
DRIVER-STEP(H_t):
  1. Advisor proposals:     P_t = { propose(a, H_t) : a ∈ A }          # parallel
  2. Judge analysis:        α_t = analyze(J, H_t, {c_a : a ∈ A})       # compares, no merge
  3. Driver step:           (r_d, c_d) = propose(d, H_t ⊕ advice(P_t, α_t))
  4. Commit:                return c_d                                  # verbatim, copy only
```

where `advice(P_t, α_t)` renders advisor proposals and the judge analysis
as **read-only context** appended to the driver's input (⊕), never as a
payload. Step 3 is an ordinary generation call: the driver writes its own
`c_d`, conditioned on advice, and `c_d` is committed unmodified (Invariant
D holds — the only payload emitted is a single author's).

### 2-arg specialization (this program's panel)

`d = terminus`, `A = {qwen3}`, `J = terminus`. Each step: qwen3 proposes,
terminus's judge analysis compares terminus's own draft vs qwen3's,
terminus writes the committed step with qwen3's proposal + the analysis in
context. Floor: with empty/ignored advice, `c_d` = terminus's solo step, so
the trajectory's floor is the driver's solo path (§6).

## 4. Relation to prior topologies (all special cases)

The step function subsumes what we have been running as parameter settings:

| topology | how DRIVER-STEP degenerates to it |
|---|---|
| **solo** | `A = ∅`, no judge; `c_d` is the driver alone |
| **select-commit** | driver does not generate at step 3; commit = `c_{α_t.best_author}` verbatim (copy of the *winner*, still Invariant-D-safe) |
| **synthesize-commit** (our current engine, refuted) | step 3's author is a *synthesizer* whose payload may splice `{c_m}` → **violates Invariant D** |
| **driver topology** (this spec) | as written above |
| **MoA aggregator** | `advice` = all proposals; step-3 author generates fresh output conditioned on them — MoA layers are `propose(m, H ⊕ others' outputs)`, i.e. Invariant D already holds in MoA; only our synthesize-commit added the unsafe splice |
| **OpenRouter Fusion** | `A` = panel, `J` compares-not-merges, outer model = driver writing from `α_t` — DRIVER-STEP with a single (answer) step and a trigger gate (§5) |

The key formal observation: **MoA and OpenRouter never splice payloads.**
Their "aggregator"/"outer model" is a *generator conditioned on candidate
context* — the deliberation joint. FusionKit's synthesize-commit path was
the anomaly: it put combination at the commit joint. Invariant D restores
alignment with both the literature and production systems.

## 5. Selectivity (orthogonal gate)

`advice`/`analyze` are expensive (N-1 proposals + a judge call per step).
Define a trigger predicate `g(H_t) ∈ {deliberate, passthrough}`. When
`g = passthrough`, DRIVER-STEP reduces to `propose(d, H_t)` (solo step, one
call). Candidate triggers, in priority order: step writes code / mutates
repo; advisor–driver disagreement above threshold; driver error streak;
pre-submission. Selectivity changes cost, not the invariant.

## 6. Guarantees

Under Invariant D and DRIVER-STEP:

- **G1 (single-author commits).** Every committed `c` was produced and
  self-validated by one model in one generation. No unauthored splices.
- **G2 (driver floor).** If advice is ignorable (empty `A`, or driver
  disregards it), the committed trajectory equals the driver's solo
  trajectory. Fusion cannot perform *below* the driver by construction —
  deviations occur only where the driver, seeing advice, chose to deviate.
  (Contrast: our synthesize-commit path had no floor — it lost 2/20
  best-driver solves in 2A' precisely by committing non-driver payloads.)
- **G3 (insight admission).** Any advisor insight can enter the trajectory,
  but only by passing through the driver's coherent re-derivation (step 3)
  or by whole-step selection — never as a spliced fragment. This is the
  formal answer to "what if an advisor saw something the others didn't":
  it is admitted at the deliberation joint, conditioned on full context,
  and the resulting committed step is still single-author.
- **G4 (answer exception).** For *answer* steps (terminal text), the commit
  payload is prose, for which concatenation is validity-closed; synthesis
  at the commit joint is therefore permitted (`answer: synthesize`). G1–G3
  constrain *act* steps only. This is why the safe default is
  `act: driver/select, answer: synthesize`.

## 7. What this predicts (falsifiable)

On the standing 30-instance apparatus, driver topology vs. our
synthesize-commit baseline should: (a) eliminate below-driver losses
(G2) → best-member-loss rate → ~0 except driver-chosen deviations;
(b) retain any genuine advisor contribution via G3. Net effect is bounded
below by driver-solo. It does **not** predict beating the driver — that
requires the advisor to carry admissible insight the driver will act on;
G3 makes that measurable in isolation for the first time (commit noise
removed from both arms).

## 8. Non-goals

- Not a claim that fusion beats the best single model; a claim about *where
  combination is safe*, which makes the beat-or-not question cleanly
  testable.
- Not model merging, not training-time anything. Runtime orchestration.
- Selectivity (§5), asymmetric delegation (Devin-style sidekick), and
  learned drivers (Fugu-style) are compatible extensions, specified
  elsewhere.
