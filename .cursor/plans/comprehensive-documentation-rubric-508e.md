# Documentation rubric

This rubric defines the standard for every documentation entry in this repository. It exists so that user-facing pages, maintainer notes, package references, examples, and API guides can be reviewed against the same expectations before they are published or used as contributor guidance.

The goal is professional documentation that respects the reader's time while still being complete. A good page explains what the system does, why it exists, how it is used, where the relevant code lives, how to verify behavior, and which risks or boundaries matter. It should be written in direct prose, supported by examples and diagrams when they make the system easier to understand.

## Repository landing documentation

The repository landing documentation includes the root `README.md`, the `docs/README.md` maintainer index, and the Fumadocs introduction in `apps/docs/content/docs/index.mdx`.

A strong landing page orients a new reader in the first few paragraphs. It names the product, explains the main user workflow, identifies the two-process architecture, and points readers to the correct next page for installation, CLI usage, package development, or operations. It must also call out the important naming boundary in this repo: FusionKit is the product, while several Warrant governance and VM packages remain in-tree for legacy and platform reasons.

The entry is complete when it answers three questions without making the reader search the repository. First, what can I run today? Second, which packages and apps are part of the shipped FusionKit product? Third, where do I go if I am contributing to internals rather than using the CLI?

Every landing page should include at least one copyable quickstart. The quickstart should use real commands, name required prerequisites, and mention the expected result. When a page links to deeper material, the link text should describe the task or concept rather than the file name alone.

## Getting started documentation

Getting started documentation covers installation, local setup, first-run validation, quickstarts, configuration scaffolding, and the difference between global CLI installation and `npx` usage.

The documentation is successful when a new user can install the Node CLI, provision or warm the Python engine, run `fusionkit doctor`, initialize `.fusionkit/`, and start either a coding-harness session or the raw inference endpoint. It must mention Node, pnpm, `uv`, git, provider credentials, and the platform limits for local MLX panels.

Examples should show the happy path first, then a minimal troubleshooting path. The happy path should include the exact commands and the expected observable outcome. The troubleshooting path should explain what `fusionkit doctor` verifies, where sessions are stored, and how to switch from local MLX to cloud providers when the current machine cannot run local models.

## CLI command documentation

CLI documentation covers the Node `fusionkit` binary from `@fusionkit/cli` and the Python `fusionkit` command from the PyPI package. Because both commands share the same name, every CLI page must state which implementation owns the command being described.

For the Node CLI, documentation should cover the top-level launcher commands, the `fusion` group, local-model commands, session inspection, model cache management, configuration commands, setup, doctor, status, runtime inspection, ensemble tooling, and deployment helpers. For the Python CLI, documentation should cover `serve`, `init`, endpoint serving, prompt dumping, authentication status and switching, benchmarks, public benchmark reports, prompt tuning, and hill-climb commands.

Each command entry should explain the command's purpose, when a reader should use it, the important flags, the files or network services it touches, and how to verify success. High-value examples include a first-run invocation, a resumed session, a budget-limited run, a local-model run, a raw HTTP endpoint call, and a benchmark invocation that writes artifacts.

## Configuration documentation

Configuration documentation covers `.fusionkit/fusion.json`, prompt overrides, model endpoints, provider credentials, budgets, sampling, local model configuration, session directories, and generated Python YAML.

The documentation is complete when it describes the single source of truth, how defaults are resolved, which settings are safe to commit, which values must stay in the environment, and how the Node CLI derives the Python server configuration. It must also explain how prompts in `.fusionkit/prompts/` relate to judge and synthesizer behavior.

Every configuration page should contain a minimal working config and a more realistic production config. The examples should include cloud endpoints, local endpoints when relevant, budget controls, prompt override paths, and a note about credentials being resolved through environment variables or supported subscription auth mechanisms rather than committed files.

## Architecture and concept documentation

Architecture documentation covers the FusionKit product architecture, the model-fusion workflow, the runtime kernel, the harness gateway, the Python fusion engine, the protocol contracts, and the legacy governance plane.

A complete architecture page starts with the user-visible workflow and then traces it through the implementation. It should name the process boundary between Node and Python, show how requests flow through the gateway, explain how panel candidates are produced, describe how trajectories are synthesized, and state where results, costs, sessions, traces, and protocol records are stored.

Architecture entries should use Mermaid diagrams when a diagram clarifies ownership or data flow. Diagrams should be small enough to read and should be followed by prose that explains the important transitions. They should not replace the explanation.

## Package documentation

Package documentation covers every workspace package under `packages/`, every Python package under `python/`, the standalone apps under `apps/`, and the generated or schema-driven packages under `spec/`.

For each package, the documentation should state its responsibility, its product scope, its primary entry points, its public functions or types, its important dependencies, its tests, and one concrete usage example. If a package is out of the current FusionKit product scope, the page should still document it clearly and identify that boundary.

The entry is complete when a contributor can decide whether the package is the right place for a change, find the first file to read, understand the exported API surface, and run or reason about the relevant tests.

## Function and type reference documentation

Function and type reference documentation covers exported functions, classes, protocols, and important data models. It does not need to restate every private helper, but it must document public entry points and private helpers that encode core behavior, safety properties, or cross-package contracts.

Each symbol entry should explain the symbol in plain language, describe the inputs and outputs at the level a maintainer needs, identify important side effects, and link it to the module that defines it. When a symbol participates in a workflow, the documentation should explain where it sits in that workflow rather than documenting it in isolation.

Examples are required for symbols that a user or package author is expected to call directly. Internal symbols can use scenario examples instead, such as "the gateway calls this when translating Anthropic Messages to Chat Completions."

## API and protocol documentation

API and protocol documentation covers HTTP endpoints, JSON Schemas, OpenAPI files, generated TypeScript bindings, generated Python bindings, fusion trace events, and model-fusion records.

The documentation is complete when a reader can identify the canonical schema file, understand the versioning rule, construct a valid minimal request, recognize the success and error responses, and know which generated package exposes the contract. For HTTP APIs, each endpoint should name the serving process, route, method, request body, response shape, streaming behavior, and authentication assumptions.

Examples should include both curl usage and programmatic usage when clients exist. Contract examples should use fixtures from `spec/model-fusion-contract/fixture/` where possible, because those fixtures are validated by the repository tooling.

## Example documentation

Example documentation covers every package under `examples/` and any standalone demo under `test/`, `apps/`, or `scripts/`.

Each example entry should explain the behavior being demonstrated, the packages it exercises, the command to run it, whether it requires external credentials or services, and what output indicates success. It should also explain why the example exists, because many examples are platform demonstrations rather than product quickstarts.

An example is well documented when a reader can run it without reading its source first, can interpret the output, and can decide whether the example is relevant to FusionKit product behavior, governance platform behavior, benchmarks, or release validation.

## Operations documentation

Operations documentation covers releases, publishing, self-hosting, CI, dependency policy, benchmarks, generated code, and local development verification.

The entry is complete when it names the owning script or workflow, describes the required state before running it, lists the checks it performs, explains generated or published artifacts, and gives the rollback or recovery path when one exists. Release documentation must distinguish npm packages, PyPI packages, protocol packages, and docs site deployment.

Examples should show dry-run commands before mutation commands. When a command publishes, bumps versions, writes state, or depends on credentials, the documentation must state that explicitly.

## Troubleshooting documentation

Troubleshooting documentation covers failed installs, missing provider credentials, local MLX capability issues, gateway dialect errors, session resume problems, budget stops, rate limits, benchmark failures, and CI failures.

A troubleshooting entry should start from a symptom the reader can observe. It should then explain the likely cause, the command or log that verifies it, and the smallest safe fix. It should avoid generic advice and prefer repo-specific evidence, such as `fusionkit doctor`, session JSON under `~/.fusionkit/sessions/`, gateway response headers, pytest output, or protocol fixture validation.

The page is complete when it includes both prevention and diagnosis. Prevention means configuration, setup, or validation that catches the issue early. Diagnosis means a command that confirms whether the problem is present.

## Security and safety documentation

Security documentation covers credential handling, secret disclosure, network policy, signed contracts, signed receipts, workspace capture, sandbox isolation, and provenance.

The documentation should make only claims that are implemented in the repository. If a package is product-facing, the page should explain the actual runtime boundary. If a package is legacy or out of product scope, the page should state that clearly while preserving the security model for contributors.

Security examples should avoid real secrets. They should use placeholder values, environment variables, and test fixtures. A complete entry explains what is denied by default, what is allowed by policy, what evidence is recorded, and which verification function or command proves the claim.

## Review checklist for new or changed docs

Before a documentation change is complete, the author should read the entry as a first-time user and as a maintainer. The entry should identify its audience, stay within the implemented product boundary, avoid undocumented acronyms, include runnable examples where useful, link to source files or generated contracts, and explain how to verify the described behavior.

The page should also be checked for tone. Documentation in this repository should be human, precise, and professional. It should prefer prose, use lists only when they improve scanning, avoid decorative language, and avoid unsupported roadmap claims.
