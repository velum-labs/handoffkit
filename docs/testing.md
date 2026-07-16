# Testing FusionKit

How this repository tests the product, what tooling exists for it, and how to
write new tests against that tooling. The goal of the tooling is a specific
fidelity contract: **tests drive the real product stack across the Node↔Python
boundary, with a scriptable and observable RouteKit gateway as the simulated
upstream.**

## The problem this tooling solves

FusionKit is a chain of real processes and wire protocols:

```
coding tool ──(OpenAI/Anthropic/Responses dialects)──▶ Node fusion gateway
    Node gateway ──(panel fanout + trajectories:fuse)──▶ Python `fusionkit-sidecar`
        Python sidecar ──(neutral Chat Completions)──▶ Node RouteKit gateway
            RouteKit gateway ──(provider adapters/accounts)──▶ model providers
```

Historically each layer was tested against ad-hoc inline mocks of the layer
below it: Node tests hand-rolled tiny HTTP servers pretending to be
the sidecar, and Python tests injected `FakeModelClient` behind the model-call
boundary. The shared simulator now exercises neutral wire parsing, SSE chunk
reassembly, the Node↔Python namespaced-model seam, and process startup without
recreating provider accounts or routing in Python.

## The tooling

### 1. RouteKit simulator — `python/fusionkit-testkit`

`RouteKitSimulator` is a real HTTP server (stdlib-only, no framework) that
speaks the one neutral surface Python FusionKit consumes:

- **OpenAI-compatible Chat Completions** (`POST /v1/chat/completions`): JSON
  and SSE streaming with realistic chunking — role frame, token-level content
  deltas, index-keyed tool-call argument fragments, finish frame, and the
  `stream_options.include_usage` usage frame.

**Control plane** (scriptable): behaviors are queued per model name, FIFO;
an unqueued call gets a deterministic echo default. A `Behavior` can carry a
reply, tool calls, out-of-band reasoning, an HTTP error, injected latency,
stream pacing, or a deliberately broken stream
(truncated connection / garbage frame). Scripting works in-process
(`sim.queue(...)`) and over HTTP (`POST /__sim/behaviors`, `POST /__sim/reset`)
so any language can drive it.

**Observation plane** (instrumentable): every request is journaled — dialect,
namespaced RouteKit model ID, full request body, stream flag, which behavior answered
it (queued vs default), and the response status/kind. Tests assert on the
journal (`sim.journal()` / `GET /__sim/journal`): *what actually crossed the
RouteKit wire*, not whether a mock function was called.

**Standalone**: `uv run --package fusionkit-testkit fusionkit-sim --port 0`
prints a `listening` JSON line and serves until terminated (how the Node side
spawns it). The simulator core is dependency-free by design so it stays
spawnable anywhere and gives byte-level wire control.

### 2. Config builders — `fusionkit_testkit.endpoints`

`sim_endpoint(...)` / `panel_config(...)` return namespaced IDs and the production
`FusionConfig` pointed at the simulator, so the real `build_clients` factory
constructs RouteKit clients against it.

### 2b. Scenario scripting + pytest fixtures (the DX layer)

- `script_fused_turn(sim, candidates={...}, judge_model=..., answer=...)`
  scripts a whole fused turn in one call (it encodes the panel → judge
  analysis → synthesizer ordering, including the shared judge/synth endpoint
  FIFO). `judge_analysis(...)` builds well-formed judge JSON. Plain strings
  are accepted anywhere a `Behavior` is (they become text replies).
- Journal queries: `sim.calls(model=..., dialect=..., status=..., source=...)`
  filters the journal; `sim.describe_journal()` renders one line per wire call
  for assertion failure messages.
- **Pytest fixtures, zero wiring**: the testkit registers a `pytest11` entry
  point, so any test in the uv workspace can just take `routekit_sim` (a fresh
  simulator per test) or `sim_stack` (a factory that boots the real engine
  process over it) as a fixture argument.

### 3. Real engine process — `fusionkit_testkit.engine.EngineProcess`

Runs the actual `fusionkit-sidecar serve` CLI as a child process (the entrypoint
the Node CLI spawns in production) against a given config: real config-file
loading, uvicorn startup, tracing setup, and HTTP surface. Startup failures
raise with the engine's own captured output attached; `engine.log` exposes it
at any time.

### 4. Node testkit — `packages/testkit` (`@fusionkit/testkit`, never published)

The same tooling from the Node side, for cross-process tests. (Do not confuse
it with `legacy/packages/testkit`, the old in-process plane/runner fixture
package for the frozen Warrant stack — the root `packages/testkit` is a
different package that reuses the name.)

- `startProviderSim()` — spawns the simulator, returns a handle that scripts
  it over the control plane (`queue` accepts plain strings or behaviors) and
  reads the journal (`journal` / `journalFor` / `calls(filter)` /
  `describeJournal` / `reset`), with the child's log for diagnostics.
- `scriptFusedTurn(sim, {...})` / `judgeAnalysis(...)` — one-call fused-turn
  scripting (mirrors the Python scenario helpers).
- `simSidecarConfigYaml(...)` — production-shaped internal sidecar YAML over a
  RouteKit-compatible simulator URL and namespaced model IDs.
- `startEngine(...)` — the internal Python sidecar as a child process via
  `uv run --package fusionkit fusionkit-sidecar`, readiness-probed and
  log-captured.
- `parseSse` / `sseText` / `sseReasoning` / `sseDone` — structured SSE
  observation (mirrors `fusionkit_testkit.sse`), replacing per-file inline
  SSE splitters.
- `stackToolingSkip()` / `detectStackTooling()` — honest skip-gating: suites
  that need the Python toolchain self-skip (with the reason) where `uv` is
  unavailable, and can be force-disabled with `FUSIONKIT_E2E_STACK=0`.
- `spawnCaptured` / `waitForHttpReady` / `freePort` — observable process
  plumbing shared by the above.

### 4b. Real coding-agent CLI harnesses — `@fusionkit/testkit` `clis.ts`

`runClaudeCode(...)` / `runCodexExec(...)` / `runOpenCode(...)` spawn the
ACTUAL `claude`, `codex`, and `opencode` binaries against a gateway URL — no
mocked tool clients. Claude Code
is pointed via `ANTHROPIC_BASE_URL` (+ an inert token; background traffic,
telemetry, and auto-update disabled for determinism); Codex gets a generated
`CODEX_HOME` registering the gateway as a Responses-wire provider with
`requires_openai_auth = false`. No real provider account is ever touched.
`cliAvailable` / `cliSkip` gate suites where the binaries are missing; the
`stack-e2e` CI job installs them (`npm i -g @openai/codex
@anthropic-ai/claude-code opencode-ai`). It also installs the official
`cursor-agent` binary; model turns remain login-gated.

The real-CLI suite (`stack-cli-e2e.test.ts`) drives each binary through the
whole stack: plain fused turns (asserting the CLI's own toolset and prompt
reached the panel wire verbatim), and **real tool loops** — the fused step
commits a `Bash` / `exec_command` / OpenCode `bash` call, the binary executes it on the local
machine (proven by the file the command creates), posts the result back, and
the loop closes on a second fused turn. The cursor-agent CLI still requires a
real Cursor login and stays behind the env-gated live tests.

### 5. Full-stack harness — `packages/cli/src/test/sim-stack.ts`

`startSimFusionStack(...)` is the composition root for whole-product tests:
TypeScript provider simulator → real Node RouteKit gateway → real Python
sidecar → **real Node fusion gateway**
(`startFusionStepGateway`, the production front door). Defaults to `k=1`
proposal panels so the entire chain runs without external coding-agent
binaries. The returned stack carries:

- `sim` / `engine` / `gatewayUrl` — the composed processes;
- `door.*` — a typed fetch helper per gateway surface (`chat`, `messages`,
  `countTokens`, `responses`, `cursorChat`, `embeddings`, `models`, `model`,
  `cursorModels`), so tests read as "hit this door";
- `scriptFusedTurn({candidates, answer})` — reset + script a fused turn
  against this stack's judge in one call.

## Executable behavior inventory

The complete claimed behavior inventory lives in
`spec/testing/expected-behaviors.json`; its reviewable generated form is
`docs/generated/expected-behaviors.md`. Required rows name a concrete test
file and source anchor; environment-gated rows must name the reason and exact
live command. Node/Python meta-tests compare its door/tool/provider axes to
the executable registries, and `pnpm check` fails if the generated list or
anchors drift. Provider/account matrices are TypeScript RouteKit tests; Python
has one RouteKit-client matrix over buffered/streamed text, usage, reasoning,
tool calls, malformed responses, and namespaced model IDs.

- **Door axis** — `@fusionkit/testkit`'s `DOOR_PROFILES`: one `DoorProfile`
  per gateway front door (OpenAI chat, Anthropic Messages, Codex Responses,
  Cursor BYOK hybrid) declaring how to build requests (plain / streaming /
  tool-loop turns) and how to extract text / tool calls from its native JSON
  and SSE shapes. Node suites loop over the profiles and generate tests.
- **Behavior axis** — scripted replies, reasoning, tool calls, latency, and
  broken streams.

Generated Node suites cover the door × behavior product:

- `stack-e2e.test.ts` — door × {fused JSON, fused SSE with native close
  markers, multi-turn fused tool loop with native tool dialects} = 12
  generated tests through the whole stack (plus targeted cross-door
  invariants: passthrough, discovery, count_tokens, embeddings, degradation).
Python `test_simulator.py` keeps the RouteKit tools guardrail and control-plane
checks targeted.

## The test pyramid, by layer

| Layer | What runs for real | What is simulated | Where |
|---|---|---|---|
| Unit / component | one module | everything around it | `packages/*/src/test`, `python/*/tests` (existing suites, incl. `FakeModelClient`-based server tests) |
| Sidecar API | internal route scope, health, trajectory fusion, native runs, and tool resume | none | `python/fusionkit-server/tests/` |
| Neutral RouteKit client | namespaced model ids, buffered/stream parsing, reasoning, usage, and tools | none | `python/fusionkit-core/tests/test_routekit_client.py` |
| Sidecar process e2e | real `fusionkit-sidecar serve` child process over a simulated RouteKit upstream | none | `python/fusionkit-testkit/tests/test_engine_process.py` |
| Cross-stack door matrix | door × {fused JSON, fused SSE, tool loop} through the whole stack | provider | `packages/testkit/src/test/`, `packages/cli/src/test/stack-e2e.test.ts` |
| Cross-stack depth | multi-ensemble routing + prompts, session/cost accounting, narration | provider | `packages/cli/src/test/stack-depth-e2e.test.ts` |
| Gateway policies | WS5 failover (`fusion`/`passthrough`/`fail`), WS7 budget-stop (402 before spend), WS4 finite-k round semantics + persistence | provider | `packages/cli/src/test/stack-policies-e2e.test.ts` |
| Managed harness k | real AI SDK agents + git worktrees: k=2 executed/proposed boundaries, unbounded completion, path traversal rejection | provider | `packages/cli/src/test/stack-harness-k-e2e.test.ts` |
| Chaos/lifecycle | k=1 straggler abandonment, hard panel timeout, caller cancellation + post-failure recovery | provider | `packages/cli/src/test/stack-chaos-e2e.test.ts` |
| Durable resume | unbounded candidate cache persisted in FileSystemSessionStore and restored after gateway restart with zero re-fanout | provider | `packages/cli/src/test/stack-resume-e2e.test.ts` |
| Canonical tool drivers | Real Claude Agent SDK + Codex SDK, native dialect gateways, stale-cursor fallback | provider | `packages/cli/src/test/stack-drivers-e2e.test.ts` |
| Auth boundary | every door rejects missing/wrong bearer credentials before any provider call | provider | `packages/cli/src/test/stack-auth-e2e.test.ts` |
| Hostile-input fuzz | malformed bodies per public gateway door plus seeded random bodies; native 400 envelope, zero fanout, no leaked internals, bounded latency | provider | `packages/cli/src/test/stack-fuzz-e2e.test.ts`, unit: `wire-validation.test.ts` |
| Chunk-boundary fuzz | gateway streams re-split mid-frame and mid-UTF-8-rune must reassemble byte-exactly | provider | `packages/model-gateway/src/test/sse-codec.test.ts` |
| Concurrency | 24 parallel passthrough streams + 8 parallel fused streams with per-request content identity (cross-talk detection), abort isolation | provider | `packages/cli/src/test/stack-concurrency-e2e.test.ts` |
| Sidecar runs | native create/inspect/events/idempotency and tool resume over internal APIs | none | `python/fusionkit-server/tests/test_fusion_runs_api.py`, `test_tool_resume.py` |
| **Real product CLI** | the ACTUAL `fusionkit serve` entrypoint booting its production stack: fusion.json loading, preflight probes, `uv run` router spawn, gateway + setup snippets | provider only | `packages/cli/src/test/stack-npm-cli-e2e.test.ts` |
| **Real RouteKit CLI** | the ACTUAL `routekit serve --json` process, model discovery, all supported gateway dialects, command surfaces, doctor, install, and missing-harness preflight | provider only | `packages/routekit-cli/src/test/serve-process-e2e.test.ts`, `cli-process-e2e.test.ts` |
| RouteKit/Fusion composition | namespaced model IDs through embedded routing plus an authenticated external `routekit serve` process behind a Fusion-owned bridge; Fusion close leaves external RouteKit alive | provider only | `packages/cli/src/test/stack-model-ids-e2e.test.ts` |
| Real command CLI | actual built entrypoint: version/completions/runtime, config CRUD/export, prompts, install/uninstall, telemetry, setup, doctor | provider only for doctor probes | `packages/cli/src/test/cli-command-surfaces-e2e.test.ts` |
| **Real-CLI e2e** | the ACTUAL `claude` / `codex` / `opencode` binaries: production wire/toolsets and real local tool execution | provider only | `packages/cli/src/test/stack-cli-e2e.test.ts` |
| Live (env-gated) | everything incl. real provider accounts | nothing | `FUSIONKIT_GATEWAY_LIVE_*` tests, billed benchmarks |

Provider-wire and cost-accounting coverage lives in the TypeScript RouteKit
gateway suites. Python receives only neutral responses and usage.

**Surface coverage** at the two e2e layers:

- Sidecar doors: `/health`, `/v1/fusion/trajectories:fuse` (JSON and SSE), and
  `/v1/fusion/runs` plus inspect/events/tool-results.
- Gateway doors: `/v1/chat/completions` (JSON + SSE), `/v1/messages` (+
  streaming, + `count_tokens`), `/v1/responses` (JSON + SSE), 
  `/v1/cursor/chat/completions`, `/v1/models` (OpenAI + Anthropic shapes),
  `/v1/models/{id}`, `/v1/cursor/models`, `/v1/embeddings` (documented
  unsupported contract) — each fused turn fanning out across all four
  provider dialects at once.

## Running

```bash
# Python: everything, including the simulator/engine e2e layers
uv run pytest python -q

# Node: everything (cross-stack suites self-skip without uv)
pnpm build && pnpm test

# Just the cross-stack suites
PORTLESS=0 node --test "packages/testkit/dist/test/*.test.js"
PORTLESS=0 node --test packages/cli/dist/test/stack-e2e.test.js
PORTLESS=0 node --test packages/cli/dist/test/stack-model-ids-e2e.test.js
node --test "packages/routekit-cli/dist/test/*process-e2e.test.js"
```

CI runs the Python layers in the `python` job, and the cross-stack suites in
the dedicated `stack-e2e` job (Node + uv toolchains installed together). A
separate `observability` job validates the Hyperkit Grafana dashboards: it
boots seeded Prometheus and Grafana and executes every panel query via
`scripts/validate_hyperkit_dashboards.py` (see [Hyperkit](hyperkit.md)).

## Proving the tests can fail — the mutation pass

A suite that has never been seen to fail is unproven. `scripts/mutation_pass.py`
applies targeted breaks to **product** code (dropping parallel tool-call
slots, disabling transient retries, dropping reasoning fields, dropping the
caller's tools, skipping the Cursor hybrid translation, omitting SSE `[DONE]`,
routing panel proposals by the wrong identifier, and falsifying CLI
readiness), runs the suite expected to catch each one (must fail), reverts, and
reruns (must pass). Run it when touching the testkit, provider clients, CLI
process boundaries, or engine/gateway wire paths:

```bash
uv run python scripts/mutation_pass.py   # clean tree + built workspace required
```

The inventory is intentionally open-ended, so this document does not publish
a fixed mutation score. The script prints the authoritative score for each
run. A subset can be run by id (`uv run python scripts/mutation_pass.py M34
M42`). M34–M46 pin the
second-wave audit's bug contracts: streamed fused usage including panel
tokens (M34), unknown-endpoint rejection (M35), atomic idempotent run
initialization (M36), Anthropic mid-stream provider error events (M37),
TTL hint eviction / fresh-opener isolation (M38), caller-abort propagation
into in-flight panels (M39), the request-body size cap (M40), allowlisted
tool-launch environments (M41), in-flight wall-clock budget cancellation
(M42), the paused-run execute guard (M43), count-tokens content validation
(M44), Responses tool-array validation (M45), and the tool-message
`tool_call_id` requirement (M46). M31–M33 pin structural door validation,
the `FusionBackend` SDK boundary guard, and the concurrency suite's
content-identity assertions (M33 poisons the simulator's echo default to
prove cross-talk detection bites). Before them: candidate reasoning
entering judge evidence, streamed synthesizer reasoning on the gateway, and
real Claude/Codex/OpenCode selection of injected named fused models.

M47–M49 pin the RouteKit/Fusion split directly: namespaced model IDs in the
sidecar config, authenticated external RouteKit bridging, and truthful
`routekit serve --json` process readiness.

The preceding mutations pin finite-k terminal
proposal summaries, k=1 straggler grace, native driver dialect routing,
stale-session fallback, configured provider base URLs in the real product CLI,
budget gating, failed-tool observations, durable unbounded resume, and bearer
authentication.

The earlier depth mutations M9, M11, and M12 pin per-request prompt forwarding,
judge-doubles-as-synthesizer request resolution, and the gateway's ensemble
prompt forwarding; M13/M14 pin the Anthropic adapter's tool-call rendering on
its JSON and streaming paths — M14 is killed by the REAL claude binary
executing the wrong command. A lesson from M13's first run: it survived when
aimed at the real-CLI suite because Claude Code consumes the *streaming*
path — the suites and mutations must target the code path the client actually
exercises. The depth suites also caught a real product bug on first
run: a fuse request pinning `judge_model` without `synthesizer_model` fell
back to the *config* synthesizer instead of the pinned judge, silently
synthesizing a named ensemble's turns on the default ensemble's judge
endpoint (fixed in `app.py`, guarded by M11).

The first pass had two survivors, and both were real test weaknesses that got
fixed:

- the retry test queued one 500, which the openai SDK's *internal* retry
  absorbed — FusionKit's own retry layer was never exercised. The test now
  queues three 500s (exhausting the SDK budget) and asserts all four wire
  attempts in the journal.
- the tool-loop test kept passing when the engine dropped the caller's
  `tools`, because the simulator happily returned a scripted `tool_calls`
  behavior to a request that declared no tools. The simulator now enforces
  the realism guardrail a real model implies — a queued `tool_calls` behavior
  answering a tools-less request fails the call loudly
  (`sim_tools_not_declared`).

When adding significant simulator or wire-path behavior, add a mutation for
it here rather than trusting a green run.

## Hunting unknown unknowns — adversarial invariants

Scripted suites only explore well-formed request space, so "everything
passes" says nothing about the complement. The fuzz/concurrency layers
(`stack-fuzz-e2e`, `test_engine_fuzz.py`, `test_stream_chunk_fuzz.py`,
`stack-concurrency-e2e`) assert **expectation-free invariants** instead of
scripted outcomes: every response parses, no response leaks
JavaScript/Python internals, rejected garbage never fans out to providers,
arbitrary stream chunking reassembles byte-exactly, concurrent turns keep
their own content, and the gateway survives everything.

These layers have found real production bugs on a previously all-green stack,
all fixed and pinned by regressions + mutations. The first
hostile-input run found the original four:

- **Leaked TypeErrors as 502s.** A `model` array or `messages` non-array
  reached deep code and answered `502 {"message": "requested.startsWith is
  not a function"}` / `"body.messages is not iterable"` — unvalidated input
  misclassified as an *upstream* error. Now structurally validated per door
  (`adapters/validate.ts`), answering 400 in each dialect's native envelope.
- **Leaked fusion internals.** An empty body answered
  `502 "proposal mode (k=1) needs the caller's messages..."` — internal
  panel jargon on the public wire. Now a clean 400, guarded at both the
  doors and the `FusionBackend` SDK boundary.
- **Wrong status class + wasted spend risk.** Malformed bodies could reach
  panel fanout before failing. The fuzz suite asserts zero journal growth
  for every rejected body.

The second wave (targeted code audit + expanded all-door fuzzing +
differential/stateful probes) found twenty-one more, spanning both stacks:

- **Accounting**: streamed fused turns omitted panel-member tokens from the
  terminal usage frame (buffered vs streamed responses billed differently).
- **Money-before-validation**: unknown models, unknown request-level panel
  members, invalid sampling (`max_tokens < 1`, `top_p > 1`), malformed tool
  arguments, and tool messages without `tool_call_id` all fanned out to
  providers (or crashed mid-panel as 502s) instead of answering 400/422.
- **State machine**: concurrent identical `Idempotency-Key` requests created
  two billed runs; `execute_run` restarted `requires_action` runs from
  scratch; wall-clock budgets waited for in-flight provider calls instead of
  cancelling at the deadline.
- **Sessions**: an identical fresh opener after TTL eviction reattached to
  the old persisted session's candidates and cost via a stale live hint.
- **Cancellation/resources**: client disconnect cancelled neither the
  in-flight panel run nor the upstream response body; request bodies were
  unbounded; the engine never closed its provider HTTP clients on shutdown;
  testkit child teardown reaped only direct children (uv/npm wrappers leaked
  grandchildren); stale routers/dashboards were spawned alongside rather
  than replacing their stale predecessors; `local serve` SIGINT bypassed
  `finally` cleanup via `process.exit`.
- **Protocol translation**: Anthropic streaming swallowed mid-stream
  `{"error": ...}` events (reported as `incomplete_stream`); `count_tokens`
  crashed on `content: null` (`Cannot read properties of null`); Responses/
  Anthropic/Cursor doors crashed on non-array `tools`; Gemini tool results
  lost their function name when only `tool_call_id` was present; empty
  OpenAI `choices` raised a raw `IndexError`; `spawnTool` leaked every
  parent env var (unrelated secrets) into vendor CLIs; the quota classifier
  treated any 400 containing the word "billing" as exhausted quota; and
  invalid fusion configs (duplicate/unknown model ids, unknown
  judge/panel references, `sample_count=0`) parsed successfully and failed
  only at request time.

## Writing new tests — rules of thumb

1. **Default to the simulator, not an inline mock.** If a test needs "a
   provider" or "a `fusionkit serve`", use the testkit layers; new ad-hoc
   `createServer` mocks of the router/providers should be the rare exception
   (e.g. asserting the gateway's behavior on a *malformed* router response).
2. **Assert on the journal.** The strongest assertion is what crossed the
   wire: which models were called, in what order, with which messages/tools,
   how many attempts. Response-only assertions miss silent double-calls and
   dropped requests.
3. **Script errors with the canned `SimError` / `simErrors` factories** so
   error-path tests exercise the real spellings the classifier keys on.
4. **Pick the lowest layer that can falsify your change**, and add one test at
   the highest affected layer. A judge-prompt change is engine-e2e; a new
   gateway dialect is cross-stack.
5. **Keep suites self-skipping, not environment-assuming.** Cross-stack tests
   gate on `detectStackTooling()`; live-provider tests stay behind explicit
   `FUSIONKIT_*_LIVE_*` env flags.

## Known gaps (environment- or platform-gated)

- `cursor-agent` is installed and version-checked in CI, and its bridge/ACP
  protocol has fake-peer tests, but a real model turn requires a genuine
  Cursor login. The real-binary turn therefore stays behind
  `FUSIONKIT_GATEWAY_LIVE_CURSOR=1`.
- Local MLX model lifecycle, memory pressure, and OOM restart behavior require
  Apple Silicon. Linux CI covers the gateway/process orchestration but cannot
  load MLX models.
- Real billed provider-account behavior (provider-side schema drift, actual
  rate limits, quality) remains in the explicitly env-gated live/public
  benchmarks. Deterministic TypeScript CI covers provider wires; Python CI
  covers the neutral RouteKit wire and fusion behavior.
- Generic ACP and unified command-harness worktree flows are covered by
  `packages/cli/src/test/gateway-e2e.test.ts`; native Claude/Codex SDK driver
  cutover is covered by `stack-drivers-e2e.test.ts`. OpenCode has no panel
  harness kind yet, so only its real tool-facing CLI is exercised.
