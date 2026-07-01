# Product scope: ensemble vs. governance/VM

This repository ships the **FusionKit ensemble product**: running ensembles of
local + cloud models, both as a raw inference endpoint and behind coding
harnesses. It *also* still contains the older **governance plane** and
**VM/sandbox isolation** packages. This page records exactly which packages are
which, what is reachable from the shipped product, and the precise steps to
separate the out-of-scope packages later.

It is the de-drift companion to the WS0 scope cut: the docs now describe only the
shipped CLI surface, and this page documents the package reality behind that.

## The shipped product surface

The single front door is the Node `@fusionkit/cli`. Its command tree
(`packages/cli/src/cli.ts` → `buildProgram`) wires exactly:

- `codex` / `claude` / `cursor` / `serve` (the ensemble launchers) and the
  generic `fusion [tool]`
- `init`, `config`, `sessions`, `models`, `local`, `ensemble`, `doctor`,
  `status`

No `warrant`/governance commands (`plane`, `runner`, `run`, `receipt`, `verify`,
`bundle`, `handoff` continuation, `pull`, `secrets`) are registered any more,
the README and `docs/cli.md` previously documented those; that drift has been
removed.

## Package classification

### Product packages

Reachable from the shipped `fusionkit` command runtime:

| Package | Role |
| --- | --- |
| `@fusionkit/cli` | The front door (this is the product). |
| `@fusionkit/ensemble` | Ensemble run engine: worktrees, harness execution, judge synthesis, fusion. |
| `@fusionkit/model-gateway` | Harness gateway: dialect translation, streaming, durable sessions, cost, rate-limit handoff. |
| `@fusionkit/protocol` | Model-fusion data contracts + generated SDK bindings. |
| `@fusionkit/workspace` | Git workspace capture, worktree materialization, divergence-safe pull. |
| `@fusionkit/tools`, `tool-codex`, `tool-claude`, `tool-cursor`, `tool-opencode` | Per-harness adapters that drive each vendor CLI. |
| `@fusionkit/adapter-ai-sdk` | Managed local-model stack (`mlxServer`) + AI SDK model adapters (used by `--local` / `fusionkit models`). |

### Out-of-product-scope packages (governance / VM isolation)

Not part of the ensemble product concept:

| Package | Role |
| --- | --- |
| `@fusionkit/plane` | Governance control plane: contracts, policy, receipts, approvals, storage. |
| `@fusionkit/runner` | Outbound governed runner; pluggable session-isolation backends. |
| `@fusionkit/sdk` | Thin client over the plane API + offline receipt verification. |
| `@fusionkit/handoff` | Continuation SDK (checkpoint / continueIn / pull) on the governance primitives. |
| `@fusionkit/adapter-compute` | ComputeSDK-shaped governed compute surface. |
| `@fusionkit/session-hermetic` | Hermetic (just-bash) session isolation backend. |
| `@fusionkit/session-vercel-sandbox` | Firecracker microVM session isolation backend. |
| `@fusionkit/session-harness` | AI SDK harness session backend (microVM / local sandbox bindings). |

### Test-only / never published

`@fusionkit/testkit` and `@fusionkit/example-utils` are already `private: true`
and excluded from `release/npm-packages.json` (enforced by
`scripts/check-release-publish.mjs`).

## Reachability analysis (why this is entangled)

The out-of-scope packages are **not merely dead weight reachable only by
tests**. They are pulled into the *runtime dependency closure of product
packages*. Concretely (source-level imports, not just declared deps):

- `@fusionkit/tool-claude` (`src/harness.ts`) imports `prepareExecution`,
  `CapabilityMismatchError`, `SessionBackend` from **`@fusionkit/runner`** and
  `aiSdkHarnessBackend` from **`@fusionkit/session-harness`**. The fusion panel
  uses the harness's `"local"` execution mode, but the `"sandbox"` path (and its
  governance/VM imports) is compiled into the package unconditionally.
  `@fusionkit/session-harness` in turn pulls in `runner`, `session-hermetic`,
  `session-vercel-sandbox`, `plane`, and `sdk`.
- `@fusionkit/adapter-ai-sdk` (`src/swarm-tools.ts`, `remote-tools.ts`,
  `model.ts`, `routed-model.ts`) imports from **`@fusionkit/handoff`** and
  **`@fusionkit/sdk`** (governed `swarmTools` / `remoteTools` / model routing).

In addition, the CLI itself still references governance code in non-command
paths:

- `packages/cli/src/config.ts` imports `MasterKey` from `@fusionkit/plane`. It is
  consumed only by `packages/cli/src/shared/plane.ts`.
- `packages/cli/src/shared/plane.ts` imports `PlaneClient` from `@fusionkit/sdk`.
  Nothing in `buildProgram` imports it. It is dead relative to the shipped
  command tree.
- `packages/cli/src/render.ts` (the public `@fusionkit/cli` → `./render` export)
  type-imports `HandoffTraceEvent` from `@fusionkit/handoff`.
- `packages/cli/src/test/e2e.test.ts` and `src/test/handoff.test.ts` exercise
  `plane`, `runner`, `sdk`, `handoff`, and `testkit` end-to-end; they run as part
  of `pnpm test`.

Cross-package declared dependencies on the out-of-scope set:

```
adapter-ai-sdk  -> handoff, sdk
adapter-compute -> handoff, sdk
cli             -> handoff, plane, runner, sdk
ensemble        -> runner, session-harness        (declared; no direct src import)
handoff         -> sdk
runner          -> sdk
session-harness -> runner, session-hermetic, session-vercel-sandbox, plane, sdk
session-hermetic-> runner, plane, sdk
session-vercel-sandbox -> runner
tool-claude     -> runner, session-harness
testkit         -> plane, runner, sdk
```

## Why clean separation is NOT provable today

Per the WS0 safety constraint, separation is only safe if `pnpm build` and
`pnpm test` stay green. None of the obvious moves are clean right now:

1. **Cannot drop the out-of-scope packages from the publish set / mark them
   `private`.** `@fusionkit/cli` is published with `workspace:*` deps on
   `plane`/`runner`/`sdk`/`handoff`, and product packages `tool-claude` and
   `adapter-ai-sdk` import `runner`/`session-harness`/`handoff`/`sdk` at source
   level. Un-publishing any of them would leave the published CLI (and product
   packages) with unresolvable dependencies. `scripts/check-repo.mjs` and
   `scripts/check-release-publish.mjs` also assert the manifest/`private` invariants.
2. **Cannot remove them from `packages/cli/package.json` dependencies** while the
   CLI tests (`e2e.test.ts`, `handoff.test.ts`) and the `./render` export still
   reference them, and while `adapter-ai-sdk` (a product dep) transitively needs
   `handoff`/`sdk` anyway.
3. **A cross-repo release coordinator** (`scripts/release.mjs`, `release/desired.json`,
   and the workspace `release` skill) publishes the full set in dependency order.

So this is exactly the "STOP and document" case: separation requires real
refactors with their own blast radius, not a minimal safe edit. **No package
manifests, `private` flags, or the publish set were changed by this work.**

## Follow-up steps to separate later

Each step should be its own change that keeps `pnpm check && pnpm build &&
pnpm test` green and re-runs `node scripts/check-release-publish.mjs`.

1. **Decouple `tool-claude` from governance/VM.** Split the `"sandbox"`
   execution path (which imports `@fusionkit/runner` + `@fusionkit/session-harness`)
   out of `packages/tool-claude/src/harness.ts` into an optional module/package,
   leaving the default `"local"` fusion path with no governance imports. Move the
   sandbox-path test accordingly.
2. **Decouple `adapter-ai-sdk` from governance.** Move `swarmTools` /
   `remoteTools` and the governed model-routing helpers (the `@fusionkit/handoff`
   + `@fusionkit/sdk` imports in `swarm-tools.ts`, `remote-tools.ts`, `model.ts`,
   `routed-model.ts`) into a separate adapter package, leaving `mlxServer` and the
   plain model adapters used by the product.
3. **Remove the CLI's dead governance code.** Delete `packages/cli/src/shared/plane.ts`
   (imported by nothing in `buildProgram`) and `packages/cli/src/config.ts` (only
   consumed by `shared/plane.ts`); drop the `@fusionkit/handoff` type import from
   `packages/cli/src/render.ts` (or stop exporting `./render`'s trace renderer).
4. **Relocate the CLI governance tests.** Move `packages/cli/src/test/e2e.test.ts`
   and `src/test/handoff.test.ts` into the governance packages (`plane`/`runner`/
   `handoff`) where they belong, or delete if redundant there.
5. **Remove the now-unused deps** `@fusionkit/handoff`, `@fusionkit/plane`,
   `@fusionkit/runner`, `@fusionkit/sdk` from `packages/cli/package.json` (and the
   `@fusionkit/testkit` devDep if only those tests used it). Re-run the suite.
6. **Decide the home for the out-of-scope packages.** Either move them to a
   separate repo/workspace, or mark them `private: true` and remove them from
   `release/npm-packages.json`. Update `scripts/check-release-publish.mjs`
   expectations, `release/desired.json`, `scripts/release.mjs`, and the workspace
   `release` skill so the cross-repo coordinator stops publishing them. Confirm no
   remaining publishable package depends on them via `workspace:*`.

The governed-execution design itself is preserved under [`spec/`](../spec) and the
out-of-scope topic docs linked from [`docs/README.md`](README.md).
