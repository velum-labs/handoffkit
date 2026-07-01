# Documentation taxonomy

This repository has two documentation layers. The public site in `apps/docs/content/docs/` is the user-facing source of truth. The Markdown tree in `docs/` is the maintainer and contributor layer. A page belongs in the public site when it helps a user install, run, configure, or integrate FusionKit. A page belongs in `docs/` when it explains implementation detail, code ownership, release process, protocol maintenance, benchmarks, examples, or historical design context that contributors need.

Every documentation entry should fit one primary category. If a page cannot be assigned to a category below, it should either be merged into a neighboring page, moved to `.cursor/plans/` as planning context, or deleted.

## Categories

### Orientation

Orientation pages answer "where am I and what should I read next?" They are indexes, scope maps, and repository maps. They should not become implementation dumps. They should route readers to the page that owns the detail.

### Task guides

Task guides help someone complete one workflow. They should start from a user's goal, provide commands, explain expected output, and link to reference material. Quickstarts, setup guides, handoff guides, model selection guides, and runbooks belong here.

### Concepts and architecture

Concept pages explain mental models and system boundaries. They should describe why the system is shaped the way it is and how major components collaborate. They should use diagrams when flow or ownership matters.

### Reference

Reference pages document stable surfaces: commands, packages, modules, functions, schemas, routes, examples, scripts, and configuration fields. Reference pages should be complete, searchable, and explicit about source files.

### Operations

Operations pages document release, publishing, CI, verification, self-hosting, dependency policy, and recovery. They should name the owning script or workflow and make mutation commands clear.

### Evaluation and tuning

Evaluation pages document benchmarks, public comparisons, prompt tuning, hill climbing, and measurement workflows. They are maintainer-facing unless promoted to the public site as a supported user workflow.

### Design archive

Design archive pages preserve useful historical or forward-looking design context. They must not be presented as current product truth. If they are active plans rather than durable references, they belong in `.cursor/plans/`.

## Placement rules

Public user workflows go in `apps/docs/content/docs/`. If a public page needs implementation depth, link to a maintainer reference rather than copying code ownership details into the site.

Maintainer references go in `docs/`. They can link to package entry points, generated contracts, scripts, and tests. They should identify whether a topic is current product behavior, platform depth, evaluation tooling, or historical design.

Planning prompts, research notes, and temporary implementation status notes should not live in visible docs unless they are intentionally kept as a design archive. Temporary planning material belongs in `.cursor/plans/`.

Generated API pages should not be edited by hand except when regenerating from the OpenAPI source is part of the same change.

## Maintainer documentation inventory

| Entry | Category | Justification |
| --- | --- | --- |
| `README.md` | Orientation | Maintainer landing page and routing table for the `docs/` tree. |
| `documentation-taxonomy.md` | Orientation | Defines the categories and placement rules that keep documentation coherent. |
| `repository-reference.md` | Reference | Whole-repository map across packages, apps, specs, scripts, examples, and verification. |
| `typescript-reference.md` | Reference | Package-by-package TypeScript ownership, public symbols, and examples. |
| `python-reference.md` | Reference | Python package, module, class, function, and CLI ownership. |
| `specs-and-apis.md` | Reference | Protocol schemas, generated bindings, routes, trace events, and schema workflow. |
| `apps-and-examples.md` | Reference | Standalone apps and every example package with commands and expected behavior. |
| `operations-and-scripts.md` | Operations | Root scripts, release files, CI mapping, dependency policy, and verification strategy. |
| `getting-started.md` | Task guide | Contributor setup, local verification, portless behavior, demos, and Python workspace setup. |
| `quickstart-inference.md` | Task guide | Raw endpoint workflow for `fusionkit serve` with curl and tool examples. |
| `quickstart-harness.md` | Task guide | Coding-harness launch workflow for Codex, Claude Code, and Cursor. |
| `quickstart-handoff.md` | Task guide | Rate-limit and credit handoff workflow with policies and resume behavior. |
| `configuration.md` | Reference | `.fusionkit/fusion.json` fields, precedence, default panels, prompts, and YAML export. |
| `cli.md` | Reference | Complete CLI command surface and shared flags. |
| `model-catalog.md` | Reference | Provider matrix, default panel, local MLX, mixed panels, pricing, and budget. |
| `fusion-harness-gateway.md` | Concepts and architecture | Gateway architecture, dialects, streaming, wiring, and front-door behavior. |
| `fusion-judge-trajectory.md` | Concepts and architecture | Trajectory fusion model, judge synthesis, trace events, and e2e drivers. |
| `scope.md` | Orientation | Product package boundary versus retained governance and VM packages. |
| `packages.md` | Reference | Short package guide for readers who do not need the full TypeScript or Python references. |
| `architecture.md` | Concepts and architecture | Governance platform architecture retained for contributor context. |
| `concepts.md` | Concepts and architecture | Governance concepts such as contracts, receipts, policies, runners, and handoffs. |
| `operations.md` | Operations | Governance platform operations retained for out-of-product-scope packages. |
| `examples.md` | Task guide | Governed-run demo suite guide and scenario map. |
| `handoff-sdk.md` | Reference | Handoff SDK developer surface on governance primitives. |
| `fusionkit-handoff-executor.md` | Reference | Executor seam that connects FusionKit requests to handoff execution. |
| `release-publishing.md` | Operations | npm publishing workflow and trusted publishing setup. |
| `releasing.md` | Operations | Cross-repo release plan and apply workflow. |
| `model-fusion-protocol-consumption.md` | Reference | How consumers use model-fusion protocol records and generated bindings. |
| `model-fusion-protocol-release.md` | Operations | Protocol release process and propagation. |
| `model-fusion-learnings.md` | Design archive | Durable lessons from model-fusion implementation work. |
| `local-mlx-panel-demo.md` | Task guide | Local MLX panel demo behavior and setup. |
| `handoffkit-fusion-bench.md` | Evaluation and tuning | Fusion benchmark workflow that bridges retained naming and current evaluation. |
| `benchmarking-runbook.md` | Evaluation and tuning | Benchmark execution and troubleshooting runbook. |
| `prompt-tuning.md` | Evaluation and tuning | Prompt tuning workflow and reporting guidance. |
| `public-benchmark-smoke.md` | Evaluation and tuning | Public benchmark smoke-test workflow. |
| `public-benchmark-comparison.md` | Evaluation and tuning | Public benchmark comparison and reporting workflow. |
| `fusion/runtime-kernel.md` | Concepts and architecture | Maintainer detail for runtime kernel concepts, artifacts, schedulers, and status. |
| `fusion/runtime-recipes.md` | Task guide | Runtime-kernel recipe examples for maintainers. |
| `fusion/kernel-migration.md` | Design archive | Migration status and decisions for kernel adoption. |
| `fusion/MOA_DESIGN.md` | Design archive | Historical model-fusion architecture draft. |
| `fusion/MOA_IMPLEMENTATION_PROMPT.md` | Design archive | Preserved implementation prompt for auditability, not product truth. |
| `fusion/MOA_IMPLEMENTATION_STATUS.md` | Design archive | Preserved implementation status notes for auditability, not product truth. |

## Public documentation taxonomy

The public site uses the same categories, but with user-facing names.

| Site section | Category | Purpose |
| --- | --- | --- |
| Introduction | Orientation | Explain FusionKit, route users to setup, CLI, concepts, SDKs, operations, and APIs. |
| Documentation taxonomy | Orientation | Explain how the public docs are organized and why each entry exists. |
| Get Started | Task guides | Install, run the first session, configure a repo, run the raw endpoint, and recover from rate limits. |
| fusionkit CLI | Reference and task guides | Commands, flags, cost controls, model panels, observability, and troubleshooting. |
| Concepts | Concepts and architecture | Product scope, architecture, model fusion, and runtime kernel mental models. |
| SDKs and Packages | Reference | SDK surfaces, adapters, and package ownership. |
| Self-Hosting | Operations | Plane and runner operation plus release publishing. |
| Examples | Task guide | Runnable example map for learning by scenario. |
| API Reference | Reference | Runtime gateway routes and generated harness-executor contract. |

## Review checklist

When adding or editing documentation, assign the page to one category, name the audience, state the workflow or surface it owns, link to neighboring categories, and include runnable examples when the page describes a task. If a page is generated, update its source. If a page is historical, label it as design archive or move it out of visible docs.
