# Documentation taxonomy

This repository has two documentation layers. The public site in `apps/docs/content/docs/` is the user-facing source of truth. The Markdown tree in `docs/` is the maintainer and contributor layer. Legacy Warrant governance material lives under `legacy/docs/`.

A page belongs in the public site when it helps a user install, run, configure,
understand, or integrate RouteKit or FusionKit. A page belongs in `docs/` when
it explains implementation detail, code ownership, release process, protocol
maintenance, benchmarks, examples, or historical design context. A page
belongs in `legacy/docs/` when it documents the quarantined governance plane,
runner, SDK, handoff SDK, Docker stack, or governed-run examples.

## Categories

| Category | Use |
| --- | --- |
| Orientation | Indexes, scope maps, and repository maps. |
| Task guides | Concrete workflows with commands and expected output. |
| Concepts and architecture | Mental models, boundaries, and component collaboration. |
| Reference | Stable surfaces: commands, packages, modules, schemas, routes, examples, scripts, and config fields. |
| Operations | Release, publishing, CI, verification, dependency policy, and recovery. |
| Evaluation and tuning | Benchmarks, public comparisons, prompt tuning, hill climbing, and measurement workflows. |
| Privacy and policy | Data handling, security reporting, local retention, provider egress, and supply-chain posture. |
| Design archive | Historical or forward-looking context that is not current product truth. |
| Internal/design archive | Maintainer-only notes or prompts that must not be presented as product docs. |

## Maintainer documentation inventory

| Entry | Category | Classification |
| --- | --- | --- |
| `README.md` | Orientation | Maintainer landing page and routing table for `docs/`. |
| `documentation-taxonomy.md` | Orientation | Placement rules and inventory. |
| `repository-coverage-map.md` | Orientation | Repo areas mapped to docs. |
| `repository-reference.md` | Reference | Whole-repository map across packages, apps, specs, scripts, examples, and verification. |
| `source-symbol-index.md` | Reference | Source-grounded TypeScript export and Python symbol inventory. |
| `generated/code-api.md` | Reference | Generated API reference; do not edit by hand. |
| `generated/expected-behaviors.md` | Reference | Generated expected-behavior inventory from `spec/testing/expected-behaviors.json`; do not edit by hand. |
| `typescript-reference.md` | Reference | TypeScript package ownership, public symbols, and examples. |
| `python-reference.md` | Reference | Python packages, modules, symbols, CLI ownership, and examples. |
| `specs-and-apis.md` | Reference | Protocol schemas, generated bindings, routes, trace conventions, and schema workflow. |
| `apps-and-examples.md` | Reference | Apps and product/legacy example map. |
| `operations-and-scripts.md` | Operations | Root scripts, release files, CI mapping, dependency policy, and verification strategy. |
| `getting-started.md` | Task guide | Contributor setup, local verification, portless behavior, demos, and Python workspace setup. |
| `testing.md` | Task guide | Living test-tooling doc: provider simulator, testkits, coverage matrix, mutation pass, and rules for new tests. |
| `hyperkit.md` | Reference | Living reference for the Hyperkit experiment platform: boundary, CLI, adapters, backends, and observability. |
| `quickstart-inference.md` | Task guide mirror | In-repo mirror of the public raw endpoint workflow. |
| `quickstart-harness.md` | Task guide mirror | In-repo mirror of the public coding-harness workflow. |
| `quickstart-handoff.md` | Task guide mirror | In-repo mirror of rate-limit failover; not legacy handoff SDK. |
| `routekit-user-guide.md` | Task guide mirror | In-repo mirror of the public zero-context RouteKit install, provider, pooling, tool-launch, and gateway workflow. |
| `configuration.md` | Reference | `.fusionkit/fusion.json` fields, precedence, default panels, prompts, and YAML export. |
| `cli.md` | Reference | Complete CLI command surface and shared flags. |
| `privacy.md` | Privacy and policy | Local session storage, retention, provider egress, failover expansion, and opt-in telemetry. |
| `routekit-l06-evidence.md` | Privacy and policy evidence | Generated, sanitized qualification report sourced from `spec/routekit/l06-evidence.json`; do not edit by hand. |
| `routekit-routes-and-billing.md` | Privacy and policy mirror | Maintainer mirror of the public per-route credential, billing, egress, fallback, limitations, and qualification disclosures. |
| `model-catalog.md` | Reference | Provider matrix, default panels, local MLX, mixed panels, pricing, and budgets. |
| `fusion-harness-gateway.md` | Concepts and architecture | Product gateway architecture, dialects, streaming, wiring, and front-door behavior. |
| `subscription-pooling.md` | Concepts and architecture | Provider-native relays, credential pools, usage windows, and quota-aware rotation. |
| `fusion-judge-trajectory.md` | Concepts and architecture | Trajectory fusion model, judge synthesis, OTel trace spans, and e2e drivers. |
| `scope.md` | Orientation | Product package boundary versus retained legacy governance and VM packages. |
| `packages.md` | Reference | Short package guide for readers who do not need full package references. |
| `release-publishing.md` | Operations | npm publishing workflow and trusted publishing setup. |
| `releasing.md` | Operations | Cross-repo release plan/apply workflow. |
| `model-fusion-protocol-consumption.md` | Reference | How consumers use model-fusion protocol records and generated bindings. |
| `model-fusion-protocol-release.md` | Operations | Protocol release process and propagation. |
| `model-fusion-learnings.md` | Design archive | Durable lessons from model-fusion implementation work. |
| `planning/ensemble-product-plan.md` | Design archive | Historical ensemble product plan retained with stale-content context. |
| `planning/tracing-and-telemetry-plan.md` | Design archive | Historical tracing and telemetry plan. |
| `oss-release/README.md` | Internal/design archive | OSS release working-set index for maintainers. |
| `oss-release/workstreams.md` | Internal/design archive | OSS release workstream tracking notes. |
| `oss-release/audit-findings.md` | Internal/design archive | OSS release audit findings; internal working notes. |
| `specs/harness-prompt-passthrough.md` | Design archive | Implemented harness prompt pass-through design spec. |
| `local-mlx-panel-demo.md` | Task guide | Local MLX panel demo behavior and setup. |
| `handoffkit-fusion-bench.md` | Evaluation and tuning | Fusion benchmark workflow retained for maintainer evaluation work. |
| `benchmarking-runbook.md` | Evaluation and tuning | Benchmark execution and troubleshooting runbook. |
| `prompt-tuning.md` | Evaluation and tuning | Prompt tuning workflow and reporting guidance. |
| `public-benchmark-smoke.md` | Evaluation and tuning | Public benchmark smoke-test workflow. |
| `public-benchmark-comparison.md` | Evaluation and tuning | Public benchmark comparison and reporting workflow. |
| `fusion/runtime-kernel.md` | Concepts and architecture | Runtime kernel concepts, artifacts, schedulers, and status. |
| `fusion/runtime-recipes.md` | Task guide | Runtime-kernel recipe examples for maintainers. |
| `fusion/kernel-migration.md` | Design archive | Migration status and decisions for kernel adoption. |
| `fusion/MOA_DESIGN.md` | Design archive | Historical model-fusion architecture draft. |
| `fusion/MOA_IMPLEMENTATION_STATUS.md` | Design archive | Preserved implementation status notes for auditability. |
| `fusion/FUSION_VALUE_RUBRIC.md` | Internal/design archive | Internal rubric for evaluating fusion value; not a published benchmark result. |
| `fusion/FUSION_ARCHITECTURE_V2.md` | Internal/design archive | Internal architecture notes; not product documentation. |
| `fusion/STABILIZATION.md` | Internal/design archive | Internal stabilization notes. |
| `fusion/incomplete-work-inventory.md` | Internal/design archive | Internal incomplete-work inventory. |
| `fusion/coding-capability-index-report.md` | Internal/design archive | Internal/design benchmark report; not public product proof. |
| `fusion/MOA_IMPLEMENTATION_PROMPT.md` | Internal/design archive | Preserved agent prompt for auditability, not product truth. |
| `fusion/capability-index-program.md` | Internal/design archive | Internal capability-index program notes. |
| `fusion/capability-index-spec.md` | Internal/design archive | Internal capability-index specification draft. |
| `fusion/capability-index-status.md` | Internal/design archive | Internal capability-index status tracking. |
| `fusion/catalog-snapshot-2026-07-07.md` | Design archive | Dated model-catalog snapshot retained for historical comparison. |
| `fusion/company-operating-system-2026-07.md` | Internal/design archive | Internal operating notes; not product documentation. |
| `fusion/driver-topology-spec-2026-07.md` | Design archive | Dated driver-topology design spec. |
| `fusion/ensemble-hypotheses-v0-2026-07.md` | Design archive | Dated ensemble hypothesis notes. |
| `fusion/ensemble-launch-clean-room-2026-07.md` | Internal/design archive | Internal ensemble launch clean-room notes. |
| `fusion/ensemble-literature-review-2026-07.md` | Design archive | Dated ensemble literature review. |
| `fusion/k1-official-harness-plan-2026-07.md` | Design archive | Dated k=1 official-harness plan. |
| `fusion/lab-loop-2026-07.md` | Design archive | Dated lab-loop design notes. |
| `fusion/lab-loop-implementation-spec-2026-07.md` | Design archive | Dated lab-loop implementation spec. |
| `fusion/oss-ensemble-launch-plan.md` | Internal/design archive | Internal OSS ensemble launch plan. |
| `fusion/phase0-validation-report.md` | Internal/design archive | Internal phase-0 validation report. |
| `fusion/strategy-rethink-2026-07.md` | Internal/design archive | Internal strategy notes; not product truth. |
| `fusion/unicorn-roadmap-2026-07.md` | Internal/design archive | Internal roadmap notes; not product truth. |

## Legacy documentation inventory

| Entry | Category | Classification |
| --- | --- | --- |
| `legacy/docs/concepts.md` | Concepts and architecture | Historical Warrant governance concepts. |
| `legacy/docs/architecture.md` | Concepts and architecture | Historical Warrant control-plane and runner architecture. |
| `legacy/docs/operations.md` | Operations | Historical plane/runner/Docker operations; commands removed from shipped CLI. |
| `legacy/docs/examples.md` | Task guide | Historical governed-run demo suite under `legacy/examples/`. |
| `legacy/docs/handoff-sdk.md` | Reference | Historical governance handoff SDK, unrelated to product rate-limit handoff. |
| `legacy/docs/production-readiness-audit-2026-06.md` | Internal/design archive | Historical internal readiness audit retained in the legacy archive. |

## Other moved/archived directories

| Directory | Classification | Notes |
| --- | --- | --- |
| `docs/planning/` | Design archive | Historical plans and product-shaping notes. |
| `docs/specs/` | Design archive / implemented specs | Product-relevant specs retained in maintainer docs. |
| `legacy/specs/` | Legacy design archive | Governance, handoff, microVM, and secret-disclosure specs. |

## Public documentation taxonomy

| Site section | Category | Purpose |
| --- | --- | --- |
| Introduction | Orientation | Explain RouteKit and FusionKit, distinguish standalone routing from model fusion, and route users to the correct setup path. |
| Documentation taxonomy | Orientation | Explain site organization. |
| Get Started | Task guides | Install RouteKit or FusionKit, run the first routed or fused session, configure a repo, run an endpoint, and recover from rate limits. |
| fusionkit CLI | Reference and task guides | Commands, flags, cost controls, model panels, observability, and troubleshooting. |
| Concepts | Concepts and architecture | Product vocabulary, model fusion, runtime kernel, and product scope. |
| Packages | Reference | Product package map with legacy archive pointer. |
| Privacy | Privacy and policy | Local storage, retention, provider egress, rate-limit expansion, and opt-in telemetry. |
| Examples | Task guide | Product examples and legacy demo archive pointer. |
| API Reference | Reference | Runtime gateway routes and generated harness-executor contract. |

## Review checklist

When adding or editing documentation, assign the page to one category, name the audience, state the workflow or surface it owns, link to neighboring categories, and include runnable examples when the page describes a task. If a page is generated, update its source. If a page is historical, label it as design archive or move it under `legacy/docs/` when it describes the legacy stack.
