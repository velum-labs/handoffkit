# Architecture

## Module map

- `src/index.ts`: stdio entrypoint, graceful shutdown, fatal error logging.
- `src/server.ts`: MCP server construction and registration of the seven tools.
- `src/config.ts`: environment parsing and non-fatal configuration-error state.
- `src/logger.ts`: structured stderr JSON logger with token and Authorization redaction.
- `src/matter/`: Matter REST client, response schemas, endpoint allowlist, pagination, rate limiting, and typed errors.
- `src/cache/`: filesystem cache paths, atomic writes, cache interface, no-op cache, and file-backed cache.
- `src/retrieval/`: tag resolution, filtering, content service, candidate ranking, Markdown chunking, chunk ranking, budget allocation, and context-bundle orchestration.
- `src/utils/`: small shared utilities such as SHA-256 hashing.
- `examples/`: Cursor MCP config, repository context config, project rule, and sample report.
- `test/`: unit, mock integration, MCP contract, and gated live tests.

## Data flow by tool

### `matter_health`

1. Validate local configuration state.
2. Read fresh account metadata from cache when available.
3. Otherwise call `GET /me`.
4. Return account ID, display name, server metadata, and documented rate limits. The account email is never returned.

### `matter_list_tags`

1. Read tags from in-memory cache, then filesystem cache.
2. Otherwise page through `GET /tags`.
3. Cache the full tag list for five minutes.
4. Apply query and minimum-count filters locally.

### `matter_list_items`

1. Resolve tag names to Matter tag IDs from the tag cache.
2. Page through `GET /items` with bounded scanning.
3. Apply any/all tag matching locally when needed.
4. Return compact metadata only; Markdown and annotations are not fetched.

### `matter_search_items`

1. Resolve tag names when supplied.
2. Page through `GET /search?type=items`.
3. Preserve Matter search order while applying local status, content-type, and tag filters.
4. Return compact candidates and scan-limit warnings.

### `matter_get_annotations`

1. Validate the item ID.
2. Fetch or cache item metadata to obtain `updated_at`.
3. Read annotation cache when the parent `updated_at` matches.
4. Otherwise page through `GET /items/{item_id}/annotations` with page size 100.

### `matter_get_item`

1. Fetch metadata from cache or `GET /items/{id}`.
2. If the item is still processing, return metadata and a warning.
3. If Markdown is requested, read cached Markdown whose metadata matches `updated_at`, otherwise call `GET /items/{id}?include=markdown`.
4. Hash complete Markdown and truncate only the MCP response.
5. Fetch annotations through the same cache-aware annotation service when requested.

### `matter_build_context_bundle`

1. Run Matter search.
2. Apply local filters and supplement with list-items when tags are supplied and too few candidates remain.
3. Enrich up to the best 30 candidates with annotations.
4. Rank candidates deterministically.
5. Fetch selected source Markdown and annotations through cache-aware services.
6. Chunk Markdown, score chunks lexically, and allocate character budgets.
7. Return separated source excerpts, annotations, provenance, truncation, coverage, and warnings.

## Context-bundle pipeline stages

1. Candidate discovery: Matter search, local filters, optional list supplement, dedupe by item ID.
2. Annotation enrichment: bounded concurrency and existing client rate limits.
3. Candidate ranking: transparent weighted heuristic.
4. Source retrieval: cache-aware metadata, Markdown, and annotations.
5. Markdown chunking: heading-aware chunks near 2,500 characters with overlap and code-fence avoidance.
6. Chunk ranking: stopword-aware lexical overlap, heading bonus, phrase bonus, annotation-overlap boost.
7. Budget allocation: annotations before excerpts, per-item cap, total cap, omissions recorded.

## Ranking weights

The constants are exported from `src/retrieval/candidate-ranking.ts`.

| Feature | Weight |
| --- | ---: |
| Matter relevance | 0..100 |
| All required tags present | +25 |
| At least one annotation | +10 |
| At least one non-empty user note | +15 |
| Query match in user note | +20 |
| Favorite item | +5 |
| Recency over last 90 days | 0..5 |

Matter search rank 1 maps to 100 and decreases linearly over the scanned window. Supplemental list-derived candidates receive 0 relevance points. Ties break by Matter item ID ascending.

## Determinism guarantees and limits

Given fixed Matter responses and an injected fixed clock, context bundle selection, ranking, chunk ordering, budgets, and `ctx_...` bundle IDs are deterministic. Results can still change when Matter data changes, the configured budget changes, the query changes, the system clock changes, or Matter returns different search ordering.

## Cache design

Default cache root:

```text
~/.cache/matter-cursor-mcp/
```

Layout:

```text
account.json
tags.json
search/<query-hash>.json
items/<item-id>/metadata.json
items/<item-id>/markdown.md
items/<item-id>/markdown-meta.json
items/<item-id>/annotations.json
tmp/
```

TTL and invalidation:

- Account metadata: 5 minutes.
- Tags: 5 minutes.
- Search results: 60 seconds.
- Item metadata: 5 minutes.
- Markdown: invalidated by item `updated_at`.
- Annotations: invalidated by parent item `updated_at` when available.

Corrupted or unreadable cache entries are treated as misses. `MATTER_MCP_CACHE_MODE=off` uses the no-op cache.
