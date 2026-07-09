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
speaks the provider dialects FusionKit's clients use:

- **OpenAI Chat Completions** (`POST /v1/chat/completions`): JSON and SSE
  streaming with realistic chunking — role frame, token-level content deltas,
  index-keyed tool-call argument fragments, finish frame, and the
  `stream_options.include_usage` usage frame, exactly like the real API.
- **Anthropic Messages** (`POST /v1/messages`): JSON content blocks (`text` /
  `thinking` / `tool_use`) and the full named-event SSE sequence
  (`message_start` … `input_json_delta` … `message_delta` … `message_stop`).

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
constructs real SDK clients against it.

### 3. Real engine process — `fusionkit_testkit.engine.EngineProcess`

Runs the actual `fusionkit serve` CLI as a child process (the same entrypoint
the Node CLI spawns in production) against a given config: real config-file
loading, uvicorn startup, tracing setup, and HTTP surface. Startup failures
raise with the engine's own captured output attached; `engine.log` exposes it
at any time.

### 4. Node testkit — `packages/testkit` (`@fusionkit/testkit`, never published)

The same tooling from the Node side, for cross-process tests:

- `startProviderSim()` — spawns the simulator, returns a handle that scripts
  it over the control plane and reads the journal (`queue` / `journal` /
  `journalFor` / `reset`), with the child's log for diagnostics.
- `simRouterConfigYaml(...)` — real `fusionkit serve` router YAML (the same
  document shape `routerConfigYaml` emits in production) with all endpoints
  simulator-backed.
- `startEngine(...)` — the real Python engine as a child process via
  `uv run --package fusionkit`, readiness-probed, log-captured.
- `parseSse` / `sseText` / `sseReasoning` / `sseDone` — structured SSE
  observation (mirrors `fusionkit_testkit.sse`), replacing per-file inline
  SSE splitters.
- `detectStackTooling()` — honest skip-gating: suites that need the Python
  toolchain self-skip (with the reason) where `uv` is unavailable, and can be
  force-disabled with `FUSIONKIT_E2E_STACK=0`.
- `spawnCaptured` / `waitForHttpReady` / `freePort` — observable process
  plumbing shared by the above.

### 5. Full-stack harness — `packages/cli/src/test/sim-stack.ts`

`startSimFusionStack(...)` is the composition root for whole-product tests:
provider simulator → real Python engine → **real Node fusion gateway**
(`startFusionStepGateway`, the production front door). Defaults to `k=1`
proposal panels so the entire chain runs without external coding-agent
binaries. Returns the sim handle (script/observe), the engine handle, and the
gateway URL a "coding tool" can hit on any supported dialect.

## The test pyramid, by layer

| Layer | What runs for real | What is simulated | Where |
|---|---|---|---|
| Unit / component | one module | everything around it | `packages/*/src/test`, `python/*/tests` (existing suites, incl. `FakeModelClient`-based server tests) |
| Wire-client | real SDK clients + retry/classification | provider (simulator) | `python/fusionkit-testkit/tests/test_simulator.py` |
| Engine e2e | `create_app` + real clients + kernel | provider | `python/fusionkit-testkit/tests/test_engine_e2e.py` |
| Process e2e | real `fusionkit serve` child process | provider | `python/fusionkit-testkit/tests/test_engine_process.py` |
| Cross-stack e2e | Node gateway + Python engine, all processes & dialects | provider | `packages/testkit/src/test/`, `packages/cli/src/test/stack-e2e.test.ts` |
| Live (env-gated) | everything incl. real providers/tools | nothing | `FUSIONKIT_GATEWAY_LIVE_*` tests, billed benchmarks |

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

## Known simulator gaps (extend here first)

- Provider dialects: `google` (GenAI SDK wire) and `codex` (subscription
  Responses API) endpoints are not yet simulated; panel configs cover them
  today via the OpenAI/Anthropic members. Adding a dialect = one new
  `wire_*.py` module + a route in `server.py`.
- Harness rollouts (`k>1`) drive real coding-agent binaries and stay in the
  env-gated live tests; the cross-stack harness covers `k=1` proposal panels.
