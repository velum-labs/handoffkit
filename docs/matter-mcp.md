# Matter MCP for Cursor

Handoffkit cloud agents and local Cursor sessions can retrieve read-only evidence from your Matter library through the [`matter-cursor-mcp`](https://github.com/velum-labs/matter-cursor-mcp) server.

## What is configured in this repo

| File | Purpose |
|------|---------|
| `.cursor/mcp.json` | Registers the Matter MCP server for this workspace |
| `.matter-context.json` | Tags, retrieval budgets, and research output paths |
| `.cursor/rules/matter-research-rule.mdc` | Agent guidance for Matter-backed research |
| `scripts/setup-matter-mcp.sh` | Clones and builds `matter-cursor-mcp` during cloud startup |

Cloud agents run `scripts/setup-matter-mcp.sh` from `.cursor/environment.json` so `matter-cursor-mcp/dist/index.js` exists before MCP tools are used.

## One-time secret setup

Add your Matter API token to the Handoffkit cloud environment:

1. Open [Cursor Cloud Agents](https://cursor.com/dashboard/cloud-agents).
2. Select the environment used for `velum-labs/handoffkit`.
3. Add a **Runtime Secret** named `MATTER_API_TOKEN` with your `mat_...` token.

If you already added this secret for `matter-cursor-mcp`, reuse the same value for the Handoffkit environment (or use an environment-scoped secret shared across both repos).

Allow outbound access to `api.getmatter.com` if your environment uses restricted egress.

## Tag your Matter library

Tag relevant Matter items for this repository:

- `cursor`
- `repo-handoffkit`

Optional routing tags:

- `intent-architecture`
- `intent-research`
- `domain-fusion`
- `domain-routekit`

## Verify

Ask a cloud agent:

```text
Call matter_health and confirm the Matter MCP server is configured. Do not show my account email.
```

Then:

```text
Search my Matter library for items tagged cursor and repo-handoffkit related to FusionKit.
```

## Local Cursor

For local development, you can either rely on this repo's `.cursor/mcp.json` (after running `./scripts/setup-matter-mcp.sh`) or configure a global server in `~/.cursor/mcp.json` pointing at a local `matter-cursor-mcp` checkout.

## Research outputs

By default, durable research is written to:

- `docs/research/matter/`
- `docs/decisions/`

See `.matter-context.json` to adjust budgets and paths.
