# Testing FusionKit

How this repository tests the product, what tooling exists for it, and how to
write new tests against that tooling. The goal of the tooling is a specific
fidelity contract: **tests drive the real product stack over the real provider
wire protocols, with the provider itself being the only simulated component —
and that component is scriptable and observable.**

## The problem this tooling solves

FusionKit is a chain of real processes and wire protocols:

```
coding tool ──(OpenAI/Anthropic/Responses dialects)──▶ Node fusion gateway
    Node gateway ──(panel fanout + trajectories:fuse)──▶ Python `fusionkit serve`
        Python engine ──(OpenAI/Anthropic SDK clients)──▶ model providers
```

Historically each layer was tested against ad-hoc inline mocks of the layer
below it: Node tests hand-rolled tiny HTTP servers pretending to be
`fusionkit serve`, and Python tests injected `FakeModelClient` *behind* the
provider-client boundary. That leaves the most failure-prone code — SDK wire
parsing, SSE chunk reassembly, retry/backoff, error classification, the
Node↔Python config seam, process startup — untested, and every suite invents
its own unobservable mock. Abstracting the mocks further would recreate the
same problem; the fix is to move the simulation **outside** the product, to
the provider wire, and make it a first-class, instrumentable tool.

## The tooling

### 1. Provider simulator — `python/fusionkit-testkit`

`ProviderSimulator` is a real HTTP server (stdlib-only, no framework) that
speaks **every provider dialect FusionKit ships a client for** — one per
`build_client` family:

- **OpenAI Chat Completions** (`POST /v1/chat/completions` — the `openai` /
  `openrouter` / `openai-compatible` / `mlx-lm` / `custom` providers): JSON and
  SSE streaming with realistic chunking — role frame, token-level content
  deltas, index-keyed tool-call argument fragments, finish frame, and the
  `stream_options.include_usage` usage frame, exactly like the real API.
- **Anthropic Messages** (`POST /v1/messages` — the `anthropic` provider):
  JSON content blocks (`text` / `thinking` / `tool_use`) and the full
  named-event SSE sequence (`message_start` … `input_json_delta` …
  `message_delta` … `message_stop`).
- **OpenAI Responses** (`POST /responses` — the `codex` subscription
  provider): the stream-only typed-event sequence the `openai` SDK validates
  (`response.created` … reasoning-summary / output-text /
  function-call-argument deltas … `response.completed` with a full terminal
  `Response` snapshot), plus fake subscription-token auth via
  `CODEX_TEST_TOKEN_ENV` so no real ChatGPT login is touched.
- **Google GenAI** (`POST /v1beta/models/{model}:generateContent` and
  `:streamGenerateContent` — the `google` provider): typed candidate parts
  (`text` / `thought` / `functionCall`), camelCase `usageMetadata`, and the
  Google RPC error envelope.

**Control plane** (scriptable): behaviors are queued per model name, FIFO;
an unqueued call gets a deterministic echo default. A `Behavior` can carry a
reply, tool calls, out-of-band reasoning, a provider-shaped error (429 with
`retry-after`, 401 invalid key, quota exhaustion, context overflow, 529
overloaded, 500 — using the real wire spellings `classify_provider_error`
keys on), injected latency, stream pacing, or a deliberately broken stream
(truncated connection / garbage frame). Scripting works in-process
(`sim.queue(...)`) and over HTTP (`POST /__sim/behaviors`, `POST /__sim/reset`)
so any language can drive it.

**Observation plane** (instrumentable): every request is journaled — dialect,
model, full request body, auth headers, stream flag, which behavior answered
it (queued vs default), and the response status/kind. Tests assert on the
journal (`sim.journal()` / `GET /__sim/journal`): *what actually crossed the
provider wire*, not whether a mock function was called.

**Standalone**: `uv run --package fusionkit-testkit fusionkit-sim --port 0`
prints a `listening` JSON line and serves until terminated (how the Node side
spawns it). The simulator core is dependency-free by design so it stays
spawnable anywhere and gives byte-level wire control.

### 2. Config builders — `fusionkit_testkit.endpoints`

`sim_endpoint(...)` / `panel_config(...)` return the *production*
`ModelEndpoint` / `FusionConfig` objects pointed at the simulator, so a test
composes its topology explicitly and the real `build_clients` factory
constructs real SDK clients against it. Every provider kind is supported
(`codex` endpoints get their fake subscription token seeded automatically).

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
  point, so any test in the uv workspace can just take `provider_sim` (a fresh
  simulator per test) or `sim_stack` (a factory that boots the real engine
  process over it) as a fixture argument.

### 3. Real engine process — `fusionkit_testkit.engine.EngineProcess`

Runs the actual `fusionkit serve` CLI as a child process (the same entrypoint
the Node CLI spawns in production) against a given config: real config-file
loading, uvicorn startup, tracing setup, and HTTP surface. Startup failures
raise with the engine's own captured output attached; `engine.log` exposes it
at any time.

### 4. Node testkit — `packages/testkit` (`@fusionkit/testkit`, never published)

The same tooling from the Node side, for cross-process tests:

- `startProviderSim()` — spawns the simulator, returns a handle that scripts
  it over the control plane (`queue` accepts plain strings or behaviors) and
  reads the journal (`journal` / `journalFor` / `calls(filter)` /
  `describeJournal` / `reset`), with the child's log for diagnostics.
- `scriptFusedTurn(sim, {...})` / `judgeAnalysis(...)` — one-call fused-turn
  scripting (mirrors the Python scenario helpers).
- `simRouterConfigYaml(...)` — real `fusionkit serve` router YAML (the same
  document shape `routerConfigYaml` emits in production) with all endpoints
  simulator-backed; supports every provider kind including `google` and
  `codex` (subscription auth wired to the fake test token).
- `startEngine(...)` — the real Python engine as a child process via
  `uv run --package fusionkit`, readiness-probed, log-captured.
- `parseSse` / `sseText` / `sseReasoning` / `sseDone` — structured SSE
  observation (mirrors `fusionkit_testkit.sse`), replacing per-file inline
  SSE splitters.
- `stackToolingSkip()` / `detectStackTooling()` — honest skip-gating: suites
  that need the Python toolchain self-skip (with the reason) where `uv` is
  unavailable, and can be force-disabled with `FUSIONKIT_E2E_STACK=0`.
- `spawnCaptured` / `waitForHttpReady` / `freePort` — observable process
  plumbing shared by the above.

### 5. Full-stack harness — `packages/cli/src/test/sim-stack.ts`

`startSimFusionStack(...)` is the composition root for whole-product tests:
provider simulator → real Python engine → **real Node fusion gateway**
(`startFusionStepGateway`, the production front door). Defaults to `k=1`
proposal panels so the entire chain runs without external coding-agent
binaries. The returned stack carries:

- `sim` / `engine` / `gatewayUrl` — the composed processes;
- `door.*` — a typed fetch helper per gateway surface (`chat`, `messages`,
  `countTokens`, `responses`, `cursorChat`, `embeddings`, `models`, `model`,
  `cursorModels`), so tests read as "hit this door";
- `scriptFusedTurn({candidates, answer})` — reset + script a fused turn
  against this stack's judge in one call.

## The test pyramid, by layer

| Layer | What runs for real | What is simulated | Where |
|---|---|---|---|
| Unit / component | one module | everything around it | `packages/*/src/test`, `python/*/tests` (existing suites, incl. `FakeModelClient`-based server tests) |
| Wire-client | real SDK clients + retry/classification, all four dialects | provider (simulator) | `python/fusionkit-testkit/tests/test_simulator.py`, `test_simulator_google_codex.py` |
| Engine e2e | `create_app` + real clients + kernel | provider | `python/fusionkit-testkit/tests/test_engine_e2e.py` |
| Engine surface matrix | every engine HTTP door + fusion mode, four-provider panel | provider | `python/fusionkit-testkit/tests/test_engine_surfaces.py` |
| Process e2e | real `fusionkit serve` child process | provider | `python/fusionkit-testkit/tests/test_engine_process.py` |
| Cross-stack e2e | Node gateway (every front door) + Python engine, all processes & dialects | provider | `packages/testkit/src/test/`, `packages/cli/src/test/stack-e2e.test.ts` |
| Live (env-gated) | everything incl. real providers/tools | nothing | `FUSIONKIT_GATEWAY_LIVE_*` tests, billed benchmarks |

**Surface coverage** at the two e2e layers:

- Engine doors: `/v1/chat/completions` (fused aliases `panel` / `single` /
  `self` / `heuristic` + per-endpoint passthrough, JSON and SSE, tool loops),
  `/v1/cursor/chat/completions` (hybrid + plain), `/v1/fusion/trajectories:fuse`
  (JSON and SSE), `/v1/fusion/runs` + `/inspect` + `/events` (via
  `x-fusionkit-record`), `/v1/models`, `/v1/cursor/models`, `/health`.
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
```

CI runs the Python layers in the `python` job, and the cross-stack suites in
the dedicated `stack-e2e` job (Node + uv toolchains installed together).

## Proving the tests can fail — the mutation pass

A suite that has never been seen to fail is unproven. `scripts/mutation_pass.py`
applies targeted breaks to **product** code (dropping parallel tool-call
slots, disabling transient retries, losing Anthropic prompt tokens, dropping
reasoning fields, dropping the caller's tools, skipping the Cursor hybrid
translation, omitting SSE `[DONE]`, routing panel proposals by the wrong
identifier), runs the suite expected to catch each one (must fail), reverts,
and reruns (must pass). Run it when touching the testkit, the provider
clients, or the engine/gateway wire paths:

```bash
uv run python scripts/mutation_pass.py   # clean tree + built workspace required
```

Current score: **8/8 killed**. The first pass scored 6/8, and both survivors
were real test weaknesses that got fixed:

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

## Known gaps (extend here first)

- Harness rollouts (`k>1`) drive real coding-agent binaries and stay in the
  env-gated live tests; the cross-stack harness covers `k=1` proposal panels.
- The generic ACP door and the unified-harness front door run real worktree
  harnesses; they are covered by `packages/cli/src/test/gateway-e2e.test.ts`
  (command harness) rather than the sim stack.
- The `serve-endpoint` single-model shim shares `create_app` with `serve`;
  it has no dedicated process-level suite.
- Adding a provider dialect = one new `wire_*.py` module + a route in
  `server.py` + a self-test proving the real client parses it.
