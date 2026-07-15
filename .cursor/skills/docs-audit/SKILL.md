---
name: docs-audit
description: >-
  Audit and heal this repository's documentation against the current code:
  find drift (renamed commands, changed config fields, dead paths, stale
  claims), fix it with surgical deltas, and re-stamp the freshness ledger.
  Use when asked to "audit the docs", "heal the docs", "check documentation
  drift", "run the docs audit", or when the docs-heal workflow invokes the
  healer after a merge or on the weekly sweep. Detection scope comes from
  ledger-plan.mjs; all content judgment and writing follows
  docs/style-guide.md.
---

# Docs audit

You audit documentation against the code it describes, repair drift with
minimal diffs, and record what you verified. Detection scoping is computed by
helper scripts; judging accuracy and writing prose is your job.

## Iron laws

1. **Verify before you write.** Never state a behavior you have not confirmed
   in source, in `--help` output, or by running the command. A claim you
   cannot anchor to code is removed or flagged, never guessed.
2. **Surgical deltas, not rewrites.** Anchored to the diff that caused the
   drift, change the smallest set of lines that makes the page true again.
   Never restructure a page or rewrite it in your own voice.
3. **Evidence in the report.** "Nothing found" is a claim; your report must
   show what you enumerated and compared so a human can audit your recall.
4. **Uncertainty is surfaced, not resolved by guessing.** Questions you cannot
   answer from the repo go in the report's "Open questions" section.
5. **Stamp only what you verified.** `ledger-stamp.mjs` records a fact. Never
   stamp a page you did not actually check; never skip stamping one you did.
6. **Helpers stay dumb.** `ledger-plan.mjs` / `ledger-stamp.mjs` may touch
   ledger state and git plumbing only. If you find yourself wanting them to
   read doc content or decide what a doc should say, stop — that logic
   belongs here, in this skill, executed by you.

## Procedure

### 1. Scope the run

Run the planner and treat its output as your work queue:

```sh
node .cursor/skills/docs-audit/ledger-plan.mjs
```

- `changed` — pages whose sources moved since last verification. Each carries
  a `diffCommand`; run it and reconcile the page against that diff.
- `rotation` — the oldest-verified pages. Re-verify these fully (every claim,
  every link), regardless of hashes: their dependency lists may be incomplete
  or their claims may never have been true.
- `warnings` — fix `dead-dep` entries (re-verify the page, then re-point its
  deps: `ledger-stamp.mjs <page> --deps <new,paths>`) and `missing-page`
  entries (either restore the page, or clean up references to it repo-wide
  and drop the entry: `ledger-stamp.mjs --remove <page>`).
- `unledgered` — new doc pages; verify them, then add entries with
  `ledger-stamp.mjs --add <page> --deps <paths>`. Note the scan skips the
  excluded archive prefixes (see `ledger.json` config), so a new *living*
  page under one of them (e.g. `docs/fusion/`) must be added manually.

When invoked for a specific merge (the workflow passes a commit SHA), also
read that diff directly: `git show <sha> --stat` then the relevant hunks.

**Docs-worthiness gate:** if the triggering change is tests-only, a CI or
infra tweak, a dependency bump, a lab/analysis record, or an internal refactor
that changes no command, flag, config field, route, export, package, or
behavior a doc describes — write the report saying so and stop. Do not
manufacture doc changes to justify the run.

### 2. Verify

For each in-scope page, check its claims against ground truth. Deterministic
enumerations to run (each caught real drift in the 2026-07 audit):

- **CLI surface:** build (`pnpm build`), then diff `node packages/cli/dist/index.js --help`
  and per-command `--help` against [docs/cli.md](../../../docs/cli.md) and
  [apps/docs/content/docs/reference/commands.mdx](../../../apps/docs/content/docs/reference/commands.mdx).
  Registration ground truth: `packages/cli/src/cli.ts` (`buildProgram()`).
- **Config fields:** fields parsed in `packages/cli/src/fusion-config.ts` and
  defaults in `packages/cli/src/fusion/effective-config.ts` versus
  `docs/configuration.md` and the site's `reference/configuration.mdx` —
  both directions.
- **Docs inventory:** `git ls-files 'docs/**/*.md'` versus the inventory
  tables in `docs/documentation-taxonomy.md` — both directions.
- **Cited paths:** every repo path a page cites must exist (`git ls-files`);
  every relative link must resolve.
- **Package inventory:** directories in `packages/*` and `python/*` versus
  `docs/packages.md`.
- **Registry data:** provider/model/pricing claims versus `spec/registry/*.json`.

Ownership map — where ground truth lives per doc area:

| Doc area | Verify against |
| --- | --- |
| Repo maps (`docs/README.md`, taxonomy, coverage map, `repository-reference.md`, `packages.md`, `scope.md`) | `pnpm-workspace.yaml`, `pyproject.toml`, directory listings, `.github/workflows/` |
| CLI + config (`docs/cli.md`, `configuration.md`, `model-catalog.md`, quickstarts, site `reference/` + `getting-started/` + `tools/`) | `packages/cli/src` (esp. `cli.ts`, `commands/`, `fusion-config.ts`), `spec/registry/` |
| Gateway + architecture (`fusion-harness-gateway.md`, `fusion-judge-trajectory.md`, `subscription-pooling.md`, site `api/` + `guides/`) | `packages/model-gateway/src` (esp. `server.ts`, `subscriptions/`), `packages/ensemble/src`, `python/fusionkit-server/src` |
| Eval + bench (`benchmarking-runbook.md`, `public-benchmark-*.md`, `prompt-tuning.md`, `handoffkit-fusion-bench.md`) | `python/fusionkit-evals`, `python/fusionkit-cli/src/fusionkit_cli/commands/bench.py`, `configs/` |
| Hyperkit (`docs/hyperkit.md`, infra/docker READMEs) | `python/hyperkit` (esp. `cli.py`, `adapters/`), `infra/`, `docker/`, `fusionkit_cli/hyperkit_plugin.py` |
| Release + protocol (`releasing.md`, `release-publishing.md`, `model-fusion-protocol-*.md`) | `scripts/release.mjs`, `release/*.json`, `spec/model-fusion-contract`, `.github/workflows/` |
| Package READMEs | that package's `src/` entry points and `package.json` / `pyproject.toml` |

### 3. Fix

- Every edit conforms to [docs/style-guide.md](../../../docs/style-guide.md)
  (it is the output contract; read it before writing).
- Keep each page's existing structure and voice; change facts, not form.
- A removed feature means removing its doc coverage, not marking it deprecated
  (this repo does not keep compatibility shims in docs).
- If a source you consulted is not in the page's `dependsOn`, add it when you
  stamp.

### 4. Validate

```sh
pnpm check                      # includes generated-doc and changelog sync checks
pnpm docs:generate-code && pnpm docs:generate-behaviors   # must be drift-free
cd apps/docs && pnpm install --frozen-lockfile && pnpm build   # only when .mdx files changed
```

### 5. Stamp

Re-stamp every page you verified in this run — fixed or confirmed clean:

```sh
node .cursor/skills/docs-audit/ledger-stamp.mjs <page...>
```

Stamp after your doc edits are final: the ledger records content hashes, and
the stamp reads the page from the working tree, so stamping before the commit
is created is correct — the recorded hash matches the committed blob because
git hashes are content-addressed.

### 6. Report

Write the report to the path the caller names (the workflow expects
`$RUNNER_TEMP/docs-heal-report.md`; interactively, print it). Required
sections:

- **Trigger** — merge SHA / weekly sweep / manual, and the docs-worthiness
  verdict for merge-triggered runs.
- **Plan** — the `ledger-plan.mjs` output, verbatim, in a collapsed
  `<details>` block.
- **Enumeration evidence** — what you compared: the command list you diffed,
  config fields checked, file counts for inventory checks.
- **Changes** — per page: what was wrong, what you changed, the source that
  proves the new claim.
- **Verified clean** — pages checked with no changes needed.
- **Open questions** — anything you could not verify; phrase each so a
  maintainer can answer with a yes/no or a file path.
