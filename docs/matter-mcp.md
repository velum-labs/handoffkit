# Matter MCP for Cursor

Handoffkit agents and local Cursor sessions retrieve read-only evidence from Matter through the [`matter-cursor-mcp`](https://github.com/velum-labs/matter-cursor-mcp) stdio MCP server.

The server ships as the public npm package `matter-cursor-mcp`. Cloud MCP
registrations run it through a login shell so `npx` is on `PATH`; Handoffkit
does not vendor the server, build it during agent setup, or host a remote HTTP
deployment.

## What stays in this repo

| File | Purpose |
|------|---------|
| `.matter-context.json` | Repository tags (`cursor`, `repo-handoffkit`), retrieval budgets, and output directories (`docs/research/matter/`, `docs/decisions/`) |
| `.matter-context.schema.json` | Schema for the Matter context file |
| `.cursor/rules/matter-research-rule.mdc` | Agent guidance for Matter-backed research |
| `.cursor/mcp.json` | Cursor desktop stdio MCP registration template |
| `AGENTS.md` | Cloud-agent operating notes for Matter research |

## Register clients

### Cursor cloud agents

Register the npm package once as a stdio MCP server:

- Personal: [cursor.com/agents](https://cursor.com/agents) -> **MCP dropdown** -> add server
- Team-wide: **Dashboard -> Integrations & MCP** -> add MCP server

Use:

| Field | Value |
|-------|-------|
| Name | `matter` |
| Command | `bash` |
| Args | `-lc`, `exec npx -y matter-cursor-mcp` |
| Env | `MATTER_API_TOKEN=<your Matter token>`, `MATTER_MCP_CACHE_MODE=on`, `LOG_LEVEL=info` |

Enter `MATTER_API_TOKEN` directly in the registration's env block; Cursor encrypts env values for cloud MCP configs. No VM build step or Cursor Runtime Secret is needed for Matter.

Enter the two arguments as separate entries. Do not add quote characters around
the second argument. The login shell is required because cloud MCP child
processes can start with a minimal `PATH` that does not include `npx`.

### Cursor desktop

Use this repo's `.cursor/mcp.json` or your global `~/.cursor/mcp.json`. Export `MATTER_API_TOKEN` in the shell that launches Cursor:

```json
{
  "mcpServers": {
    "matter": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "matter-cursor-mcp"],
      "env": {
        "MATTER_API_TOKEN": "${env:MATTER_API_TOKEN}",
        "MATTER_MCP_CACHE_MODE": "on",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Other MCP clients

OpenClaw, Hermes, and other MCP clients use the same stdio command (`npx -y matter-cursor-mcp`) with `MATTER_API_TOKEN` in the MCP server environment.

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

1. Publish `matter-cursor-mcp` to npm; see the `matter-cursor-mcp` README publishing steps.
2. Add the cloud MCP registration with `bash`, args `-lc` and
   `exec npx -y matter-cursor-mcp`, and the encrypted env token.
3. Merge this PR.
4. Delete old per-account stdio registrations pointing at `/workspace` scripts and, optionally, the `MATTER_API_TOKEN` Runtime Secret.
5. Start a new cloud agent and verify with `matter_health`.

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
