# Documentation style guide

This page is the format specification for every documentation surface in the
repository. It codifies the patterns the living docs predominantly follow so
that humans, interactive agents, and the automated docs healer (see
[`.cursor/skills/docs-audit/SKILL.md`](../.cursor/skills/docs-audit/SKILL.md))
produce consistent output. It absorbs the former conventions bullets in
[`docs/README.md`](README.md) and extends the review checklist in
[Documentation taxonomy](documentation-taxonomy.md).

Scope: these rules bind new writing and edits to living pages. Design-archive
and legacy pages are exempt — do not retrofit them.

## Common core (all surfaces)

- One title per page: an H1 for Markdown pages, frontmatter `title` for site
  MDX pages. Never both.
- Open with a one-paragraph lead that names the audience and what the page is
  for, before any heading.
- Sentence-case headings (`## Command groups`, not `## Command Groups`).
- Tables are for enumerable facts (commands, flags, fields, packages);
  explanation belongs in the surrounding prose, not in cells.
- Label every code fence with a language (`sh`, `json`, `ts`, `python`,
  `yaml`).
- Backtick file paths, directories, commands, flags, config fields, env vars,
  and model ids.
- Every link must resolve: relative links to real files, absolute site links
  to real pages.
- Factual claims about behavior name their source: cite the defining file
  (and symbol where useful), e.g. "registered in `packages/cli/src/cli.ts`
  (`buildProgram()`)". A claim that cannot be anchored to code is either
  removed or labeled as historical.
- No emojis. No marketing language. Present tense, active voice.
- Historical or aspirational content is labeled as design archive (see the
  taxonomy) and never presented as current product truth.

## Surface profiles

### Public docs site (`apps/docs/content/docs/**.mdx`)

- Frontmatter with `title` and `description` is required; the body contains
  no H1 (Fumadocs renders the title) and headings start at `##`.
- Cross-page links are absolute site paths (`/docs/cli/commands`), not
  relative file paths.
- Voice addresses the user directly ("you"); assume no knowledge of the
  monorepo layout, and do not cite repo-internal paths except in
  contributor-facing pages.
- Every page must be reachable through a `meta.json` navigation tree.
- The changelog page is generated from `CHANGELOG.md` by
  `scripts/sync-docs-changelog.mjs`; never edit it by hand.

### Maintainer docs (`docs/**.md`)

- Exactly one H1 on the first line; no frontmatter.
- Links are relative (`configuration.md`, `../packages/cli`).
- Every page has a row in [Documentation taxonomy](documentation-taxonomy.md)
  with a category; pages routed from [`docs/README.md`](README.md) keep their
  routing-table description in sync with their lead paragraph.
- Quickstart mirrors state that the site page is canonical and link to it.
- Pages under `docs/generated/` are generated; update the source and
  regenerate (`pnpm docs:generate-code`, `pnpm docs:generate-behaviors`)
  instead of editing.

### READMEs (root, `packages/*`, `python/*`, `apps/*`, `infra/*`, `docker/*`)

- Title is the package or directory name (`# @fusionkit/kernel`,
  `# hyperkit`).
- One-paragraph purpose statement, then a pointer to the canonical deeper
  docs (a `docs/` page or the site).
- Do not duplicate reference tables that live in `docs/` or on the site; a
  README that restates the CLI reference will drift.

## Review checklist

Before merging documentation changes, confirm: the page sits on the correct
surface for its audience; it has a taxonomy category (maintainer docs); its
claims are verified against the code they describe; its links resolve; task
pages include runnable commands with expected results; generated pages were
regenerated from source rather than edited.
