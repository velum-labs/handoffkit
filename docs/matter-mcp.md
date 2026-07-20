# Matter MCP for Cursor

Handoffkit agents and local Cursor sessions retrieve read-only evidence from Matter through the hosted [`matter-cursor-mcp`](https://github.com/velum-labs/matter-cursor-mcp) server over streamable HTTP.

## What stays in this repo

| File | Purpose |
|------|---------|
| `.matter-context.json` | Repository tags (`cursor`, `repo-handoffkit`), retrieval budgets, and output directories (`docs/research/matter/`, `docs/decisions/`) |
| `.matter-context.schema.json` | Schema for the Matter context file |
| `.cursor/rules/matter-research-rule.mdc` | Agent guidance for Matter-backed research |
| `.cursor/mcp.json` | Cursor desktop HTTP MCP registration template |
| `AGENTS.md` | Cloud-agent operating notes for Matter research |

The server is deployed separately from `github.com/velum-labs/matter-cursor-mcp`; see that repo's `docs/deploy.md`. `MATTER_API_TOKEN` lives only on the hosted deployment. MCP clients authenticate to the hosted server with per-client access keys.

## Register clients

### Cursor cloud agents

Register the hosted HTTP MCP server once for the team:

1. Open **Dashboard -> Integrations & MCP**.
2. Add an HTTP MCP server named `matter`.
3. Set URL to `https://<host>/mcp`.
4. Add header `Authorization: Bearer <key>`.

This one-time team registration covers all repos and all team accounts. Handoffkit no longer needs per-repo MCP files for cloud agents, a VM build step, or a Cursor Runtime Secret for Matter.

### Cursor desktop

Use this repo's `.cursor/mcp.json` or your global `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "matter": {
      "url": "https://MATTER-MCP-HOST-PLACEHOLDER/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MATTER_MCP_ACCESS_KEY}"
      }
    }
  }
}
```

After the hosted deployment is live, replace `MATTER-MCP-HOST-PLACEHOLDER` with the deployed host and export `MATTER_MCP_ACCESS_KEY` in your local shell.

### Other MCP clients

OpenClaw, Hermes, and other MCP clients use the same streamable HTTP URL (`https://<host>/mcp`) and `Authorization: Bearer <key>` header.

## Tag your Matter library

Tag relevant Matter items for this repository:

- `cursor`
- `repo-handoffkit`

Optional routing tags:

- `intent-architecture`
- `intent-research`
- `domain-fusion`
- `domain-routekit`

## Cutover checklist

1. Deploy the hosted server from `github.com/velum-labs/matter-cursor-mcp`.
2. Replace the placeholder URL in `.cursor/mcp.json`.
3. Register the team HTTP MCP server in Cursor Dashboard -> Integrations & MCP.
4. Merge this PR.
5. Delete old per-account stdio MCP registrations and, optionally, the `MATTER_API_TOKEN` Runtime Secret.
6. Start a new cloud agent and verify with `matter_health`.

## Verify

Start a new cloud agent and ask:

```text
Call matter_health. Do not show my account email.
```

Expected: `matter_health` reports configured/healthy without exposing the account email.

Then run a tagged search:

```text
Search my Matter library for items tagged cursor and repo-handoffkit related to FusionKit.
```

## Research outputs

Before calling Matter tools, read `.matter-context.json`. By default, durable research is written to:

- `docs/research/matter/`
- `docs/decisions/`
