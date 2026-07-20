# matter-cursor-mcp

`matter-cursor-mcp` is a local, read-only MCP server that lets Cursor retrieve bounded evidence from a user's Matter library through Matter's official v1 REST API. It exposes search, listing, item, annotation, and context-bundle tools over stdio; it does not mutate Matter content and it does not perform LLM inference.

## Architecture

```text
Matter app
  capture, reading, tags, highlights, notes
          |
          | Official Matter REST API v1
          v
Local read-only Matter MCP server
  authentication, pagination, caching,
  filtering, deterministic context selection
          |
          | MCP over stdio
          v
Cursor editor / Cursor CLI
  repo inspection, reasoning, reports, plans,
  implementation, tests, commits, pull requests
          |
          v
Git repository
  durable research, decisions, and code
```

## Quick start

1. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

2. Store a Matter API token in a local env file:

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

3. Add a Cursor MCP config such as `examples/cursor-mcp.global.example.json` to `~/.cursor/mcp.json`, replacing the absolute paths.

4. Verify from Cursor CLI:

   ```bash
   agent mcp list
   agent mcp list-tools matter
   ```

## Tools

- `matter_health`: checks local configuration, authentication, and Matter API connectivity without returning account email.
- `matter_list_tags`: lists and filters Matter tags, backed by a five-minute cache.
- `matter_list_items`: lists compact item metadata by status, content type, tags, favorite state, order, and update time.
- `matter_search_items`: runs Matter item search and returns compact candidates with local post-filtering.
- `matter_get_annotations`: retrieves paginated highlights and user notes for one item.
- `matter_get_item`: retrieves item metadata, optional parsed Markdown, optional annotations, hashes, truncation metadata, and cache-hit flags.
- `matter_build_context_bundle`: builds a bounded, deterministic, provenance-preserving evidence bundle for broad research tasks.

## Tag convention

Use tags as routing metadata:

- `cursor`: material intended for Cursor workflows.
- `repo-<repository-slug>`: material routed to a repository.
- `intent-<workflow>`: expected use, such as `intent-architecture`.
- Optional: `domain-<topic>` and `project-<project>`.

Tag matching in the MCP server is case-insensitive. Original Matter tag spelling is preserved in outputs. Unknown tag names return close-name suggestions.

## Repository configuration

Repositories can commit `.matter-context.json` using `examples/matter-context.example.json` and validate it with `examples/matter-context.schema.json`. Cursor reads this file and passes its values to MCP tools; the MCP server does not depend on the repository working directory.

## Cache and privacy

The filesystem cache defaults to:

```text
~/.cache/matter-cursor-mcp/
```

It stores account metadata, tags, search results, item metadata, parsed Markdown, Markdown metadata, and annotations. Directories are created with `0700` permissions and files with `0600` where supported.

To delete the cache:

```bash
rm -rf ~/.cache/matter-cursor-mcp
```

To disable it:

```dotenv
MATTER_MCP_CACHE_MODE=off
```

Matter source content returned to Cursor may be sent to the selected AI model as context. Treat cached content as sensitive reading data.

## Rate limits

The client applies process-local throttling for Matter's documented read, search, Markdown, and burst limits. Markdown requests count against both read and Markdown budgets. This throttling cannot account for other clients or devices sharing the same Matter token.

## Security model

- Reads the token only from environment variables.
- Exposes no write tools.
- Issues only `GET` requests through a hard Matter endpoint allowlist.
- Rejects arbitrary paths, arbitrary URLs, unsupported hosts, invalid item IDs, and non-HTTPS production base URLs.
- Redacts `mat_...` tokens and Authorization headers from logs.
- Logs metadata only to stderr; stdout is reserved for MCP protocol JSON.
- Labels returned source content as untrusted evidence and keeps annotation notes separate from source text.

## Development

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run lint
npm run smoke:mcp
npm run inspect
```

Optional live checks require `RUN_LIVE_MATTER_TESTS=true` and a real `MATTER_API_TOKEN`.

## License

MIT
