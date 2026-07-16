> Historical product plan (June 2026). Many workstreams have since landed; see docs/scope.md and the fusion docs for current state.

# FusionKit — Ensemble Product Build Plan

Goal: ship a tool people install to **run ensembles of models** — local and commercial cloud — for both **normal inference** (text generation + tool calling) and **coding with harnesses** (Cursor, Codex, Claude Code), including **automatic handoff to the ensemble when a vendor rate-limits or runs out of credits**.

Explicitly **out of scope** for this plan: the Warrant governance plane (contracts/receipts/policy/approvals), VM/microVM isolation (`session-vercel-sandbox`, hermetic sandboxes), and multi-tenant hosting. We keep only what's needed to run ensembles.

---

## What already works (do not rebuild)

The end-to-end loop is real today, verified across the codebase:

- **Harness gateway loop**: `fusionkit codex|claude|cursor|serve` auto-wires each harness to the Node gateway → runs a per-model panel (each model in its own git worktree, driven through the launched harness) → sends completed trajectories to the internal `fusionkit-sidecar` → returns a native-shaped answer in the tool's own dialect (OpenAI Responses / Anthropic Messages / OpenAI Chat).
- **Auto-wiring** per harness: Codex via ephemeral `CODEX_HOME` config.toml; Claude via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`; Cursor via the bundled cursorkit bridge driving `cursor-agent`.
- **Onboarding**: `fusionkit init` (interactive panel wizard), `fusionkit doctor` (preflight), `fusionkit models download|list|rm` (resumable HF download for MLX, RAM-fit guard) — **all in the Node CLI**.
- **Cloud auth**: RouteKit URL-backed endpoints use `apiKeyEnv`; account-backed endpoints use the canonical `claude-code` or `codex` subscription kind.
- **Ensemble fault-tolerance**: a failed model becomes a `status="failed"` trajectory; survivors are still fused (`producers.py`); only zero survivors raises.
- **Native passthrough**: the gateway also exposes each panel model as a direct (non-fused) pick — the substrate for "use the vendor, fall back to fusion."
- **Config**: `.fusionkit/fusion.json` v4 contains opaque RouteKit endpoint IDs and Fusion policy; `.routekit/router.yaml` owns provider models, URLs, keys, and accounts.

So this is a **gap-closing** effort, not greenfield. The gaps cluster into 8 workstreams below.

---

## The gaps at a glance

| Area | State today | Gap |
|---|---|---|
| Streaming through fusion | Faked (buffer-then-rechunk); real `stream_chat` never wired to server | Real SSE streaming on the fused path |
| Tool calling through fusion | Works on single-model **passthrough only**; fusion path drops tools; in-process executor returns `not_implemented` | Tool calls must flow through the ensemble + judge |
| Rate-limit / credit handoff | **No 429/quota/credit detection anywhere; no failover; no mid-stream cutover** | The headline feature — build detection → reroute → cutover |
| Session continuity | In-memory, dies with the CLI process; no resume | Durable sessions; `resume`/`continue` |
| Local models off Apple Silicon | MLX is Apple-Silicon-only; fork unpublished | vLLM/TGI backend (openai-compatible); publish/pin fork |
| Cloud open-weight behind harnesses | Only in Python bench layer; Node `PanelProvider` lacks `openai-compatible` | Add `openai-compatible` to the harness panel |
| Config split | Node uses `.fusionkit/fusion.json`; Python uses YAML | One source of truth / clean bridge |
| Inference completeness | No embeddings, no vision; `/v1/models` partial; no retries/backoff | OpenAI/Anthropic parity surface |
| Cursor coverage | `cursor-agent` CLI works; **IDE needs manual tunnel**; cursorkit UNLICENSED | Turnkey Cursor + license |
| Trust/cost | `producer_git_sha = "0"*40`; no token/cost accounting at gateway | Real-lite provenance + cost meter |
| Packaging | Two installs (uvx + npm); docs/version drift (`FUSIONKIT_PYPI_VERSION=0.7.0` vs 0.7.1) | One install story; clean fusion-only docs |

---

## Architecture (kept)

Current implementation uses three cooperating layers:

1. **RouteKit** owns endpoint routing, provider dialects, credentials, and subscription accounts.
2. **`@fusionkit/cli`** (Node) owns the public gateway, Fusion v4 config, harness wiring, worktrees, onboarding, and sessions.
3. **`fusionkit-sidecar`** (Python, provisioned from PyPI) is internal and performs judge/synthesis calls through opaque RouteKit endpoint IDs.

Git worktrees stay (lightweight, and essential for multiple harnesses editing one repo in parallel) — they are not "VM isolation." We drop only the governance/VM packages from the shipped surface.

---

## Workstream 0 — Scope cut, license, de-drift (P0, unblocks publish)

- [ ] **Carve the product surface.** Ship only `ensemble`/`fusion`/`local`/`models`/`doctor`/`init` + the `codex|claude|cursor|serve` shortcuts. Move `plane`/`runner`/`handoff`(governed)/`session-*` packages out of the default install (separate optional package or repo). Remove governance commands from README/`docs/cli.md` (the historical docs described removed governance commands and referenced a non-existent `commands/plane.ts`).
- [ ] **License decision** (BSL / Apache-2 / dual). 42+ packages are currently UNLICENSED — blocks any public publish. cursorkit additionally carries a "no hosted deployment" disclaimer; decide its license/path (see WS6).
- [ ] **Fix version + doc drift**: `FUSIONKIT_PYPI_VERSION` 0.7.0 → 0.7.1; remove the stale "cloud requires `--fusionkit-dir`" claim; single clean "run an ensemble" README + per-harness quickstarts.
- [ ] **Naming**: pick one brand for the product (fusionkit), align env vars (`FUSIONKIT_*`), config dir (`~/.fusionkit`, `.fusionkit/`), and command help text.

## Workstream 1 — Inference parity (Python engine + server) (P0)

Make `fusionkit serve` behave like a real OpenAI/Anthropic-compatible endpoint, so any client (not just harnesses) can point at it.

- [ ] **Real streaming through fusion.** Today streaming is faked (buffer then re-chunk) and `stream_chat` is never wired to the server. Wire true token streaming on `/v1/chat/completions` and `/v1/fusion/...` for the fused path (the synthesizer turn should stream).
- [ ] **Tool calling through the ensemble.** Today tools only work on single-model passthrough; the fusion path drops `tools`, and the in-process executor returns `executor_not_implemented`. Implement: panel members receive tools, the judge/synthesizer emits tool calls, and the agent-step contract drives the harness loop. This is the single most important inference gap for "tool calling" parity.
- [ ] **Endpoint completeness**: correct `/v1/models` (list fused + each passthrough), `/v1/embeddings` passthrough, optional `/v1/responses` + `/v1/messages` native surfaces (so non-harness clients get all three dialects). Vision/multimodal = P2 stretch.
- [ ] **Egress error taxonomy + retries** in `clients.py` (shared with WS5): classify transient (429, `overloaded`, `Retry-After`) vs quota-exhausted (`insufficient_quota`, billing) vs permanent (401/403/model-not-found); add bounded backoff + retry for transient. Currently clients call the SDK once with no retry/backoff.

## Workstream 2 — Models: local cross-platform + cloud open-weight (P0/P1)

- [ ] **Add `openai-compatible` to the harness panel.** Node `PanelProvider` is `mlx|openai|anthropic|google` only; add `openai-compatible` so Together / Fireworks / DeepInfra / self-hosted vLLM models can sit in a panel behind a harness (Python already supports this provider). This unlocks cloud open-weight ensembles with zero new inference code.
- [ ] **Non-Apple local backend.** MLX is Apple-Silicon-only. Add a **vLLM/TGI** local backend (openai-compatible) so Linux/NVIDIA users can run local ensembles. `MlxBackend` becomes one of N `LocalBackend` implementations behind a common interface; `fusionkit models` learns to provision the right one per platform.
- [ ] **Publish the model server.** Publish the `velum-labs/mlx-lm` fork to a registry (or officially bless the git-SHA install). Document GPU sizing for vLLM (7B/32B/70B tiers).
- [ ] **Unified model catalog**: extend `fusionkit models` to also list/validate configured cloud + self-hosted endpoints (not just MLX downloads), show disk/VRAM fit, and verify keys.

## Workstream 3 — Onboarding & config UX (P1)

- [ ] **One config source of truth.** Reconcile Node `.fusionkit/fusion.json` and Python YAML — either generate the Python router YAML from `.fusionkit/fusion.json` (already partly done) and make that the only file users edit, or share a schema. Document precedence once.
- [ ] **`fusionkit doctor` / `init` on the Python side.** The Node CLI has both; the Python `fusionkit init` is a shallow detector and there is **no `fusionkit doctor`**. Bring Python to parity (or make the Node CLI the single front door that drives Python).
- [ ] **Historical first-run proposal**: provider/key detection, hardware-aware defaults, and model-download progress. The proposed one-time cloud cost-confirmation prompt was not adopted; current controls are explicit RouteKit endpoint configuration and Fusion `--budget`.

## Workstream 4 — Session lifecycle & continuity (P1)

- [ ] **Durable session store.** Today gateway sessions are an in-memory `Map` swept on a TTL and die with the CLI process; nothing carries across `fusionkit codex` invocations. Add a persistent store (SQLite or JSONL under `~/.fusionkit/sessions/`) keyed by session id, holding the conversation, candidate cache, and per-turn metadata. The Python `FusionRunManager` already persists runs to a filesystem event log — extend/align it rather than inventing a second store.
- [ ] **`fusionkit sessions list|show|resume|continue`.** Resume a coding or inference session: rehydrate conversation + worktrees (or re-derive), and continue the harness against the same session id.
- [ ] **Conversation persistence for replay.** Persist the structured conversation (the gateway already receives the full message array each turn; `trajectory-capture.ts` reconstructs a uniform trajectory across dialects) so it can be replayed into a different model/provider — the substrate WS5 needs.

## Workstream 5 — Rate-limit / credit handoff (P0, the headline feature)

"When Codex/Claude/Cursor hits a vendor rate-limit or runs out of credits, transparently continue the same session on the ensemble." Nothing here exists today.

- [ ] **Detection (egress taxonomy).** Add a shared classifier at all three egress points: gateway native passthrough (`fusion-backend.ts #proxyNative`, returns 429 verbatim today), cursorkit provider (`openai.ts`, collapses all to `http_error`), and Python `clients.py`. Parse status codes, `Retry-After`, and provider bodies (`insufficient_quota`, Anthropic `rate_limit_error`, `overloaded_error`, OpenAI billing) into: `transient` / `quota_exhausted` / `auth_permanent`.
- [ ] **Trigger signal.** Add `rate-limited` / `quota-exhausted` to the trigger system (current triggers are `user-requested`/`tool-failed`/`slow-tools`/`model-escalated` and fire on local tool state, not vendor HTTP).
- [ ] **Pre-stream failover (easy win).** When the user is on a vendor passthrough model and detection fires **before** streaming starts, reroute that turn to the fusion ensemble path (which already tolerates dead slots and excludes the rate-limited vendor from the panel) instead of returning the 429. The gateway already holds the full conversation, so re-running the turn is straightforward.
- [ ] **Mid-stream cutover (hard).** If the failure lands **after** SSE has started, abandon the in-flight stream and resume from a substitute model while preserving dialect continuity (`serverBubbleId`, tool-call ids, finish semantics). Design a cutover protocol per dialect; the fused path can currently only emit a terminal error event — extend it to splice in a fresh generation.
- [ ] **Conversation replay across dialects.** Replay the persisted conversation (WS4) into the substitute provider's dialect (OpenAI Chat ↔ Responses ↔ Anthropic Messages) so the ensemble continues the exact task.
- [ ] **Per-harness wiring.** Codex (Responses), Claude (Messages), Cursor (bridge — today the bridge ends the stream with `"local model failed"` on upstream error; add failover there too). Surface a clear "handed off to ensemble (vendor rate-limited)" notice in the harness.
- [ ] **Policy knobs.** `--on-rate-limit fusion|passthrough|fail`, optional auto-retry-after for transient, budget cap interplay (WS7).

## Workstream 6 — Harness coverage & parity (P1)

- [ ] **Cursor IDE path.** `cursor-agent` CLI works; the IDE needs a manual public tunnel + Settings override. Either ship a managed tunnel/loopback shim or document it as a first-class flow. Resolve cursorkit licensing (it's UNLICENSED with a no-hosted-deploy disclaimer) — required before shipping Cursor support.
- [ ] **opencode fusion mode** (currently `local`-only) and the **generic ACP door** (currently reported `blocked`) — finish or explicitly defer.
- [ ] **Parity checklist per harness**: streaming ✅, tool calling (WS1), `/model` picker incl. fused + passthrough ✅, multi-turn within a run ✅, session resume (WS4), and the handoff notice (WS5). Verify worktree create/cleanup robustness under crashes.

## Workstream 7 — Trust & cost (minimal, since Warrant is out) (P1/P2)

- [ ] **Real-lite provenance.** Replace `producer_git_sha = "0".repeat(40)` with the actual git SHA + real producer version in all record producers (cheap, removes a glaring "faked provenance" finding). Full signed receipts stay out of scope (that's Warrant).
- [ ] **Cost + token accounting at the gateway.** Per-turn token counts and cost (using endpoint `pricing` metadata), a running session total, and an optional `--budget` cap that stops or downshifts the panel. Today only a pre-run confirmation prompt exists.
- [ ] **Secrets hygiene.** Config stores env-var *names* only (already true) — keep it; document key handling; if the gateway is ever exposed beyond localhost, require the existing `--auth-token` and authenticate the scope ingest (currently unauthenticated).

## Workstream 8 — Packaging & distribution (P1)

- [ ] **One install.** A user should run one thing. Either bundle the Python engine launch behind the npm CLI (current `uvx fusionkit@<pin>` approach, but pin-correct and with a cached/offline path) or ship a single installer that provisions both. Eliminate the cold-start surprise (first run pulls PyPI + multi-GB weights).
- [ ] **Cross-platform**: Linux/Windows for cloud-only ensembles; Apple Silicon for local MLX; Linux+NVIDIA for vLLM (WS2). Gate features by platform in `doctor`.
- [ ] **Docs**: three quickstarts — (1) inference endpoint (`fusionkit serve` + curl), (2) coding harness (`fusionkit codex`), (3) rate-limit handoff — plus a config reference and a model-catalog guide.

---

## Phased roadmap

**P0 — Make the core honest and publishable** (the loop works, but these are required to ship and to deliver the headline feature)
- WS0 scope cut + license + de-drift
- WS1 real streaming + tool-calling-through-fusion + error taxonomy
- WS2 `openai-compatible` in the harness panel (cloud open-weight + self-host)
- WS5 detection + pre-stream failover (the rate-limit/credit handoff, minimum viable)

**P1 — Make it a product people keep using**
- WS2 vLLM/TGI local backend + publish model server + unified catalog
- WS3 config unification + Python `doctor`/`init` parity + first-run UX
- WS4 durable sessions + `resume`/`continue`
- WS5 mid-stream cutover + per-harness handoff wiring + replay
- WS6 Cursor IDE turnkey + license + parity checklist
- WS7 real-lite provenance + cost meter
- WS8 one-install + cross-platform + docs

**P2 — Polish / stretch**
- Vision/multimodal inference parity
- opencode fusion mode + generic ACP door
- Budget-driven panel downshift, richer cost analytics

---

## Feature-parity checklist (definition of done)

For each harness (Codex, Claude Code, Cursor) and for the raw inference endpoint:

- [ ] Streaming responses (real SSE) on both passthrough and fused paths
- [ ] Tool / function calling end-to-end through the ensemble
- [ ] `/model` picker shows fused model + each panel member (passthrough)
- [ ] Local ensemble works (MLX on Apple Silicon, vLLM/TGI elsewhere)
- [ ] Cloud ensemble works (OpenAI/Anthropic/Google + open-weight via openai-compatible)
- [ ] Mixed local+cloud panel works
- [ ] Onboarding: `init` wizard + `doctor` preflight on one platform-correct path
- [ ] Model download/management with progress + disk/VRAM fit
- [ ] Start a session; **resume/continue** it later
- [ ] **Vendor rate-limit/credit exhaustion → automatic handoff to the ensemble**, with a visible notice (pre-stream P0, mid-stream P1)
- [ ] Per-turn token + cost reporting; optional budget cap
- [ ] One documented install; cross-platform gating in `doctor`

---

## Key open decisions (need a call before building)

1. **Single front door**: make the Node CLI the only user-facing entry (driving Python under the hood), or keep Python `fusionkit` as a co-equal CLI? Recommend Node-as-front-door for harnesses; Python `serve` as the documented raw endpoint.
2. **Config source of truth**: `.fusionkit/fusion.json` (generate YAML from it) vs a shared schema. Recommend the former.
3. **Mid-stream cutover scope**: full transparent cutover (hard, P1) vs "fail the turn with a one-tap resume on the ensemble" (much cheaper). Recommend shipping the cheaper version first.
4. **Cursor**: invest in turnkey IDE support + relicense cursorkit, or scope Cursor to `cursor-agent` CLI only for v1?
5. **Local backend priority**: is Linux/NVIDIA (vLLM) a v1 requirement, or is Apple-Silicon-MLX + cloud enough to launch?

---

*Grounded in a 3-agent deep exploration of the current code. The orchestration core is sound; this plan closes the gaps between "works end-to-end in a demo" and "a product people install to run model ensembles."*
