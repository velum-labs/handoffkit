# Claude Router (Side Project) — Status

> **Status as of 2026-06-22:** Six phases (1, 2, 3A, 3B, 4, 5a) merged into `feature/claude-code-router`. Phase 5b (local routing) in flight. Main-merge PR not yet opened.

This document is a stable marker pointing at the canonical specs for the **Claude Router** side project (formerly tracked outside this repo).

## What it is

`fusionkit fusion claude` is a smart-routing proxy for Claude Code. It speaks the Anthropic Messages API (via `packages/model-gateway/src/adapters/anthropic.ts`), classifies each request into one of five scenarios (default, background, longContext, reasoning, webSearch), and routes to the configured provider for that scenario. Supports subscription reuse (Claude Code OAuth, Codex JWT), 6+ cloud providers, and (after Phase 5b) first-class local models via MLX and Ollama.

## What it is not

**Not** the fusion-with-judge runtime. `fusion <tool>` is single-model routing. Bare `fusionkit fusion` (no tool subcommand) is the parallel-multi-model-plus-judge product. Phase 6 will let routing scenarios invoke a fusion panel — that's the strategic killer feature.

## User-facing docs

- **End-user guide:** `docs/fusion-router.md`
- **Provider extensions design:** `docs/phase-2-providers.md`

## Implementation map

### Routing engine
- `packages/model-gateway/src/routing/` — engine (`routing.ts`, `routing-backend.ts`, `providers.ts`, `provider-request.ts`, `provider-errors.ts`, `types.ts`)
- `packages/model-gateway/src/mlx-backend.ts` — MLX server lifecycle (used by 5b for local routing kind)

### CLI
- `packages/cli/src/commands/fusion.ts` — top-level command registration
- `packages/cli/src/commands/fusion-{status,model,dashboard}.ts` — Phase 5a demo surface
- `packages/cli/src/fusion/claude-route.ts` — `fusion claude --route` entry
- `packages/cli/src/fusion/routing.ts` — CLI-side routing helpers
- `packages/cli/src/fusion/providers/index.ts` — panel-to-routing mapping
- `packages/cli/src/fusion/routing-decision-publisher.ts` — best-effort scope dashboard publish
- `packages/cli/src/fusion/routing-onboarding{,-ai}.ts` — `fusion init` integration (3B added AI-assisted flow)
- `packages/cli/src/fusion/session-override.ts` — session model override (5a)
- `packages/cli/src/fusion/subscriptions.ts` — subscription detection
- `packages/cli/src/fusion-config.ts` — schema (extended with `routing` + `fallback` blocks)

### Dashboard
- `apps/scope/app/routing/` — Phase 3A pages: live decisions, rule editor, provider status, analytics

## PR trail

| Phase | What | PR |
|---|---|---|
| 1 | Core routing engine | #27, #28 |
| 2 | Provider backends (OpenRouter/DeepSeek/Groq/Gemini) | #29 |
| 3A | Scope dashboard pages | #30 |
| 3B | AI-assisted onboarding (local MLX) | #31 |
| 4 | Polish (wire classifier, delete no-op, wire publisher) | #32 |
| 5a | Demo surface CLI commands | #33 |
| 5b | First-class local routing (MLX + Ollama) | TBD |

## Outstanding work

1. **Phase 5b** — local MLX + Ollama as first-class routing kinds (in flight)
2. **Main-merge PR** — `feature/claude-code-router` → `main` (staged, opens after 5b lands)
3. **Phase 6** — route-to-panel: let routing scenarios invoke fusion panels (the strategic killer feature; differentiates from claude-code-router MIT)
4. **Phase 7** — rename `fusion <tool>` → `route <tool>` (keep `fusion` as brand)
5. **v0.6 backlog:** cost tracking, dashboard expiry banners, last-24h analytics charts, Windows support

## Canonical specs (outside this repo)

The plan-of-record and gap audit live in Benja's workspace:

- Plan: `~/.openclaw/workspace-benjamin/openclaw-shared/plans/2026-06-22-fusionkit-claude-router-implementation-report.md`
- Gap audit: `~/.openclaw/workspace-benjamin/openclaw-shared/plans/2026-06-22-fusionkit-claude-router-gap-audit.md`
- Resumption guide: `~/.openclaw/workspace-benjamin/openclaw-shared/plans/2026-06-22-fusionkit-claude-router-resumption.md`

If those paths are inaccessible, this README + the PR descriptions on the trail above are the recovery source-of-truth.

🦕
