import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalSharedPackageViolations,
  fusionkitCompositionViolations,
  isInternalWorkspaceDependency,
  polynomialTrailingSlashRegexViolations,
  routekitDependencyViolations,
  routekitProductionSources,
  routekitSourceViolations,
  toolRegistryCliSourceViolations,
  toolRegistryCompositionViolations,
  toolRegistryConstructionViolations
} from "./lib/architecture-guards.mjs";

// A deliberately curated manifest of files that must exist for the repo to
// be considered intact (specs, entry points, test suites, deploy assets).
// It is maintained by hand on purpose: adding a load-bearing file to this
// list is part of reviewing the change that introduces it.
const requiredFiles = [
  "README.md",
  "SECURITY.md",
  ".npmrc",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".github/workflows/ci.yml",
  ".github/workflows/release-packages.yml",
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
  "tsconfig.json",
  "tsconfig.base.json",
  // uv workspace (the Python monorepo side)
  "pyproject.toml",
  "uv.lock",
  "python/uniroute/pyproject.toml",
  "python/uniroute/src/uniroute/__init__.py",
  "python/uniroute/tests/test_end_to_end.py",
  "python/uniroute-mlx/pyproject.toml",
  "python/uniroute-mlx/src/uniroute_mlx/card.py",
  "python/uniroute-mlx/tests/test_cli_end_to_end.py",
  // cross-language registries (spec/registry is the source of truth; neutral
  // RouteKit and FusionKit-only bindings are generated separately)
  "spec/registry/providers.json",
  "spec/registry/subscriptions.json",
  "spec/registry/connectors.json",
  "spec/registry/fusion.json",
  "spec/registry/model-catalog.json",
  "spec/registry/model-capabilities.json",
  "spec/registry/pricing.json",
  "spec/registry/local-catalog.json",
  "scripts/generate-pricing.mjs",
  "scripts/generate-local-catalog.mjs",
  "scripts/generate-registry.mjs",
  // fusion trace semantic conventions (spec/fusion-trace is the source of
  // truth; TS/Python/scope bindings are generated)
  "spec/fusion-trace/registry.json",
  "scripts/generate-trace-conventions.mjs",
  "packages/tracing/src/index.ts",
  "packages/routekit-tracing/src/index.ts",
  "packages/runtime-utils/src/index.ts",
  "packages/runtime-utils/src/environment.ts",
  "packages/runtime-utils/src/url.ts",
  "packages/cli-ui/src/index.ts",
  "packages/cli-core/src/index.ts",
  "packages/config-core/src/index.ts",
  "packages/routekit-config/src/index.ts",
  "packages/routekit-router/src/index.ts",
  "packages/fusion-config/src/index.ts",
  "packages/telemetry-core/src/index.ts",
  "packages/protocol/src/generated/trace-conventions.ts",
  "python/fusionkit-core/src/fusionkit_core/_generated/trace_conventions.py",
  "apps/scope/lib/generated/trace-conventions.ts",
  "packages/routekit-registry/src/index.ts",
  "packages/routekit-registry/src/generated/data.ts",
  "packages/registry/src/index.ts",
  "packages/registry/src/generated/data.ts",
  "python/fusionkit-core/src/fusionkit_core/registry.py",
  "python/fusionkit-core/src/fusionkit_core/_generated/fusion_registry_data.py",
  "python/fusionkit-evals/src/fusionkit_evals/_generated/benchmark_registry_data.py",
  "python/fusionkit-evals/src/fusionkit_evals/cli.py",
  "python/fusionkit-evals/src/fusionkit_evals/cli_shared.py",
  "python/fusionkit-evals/src/fusionkit_evals/hyperkit_plugin.py",
  "python/fusionkit-cli/src/fusionkit_cli/main.py",
  "python/fusionkit-core/tests/test_docs_contracts.py",
  // package entry points
  "packages/contracts/src/index.ts",
  "packages/contracts/src/jcs.ts",
  "packages/contracts/src/hash.ts",
  "packages/contracts/src/model.ts",
  "packages/contracts/src/harness-event.ts",
  "packages/protocol/src/index.ts",
  "packages/protocol/src/types.ts",
  "packages/protocol/src/api.ts",
  "packages/protocol/src/model-fusion.ts",
  "packages/protocol/src/generated/model-fusion-openapi.ts",
  "packages/protocol/generated/python/velum_model_fusion_protocol/__init__.py",
  "packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py",
  "packages/protocol/openapi/model-fusion-harness-executor.openapi.json",
  "packages/protocol/model-fusion-bindings.json",
  "packages/protocol/docs/model-fusion-consumption.md",
  "packages/protocol/src/tool-executor.ts",
  "packages/protocol/src/receipt.ts",
  "packages/workspace/src/index.ts",
  "packages/adapter-ai-sdk/src/mlx-env.ts",
  "packages/adapter-ai-sdk/src/managed-server.ts",
  "packages/model-gateway/src/backend.ts",
  "packages/model-gateway/src/router.ts",
  "packages/model-gateway/src/provider-backends.ts",
  "packages/model-gateway/src/endpoint-health.ts",
  "packages/model-gateway/src/capacity-pool.ts",
  "packages/accounts/src/index.ts",
  "packages/accounts/src/credentials.ts",
  "packages/accounts/src/account-source.ts",
  "packages/accounts/src/account-set.ts",
  "packages/accounts/src/backend.ts",
  "packages/accounts/src/gateway.ts",
  "packages/accounts/src/provider.ts",
  "packages/accounts/src/relay.ts",
  "packages/accounts/src/codex-relay.ts",
  "packages/accounts/src/types.ts",
  "packages/accounts/src/proxy.ts",
  "packages/accounts/src/client.ts",
  "packages/accounts/src/usage.ts",
  "packages/accounts/src/cliproxy.ts",
  "packages/accounts/src/connector.ts",
  "packages/accounts/src/managed-login.ts",
  "packages/accounts/src/wire.ts",
  "packages/accounts/src/test/account-removal.test.ts",
  "packages/accounts/src/test/subscription-backend.test.ts",
  "packages/fusion-gateway/src/fusion-backend.ts",
  "packages/fusion-gateway/src/fusion-proxy.ts",
  "packages/fusion-gateway/src/fusion-cost-meter.ts",
  "packages/fusion-gateway/src/fusion-failover.ts",
  "packages/fusion-gateway/src/fusion-session.ts",
  "packages/fusion-gateway/src/fusion-turn.ts",
  "packages/fusion-gateway/src/fusion-types.ts",
  "packages/fusion-gateway/src/fusion-vendor-proxy.ts",
  "packages/fusion-gateway/src/logger.ts",
  "packages/model-gateway/src/sse-wire.ts",
  "packages/model-gateway/src/adapters/openai-chat-wire.ts",
  "packages/model-gateway/src/adapters/responses-stream.ts",
  "packages/ensemble/src/index.ts",
  "packages/ensemble/src/unified-core.ts",
  "packages/ensemble/src/unified-types.ts",
  "packages/ensemble/src/unified-url.ts",
  "packages/ensemble/src/harness-kind-registry.ts",
  "packages/ensemble/src/panel-orchestration.ts",
  "packages/ensemble/src/harness-factories.ts",
  "packages/kernel/src/engine.ts",
  "packages/kernel/src/types.ts",
  "packages/kernel/src/budget.ts",
  "packages/kernel/src/streaming.ts",
  "packages/kernel/src/scheduling.ts",
  "packages/kernel/src/outcome.ts",
  "packages/kernel/src/runtime-artifacts.ts",
  "packages/kernel/src/visibility.ts",
  "packages/ensemble/src/harness.ts",
  "packages/ensemble/src/run.ts",
  "packages/ensemble/src/artifacts.ts",
  "packages/ensemble/src/worktree.ts",
  "packages/ensemble/src/judge.ts",
  "packages/ensemble/src/synthesis.ts",
  "packages/ensemble/src/tool-executor.ts",
  "packages/ensemble/src/external-executor.ts",
  "packages/ensemble/src/isolation.ts",
  "packages/ensemble/src/mock.ts",
  "packages/ensemble/src/command.ts",
  "packages/tools/src/index.ts",
  "packages/tools/src/launch-context.ts",
  "packages/tools/src/registry.ts",
  "packages/harness-core/src/driver-factory.ts",
  "packages/harness-core/src/stream-json.ts",
  "packages/tool-codex/src/index.ts",
  "packages/tool-codex/src/driver.ts",
  "packages/tool-codex/src/launch.ts",
  "packages/tool-claude/src/index.ts",
  "packages/tool-claude/src/driver.ts",
  "packages/tool-claude/src/launch.ts",
  "packages/tool-cursor/src/index.ts",
  "packages/tool-cursor/src/driver.ts",
  "packages/tool-cursor/src/launch.ts",
  "packages/tool-cursor/src/bridge.ts",
  "packages/tool-opencode/src/index.ts",
  "packages/tool-opencode/src/driver.ts",
  "packages/tool-opencode/src/launch.ts",
  "packages/tool-registry/package.json",
  "packages/tool-registry/LICENSE",
  "packages/tool-registry/README.md",
  "packages/tool-registry/tsconfig.json",
  "packages/tool-registry/src/index.ts",
  "packages/tool-registry/src/test/registry.test.ts",
  "packages/routekit-cli/package.json",
  "packages/routekit-cli/LICENSE",
  "packages/routekit-cli/src/index.ts",
  "packages/routekit-cli/src/cli.ts",
  "packages/routekit-cli/src/commands/index.ts",
  "packages/routekit-cli/src/commands/context.ts",
  "packages/routekit-cli/src/commands/launchers.ts",
  "packages/routekit-cli/src/commands/accounts.ts",
  "packages/routekit-cli/src/commands/providers.ts",
  "packages/routekit-cli/src/commands/models.ts",
  "packages/routekit-cli/src/commands/config.ts",
  "packages/routekit-cli/src/commands/doctor.ts",
  "packages/routekit-cli/src/commands/install.ts",
  "packages/routekit-cli/src/commands/telemetry.ts",
  "packages/routekit-cli/src/commands/stop.ts",
  "packages/routekit-cli/src/config.ts",
  "packages/routekit-cli/src/catalog.ts",
  "packages/routekit-cli/src/launch.ts",
  "packages/routekit-cli/src/accounts.ts",
  "packages/routekit-cli/src/state.ts",
  "packages/routekit-cli/src/telemetry.ts",
  "packages/routekit-cli/src/completion.ts",
  "packages/routekit-cli/src/test/accounts-command.test.ts",
  "packages/routekit-cli/src/test/providers-command.test.ts",
  "packages/routekit-cli/src/test/cli.test.ts",
  "packages/routekit-cli/src/test/config.test.ts",
  "packages/routekit-cli/src/test/docs-contract.test.ts",
  "packages/routekit-cli/src/test/cli-process-e2e.test.ts",
  "packages/routekit-cli/src/test/launch.test.ts",
  "packages/routekit-cli/src/test/daemon-run-process-e2e.test.ts",
  "packages/routekit-cli/src/test/serve.test.ts",
  "packages/routekit-cli/src/test/state.test.ts",
  "packages/model-gateway/src/test/endpoint-health.test.ts",
  "packages/cli/src/index.ts",
  "packages/cli/src/commands/completion.ts",
  "packages/cli/src/dashboard.ts",
  "packages/cli/src/fusion-quickstart.ts",
  "packages/cli/src/fusion/env.ts",
  "packages/cli/src/fusion/observability.ts",
  "packages/cli/src/fusion/stack.ts",
  "packages/example-utils/src/index.ts",
  "packages/example-utils/src/narrate.ts",
  "packages/example-utils/src/models.ts",
  "scripts/demo.mjs",
  "scripts/check-release-publish.mjs",
  "scripts/build-fusionkit-python-packages.mjs",
  "scripts/check-routekit-cli-pack.mjs",
  "scripts/check-dual-cli-pack.mjs",
  "scripts/check-model-fusion-protocol.mjs",
  "scripts/check-generated-model-fusion-sdk.mjs",
  "scripts/generate-model-fusion-openapi-sdk.mjs",
  "scripts/generate-code-docs.mjs",
  "scripts/generate-expected-behaviors.mjs",
  "scripts/publish-npm-workspaces.mjs",
  "scripts/release.mjs",
  "scripts/lib/changelog.mjs",
  "scripts/sync-docs-changelog.mjs",
  "scripts/monorepo.mjs",
  "release/npm-packages.json",
  "release/workspace.release.json",
  "release/desired.json",
  "docs/privacy.md",
  "docs/subscription-pooling.md",
  "apps/docs/content/docs/guides/subscription-pooling.mdx",
  "apps/docs/content/docs/concepts/privacy.mdx",
  "apps/docs/content/docs/changelog.mdx",
  "docs/release-publishing.md",
  "docs/releasing.md",
  "docs/planning/ensemble-product-plan.md",
  "docs/specs/harness-prompt-passthrough.md",
  "docs/generated/code-api.md",
  "spec/testing/expected-behaviors.json",
  "docs/generated/expected-behaviors.md",
  "references/trackcn.json",
  "references/THIRD_PARTY.md",
  "references/opencode/LICENSE",
  "references/t3code/LICENSE",
  "references/cliproxyapi/LICENSE",
  "CHANGELOG.md",
  "examples/manifest.json",
  "packages/example-utils/src/manifest.ts",
  // test suites
  "packages/contracts/src/test/contracts.test.ts",
  "packages/routekit-registry/src/test/registry.test.ts",
  "packages/registry/src/test/registry.test.ts",
  "packages/protocol/src/test/protocol.test.ts",
  "packages/protocol/src/test/model-fusion.test.ts",
  "packages/protocol/src/test/tool-executor.test.ts",
  "packages/kernel/src/test/runtime.test.ts",
  "packages/tools/src/test/registry.test.ts",
  "packages/ensemble/src/test/tool-executor.test.ts",
  "packages/ensemble/src/test/external-executor.test.ts",
  "packages/ensemble/src/test/isolation.test.ts",
  "packages/tool-codex/src/test/driver.test.ts",
  "packages/tool-cursor/src/test/driver.test.ts",
  "packages/tool-claude/src/test/driver.test.ts",
  "packages/tool-opencode/src/test/opencode.test.ts",
  "packages/cli/src/test/dashboard.test.ts",
  "packages/accounts/src/test/subscription-pool.test.ts",
  "packages/accounts/src/test/subscription-account-source.test.ts",
  "packages/accounts/src/test/subscription-provider.test.ts",
  "packages/accounts/src/test/subscription-relay.test.ts",
  "packages/accounts/src/test/subscription-sdk.test.ts",
  "packages/accounts/src/test/cliproxy.test.ts",
  "packages/protocol/src/fixtures/model-fusion-contract/artifact-ref.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/artifact-ref.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/benchmark-task-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/benchmark-task-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/ensemble-receipt.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/ensemble-receipt.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-candidate-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-candidate-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-request.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-request.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-result.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-result.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/judge-synthesis-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/judge-synthesis-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/model-call-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/model-call-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-call-plan.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-call-plan.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-execution-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-execution-record.v1/realistic.json",
  "packages/workspace/src/test/workspace.test.ts",
  "packages/adapter-ai-sdk/src/test/mlx-env.test.ts",
  "packages/adapter-ai-sdk/src/test/managed-server.test.ts",
  "packages/ensemble/src/test/ensemble.test.ts",
  "packages/routekit-config/src/test/config.test.ts",
  "packages/routekit-router/src/test/router.test.ts",
  "packages/fusion-config/src/test/config.test.ts",
  "packages/cli/src/test/composition.test.ts",
  "packages/cli/src/test/stack-model-ids-e2e.test.ts",
  "packages/cli/src/test/v4-commands.test.ts",
  "test/demos.test.js",
  "examples/mlx/src/test/run.test.ts"
];

const fail = (message) => {
  console.error(`check failed: ${message}`);
  process.exitCode = 1;
};

// Every example the manifest declares (demos and infra projects alike) must
// have its entry point; the manifest is the single source the demo
// dispatcher, the acceptance suite, and this check all read.
const manifest = JSON.parse(readFileSync("examples/manifest.json", "utf8"));
for (const entry of [...manifest.demos, ...manifest.infra]) {
  requiredFiles.push(`${entry.location ?? "examples"}/${entry.directory}/src/run.ts`);
}

for (const file of requiredFiles) {
  if (!existsSync(file)) fail(`missing ${file}`);
}

for (const file of [
  "python/fusionkit-cli/src/fusionkit_cli/commands/__init__.py",
  "python/fusionkit-cli/src/fusionkit_cli/commands/bench.py",
  "python/fusionkit-cli/src/fusionkit_cli/commands/shared.py"
]) {
  if (existsSync(file)) fail(`forbidden sidecar maintainer command module: ${file}`);
}

const traceConventionsCheck = spawnSync(
  process.execPath,
  ["scripts/generate-trace-conventions.mjs", "--check"],
  { encoding: "utf8" }
);
if (traceConventionsCheck.stdout.trim()) {
  console.log(traceConventionsCheck.stdout.trim());
}
if (traceConventionsCheck.stderr.trim()) {
  console.error(traceConventionsCheck.stderr.trim());
}
if (traceConventionsCheck.status !== 0) {
  fail("trace conventions check failed");
}

const registryCheck = spawnSync(
  process.execPath,
  ["scripts/generate-registry.mjs", "--check"],
  { encoding: "utf8" }
);
if (registryCheck.stdout.trim()) {
  console.log(registryCheck.stdout.trim());
}
if (registryCheck.stderr.trim()) {
  console.error(registryCheck.stderr.trim());
}
if (registryCheck.status !== 0) {
  fail("registry bindings check failed");
}

const localCatalogCheck = spawnSync(
  process.execPath,
  ["scripts/generate-local-catalog.mjs", "--check"],
  { encoding: "utf8" }
);
if (localCatalogCheck.stdout.trim()) {
  console.log(localCatalogCheck.stdout.trim());
}
if (localCatalogCheck.stderr.trim()) {
  console.error(localCatalogCheck.stderr.trim());
}
if (localCatalogCheck.status !== 0) {
  fail("local catalog check failed");
}

const pricingCheck = spawnSync(
  process.execPath,
  ["scripts/generate-pricing.mjs", "--check"],
  { encoding: "utf8" }
);
if (pricingCheck.stdout.trim()) {
  console.log(pricingCheck.stdout.trim());
}
if (pricingCheck.stderr.trim()) {
  console.error(pricingCheck.stderr.trim());
}
if (pricingCheck.status !== 0) {
  fail("pricing check failed");
}

const modelFusionProtocolCheck = spawnSync(
  process.execPath,
  ["scripts/check-model-fusion-protocol.mjs"],
  { encoding: "utf8" }
);
if (modelFusionProtocolCheck.stdout.trim()) {
  console.log(modelFusionProtocolCheck.stdout.trim());
}
if (modelFusionProtocolCheck.stderr.trim()) {
  console.error(modelFusionProtocolCheck.stderr.trim());
}
if (modelFusionProtocolCheck.status !== 0) {
  fail("model-fusion protocol check failed");
}

const generatedCodeDocsCheck = spawnSync(
  process.execPath,
  ["scripts/generate-code-docs.mjs", "--check"],
  { encoding: "utf8" }
);
if (generatedCodeDocsCheck.stdout.trim()) {
  console.log(generatedCodeDocsCheck.stdout.trim());
}
if (generatedCodeDocsCheck.stderr.trim()) {
  console.error(generatedCodeDocsCheck.stderr.trim());
}
if (generatedCodeDocsCheck.status !== 0) {
  fail("generated code documentation check failed");
}

const expectedBehaviorsCheck = spawnSync(
  process.execPath,
  ["scripts/generate-expected-behaviors.mjs", "--check"],
  { encoding: "utf8" }
);
if (expectedBehaviorsCheck.stdout.trim()) {
  console.log(expectedBehaviorsCheck.stdout.trim());
}
if (expectedBehaviorsCheck.stderr.trim()) {
  console.error(expectedBehaviorsCheck.stderr.trim());
}
if (expectedBehaviorsCheck.status !== 0) {
  fail("expected behavior documentation check failed");
}

// The docs-site changelog page is generated from CHANGELOG.md; fail when it
// has drifted (run `node scripts/sync-docs-changelog.mjs` to regenerate).
const docsChangelogCheck = spawnSync(
  process.execPath,
  ["scripts/sync-docs-changelog.mjs", "--check"],
  { encoding: "utf8" }
);
if (docsChangelogCheck.stdout.trim()) {
  console.log(docsChangelogCheck.stdout.trim());
}
if (docsChangelogCheck.stderr.trim()) {
  console.error(docsChangelogCheck.stderr.trim());
}
if (docsChangelogCheck.status !== 0) {
  fail("docs changelog page is out of sync with CHANGELOG.md");
}

const releasePublishCheck = spawnSync(
  process.execPath,
  ["scripts/check-release-publish.mjs"],
  { encoding: "utf8" }
);
if (releasePublishCheck.stdout.trim()) {
  console.log(releasePublishCheck.stdout.trim());
}
if (releasePublishCheck.stderr.trim()) {
  console.error(releasePublishCheck.stderr.trim());
}
if (releasePublishCheck.status !== 0) {
  fail("release publish check failed");
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.private !== true) fail("package.json must remain private");
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? "")) {
  fail("packageManager must pin a concrete pnpm version");
}
if (pkg.scripts?.check !== "node scripts/check-repo.mjs") {
  fail("check script must run scripts/check-repo.mjs");
}
if (pkg.scripts?.["test:dual-cli-pack"] !== "node scripts/check-dual-cli-pack.mjs") {
  fail("test:dual-cli-pack script must run scripts/check-dual-cli-pack.mjs");
}
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
for (const command of [
  "node scripts/check-dual-cli-pack.mjs",
  "node --test packages/cli/dist/test/stack-model-ids-e2e.test.js"
]) {
  if (!ciWorkflow.includes(command)) fail(`CI workflow must run ${command}`);
}

const npmrc = readFileSync(".npmrc", "utf8");
for (const setting of [
  "engine-strict=true",
  "package-manager-strict=true",
  "strict-peer-dependencies=true",
  "ignore-scripts=true",
  "verify-store-integrity=true",
  "minimum-release-age-exclude[]=@velum-labs/model-fusion-protocol"
]) {
  if (!npmrc.includes(setting)) fail(`.npmrc missing ${setting}`);
}

// Dependency policy: third-party dependencies are allowed in any workspace
// package, but only trusted, exact-pinned versions reviewed onto this
// allowlist. There is no "kernel must be zero-dependency" rule: trust comes
// from pinning known-good versions and from the supply-chain controls in
// .npmrc (frozen lockfile, ignore-scripts, verify-store-integrity, a minimum
// release age), not from the absence of dependencies. The protocol/sdk
// packages still happen to use only Node built-ins, which keeps the offline
// verifier maximally auditable, but that is now a property, not a gate.
//
// Every third-party version must be pinned exactly (no ranges) and listed
// here. Bumping a dependency means updating this allowlist, which is the
// review checkpoint.
const TRUSTED_THIRD_PARTY = new Map([
  // The @ai-sdk/harness* packages are experimental canary releases (the AI
  // SDK 7 harness abstraction); they are pinned exactly like every other
  // dependency and bumped only as reviewed allowlist changes.
  ["@ai-sdk/harness", "1.0.0-canary.6"],
  ["@ai-sdk/harness-claude-code", "1.0.0-canary.2"],
  ["@ai-sdk/harness-pi", "1.0.0-canary.2"],
  ["@ai-sdk/openai-compatible", "2.0.48"],
  ["@ai-sdk/provider", "4.0.2"],
  ["@ai-sdk/sandbox-just-bash", "1.0.0-canary.6"],
  ["@ai-sdk/sandbox-vercel", "1.0.0-canary.6"],
  ["@ai-sdk/tui", "1.0.0-canary.6"],
  // Official coding-agent SDKs that back the harness-core drivers: each drives
  // one CLI's native protocol (codex app-server threads, Claude Agent SDK,
  // Zed ACP for cursor-agent, opencode HTTP), pinned exactly like every other
  // dependency and bumped only as reviewed allowlist changes.
  ["@anthropic-ai/claude-agent-sdk", "0.3.198"],
  // Cloudflare Quick Tunnel wrapper (unjs), retained by packages outside the
  // trimmed FusionKit CLI dependency closure. Downloads the official
  // cloudflared binary at runtime (no install scripts).
  ["untun", "0.1.3"],
  ["@openai/codex-sdk", "0.145.0"],
  // OpenTelemetry: the tracing engine behind @fusionkit/tracing (spans + log
  // events, W3C propagation, batching, OTLP export). The exporter/logs line is
  // 0.x upstream; both lines are pinned exactly and bumped only as reviewed
  // allowlist changes.
  ["@opentelemetry/api", "1.9.1"],
  ["@opentelemetry/api-logs", "0.220.0"],
  ["@opentelemetry/exporter-logs-otlp-http", "0.220.0"],
  ["@opentelemetry/exporter-trace-otlp-http", "0.220.0"],
  ["@opentelemetry/resources", "2.9.0"],
  ["@opentelemetry/sdk-logs", "0.220.0"],
  ["@opentelemetry/sdk-trace-base", "2.9.0"],
  ["@opentelemetry/sdk-trace-node", "2.9.0"],
  ["@opencode-ai/sdk", "1.17.13"],
  ["@zed-industries/agent-client-protocol", "0.4.5"],
  ["@types/figlet", "1.7.0"],
  ["@types/node", "22.19.20"],
  ["@types/react", "19.2.17"],
  ["@velum-labs/cursorkit", "0.2.0"],
  // Temporarily consumed from the in-repo contract source: the WS8.5
  // heuristic rename changed the schema bundle and v0.6.0 is prepared in
  // spec/model-fusion-contract but not yet published. Restore an exact
  // registry pin ("0.6.0") once the model-fusion-protocol-v0.6.0 tag ships.
  ["@velum-labs/model-fusion-protocol", "file:spec/model-fusion-contract"],
  ["@vercel/sandbox", "2.4.0"],
  ["ai", "6.0.200"],
  ["commander", "14.0.3"],
  ["figlet", "1.11.0"],
  // The CLI's Ink-based presentation layer (@routekit/cli-ui): React for
  // terminals plus its testing harness, pinned exactly like everything else.
  ["ink", "7.1.0"],
  ["ink-testing-library", "4.0.0"],
  ["react", "19.2.7"],
  ["jose", "6.2.3"],
  ["just-bash", "3.0.1"],
  ["minimatch", "10.2.5"],
  ["ms", "2.1.3"],
  // Official OpenAI SDK retained for packages that consume OpenAI-compatible
  // discovery APIs. Public routing and provider egress belong to RouteKit;
  // the internal Python sidecar has no provider implementation.
  ["openai", "6.46.0"],
  ["pino", "10.3.1"],
  // Product telemetry engine: official PostHog server SDK (batched, async,
  // shutdown flush). Only the CLI's opt-in telemetry module uses it.
  ["posthog-node", "5.46.0"],
  // TOML parser/serializer used by RouteKit-owned Codex configuration.
  ["smol-toml", "1.7.0"],
  ["string-width", "8.2.1"],
  ["turbo", "2.10.5"],
  ["typescript", "6.0.3"],
  ["ws", "8.21.0"],
  ["yaml", "2.9.0"],
  ["zod", "4.4.3"]
]);

// The private Next.js applications share the frozen workspace lockfile and
// exact-pin policy, but retain their framework-compatible toolchain versions.
// Keeping this as an explicit extension preserves the core allowlist's
// single-version invariant while making application dependency review equally
// visible.
const TRUSTED_APP_THIRD_PARTY = new Map([
  ...TRUSTED_THIRD_PARTY,
  ["@tailwindcss/postcss", "4.3.1"],
  ["@types/mdx", "2.0.14"],
  ["@types/react-dom", "19.2.3"],
  ["class-variance-authority", "0.7.1"],
  ["clsx", "2.1.1"],
  ["fumadocs-core", "15.8.5"],
  ["fumadocs-mdx", "11.10.1"],
  ["fumadocs-openapi", "8.1.12"],
  ["fumadocs-ui", "15.8.5"],
  ["lucide-react", "1.20.0"],
  ["mermaid", "11.15.0"],
  ["next", "15.5.19"],
  ["next-themes", "0.4.6"],
  ["radix-ui", "1.6.0"],
  ["react-dom", "19.2.7"],
  ["recharts", "2.15.4"],
  ["shadcn", "4.11.0"],
  ["tailwind-merge", "3.6.0"],
  ["tailwindcss", "4.3.1"],
  ["tw-animate-css", "1.4.0"],
  ["tsx", "4.22.4"],
  ["typescript", "5.9.3"]
]);

function checkDeps(manifestPath, manifest, trustedDependencies = TRUSTED_THIRD_PARTY) {
  for (const [section, deps] of [
    ["dependencies", manifest.dependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}]
  ]) {
    for (const [name, version] of Object.entries(deps)) {
      if (isInternalWorkspaceDependency(name)) {
        if (version !== "workspace:*") {
          fail(`${manifestPath} ${section} "${name}": internal packages must use workspace:*`);
        }
        continue;
      }
      const trusted = trustedDependencies.get(name);
      if (trusted === undefined) {
        fail(
          `${manifestPath} ${section} "${name}": not on the trusted dependency allowlist in scripts/check-repo.mjs`
        );
      } else if (version !== trusted) {
        fail(
          `${manifestPath} ${section} "${name}": version "${version}" must be the exact trusted pin "${trusted}"`
        );
      }
    }
  }
}

// Root manifest may carry only allowlisted, exact-pinned dev tooling.
checkDeps("package.json", pkg);

const releaseManifest = JSON.parse(readFileSync("release/npm-packages.json", "utf8"));
const publishableWorkspaceDirs = new Set(
  (releaseManifest.packages ?? []).map((entry) => entry.path)
);

const workspaceDirs = [
  ...readdirSync("packages").map((dir) => join("packages", dir)),
  ...readdirSync("examples").map((dir) => join("examples", dir)),
  ...readdirSync("apps").map((dir) => join("apps", dir))
];
const workspaceManifests = [];
for (const dir of workspaceDirs) {
  if (!statSync(dir).isDirectory()) continue;
  const trackedPackageJson = spawnSync("git", ["ls-files", join(dir, "package.json")], {
    encoding: "utf8"
  });
  if (
    trackedPackageJson.status !== 0 ||
    (!trackedPackageJson.stdout.trim() && !publishableWorkspaceDirs.has(dir))
  ) {
    fail(`stale build debris in ${dir} — git clean it (no tracked package.json)`);
  }
}
for (const dir of workspaceDirs) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (publishableWorkspaceDirs.has(dir)) {
    if (manifest.private !== false) {
      fail(`${manifestPath} must set private:false because it is in release/npm-packages.json`);
    }
  } else if (manifest.private !== true) {
    fail(`${manifestPath} must remain private`);
  }
  // Test discovery is workspace-driven (`pnpm -r run test`), so a package with
  // tests but no `test` script would silently drop out of the suite.
  if (existsSync(join(dir, "src", "test")) && manifest.scripts?.test === undefined) {
    fail(`${manifestPath} has src/test/ but no "test" script — its tests would never run`);
  }
  checkDeps(
    manifestPath,
    manifest,
    dir.startsWith("apps/") ? TRUSTED_APP_THIRD_PARTY : TRUSTED_THIRD_PARTY
  );
  workspaceManifests.push({ manifestPath, manifest, dir });
}

// Architectural direction is strict: RouteKit is the neutral foundation and
// FusionKit may build on it, never the reverse. Traverse workspace manifests so
// an apparently-neutral package cannot acquire FusionKit transitively through
// another RouteKit package.
for (const violation of routekitDependencyViolations(workspaceManifests)) {
  fail(
    `${violation.manifestPath} RouteKit dependency reaches FusionKit: ` +
      violation.dependencyPath.join(" -> ")
  );
}
for (const violation of canonicalSharedPackageViolations(workspaceManifests)) {
  fail(`canonical shared package violation: ${violation}`);
}
for (const violation of fusionkitCompositionViolations(workspaceManifests)) {
  fail(`FusionKit composition violation: ${violation}`);
}
for (const violation of toolRegistryCompositionViolations(workspaceManifests)) {
  fail(`tool registry composition violation: ${violation}`);
}
for (const consumerName of ["@routekit/cli", "@fusionkit/cli"]) {
  const consumer = workspaceManifests.find(({ manifest }) => manifest.name === consumerName);
  const sources =
    consumer !== undefined && existsSync(join(consumer.dir, "src"))
      ? routekitProductionSources(consumer.dir)
      : [];
  for (const violation of toolRegistryCliSourceViolations(consumerName, sources)) {
    fail(`tool registry consumer violation: ${violation}`);
  }
}
const productionSources = workspaceManifests.flatMap(({ dir }) =>
  existsSync(join(dir, "src")) ? routekitProductionSources(dir) : []
);
for (const violation of toolRegistryConstructionViolations(productionSources)) {
  fail(`tool registry construction violation: ${violation}`);
}
for (const { file, source } of productionSources) {
  for (const violation of polynomialTrailingSlashRegexViolations(file, source)) {
    fail(`unsafe trailing-slash normalization: ${violation}`);
  }
}
for (const file of [
  "packages/tool-registry/package.json",
  "packages/tool-registry/README.md",
  "packages/tool-registry/tsconfig.json",
  "packages/tool-registry/src/index.ts",
  "packages/tool-registry/src/test/registry.test.ts"
]) {
  if (/(?:@fusionkit\/|\b(?:fusionkit|fusion|fused)\b)/i.test(readFileSync(file, "utf8"))) {
    fail(`${file} must not contain FusionKit dependencies or vocabulary`);
  }
}

// Shared process/config/CLI behavior has one public owner. These historical
// local facades make duplicate implementations easy to reintroduce.
for (const wrapper of [
  "packages/tools/src/proc.ts",
  "packages/tools/src/env.ts",
  "packages/cli/src/shared/proc.ts",
  "packages/cli/src/shared/context.ts",
  "packages/cli/src/shared/errors.ts",
  "packages/cli/src/shared/flag-suggest.ts",
  "packages/cli/src/shared/pickers.ts",
  "packages/cli/src/shared/package-version.ts",
  "packages/cli/src/fusion/cliproxy.ts"
]) {
  if (existsSync(wrapper)) fail(`forbidden local shared-core wrapper: ${wrapper}`);
}

for (const legacyHarness of [
  "packages/tool-codex/src/harness.ts",
  "packages/tool-claude/src/harness.ts",
  "packages/tool-cursor/src/harness.ts",
  "packages/tool-opencode/src/harness.ts",
  "packages/tool-claude/src/stream-trajectory.ts",
  "packages/tool-cursor/src/stream-trajectory.ts"
]) {
  if (existsSync(legacyHarness)) fail(`forbidden parallel harness implementation: ${legacyHarness}`);
}

const retiredToolNames = new RegExp(
  `@fusionkit/(?:tools|harness-core|tool-(?:codex|claude|cursor|opencode))|` +
    `FUSIONKIT_${"HARNESS"}_${"DRIVERS"}`
);
for (const { manifestPath, manifest } of workspaceManifests) {
  if (retiredToolNames.test(JSON.stringify(manifest))) {
    fail(`${manifestPath} references a retired tool package or cutover flag`);
  }
}

// RouteKit production source names and imports must remain product-neutral.
// Tests and docs are intentionally excluded: they need to assert the boundary
// and explain FusionKit without triggering vocabulary false positives.
for (const { manifest, dir } of workspaceManifests) {
  if (!manifest.name?.startsWith("@routekit/") || !existsSync(join(dir, "src"))) continue;
  for (const { file, source } of routekitProductionSources(dir)) {
    for (const violation of routekitSourceViolations(file, source)) {
      fail(`${file}: RouteKit architecture violation: ${violation}`);
    }
  }
}

// The signed-run/receipt governance protocol is legacy Warrant surface. It
// remains in @fusionkit/protocol for compatibility in this phase and must not
// be mistaken for, copied into, or rebranded as RouteKit's neutral contracts.
const protocolManifest = JSON.parse(readFileSync("packages/protocol/package.json", "utf8"));
if (protocolManifest.name !== "@fusionkit/protocol") {
  fail("legacy governance protocol must remain explicitly owned by @fusionkit/protocol");
}
for (const file of ["types.ts", "api.ts", "receipt.ts", "contract.ts", "chain.ts"]) {
  if (existsSync(join("packages", "contracts", "src", file))) {
    fail(`legacy governance protocol ${file} must not move into @routekit/contracts`);
  }
}

// No deferred-work markers in tracked sources: anything worth flagging is
// either fixed or documented as a deliberate decision. The pattern is
// assembled from parts so this guard does not match itself.
const todoMarker = new RegExp(`TODO${"\\("}(hardcoded|brittle|lib)${"\\)"}`);
const sourceListing = spawnSync(
  "git",
  ["ls-files", "*.ts", "*.mjs", "*.js", "*.yml", "*.yaml", "*.md"],
  { encoding: "utf8" }
);
if (sourceListing.status === 0) {
  for (const file of sourceListing.stdout.split("\n").filter((l) => l.length > 0)) {
    if (file === "scripts/check-repo.mjs") continue;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (todoMarker.test(lines[i])) {
        fail(`deferred-work marker in ${file}:${i + 1} — fix it or document the decision`);
      }
    }
  }
}

// The CLI renders exclusively through the @routekit/cli-ui presenter (UI on
// stderr, machine payloads on stdout). Raw console.* calls bypass that
// contract — non-interactive degradation, --json purity, NO_COLOR — so they
// are disallowed in the CLI and UI sources (tests excluded).
const noConsoleListing = spawnSync(
  "git",
  [
    "ls-files",
    "packages/cli/src/**/*.ts",
    "packages/cli-core/src/**/*.ts",
    "packages/cli-ui/src/**/*.ts",
    "packages/cli-ui/src/**/*.tsx"
  ],
  { encoding: "utf8" }
);
if (noConsoleListing.status === 0) {
  const consolePattern = /\bconsole\.(log|error|warn|info|debug|trace)\(/;
  for (const file of noConsoleListing.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.includes("/test/")) continue;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (consolePattern.test(lines[i])) {
        fail(`raw console output in ${file}:${i + 1} — render through the @routekit/cli-ui presenter instead`);
      }
    }
  }
}

// Spawned children must never inherit the full parent environment: a panel
// model or harness child that can run shell commands would see every
// credential the parent holds (and persist them into trajectories/artifacts).
// All spawn/exec env objects must be built through @routekit/runtime's
// buildChildEnv allowlist; spreading process.env into an env literal is only
// permitted inside the canonical runtime itself (which implements the policy).
const envSpreadListing = spawnSync(
  "git",
  ["ls-files", "packages/*/src/**/*.ts"],
  { encoding: "utf8" }
);
// A deliberate exception for a trusted infrastructure child must carry an
// `env-spread-allowed: <reason>` comment on the preceding line. The internal
// Python sidecar is not such an exception: it receives a restricted environment
// and calls namespaced RouteKit model IDs.
if (envSpreadListing.status === 0) {
  const envSpreadPattern = /\.\.\.process\.env\b/;
  const waiverPattern = /env-spread-allowed:\s*\S/;
  for (const file of envSpreadListing.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.startsWith("packages/runtime-utils/")) continue;
    if (file.includes("/test/")) continue;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (envSpreadPattern.test(lines[i]) && !waiverPattern.test(lines[i - 1] ?? "")) {
        fail(
            `full parent env spread in ${file}:${i + 1} — build the child env with buildChildEnv (@routekit/runtime), ` +
            `or add an "env-spread-allowed: <reason>" comment for a trusted infra child`
        );
      }
    }
  }
}

// Local secrets files must never be tracked, whatever .gitignore says.
const trackedEnvFiles = spawnSync("git", ["ls-files", ".env", ".env.*", "**/.env", "**/.env.*"], {
  encoding: "utf8"
});
if (trackedEnvFiles.status === 0) {
  for (const file of trackedEnvFiles.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.endsWith(".example")) continue;
    fail(`secrets file is tracked in git: ${file}`);
  }
}

// Build artifacts must never be tracked: a committed .tsbuildinfo makes
// `tsc -b` skip emit on fresh clones, which breaks `pnpm build` from scratch.
const tracked = spawnSync(
  "git",
  ["ls-files", "*.tsbuildinfo", "**/dist/**"],
  { encoding: "utf8" }
);
if (tracked.status === 0) {
  for (const file of tracked.stdout.split("\n").filter((line) => line.length > 0)) {
    fail(`build artifact is tracked in git: ${file}`);
  }
}

const kernelWrapperGuards = [
  {
    file: "packages/cli/src/gateway.ts",
    snippets: ["new FusionBackend({", "runFuseStep: createKernelFuseStepRunner()"]
  },
  {
    file: "packages/fusion-gateway/src/fusion-proxy.ts",
    snippets: ["runFrontdoorRequest(this.#services", "new FusionTurnAssembler(", "new FusionVendorProxy("]
  },
  {
    file: "packages/fusion-gateway/src/fusion-vendor-proxy.ts",
    snippets: ["async proxy(", "failoverNotice(", "firstSseSignal("]
  },
  {
    file: "packages/fusion-gateway/src/frontdoor/request.ts",
    snippets: [
      "class FrontdoorRequestScheduler",
      "frontdoorBudgetGateOperator",
      "frontdoorResolveModelOperator",
      "frontdoorVendorProxyOperator",
      "runFusionTurnResponse"
    ]
  },
  {
    file: "packages/fusion-gateway/src/frontdoor/workflow.ts",
    snippets: [
      "frontdoorPanelOperator",
      "frontdoorFuseOperator",
      "frontdoorFinalizeOperator",
      "frontdoorStreamingFuseOperator"
    ]
  },
  {
    file: "packages/ensemble/src/run.ts",
    snippets: ["ensembleRunWorkflow({ descriptor })"]
  },
  {
    file: "python/fusionkit-server/src/fusionkit_server/app.py",
    snippets: ["kernel = FusionKernel(engine, native_runs)"]
  },
  {
    file: "packages/ensemble/src/kernel-gateway.ts",
    snippets: ["createKernelFuseStepRunner", "captureWireResponse", "WireArtifactTypes.TrajectoryFuseStepResponse"]
  },
  {
    file: "packages/ensemble/src/kernel-backend.ts",
    snippets: ["captureWireResponse", "WireArtifactTypes.WireResponse"]
  }
];
for (const guard of kernelWrapperGuards) {
  if (!existsSync(guard.file)) continue;
  const text = readFileSync(guard.file, "utf8");
  for (const snippet of guard.snippets) {
    if (!text.includes(snippet)) {
      fail(`kernel wrapper guard failed: ${guard.file} must include ${snippet}`);
    }
  }
}

// Docs-consistency guard: the front-door workflow ids and operator kinds are the
// product's public vocabulary, so the docs must name them. This fails CI if the
// operators/workflows are renamed without updating the docs (fixes doc drift at
// the process level).
const docsConsistencyTerms = [
  "fusion-frontdoor-request",
  "fusion-frontdoor-turn",
  "frontdoor.budget-gate",
  "frontdoor.resolve-model",
  "frontdoor.vendor-proxy",
  "frontdoor.panel",
  "frontdoor.fuse",
  "frontdoor.finalize"
];
const docsConsistencyFiles = [
  "docs/fusion/kernel-migration.md"
];
for (const term of docsConsistencyTerms) {
  const documented = docsConsistencyFiles.some((file) => readFileSync(file, "utf8").includes(term));
  if (!documented) {
    fail(`docs-consistency guard failed: no doc/runtime-explain surface names "${term}"`);
  }
}

// FusionKit product versions must stay in lockstep across the npm CLI, the PyPI
// synthesizer pin, and the release coordinator's desired versions.
function readPyprojectVersion(relPath) {
  const text = readFileSync(relPath, "utf8");
  const match = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function readFusionkitPypiPin() {
  const text = readFileSync("packages/cli/src/fusion/env.ts", "utf8");
  const match = text.match(/export const FUSIONKIT_PYPI_VERSION = "([^"]+)"/);
  return match ? match[1] : null;
}

const cliPackageVersion = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;
const pypiCliVersion = readPyprojectVersion("python/fusionkit-cli/pyproject.toml");
const pypiPin = readFusionkitPypiPin();
const desired = JSON.parse(readFileSync("release/desired.json", "utf8")).versions ?? {};

const lockstepVersions = new Map([
  ["packages/cli/package.json", cliPackageVersion],
  ["python/fusionkit-cli/pyproject.toml", pypiCliVersion],
  ["packages/cli/src/fusion/env.ts (FUSIONKIT_PYPI_VERSION)", pypiPin],
  ["release/desired.json#handoffkit", desired.handoffkit ?? null],
  ["release/desired.json#fusionkit-pypi", desired["fusionkit-pypi"] ?? null]
]);

const uniqueVersions = [...new Set([...lockstepVersions.values()].filter((value) => value != null))];
if (uniqueVersions.length > 1) {
  const detail = [...lockstepVersions.entries()]
    .map(([source, value]) => `  ${source}: ${value ?? "(missing)"}`)
    .join("\n");
  fail(`FusionKit version lockstep violated:\n${detail}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("repo check passed");
