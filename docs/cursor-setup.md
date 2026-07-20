# Cursor setup

## Prerequisites

- Node.js 20 or newer.
- A Matter Pro account with an API token.
- Cursor editor or Cursor CLI.

## Build the server

```bash
npm install
npm run build
```

## Store the token

Create a local env file. Do not commit it.

```bash
mkdir -p ~/.config/matter-cursor-mcp
chmod 700 ~/.config/matter-cursor-mcp
cat > ~/.config/matter-cursor-mcp/.env <<'EOF'
MATTER_API_TOKEN=mat_your_token_here
MATTER_MCP_CACHE_MODE=on
LOG_LEVEL=info
EOF
chmod 600 ~/.config/matter-cursor-mcp/.env
```

## Configure Cursor

Add this to `~/.cursor/mcp.json`, replacing paths with absolute paths:

```json
{
  "mcpServers": {
    "matter": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/matter-cursor-mcp/dist/index.js"],
      "envFile": "/ABSOLUTE/PATH/TO/.config/matter-cursor-mcp/.env"
    }
  }
}
```

The same config is used by the Cursor editor and Cursor CLI.

## Verify

```bash
agent mcp list
agent mcp list-tools matter
```

Then ask Cursor:

```text
Call matter_health and confirm the Matter MCP server is configured. Do not show my account email.
```

## Project configuration

Copy these files into repositories that should use Matter research:

- `examples/matter-context.example.json` as `.matter-context.json`.
- `examples/matter-context.schema.json` as `.matter-context.schema.json`.
- `examples/matter-research-rule.mdc` into `.cursor/rules/matter-research-rule.mdc`.

Adjust tags, retrieval budgets, and output paths for the repository.

## Troubleshooting

### Node engine version

The project requires Node.js 20 or newer. If package installation or scripts fail because an older Node is on PATH, switch to a current Node and rerun the command.

### Missing token

If `MATTER_API_TOKEN` is missing or does not begin with `mat_`, the MCP server still starts so Cursor can discover tools. Every tool returns a structured `configuration_error` explaining what to fix.

### HTTP base URL rejected

`MATTER_API_BASE_URL` must be HTTPS in normal use. `MATTER_MCP_ALLOW_HTTP=true` exists only for localhost tests.

### 401 from Matter

The token is invalid or revoked. Matter permits one active API token at a time; generating a new token revokes the previous one.

### 403 from Matter

Matter Pro may be required, or the account is forbidden from accessing the API.

### Cache issues

Delete the local cache and retry:

```bash
rm -rf ~/.cache/matter-cursor-mcp
```

Disable cache for debugging:

```dotenv
MATTER_MCP_CACHE_MODE=off
```

### Inspect the server

```bash
npm run build
npm run inspect
```
