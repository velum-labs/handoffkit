"""Mutation pass: prove the e2e test suites are load-bearing.

Protocol per mutation: apply a targeted break to PRODUCT code -> run the suite
expected to catch it (must FAIL) -> revert -> rerun the same suite (must
PASS). A mutation that survives (its suite passes while the product is broken)
is a finding against the tests, and this script exits non-zero.

Run from the repo root with both toolchains available (uv + a built pnpm
workspace)::

    uv run python scripts/mutation_pass.py            # full pass
    uv run python scripts/mutation_pass.py M31 M32    # only these mutations

Not part of CI's per-commit path because it runs each targeted suite twice;
run it when touching the testkit, provider clients, CLI process boundaries,
or engine/gateway wire paths. The mutation inventory is expected to grow, so
documentation intentionally avoids a fixed score (see docs/testing.md).
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Mutation:
    id: str
    what: str
    file: str
    old: str
    new: str
    cmd: str
    replace_all: bool = False
    build: bool = False


MUTATIONS = [
    Mutation(
        id="M1",
        what="RouteKit stream client drops parallel tool-call slots beyond the first",
        file="python/fusionkit-core/src/fusionkit_core/routekit_client.py",
        old="for fragment in fragments[1:]:",
        new="for fragment in fragments[1:1]:",
        cmd=(
            "uv run pytest python/fusionkit-core/tests/test_routekit_client.py "
            "-q -x -k simultaneous"
        ),
    ),
    Mutation(
        id="M2",
        what="transient provider errors are never retried",
        file="packages/model-gateway/src/router.ts",
        old="    return isRetryableProviderFailure(failure.category);",
        new="    return false;",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'cools a throttled instance' "
            "packages/model-gateway/dist/test/router.test.js"
        ),
    ),
    Mutation(
        id="M4",
        what="out-of-band reasoning fields are dropped by the RouteKit wire parser",
        file="python/fusionkit-core/src/fusionkit_core/routekit_client.py",
        old='for field in ("reasoning", "reasoning_content"):',
        new="for field in ():",
        cmd=(
            "uv run pytest python/fusionkit-core/tests/test_routekit_client.py "
            "-q -x -k reasoning"
        ),
    ),
    Mutation(
        id="M5",
        what="the engine silently drops the caller's tools",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old="tools=tools,",
        new="tools=None,",
        replace_all=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern 'tool loop' "
            "packages/cli/dist/test/stack-e2e.test.js"
        ),
    ),
    Mutation(
        id="M6",
        what="the Cursor BYOK hybrid translation is skipped at the gateway",
        file="packages/model-gateway/src/server.ts",
        old="      const translated = translateCursorRequest(raw);",
        new="      const translated = raw;",
        build=True,
        cmd=(
            "node --test packages/model-gateway/dist/test/cursor.test.js"
        ),
    ),
    Mutation(
        id="M7",
        what="the engine's SSE streams never terminate with [DONE]",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old='yield "data: [DONE]\\n\\n"',
        new='yield "data: {}\\n\\n"',
        replace_all=True,
        cmd="PORTLESS=0 node --test packages/testkit/dist/test/testkit.test.js",
    ),
    Mutation(
        id="M8",
        what="Node panel proposals send provider model names instead of opaque endpoint ids",
        file="packages/ensemble/src/panel-propose.ts",
        old="model: model.id,",
        new="model: model.model,",
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-endpoint-ids-e2e.test.js",
    ),
    Mutation(
        id="M9",
        what="the engine drops per-request prompt overrides on the fuse step",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old="prompts=request.prompts,",
        new="prompts=None,",
        replace_all=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern prompt "
            "packages/cli/dist/test/stack-depth-e2e.test.js"
        ),
    ),
    Mutation(
        id="M11",
        what=(
            "a request-pinned judge no longer doubles as the synthesizer "
            "(regression guard for the multi-ensemble routing bug)"
        ),
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old="or request.judge_model",
        new="or None",
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-depth-e2e.test.js",
    ),
    Mutation(
        id="M12",
        what="the Node gateway forwards empty ensemble prompt overrides",
        file="packages/fusion-gateway/src/fusion-turn.ts",
        old=(
            "    if (route?.prompts !== undefined && Object.keys(route.prompts).length > 0) "
            "stepBody.prompts = route.prompts;"
        ),
        new=(
            "    if (route?.prompts !== undefined && Object.keys(route.prompts).length > 0) "
            "stepBody.prompts = {};"
        ),
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-depth-e2e.test.js",
    ),
    Mutation(
        id="M13",
        what=(
            "the Anthropic adapter's non-streaming JSON path renders fused tool "
            "calls with empty input (caught by the door matrix's tool loop)"
        ),
        file="packages/model-gateway/src/adapters/anthropic.ts",
        old=(
            "      content.push({\n"
            '        type: "tool_use",\n'
            "        id: call.id ?? `toolu_${randomId()}`,\n"
            '        name: call.function?.name ?? "",\n'
            "        input\n"
            "      });"
        ),
        new=(
            "      content.push({\n"
            '        type: "tool_use",\n'
            "        id: call.id ?? `toolu_${randomId()}`,\n"
            '        name: call.function?.name ?? "",\n'
            "        input: {}\n"
            "      });"
        ),
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-e2e.test.js",
    ),
    Mutation(
        id="M14",
        what=(
            "the Anthropic adapter's STREAMING path drops tool-call argument "
            "deltas (the real claude binary executes the wrong command)"
        ),
        file="packages/model-gateway/src/adapters/anthropic.ts",
        old='delta: { type: "input_json_delta", partial_json: args }',
        new='delta: { type: "input_json_delta", partial_json: "{}" }',
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-cli-e2e.test.js",
    ),
    Mutation(
        id="M15",
        what=(
            "finite-k terminal proposals lose their required textual wire summary "
            "(valid bounded rollouts are rejected)"
        ),
        file="packages/ensemble/src/panel-orchestration.ts",
        old="    final_output: finalOutput,",
        new="    final_output: trajectory.finalOutput,",
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-harness-k-e2e.test.js",
    ),
    Mutation(
        id="M16",
        what="k=1 proposal panels ignore straggler grace and wait for the slowest member",
        file="packages/ensemble/src/panel-propose.ts",
        old="        graceMs: options.stragglerGraceMs,",
        new="        graceMs: undefined,",
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern straggler "
            "packages/cli/dist/test/stack-chaos-e2e.test.js"
        ),
    ),
    Mutation(
        id="M17",
        what="Claude's harness-core driver bypasses the native per-member dialect gateway",
        file="packages/ensemble/src/driver-adapter.ts",
        old="    const endpointUrl = options.modelEndpoints?.[modelId];",
        new='    const endpointUrl = options.modelEndpoints?.["__missing__"];',
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern claude-agent-sdk "
            "packages/cli/dist/test/stack-drivers-e2e.test.js"
        ),
    ),
    Mutation(
        id="M18",
        what="a stale native session cursor makes every follow-up driver turn fail",
        file="packages/ensemble/src/driver-adapter.ts",
        old="  return stale.test(folded.error.message);",
        new="  return false;",
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern claude-agent-sdk "
            "packages/cli/dist/test/stack-drivers-e2e.test.js"
        ),
    ),
    Mutation(
        id="M20",
        what="the RouteKit catalog ignores configured provider base URLs",
        file="packages/model-gateway/src/router.ts",
        old="    baseUrl: endpoint.baseUrl,",
        new='    baseUrl: "http://127.0.0.1:1",',
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-npm-cli-e2e.test.js",
    ),
    Mutation(
        id="M21",
        what="the gateway budget gate never stops an over-budget session",
        file="packages/fusion-gateway/src/frontdoor/operators.ts",
        old=(
            "        services.budgetUsd !== undefined && services.costTotalUsd(req.sessionKey) "
            ">= services.budgetUsd;"
        ),
        new="        false;",
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern budgetUsd "
            "packages/cli/dist/test/stack-policies-e2e.test.js"
        ),
    ),
    Mutation(
        id="M22",
        what="AI SDK tool execution failures disappear from managed trajectories",
        file="packages/adapter-ai-sdk/src/worktree-agent.ts",
        old='    } else if (part.type === "tool-error") {',
        new="    } else if (false) {",
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern 'path traversal' "
            "packages/cli/dist/test/stack-harness-k-e2e.test.js"
        ),
    ),
    Mutation(
        id="M24",
        what="unbounded completed candidates are never restored from the durable turn cache",
        file="packages/fusion-gateway/src/fusion-session.ts",
        old="    const cacheable = !isFiniteK(input.k);",
        new="    const cacheable = false;",
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-resume-e2e.test.js",
    ),
    Mutation(
        id="M25",
        what="gateway bearer authentication is bypassed on every front door",
        file="packages/model-gateway/src/server.ts",
        old="    if (authToken !== undefined && !authorizedRequest(req, authToken)) {",
        new="    if (false) {",
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-auth-e2e.test.js",
    ),
    Mutation(
        id="M26",
        what="k=1 panel member reasoning is dropped before trajectories reach the judge",
        file="packages/ensemble/src/panel-propose.ts",
        old="  if (reasoning.length > 0) {",
        new="  if (false) {",
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern reasoning "
            "packages/cli/dist/test/stack-e2e.test.js"
        ),
    ),
    Mutation(
        id="M27",
        what="streamed synthesizer model reasoning is dropped before the gateway",
        file="python/fusionkit-core/src/fusionkit_core/routekit_client.py",
        old="                    model_reasoning_delta=_reasoning(delta),",
        new="                    model_reasoning_delta=None,",
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern reasoning "
            "packages/cli/dist/test/stack-e2e.test.js"
        ),
    ),
    Mutation(
        id="M28",
        what="the real Claude CLI ignores the injected named fused model",
        file="packages/testkit/src/clis.ts",
        old='    ANTHROPIC_MODEL: input.model ?? "fusion-panel",',
        new='    ANTHROPIC_MODEL: "fusion-panel",',
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern "
            "'\\[claude\\].*fusion-mini' packages/cli/dist/test/stack-cli-e2e.test.js"
        ),
    ),
    Mutation(
        id="M29",
        what="the real Codex CLI ignores the injected named fused model",
        file="packages/testkit/src/clis.ts",
        old='      `model = "${input.model ?? "fusion-panel"}"`,',
        new='      \'model = "fusion-panel"\',',
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern "
            "'\\[codex\\].*fusion-mini' packages/cli/dist/test/stack-cli-e2e.test.js"
        ),
    ),
    Mutation(
        id="M30",
        what="the real OpenCode CLI ignores the injected named fused model",
        file="packages/testkit/src/clis.ts",
        old='  const model = input.model ?? "fusion-panel";',
        new='  const model = "fusion-panel";',
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern "
            "'\\[opencode\\].*fusion-mini' packages/cli/dist/test/stack-cli-e2e.test.js"
        ),
    ),
    Mutation(
        id="M31",
        what="structural door validation is disabled (malformed bodies reach the panel)",
        file="packages/model-gateway/src/adapters/validate.ts",
        old="export function validateChatRequest(body: unknown): WireRejection | undefined {",
        new=(
            # An unconditional `return undefined;` would make the rest of the
            # function unreachable (or over-narrow `body`) and fail tsc, so gate
            # it on a value tsc cannot reason about that is always true at run
            # time.
            "export function validateChatRequest(body: unknown): WireRejection | undefined {\n"
            "  if (Date.now() > 0) return undefined;"
        ),
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-fuzz-e2e.test.js",
    ),
    Mutation(
        id="M32",
        what="FusionBackend's own boundary guard is removed (empty fused turns leak 502 internals)",
        file="packages/fusion-gateway/src/fusion-proxy.ts",
        old="    if (messages.length === 0) {",
        new="    if (false) {",
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern 'unknown-only input' "
            "packages/cli/dist/test/stack-fuzz-e2e.test.js"
        ),
    ),
    Mutation(
        id="M33",
        what="concurrent turns share state (every stream answers with the first request's text)",
        file="python/fusionkit-testkit/src/fusionkit_testkit/server.py",
        old=(
            "            self._default_counts[model] += 1\n"
            "            count = self._default_counts[model]"
        ),
        new=(
            '            self._default_counts[model] += 1\n'
            '            count = self._default_counts[model]\n'
            '        last_user_text = "poisoned shared reply"'
        ),
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-concurrency-e2e.test.js",
    ),
    Mutation(
        id="M34",
        what="streaming fusion usage drops panel-member tokens",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old='extra["usage"] = _usage_payload(_fuse_step_usage(final_result))',
        new='extra["usage"] = _usage_payload(final_result.turn_usage())',
        cmd=(
            "uv run pytest python/fusionkit-server/tests/test_streaming.py -q -x "
            "-k fused_streaming_streams_synthesizer"
        ),
    ),
    Mutation(
        id="M35",
        what="unknown RouteKit endpoint ids silently enter sidecar fusion",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old="        for endpoint_id in (judge_model, synthesizer_model):",
        new="        for endpoint_id in ():",
        cmd=(
            "uv run pytest python/fusionkit-server/tests/test_server.py -q -x "
            "-k unknown_routekit_endpoint"
        ),
    ),
    Mutation(
        id="M36",
        what="idempotency initialization ignores an existing canonical run",
        file="python/fusionkit-core/src/fusionkit_core/run_store.py",
        old=(
            "                if path.exists():\n"
            "                    return IdempotencyRecord.model_validate(_read_json(path)), False"
        ),
        new=(
            "                if False:\n"
            "                    return IdempotencyRecord.model_validate(_read_json(path)), False"
        ),
        cmd=(
            "uv run pytest python/fusionkit-core/tests/test_fusion_run.py -q -x "
            "-k concurrent_idempotency"
        ),
    ),
    Mutation(
        id="M37",
        what="Anthropic streaming discards upstream provider error events",
        file="packages/model-gateway/src/adapters/anthropic.ts",
        old="    if (chunk.error !== undefined && chunk.error !== null) {",
        new="    if (false) {",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'mid-stream error' "
            "packages/model-gateway/dist/test/anthropic.test.js"
        ),
    ),
    Mutation(
        id="M38",
        what="expired live session hints keep reattaching fresh conversations",
        file="packages/fusion-gateway/src/fusion-session.ts",
        old="    this.#sweepExpired(Date.now());",
        new="    // mutation: stale hints are never swept",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'identical fresh opener' "
            "packages/fusion-gateway/dist/test/fusion-backend-session.test.js"
        ),
    ),
    Mutation(
        id="M39",
        what="caller abort no longer reaches an in-flight panel run",
        file="packages/fusion-gateway/src/fusion-proxy.ts",
        old="      ...(signal !== undefined ? { signal } : {})",
        new="      ...(false ? { signal } : {})",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'caller abort propagates' "
            "packages/fusion-gateway/dist/test/fusion-backend-panel-timeout.test.js"
        ),
    ),
    Mutation(
        id="M40",
        what="gateway accepts unbounded request bodies",
        file="packages/model-gateway/src/server.ts",
        old="const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;",
        new="const MAX_REQUEST_BODY_BYTES = Number.MAX_SAFE_INTEGER;",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'oversized request bodies' "
            "packages/model-gateway/dist/test/server-resilience.test.js"
        ),
    ),
    Mutation(
        id="M41",
        what="real tool launches inherit every parent secret",
        file="packages/runtime-utils/src/index.ts",
        old="      env: buildChildEnv({ extra: env }),",
        new="      env: { ...process.env, ...env },",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'spawnTool forwards' "
            "packages/runtime-utils/dist/test/helpers.test.js"
        ),
    ),
    Mutation(
        id="M42",
        what="wall-clock budgets wait for provider calls instead of cancelling them",
        file="python/fusionkit-core/src/fusionkit_core/run.py",
        old="        limit = self.engine.config.budget.wall_clock_s",
        new="        limit = None",
        cmd=(
            "uv run pytest python/fusionkit-core/tests/test_fusion_run.py -q -x "
            "-k wall_clock_budget_cancels"
        ),
    ),
    Mutation(
        id="M43",
        what="requires-action runs can be executed from the beginning again",
        file="python/fusionkit-core/src/fusionkit_core/run.py",
        old='        if summary.state != "queued":',
        new='        if summary.state in ("cancelled", "completed", "failed", "expired"):',
        cmd=(
            "uv run pytest python/fusionkit-core/tests/test_fusion_run.py -q -x "
            "-k execute_run_does_not_restart"
        ),
    ),
    Mutation(
        id="M44",
        what="count_tokens accepts null message content and crashes in tokenization",
        file="packages/model-gateway/src/adapters/validate.ts",
        old=(
            "  return checkMessages(body, anthropicError, {\n"
            "    allowEmpty: true,\n"
            "    allowNullContent: false\n"
            "  });"
        ),
        new=(
            "  return checkMessages(body, anthropicError, {\n"
            "    allowEmpty: true,\n"
            "    allowNullContent: true\n"
            "  });"
        ),
        build=True,
        cmd=(
            "node --test --test-name-pattern 'count_tokens requires' "
            "packages/model-gateway/dist/test/wire-validation.test.js"
        ),
    ),
    Mutation(
        id="M45",
        what="Responses requests bypass structural tool-array validation",
        file="packages/model-gateway/src/adapters/validate.ts",
        old=(
            '    checkPositiveInteger(body, "max_output_tokens", openAiError) ??\n'
            "    checkTools(body, openAiError);"
        ),
        new='    checkPositiveInteger(body, "max_output_tokens", openAiError);',
        build=True,
        cmd=(
            "node --test --test-name-pattern 'responses door requires' "
            "packages/model-gateway/dist/test/wire-validation.test.js"
        ),
    ),
    Mutation(
        id="M46",
        what="tool messages without call ids pass the gateway boundary",
        file="packages/model-gateway/src/adapters/validate.ts",
        old='      message.role === "tool" &&',
        new="      false &&",
        build=True,
        cmd=(
            "node --test --test-name-pattern 'chat door rejects' "
            "packages/model-gateway/dist/test/wire-validation.test.js"
        ),
    ),
    Mutation(
        id="M47",
        what="Fusion rewrites opaque endpoint ids before generating the sidecar config",
        file="packages/cli/src/fusion/stack.ts",
        old="      endpoint_ids: input.endpointIds,",
        new='      endpoint_ids: input.endpointIds.map((id) => `provider-${id}`),',
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-endpoint-ids-e2e.test.js",
    ),
    Mutation(
        id="M48",
        what="the Fusion-owned bridge sends the wrong credential to external RouteKit",
        file="packages/cli/src/fusion/stack.ts",
        old="              apiKey: ingressToken",
        new='              apiKey: "wrong-routekit-token"',
        build=True,
        cmd=(
            "PORTLESS=0 node --test --test-name-pattern 'authenticated external routekit' "
            "packages/cli/dist/test/stack-endpoint-ids-e2e.test.js"
        ),
    ),
    Mutation(
        id="M49",
        what="routekit serve reports a false readiness URL instead of its listening gateway",
        file="packages/routekit-cli/src/commands/serve.ts",
        old="            url: running.url,",
        new='            url: "http://127.0.0.1:1",',
        build=True,
        cmd=(
            "node --test packages/routekit-cli/dist/test/serve-process-e2e.test.js"
        ),
    ),
]


def _run(cmd: str) -> int:
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True).returncode


def _build() -> None:
    result = subprocess.run("pnpm build", shell=True, cwd=ROOT, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout.decode()[-2000:] + result.stderr.decode()[-2000:])
        raise SystemExit("pnpm build failed during mutation pass")


def _require_clean_tree() -> None:
    status = subprocess.run(
        "git status --porcelain", shell=True, cwd=ROOT, capture_output=True, text=True
    )
    if status.stdout.strip():
        raise SystemExit(
            "mutation pass mutates the working tree; commit or stash your changes first"
        )


def main() -> None:
    _require_clean_tree()
    requested = set(sys.argv[1:])
    selected = [m for m in MUTATIONS if not requested or m.id in requested]
    if requested and len(selected) != len(requested):
        known = {m.id for m in MUTATIONS}
        raise SystemExit(f"unknown mutation id(s): {sorted(requested - known)}")
    # Validate every mechanical target before running an expensive suite, so a
    # stale/non-unique pattern fails immediately rather than halfway through.
    originals: dict[str, str] = {}
    for mutation in selected:
        original = originals.setdefault(
            mutation.file, (ROOT / mutation.file).read_text()
        )
        occurrences = original.count(mutation.old)
        if occurrences < 1:
            raise SystemExit(f"{mutation.id}: pattern not found in {mutation.file}")
        if not mutation.replace_all and occurrences != 1:
            raise SystemExit(f"{mutation.id}: pattern is not unique ({occurrences}x)")

    results: list[tuple[Mutation, str]] = []
    for mutation in selected:
        path = ROOT / mutation.file
        original = originals[mutation.file]
        try:
            path.write_text(original.replace(mutation.old, mutation.new))
            if mutation.build:
                _build()
            caught = _run(mutation.cmd) != 0
        finally:
            path.write_text(original)
            if mutation.build:
                _build()
        restored = _run(mutation.cmd) == 0
        verdict = (
            "KILLED"
            if caught and restored
            else ("SURVIVED" if not caught else "RESTORE-FAIL")
        )
        results.append((mutation, verdict))
        print(f"{mutation.id:>3}  {verdict:<12} {mutation.what}", flush=True)

    survivors = [entry for entry in results if entry[1] != "KILLED"]
    print("\n=== mutation pass summary ===")
    for mutation, verdict in results:
        print(f"{mutation.id}: {verdict}\n    mutation: {mutation.what}\n    suite: {mutation.cmd}")
    print(f"\nscore: {len(results) - len(survivors)}/{len(results)} mutations killed")
    if survivors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
