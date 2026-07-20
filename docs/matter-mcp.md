# Matter MCP for Cursor

Handoffkit cloud agents and local Cursor sessions can retrieve read-only evidence from your Matter library through the [`matter-cursor-mcp`](https://github.com/velum-labs/matter-cursor-mcp) server.

## What is configured in this repo

| File | Purpose |
|------|---------|
| `.cursor/mcp.json` | Registers the Matter MCP server via `scripts/run-matter-mcp.sh` |
| `.matter-context.json` | Tags, retrieval budgets, and research output paths |
| `.cursor/rules/matter-research-rule.mdc` | Agent guidance for Matter-backed research |
| `scripts/setup-matter-mcp.sh` | Clones/links and builds `matter-cursor-mcp` during cloud startup |
| `scripts/run-matter-mcp.sh` | MCP launcher (PATH bootstrap + ensure build + exec server) |

Cloud agents run `scripts/setup-matter-mcp.sh` from `.cursor/environment.json` so `matter-cursor-mcp/dist/index.js` exists before MCP tools are used. The script resolves the server source in this order:

1. `vendor/matter-cursor-mcp/` — vendored copy committed to this repo (works everywhere, including single-repo environments whose GitHub token cannot see the private upstream repo)
2. A sibling checkout from a multi-repo cloud environment
3. `gh repo clone velum-labs/matter-cursor-mcp` (requires GitHub access to the private repo)

To refresh the vendored copy, see `vendor/matter-cursor-mcp/VENDORED-FROM.txt`.

## One-time secret setup (required)

Matter tools will not work until the token is present on the **same** cloud environment your agent uses.

1. Open [Cursor Cloud Agents → Environments](https://cursor.com/dashboard/cloud-agents#environments).
2. Open the environment that matches the agent (for this team’s multi-repo setup: [handoffkit + matter-cursor-mcp env](https://cursor.com/dashboard/cloud-agents/environments/e/d7135a87-845c-11f1-a7d1-d6b4613131ce)).
3. Open **Secrets**.
4. Add a **Runtime Secret** (not Build Secret) named exactly `MATTER_API_TOKEN` with your `mat_...` token.
5. Start a **new** cloud agent after saving the secret (existing runs do not pick it up).

If you already added this secret for `matter-cursor-mcp`, reuse the same value on the Handoffkit environment.

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

## Register the MCP server for Cloud Agents (one-time, dashboard)

Cloud Agents do **not** load this repo's `.cursor/mcp.json` into their MCP tool catalog — that file applies to the desktop IDE. For cloud agents, register the stdio server once:

- Personal: [cursor.com/agents](https://cursor.com/agents) → **MCP dropdown** → add server
- Team-wide (recommended): **Dashboard → Integrations & MCP** → add MCP server

Use stdio transport with:

| Field | Value |
|-------|-------|
| Name | `matter` |
| Command | `bash` |
| Args | `-lc`, `for d in /workspace /agent/repos/handoffkit; do [ -f "$d/scripts/run-matter-mcp.sh" ] && exec bash "$d/scripts/run-matter-mcp.sh"; done; echo "handoffkit checkout not found" >&2; exit 1` |

The launcher self-heals (bootstraps PATH and rebuilds `matter-cursor-mcp/dist/index.js` if missing) and reads `MATTER_API_TOKEN` from the VM environment, which Cloud Agents Runtime Secrets populate. The path loop covers both single-repo (`/workspace`) and multi-repo (`/agent/repos/handoffkit`) environments.

Until the server is registered, agents can still verify Matter by invoking `scripts/run-matter-mcp.sh` directly over stdio, but `matter_*` tools will not appear in their MCP catalog.

## Verify

Start a **new** cloud agent on `main` and ask:

```text
1) Does matter-cursor-mcp/dist/index.js exist?
2) Is MATTER_API_TOKEN set? Answer only yes/no.
3) Call matter_health. Do not show my account email.
```

Expected:

1. Yes
2. Yes
3. `matter_health` reports configured/healthy (no account email)

Then:

```text
Search my Matter library for items tagged cursor and repo-handoffkit related to FusionKit.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Update fails: `uv: command not found` | Old install without uv bootstrap | Ensure `main` includes the uv bootstrap in `.cursor/environment.json` |
| Update fails: `Repository not found` cloning matter-cursor-mcp | Private repo + unauthenticated git | Ensure `main` uses `scripts/setup-matter-mcp.sh` with `gh repo clone` |
| `matter-cursor-mcp/` missing after install | Install aborted earlier in the chain | Check update script logs; fix the first failing step |
| Matter MCP tools missing (only Linear/Notion/etc.) | Server binary missing or MCP launch failed | Confirm `dist/index.js` exists; relaunch agent on latest `main` |
| `MATTER_API_TOKEN` unset / `configuration_error` | Secret missing on **this** environment, wrong name/type, or agent started before secret was added | Add Runtime Secret `MATTER_API_TOKEN`, then start a new agent |
| `401` from Matter | Invalid/revoked token | Regenerate Matter token (revokes old) and update the Runtime Secret |

## Local Cursor

For local development:

1. Run `./scripts/setup-matter-mcp.sh`
2. Export `MATTER_API_TOKEN` in your shell (cloud Runtime Secrets do not apply to the desktop IDE)
3. Rely on this repo’s `.cursor/mcp.json`, or point `~/.cursor/mcp.json` at a local `matter-cursor-mcp` checkout

## Research outputs

By default, durable research is written to:

- `docs/research/matter/`
- `docs/decisions/`

See `.matter-context.json` to adjust budgets and paths.
