"""Mutation pass: prove the e2e test suites are load-bearing.

Protocol per mutation: apply a targeted break to PRODUCT code -> run the suite
expected to catch it (must FAIL) -> revert -> rerun the same suite (must
PASS). A mutation that survives (its suite passes while the product is broken)
is a finding against the tests, and this script exits non-zero.

Run from the repo root with both toolchains available (uv + a built pnpm
workspace)::

    uv run python scripts/mutation_pass.py

Not part of CI's per-commit path (it runs each targeted suite twice, ~1 min
total); run it when touching the testkit, the provider clients, or the
engine/gateway wire paths. History: the first pass scored 6/8 — the two
survivors exposed a retry test masked by the openai SDK's internal retries
and a simulator that accepted tool_calls behaviors for requests that never
declared tools; both the tests and the simulator were hardened (see
docs/testing.md).
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
        what="OpenAI stream client drops parallel tool-call slots beyond the first",
        file="python/fusionkit-core/src/fusionkit_core/client_openai.py",
        old="for fragment in fragments[1:]:",
        new="for fragment in fragments[1:1]:",
        cmd="uv run pytest python/fusionkit-testkit/tests/test_adversarial.py -q -x -k parallel",
    ),
    Mutation(
        id="M2",
        what="transient provider errors are never retried",
        file="python/fusionkit-core/src/fusionkit_core/client_errors.py",
        old='return self.category == "transient"',
        new="return False",
        cmd="uv run pytest python/fusionkit-testkit/tests/test_engine_e2e.py -q -x -k retried",
    ),
    Mutation(
        id="M3",
        what="Anthropic streaming loses prompt tokens from message_start",
        file="python/fusionkit-core/src/fusionkit_core/client_anthropic.py",
        old='prompt_tokens = getattr(start_usage, "input_tokens", None)',
        new="prompt_tokens = None",
        cmd=(
            "uv run pytest python/fusionkit-testkit/tests/test_matrix_wire_clients.py -q -x "
            '-k "stream_reassembles and anthropic"'
        ),
    ),
    Mutation(
        id="M4",
        what="out-of-band reasoning fields are dropped by the wire parser",
        file="python/fusionkit-core/src/fusionkit_core/client_wire.py",
        old='for field in ("reasoning", "reasoning_content"):',
        new="for field in ():",
        cmd=(
            "uv run pytest python/fusionkit-testkit/tests/test_matrix_wire_clients.py -q -x "
            '-k "chat_roundtrip and openai"'
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
            "uv run pytest python/fusionkit-testkit/tests/test_matrix_engine_passthrough.py "
            "-q -x -k tool_loop"
        ),
    ),
    Mutation(
        id="M6",
        what="the Cursor BYOK hybrid translation is skipped",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old="FusionRequest.model_validate(translate_cursor_request(body))",
        new="FusionRequest.model_validate(body)",
        cmd=(
            "uv run pytest python/fusionkit-testkit/tests/test_engine_surfaces.py -q -x "
            "-k cursor_door_translates"
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
        what="Node panel proposals route by provider model name instead of endpoint id",
        file="packages/ensemble/src/panel-propose.ts",
        old="model: model.id,",
        new="model: model.model,",
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-e2e.test.js",
    ),
    Mutation(
        id="M9",
        what="the engine drops per-request prompt overrides on the fuse step",
        file="python/fusionkit-server/src/fusionkit_server/app.py",
        old="prompts=request.prompts,",
        new="prompts=None,",
        replace_all=True,
        cmd=(
            "uv run pytest python/fusionkit-testkit/tests/test_engine_depth.py -q -x "
            "-k prompt_overrides"
        ),
    ),
    Mutation(
        id="M10",
        what="the synthesizer context-overflow ladder loses its candidate fallback",
        file="python/fusionkit-core/src/fusionkit_core/judge.py",
        old='if retry_exc.category != "context_overflow":',
        new="if True:",
        cmd=(
            "uv run pytest python/fusionkit-testkit/tests/test_engine_depth.py -q -x "
            "-k context_overflow_ladder"
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
        file="packages/model-gateway/src/fusion-turn.ts",
        old="stepBody.prompts = route.prompts;",
        new="stepBody.prompts = {};",
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-depth-e2e.test.js",
    ),
    Mutation(
        id="M13",
        what=(
            "the gateway's Anthropic adapter renders fused tool calls with empty "
            "input (the real claude binary would execute the wrong command)"
        ),
        file="packages/model-gateway/src/adapters/anthropic.ts",
        old='      content.push({\n        type: "tool_use",\n        id: call.id ?? `toolu_${randomId()}`,\n        name: call.function?.name ?? "",\n        input\n      });',
        new='      content.push({\n        type: "tool_use",\n        id: call.id ?? `toolu_${randomId()}`,\n        name: call.function?.name ?? "",\n        input: {}\n      });',
        build=True,
        cmd="PORTLESS=0 node --test packages/cli/dist/test/stack-cli-e2e.test.js",
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
    results: list[tuple[Mutation, str]] = []
    for mutation in MUTATIONS:
        path = ROOT / mutation.file
        original = path.read_text()
        occurrences = original.count(mutation.old)
        if occurrences < 1:
            raise SystemExit(f"{mutation.id}: pattern not found in {mutation.file}")
        if not mutation.replace_all and occurrences != 1:
            raise SystemExit(f"{mutation.id}: pattern is not unique ({occurrences}x)")
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
