# Incomplete work inventory

Consolidated list of work that is **not yet implemented**, **partially integrated**,
**stubbed**, **deferred**, or **planned** across the handoffkit monorepo. Use this
alongside:

- `docs/fusion/kernel-migration.md` — kernel cutover phases and parity checklist
- `docs/fusion/MOA_IMPLEMENTATION_STATUS.md` — what the runtime kernel already ships
- `docs/planning/ensemble-product-plan.md` — product gap-closing workstreams
- `docs/fusion/FUSION_VALUE_RUBRIC.md` — production gates and measurement criteria
- `docs/scope.md` — product vs governance package boundaries

**Last reviewed:** 2026-07-02. Some source documents (especially
`legacy/docs/production-readiness-audit-2026-06.md` and
`docs/planning/ensemble-product-plan.md`, dated 2026-06) are
partially stale where kernel migration, durable sessions, pre-stream failover, and
kernel-native streaming have landed since they were written.

---

## 1. Kernel migration (remaining phases)

`docs/fusion/kernel-migration.md` marks Phases 0–2 as done (the fusion front-door is
kernel-native). Still open:

| Item | Status |
| --- | --- |
| **Phase 3** — Decompose `runEnsemble` into a native `ensemble-run` workflow (today: `legacy-ensemble-run` + `LegacyRunEnsembleOperator`) | Wrapper only |
| **Phase 4** — `fusionkit local` on native `direct-model-turn` (today: kernel-wrapped via `KernelBackend`) | Partially integrated |
| **Phase 5** — Python synthesis only via `python-fusion-legacy-step` operator (today: shared `createKernelFuseStepRunner`, but Python remains the implementation) | Compatibility path |
| **Phase 6** — TS-native fusion orchestration; port or replace Python `FusionEngine` | Not started |
| **Phase 7** — Real adaptive schedulers (execution-guided select/repair, tree search, learned routing, offline architecture search) | Scaffold only |
| **`tool-continuation-turn` workflow** — same turn, cached candidates, new judge/synth with tool results | Specified, not a named workflow |
| **`native-passthrough-turn` / `panel-capture-turn` / `trajectory-fuse-step`** as first-class workflow IDs (vs legacy aliases) | Legacy wrappers exist |
| **Parity differential tests** — 14 scenarios in the migration doc (mock turns, failover, tool continuation, session resume, streaming contracts) | Checklist, not fully built |
| **Python `/v1/chat/completions` and `/v1/fusion/runs`** — still behind Python `FusionKernel` compatibility wrapper | Kernel-wrapped, not TS-native |
| **Node protocol adapters** (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`) — execution only for fused panel capture, not full backend-via-workflow | Partial |

---

## 2. Runtime kernel — scaffolds vs real behavior

From `docs/fusion/MOA_IMPLEMENTATION_STATUS.md`:

- **Advanced scheduler families** (`AdaptiveRouterScheduler`, `TreeSearchScheduler`,
  `AgenticDelegationScheduler`, `LearnedWorkflowScheduler`,
  `OfflineArchitectureSearchScheduler`) — validate and run static graphs only; no
  AB-MCTS/TreeQuest-style search, Devin-style routing, or learned coordination.
- **Learned-policy training, off-policy optimization** — explicitly out of kernel by
  design; no consumer of `OutcomeRecord` / replay streams yet.
- **Streaming replay** — live `text/event-stream` responses captured at envelope level
  only (documented inherent limitation).
- **Local / MLX harness leaf gateways** — enter kernel through `KernelBackend`
  compatibility wrapper, not kernel-native.

---

## 3. Product gaps (`docs/planning/ensemble-product-plan.md`)

Many items remain accurate; some have progressed (sessions, pre-stream failover,
kernel streaming, `openai-compatible` panel provider).

### Still open or partial

| Area | Gap |
| --- | --- |
| **Tool calling through fusion (gateway path)** | Python server supports tools on `/v1/fusion/...`; in-process **executor mode** returns `executor_not_implemented` (`run.py`); full harness ↔ ensemble tool loop on the default `fusionkit codex` path is not proven end-to-end |
| **Mid-stream rate-limit cutover** | Pre-stream failover exists (`frontdoor.vendor-proxy`); mid-stream splice / resume per dialect still hard |
| **Cursor upstream failover** | Deferred in `packages/tool-cursor/src/acp.ts` / bridge paths — Cursor `api2.cursor.sh` errors collapse to `http_error`; bridge ends with "local model failed" |
| **vLLM / TGI local backend** | Explicitly deferred (`packages/cli/src/fusion/platform.ts`); MLX Apple Silicon only for local panels |
| **Config unification** | Node `.fusionkit/fusion.json` vs Python YAML — bridge exists, single source of truth not finished |
| **Python `doctor` / `init` parity** | No Python `doctor`; shallow Python `init` |
| **Embeddings** | Fusion gateway returns "not supported" (`fusion-backend.ts`); MLX backend has a path but the fusion gateway blocks it |
| **Vision / multimodal** | P2 stretch; not on parity surface |
| **opencode fusion mode** | `tool-opencode` is local-only; no ensemble harness |
| **Generic / vendor ACP doors** | `codex-acp`, `claude-acp`, `cursor-acp`, `generic-acp` reported **`blocked`** in acceptance tests |
| **Cursor IDE turnkey** | CLI `--ide` exists; manual tunnel still required for plan-mode localhost |
| **cursorkit licensing** | UNLICENSED + no-hosted-deploy disclaimer |
| **Real-lite provenance** | Partially improved (`unknown` sentinel in gateway); some ensemble test fixtures still use `0`.repeat(40) |
| **One-install story** | `uvx` + npm dual install; cold-start PyPI + weights |
| **Scope ingest auth** | `apps/scope` `/api/ingest` accepts events with no authentication |
| **Commercial license** | 42+ packages UNLICENSED |
| **mlx-lm publish** | Fork unpublished; git-SHA pin only |
| **Docker fusion stack** | Compose covers Warrant plane only, not gateway + `fusionkit serve` |
| **Judge + synth token cost in benchmarks** | Not captured (`docs/benchmarking-runbook.md`) |

### Likely done since the plan was written

- Durable sessions (`FileSystemSessionStore`, `fusionkit sessions`, `--resume` / `--continue`)
- Kernel-native streaming front door
- Pre-stream vendor failover (WS5)
- `openai-compatible` in `PANEL_PROVIDERS`
- CLI / docs de-drift for governance commands (see `docs/scope.md`)

---

## 4. Model Fusion Protocol — stubs and ticket backlog

### Demo stubs (deferred hardening)

| Record | Status |
| --- | --- |
| `ensemble-receipt.v1` | Minimal demo stub; receipt hardening deferred |
| `artifact-ref.v1` | Minimal demo stub; full artifact lifecycle after MF-00 |
| `tool-call-plan.v1` | Stub; tool planning semantics land in later tickets |
| `tool-execution-record.v1` | Stub; safe tool execution details land in later tickets |

OpenAPI descriptions in `spec/model-fusion-contract/gen/typescript/openapi.d.ts` echo
these stubs.

### MF ticket backlog

**Landed** (`docs/model-fusion-learnings.md`): MF-00, MF-01, MF-10–MF-16, MF-51.

**Not landed / planned:**

| Ticket | Scope |
| --- | --- |
| **MF-02** | HandoffKit protocol validators for harness / tool / receipt records |
| **MF-03** | CursorKit fixture validation + `cursor-run-result` → `harness-run-result` mapping |
| **MF-04** | MLX provider-only validation without runtime imports |
| **MF-50** | Dirty-dozen benchmark manifest (seed exists under `python/fusionkit-evals/src/fusionkit_evals/data/benchmarks/dirty-dozen/`) |
| **MF-60–MF-62** | Governance / isolation fixtures: redacted transcripts, secret denial, disclosure, retention, container isolation, MicroVM hardening (`legacy/specs/2026-06-16-eng-596-microvm-design-spike.md`, `legacy/specs/2026-06-16-eng-597-secret-disclosure-receipts.md`) |

**Reserved:** Protobuf / Buf for internal streaming / gRPC — not required for v1
(`spec/model-fusion-contract/README.md`).

---

## 5. Fusion value rubric — mostly unmeasured

`docs/fusion/FUSION_VALUE_RUBRIC.md` scores most dimensions at **0 — Absent** on the
default `fusionkit codex` path:

- **§1 Headline uplift** — no held-out public benchmark wins; only synthetic fixtures
- **§2 Ensemble headroom** — oracle gap, decorrelation, leave-one-out ablations not reported on real tasks
- **§3 Judge quality** — selection accuracy, regret split, calibration unmeasured
- **§4 Synthesis policy** — default is LLM rewrite; `synthesis_select_best` is opt-in; execution-grounded selection not default on live path
- **§5 Routing** — `HeuristicRouter` only; no learned router consuming outcome records
- **§6 Agentic mechanics** — tool-call fidelity, multi-turn compounding, failover quality delta unmeasured
- **§7 Cost / latency** — no prompt caching; no straggler hedging; judge + synth cost not in bench ledger
- **§8–§9 Reliability & measurement loop** — chaos / soak, locked holdout enforcement, hill-climb wins, outcome-record consumers
- **§10 Architecture** — Python `FusionEngine` vs TS kernel drift risk until Phase 6
- **Hard gates A–D** — none met for a "production" headline claim

---

## 6. Harness and tool integrations

| Item | Location | Status |
| --- | --- | --- |
| Codex `shell_command: "degraded"` | `packages/tool-codex/src/harness.ts` | `TODO(@000alen): why degraded? Codex adapter capability metadata should be the source of truth, with ToolDashboardMetadata documenting the shell_command limitation.` |
| `panelIdentity` / `harnessPromptPassthrough` CLI flags | `docs/specs/harness-prompt-passthrough.md` §12 | Wired internally; **not exposed** on `fusionkit codex` CLI or `.fusionkit` config |
| Phase 3 optional: custom-instruction delta extraction | `docs/specs/harness-prompt-passthrough.md` | Not done |
| Harness prompt open questions Q1–Q4 | `docs/specs/harness-prompt-passthrough.md` | Unresolved |
| **pi agent** | `legacy/packages/runner` | Non-spawnable placeholder argv (harness-only hashing) |
| **Cursor ACP live probe** | `packages/tool-cursor/src/acp.ts` | Opt-in via `FUSIONKIT_GATEWAY_LIVE_CURSOR=1`; otherwise `blocked` |
| **Cursorkit tool loop** | `legacy/docs/production-readiness-audit-2026-06.md` | 9 / 31 agent tools wired; full OpenAI `tool_calls` → Cursor message loop incomplete |
| **opencode** | `packages/tool-opencode` | Local model only; no fusion panel |

---

## 7. Python fusion engine

| Item | Status |
| --- | --- |
| `executor_not_implemented` for tool policy mode `executor` | `python/fusionkit-core/src/fusionkit_core/run.py` |
| `HandoffKitExecutor` / `ExternalBenchmarkExecutor` base protocols | `raise NotImplementedError`; `Command*` implementations exist |
| `public_bench.py` external adapters | Some paths raise `NotImplementedError` |
| `StubProposer` in prompt tuning | Test stub; `LLMProposer` is the real path |
| `FusionRunManager` calling private `engine._judge_synthesize` | Coupling smell noted in audit |
| Broken `pip install fusionkit[mlx]` extra | Extra on `fusionkit-mlx` dist, not CLI dist |
| No macOS CI for MLX paths | Linux-only CI in fusionkit |
| `fusionkit doctor` | Does not exist on Python side |

---

## 8. Observability (`apps/scope`)

`.cursor/plans/fusion_observability_spine_83471272.plan.md`:

| Todo | Status |
| --- | --- |
| Trace contract + emitters (FusionKit / HandoffKit / cursorkit) | **Completed** |
| `apps/scope` collector API (ingest, sessions, stream, replay) | **Built** |
| Dashboard UI polish / rollups | Plan: **pending** |
| `--observe` flag wiring | **Implemented** in `packages/cli/src/fusion-quickstart.ts` |
| Verify: e2e live run with correlated trajectories | Plan: **pending** |
| Scope ingest authentication | **Not implemented** (`apps/scope/app/api/ingest/route.ts`) |
| Per-dimension dashboards (rubric §9.7) | Not wired |

---

## 9. Planned specs and `.cursor/plans`

| Doc | What it plans |
| --- | --- |
| `.cursor/plans/phase-2-providers-508e.md` | Claude Router backends: OpenRouter, DeepSeek, Groq, Gemini; DeepSeek `reasoning_content` risk; Gemini `webSearch` needs `extra_body` extension |
| `.cursor/plans/fusion_observability_spine_83471272.plan.md` | scopekit dashboard completion + verification |
| `.cursor/plans/comprehensive-documentation-rubric-508e.md` | Documentation quality bar (meta) |
| `legacy/specs/2026-06-11-local-first-handoff-platform-spec.md` | Full handoff platform Phases 0–5 — implementation blocked until design agreed |
| `legacy/specs/2026-06-11-governed-agent-execution-plane-spec.md` | Warrant plane v1 — microVM snapshots out of scope |
| `spec/2026-06-13-local-model-harness-bridge-spec.md` | Cursor IDE tunnel requirements |
| `legacy/specs/2026-06-16-eng-596-microvm-design-spike.md` | MF-61 MicroVM path |
| `legacy/specs/2026-06-16-eng-597-secret-disclosure-receipts.md` | MF-62 secret disclosure |
| `.cursor/skills/fusion-production-audit/SKILL.md` | Phased spend / benchmark audit playbook (operational, not code) |

---

## 10. Warrant / governance (in repo, out of product scope)

Per `docs/scope.md` and `AGENTS.md`:

- **`plane` / `runner` / `handoff` / `sdk` / session isolation packages** — legacy
  governance stack; not the shipped FusionKit product.
- Still **compiled into product dependency closure** (`tool-claude` → `runner` /
  `session-harness`, `adapter-ai-sdk` → `handoff` / `sdk`).
- **`fusionkit deployment` commands** (`ui`, `runs`, `plane start`, `runner start`) —
  removed from the product CLI and quarantined under `legacy/`, formerly documented in
  `docs/cli.md`; hidden governance surface.
- **Docker compose** — Warrant plane only; needs Docker workarounds in cloud sandbox.
- **Container / microVM isolation in ensemble** — fake drivers in tests; real
  `vercel-sandbox` / container paths not product-default.
- **`SECURITY.md`** — stale ("no released versions"); supply-chain section "blocked
  until design agreed".

**Separation work** (`docs/scope.md`): carve governance packages out of the default
install and remove compile-time imports from product packages (`tool-claude`,
`adapter-ai-sdk`, etc.).

---

## 11. Packaging, GTM, and ecosystem

From `legacy/docs/production-readiness-audit-2026-06.md` (verify which items remain open):

- No commercial license on 42+ packages
- GTM validation gate (15–20 interviews) not done
- Naming debt: `WARRANT_*` vs `FUSIONKIT_*`, `~/.warrant` vs `~/.fusionkit`
- cursorkit protocol pin may trail handoffkit — coordinated release needed
- mlx-lm unpublished
- `UV_FIND_LINKS` hack in fusionkit-sandbox
- Missing: Prometheus exporter, macOS MLX CI, cursorkit `release:check` in PR CI
- Open-weight benchmark configs (`benchmark-panel-openweight.yaml`, CI subset gate) —
  audit notes as missing
- Receipt verify needs key pinning out-of-band for trustworthy offline verification

---

## 12. Inline code markers

| Marker | File | Meaning |
| --- | --- | --- |
| `TODO(@000alen): why degraded? Codex adapter capability metadata should be the source of truth, with ToolDashboardMetadata documenting the shell_command limitation.` | `packages/tool-codex/src/harness.ts` | `shell_command` capability should be owned by adapter metadata and surfaced in dashboard capability metadata |
| `TODO(@000alen): looks very brittle; replace with classify_provider_error/ProviderCallError-style startup classification.` | `packages/cli/src/fusion/stack.ts` | Local stack startup errors need structured provider/startup classification |
| `TODO(@000alen): why are OpenAI-compatible provider name, /v1 suffix, and local dummy apiKey hardcoded here?` | `packages/adapter-ai-sdk/src/{worktree-agent.ts,managed-server.ts}` | Shared OpenAI-compatible endpoint helper still needed |
| `TODO(@000alen): why are MLX weight markers/download allow_patterns mirrored here?` | `packages/adapter-ai-sdk/src/mlx-helper-source.ts` | MLX helper/provisioner metadata should own download/scan patterns |
| `TODO(@000alen): why is the Codex model catalog cache path hardcoded here?` | `packages/tool-codex/src/launch.ts` | Codex CLI state paths should come from subscription metadata |
| `TODO(@000alen): why does Codex launch config duplicate harness provider config generation?` | `packages/tool-codex/src/launch.ts` | Codex launch/harness provider config generation should be shared |
| `TODO(@000alen): determine whether this legacy Warrant receipt/trace renderer is still reachable...` | `packages/cli/src/render.ts` | Legacy renderer reachability / export decision |
| `WS5 cursorkit failover seam (DEFERRED)` | `packages/tool-cursor/src/acp.ts` / bridge paths | Cursor upstream rate-limit handoff |
| `executor_not_implemented` | `python/fusionkit-core/src/fusionkit_core/run.py` | In-process tool executor |
| `raise NotImplementedError` | `fusion_bench.py`, `public_bench.py` protocols | Base executor protocols |
| `TODO(hardcoded\|brittle\|lib)` | `scripts/check-repo.mjs` | Legacy CI guard rejects old marker format; current provider/tool abstraction debt is tracked with `TODO(@000alen)` comments |

---

## 13. Explicitly not planned

Avoid treating these as gaps:

- Learned-policy training inside the kernel
- Arbitrary JSON graph execution with function operators
- Warrant signed receipts as part of the ensemble product (WS0 scope cut)
- Multi-tenant hosting / VM isolation as v1 product
- Google as a required panel family (product decision: two-provider constraint)
- Protobuf / Buf for v1 protocol

---

## Suggested priority clusters

1. **Kernel migration Phases 3–6** — eliminate legacy wrappers and Python / TS dual orchestration
2. **Tool-calling E2E on `fusionkit codex`** — executor seam + gateway harness loop
3. **Value rubric Gate A** — real public benchmark evidence on the shipped path
4. **Mid-stream failover + Cursor upstream (WS6)** — headline handoff feature completion
5. **Product packaging** — license, one-install, scope auth, mlx publish
6. **MF-02–04, MF-50, MF-60–62** — contract hardening and benchmark manifests

---

## Maintenance

When closing an item:

1. Update the relevant source-of-truth doc (migration plan, MOA status, product plan).
2. Remove or strike the row here, or move it to a "Completed" section with the PR /
   date reference.
3. Re-run a repo-wide search for `TODO`, `FIXME`, `NotImplementedError`, `deferred`,
   and `blocked` before major releases.
