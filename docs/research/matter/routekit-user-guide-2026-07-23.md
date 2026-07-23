# Research note: zero-context RouteKit user guide

Date: 2026-07-23

## Question

How should RouteKit be explained to a person who finds it online with no prior
knowledge of this repository?

## Matter retrieval

Matter connectivity was healthy and read-only. The repository context requested
the tags `cursor` and `repo-handoffkit`, but neither tag exists in the connected
Matter account. The only available tags were `fundamental-research`, `gtm`, and
`model-routing`. A search without tag filters for developer-tool onboarding and
CLI documentation returned two candidates. One was relevant to documentation
format; the other concerned benchmark strategy and was not selected.

### Selected source

- Matter item: `itm_DTR`
- Title: “always bet on text”
- Author: graydon2
- Original URL: <https://graydon2.dreamwidth.org/193447.html>
- Matter status: `queue`
- Matter item updated at: `2026-07-22T07:55:21Z`
- Markdown SHA-256:
  `a3575f626217ca6c4d82840a9124ed86cf9776255b121dbd83d256c7ddff9b68`
- Annotations or user notes: none

## Source evidence

The selected article argues that text is durable, precise, efficient,
searchable, translatable, editable, diffable, and easy to consume at different
speeds. Those are properties of the source text, not user annotations.

## Repository evidence

This repository has two documentation layers:

- `apps/docs/content/docs/` is the canonical public documentation published at
  <https://fusionkit.velum-labs.com/docs>.
- `docs/` is the maintainer and contributor layer.

RouteKit currently has installation, command, configuration, pooling, billing,
privacy, and tool-specific material, but no single public page that starts from
zero context and connects those pieces into one workflow. The CLI source and
tests define a deliberately small first-launch surface: OpenAI, Anthropic,
OpenRouter, Claude Code subscriptions, Codex subscriptions, and the Codex,
Claude, and Cursor launchers.

## Inference used for the implementation

The public guide should therefore be text-first and task-oriented:

1. Explain the product in plain language before naming internal components.
2. Give one short path from installation to a successful model request.
3. Use copy-paste command and code examples.
4. Explain provider/model names, credentials, billing, and account pools at the
   point where a reader encounters them.
5. Separate common workflows from advanced maintenance and troubleshooting.
6. Keep the public MDX page canonical and retain a clearly marked in-repository
   Markdown mirror for GitHub readers.
7. Link to detailed references instead of reproducing every command or policy.

## Contradictions and open questions

- The required repository tags are absent from Matter, so no source could be
  selected using the preferred all-tag match.
- The selected source supports a text-first format but is not specifically
  about developer documentation or RouteKit. Command accuracy must therefore
  come from RouteKit source, tests, and current package documentation.
- RouteKit qualification evidence and the published package can advance at
  different times. The guide should avoid turning evidence status into a broad
  marketing claim and should link to the canonical route and billing
  disclosures.

## Planned documentation changes

- Add the canonical public guide under
  `apps/docs/content/docs/getting-started/`.
- Add it to public navigation and entry-point pages.
- Keep `docs/routekit-user-guide.md` as an explicitly marked mirror.
- Add both pages to repository documentation inventories and contract checks.

## Implementation

- Canonical public guide:
  [`apps/docs/content/docs/getting-started/routekit.mdx`](../../../apps/docs/content/docs/getting-started/routekit.mdx)
- In-repository mirror:
  [`docs/routekit-user-guide.md`](../../routekit-user-guide.md)
- Public navigation:
  [`apps/docs/content/docs/getting-started/meta.json`](../../../apps/docs/content/docs/getting-started/meta.json)
- Documentation contract:
  [`packages/routekit-cli/src/test/docs-contract.test.ts`](../../../packages/routekit-cli/src/test/docs-contract.test.ts)
