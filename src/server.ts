import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEFAULT_RATE_LIMITS,
  SERVER_NAME,
  SERVER_VERSION,
  loadConfig,
  type EnvLike,
  type MatterMcpConfig
} from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { MatterClient, type MatterFetch } from "./matter/client.js";
import { MatterRateLimiter } from "./matter/rate-limiter.js";
import { MatterProtocolError, toMatterError } from "./matter/errors.js";
import { collectPages } from "./matter/pagination.js";
import type { MatterItem, MatterTag } from "./matter/schemas.js";
import {
  compactItemForList,
  compactItemForSearch,
  itemMatchesContentTypes,
  itemMatchesStatuses,
  itemMatchesTagIds,
  type TagMatchMode
} from "./retrieval/item-filtering.js";
import { resolveTagNames } from "./retrieval/tag-resolution.js";

const STATUS_SCHEMA = z.enum(["inbox", "queue", "archive"]);
const SEARCH_STATUS_SCHEMA = z.enum(["queue", "archive"]);
const CONTENT_TYPE_SCHEMA = z.enum(["article", "video", "podcast", "pdf", "tweet", "newsletter"]);
const TAG_MATCH_SCHEMA = z.enum(["any", "all"]);

const healthInputSchema = z.object({}).strict();

const listTagsInputSchema = z
  .object({
    query: z.string().optional(),
    min_item_count: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100)
  })
  .strict();

const listItemsInputSchema = z
  .object({
    statuses: z.array(STATUS_SCHEMA).default(["queue", "archive"]),
    content_types: z.array(CONTENT_TYPE_SCHEMA).optional().default([]),
    tag_names: z.array(z.string().min(1)).optional().default([]),
    tag_match: TAG_MATCH_SCHEMA.default("all"),
    is_favorite: z.boolean().nullable().default(null),
    updated_since: z.string().datetime().nullable().default(null),
    order: z.enum(["updated", "library_position", "inbox_position"]).default("updated"),
    limit: z.number().int().min(1).max(500).default(50)
  })
  .strict();

const searchItemsInputSchema = z
  .object({
    query: z.string().min(2),
    statuses: z.array(SEARCH_STATUS_SCHEMA).default(["queue", "archive"]),
    content_types: z.array(CONTENT_TYPE_SCHEMA).optional().default([]),
    tag_names: z.array(z.string().min(1)).optional().default([]),
    tag_match: TAG_MATCH_SCHEMA.default("all"),
    limit: z.number().int().min(1).max(50).default(20),
    candidate_scan_limit: z.number().int().min(10).max(500).default(100)
  })
  .strict();

export interface TagListCache {
  getTags(): Promise<{ tags: MatterTag[]; cacheHit: boolean }>;
}

export class InMemoryTagListCache implements TagListCache {
  private cached: { tags: MatterTag[]; expiresAt: number } | null = null;

  constructor(
    private readonly client: MatterClient,
    private readonly ttlMs = 5 * 60_000,
    private readonly now = () => Date.now()
  ) {}

  async getTags(): Promise<{ tags: MatterTag[]; cacheHit: boolean }> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return { tags: this.cached.tags, cacheHit: true };
    }

    const collected = await collectPages({
      fetchPage: (cursor) => this.client.listTags({ limit: 100, cursor }),
      maxItems: 10_000,
      maxPages: 50
    });
    this.cached = { tags: collected.results, expiresAt: this.now() + this.ttlMs };
    return { tags: collected.results, cacheHit: false };
  }
}

export interface CreateMatterServerOptions {
  env?: EnvLike;
  fetchImpl?: MatterFetch;
  logger?: Logger;
  rateLimiter?: { acquire(category: "read" | "search" | "markdown"): Promise<void> };
  tagCache?: TagListCache;
}

export function createMatterServer(options: CreateMatterServerOptions = {}): McpServer {
  const config = loadConfig(options.env);
  const logger = options.logger ?? createLogger(config.logLevel);
  const rateLimiter = options.rateLimiter ?? new MatterRateLimiter();
  const client = new MatterClient({
    config: {
      apiToken: config.apiToken,
      baseUrl: config.apiBaseUrl,
      userAgent: config.userAgent,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries
    },
    fetchImpl: options.fetchImpl,
    rateLimiter,
    logger
  });
  const tagCache = options.tagCache ?? new InMemoryTagListCache(client);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerTools(server, { config, logger, client, tagCache });
  return server;
}

interface ToolContext {
  config: MatterMcpConfig;
  logger: Logger;
  client: MatterClient;
  tagCache: TagListCache;
}

function registerTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "matter_health",
    {
      title: "Matter health",
      description: "Validate Matter authentication, API connectivity, and local server configuration.",
      inputSchema: healthInputSchema
    },
    async () =>
      runTool(context, "matter_health", async () => {
        const account = await context.client.getMe();
        return {
          schema_version: "1.0",
          ok: true,
          matter: {
            account_id: account.id,
            display_name: account.name ?? null,
            api_base_url: context.config.apiBaseUrl,
            api_version: "v1",
            rate_limits: DEFAULT_RATE_LIMITS
          },
          server: {
            version: SERVER_VERSION,
            transport: "stdio",
            access_mode: "read_only",
            cache_enabled: context.config.cacheMode === "on",
            cache_directory: context.config.cacheDir
          }
        };
      })
  );

  server.registerTool(
    "matter_list_tags",
    {
      title: "List Matter tags",
      description: "Discover Matter tags by optional substring query before filtering or searching items by tag.",
      inputSchema: listTagsInputSchema
    },
    async (args) =>
      runTool(context, "matter_list_tags", async () => {
        const { tags, cacheHit } = await context.tagCache.getTags();
        const query = args.query?.toLowerCase();
        const filtered = tags
          .filter((tag) => (tag.item_count ?? 0) >= args.min_item_count)
          .filter((tag) => (query ? tag.name.toLowerCase().includes(query) : true))
          .sort((a, b) => sortTags(a.name, b.name, query));
        const returned = filtered.slice(0, args.limit);

        context.logger.debug({
          tool_name: "matter_list_tags",
          cache_hit: cacheHit,
          returned_item_count: returned.length,
          truncated: filtered.length > returned.length
        });

        return {
          schema_version: "1.0",
          tags: returned.map((tag) => ({
            id: tag.id,
            name: tag.name,
            item_count: tag.item_count ?? 0,
            created_at: tag.created_at
          })),
          returned_count: returned.length,
          truncated: filtered.length > returned.length
        };
      })
  );

  server.registerTool(
    "matter_list_items",
    {
      title: "List Matter items",
      description: "List compact Matter item metadata by status, content type, favorite state, updated time, and tags.",
      inputSchema: listItemsInputSchema
    },
    async (args) =>
      runTool(context, "matter_list_items", async () => {
        const resolvedTags = await resolveRequestedTags(context.tagCache, args.tag_names);
        const scanLimit = 500;
        const collected = await scanItems({
          fetchPage: (cursor, pageSize) =>
            context.client.listItems({
              statuses: args.statuses,
              contentTypes: args.content_types.length > 0 ? args.content_types : undefined,
              tagIds: resolvedTags.tagIds.length > 0 ? resolvedTags.tagIds : undefined,
              isFavorite: args.is_favorite,
              updatedSince: args.updated_since,
              order: args.order,
              limit: pageSize,
              cursor
            }),
          limit: args.limit,
          scanLimit,
          tagIds: resolvedTags.tagIds,
          tagMatch: args.tag_match,
          statuses: args.statuses,
          contentTypes: args.content_types
        });

        return {
          schema_version: "1.0",
          items: collected.items.map((entry) => compactItemForList(entry.item)),
          returned_count: collected.items.length,
          scanned_count: collected.scannedCount,
          has_more: collected.hasMore,
          truncated: collected.items.length >= args.limit && (collected.hasMore || collected.scanLimitReached),
          scan_limit_reached: collected.scanLimitReached,
          warnings: collected.scanLimitReached
            ? ["Stopped scanning after the 500-item Phase 2 candidate scan limit."]
            : [],
          filters: {
            statuses: args.statuses,
            content_types: args.content_types,
            tag_names: resolvedTags.requestedNames,
            tag_match: args.tag_match
          }
        };
      })
  );

  server.registerTool(
    "matter_search_items",
    {
      title: "Search Matter items",
      description: "Run Matter full-text item search and return compact candidates in Matter relevance order.",
      inputSchema: searchItemsInputSchema
    },
    async (args) =>
      runTool(context, "matter_search_items", async () => {
        const resolvedTags = await resolveRequestedTags(context.tagCache, args.tag_names);
        const collected = await scanItems({
          fetchPage: (cursor, pageSize) =>
            context.client.search({
              query: args.query,
              statuses: args.statuses,
              limit: pageSize,
              cursor
            }),
          limit: args.limit,
          scanLimit: args.candidate_scan_limit,
          tagIds: resolvedTags.tagIds,
          tagMatch: args.tag_match,
          statuses: args.statuses,
          contentTypes: args.content_types
        });

        return {
          schema_version: "1.0",
          query: args.query,
          items: collected.items.map((entry) => compactItemForSearch(entry.item, entry.rank)),
          returned_count: collected.items.length,
          scanned_count: collected.scannedCount,
          scan_limit_reached: collected.scanLimitReached,
          warnings: collected.scanLimitReached
            ? ["Post-filtering may have hidden relevant items because the candidate scan limit was reached."]
            : []
        };
      })
  );
}

async function runTool(context: ToolContext, toolName: string, handler: () => Promise<unknown>): Promise<CallToolResult> {
  if (context.config.configurationError) {
    return errorResult(context.config.configurationError);
  }

  try {
    const result = await handler();
    context.logger.debug({ tool_name: toolName, message: "tool_completed" });
    return jsonResult(result);
  } catch (error) {
    return errorResult(toMatterError(error));
  }
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function errorResult(error: { code: string; message: string; retryable: boolean }): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            schema_version: "1.0",
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable
            }
          },
          null,
          2
        )
      }
    ]
  };
}

function sortTags(a: string, b: string, query?: string): number {
  if (query) {
    const aPrefix = a.toLowerCase().startsWith(query);
    const bPrefix = b.toLowerCase().startsWith(query);
    if (aPrefix !== bPrefix) {
      return aPrefix ? -1 : 1;
    }
  }

  return a.localeCompare(b);
}

async function resolveRequestedTags(tagCache: TagListCache, tagNames: string[]) {
  if (tagNames.length === 0) {
    return { requestedNames: [], tagIds: [] };
  }
  const { tags } = await tagCache.getTags();
  return resolveTagNames(tagNames, tags);
}

async function scanItems(options: {
  fetchPage: (cursor: string | undefined, pageSize: number) => Promise<{
    results: MatterItem[];
    has_more: boolean;
    next_cursor?: string | null;
  }>;
  limit: number;
  scanLimit: number;
  tagIds: string[];
  tagMatch: TagMatchMode;
  statuses: string[];
  contentTypes: string[];
}): Promise<{
  items: Array<{ item: MatterItem; rank: number }>;
  scannedCount: number;
  hasMore: boolean;
  scanLimitReached: boolean;
}> {
  const items: Array<{ item: MatterItem; rank: number }> = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scannedCount = 0;
  let hasMore = false;
  let scanLimitReached = false;

  while (items.length < options.limit && scannedCount < options.scanLimit) {
    const pageSize = Math.min(100, options.scanLimit - scannedCount);
    const page = await options.fetchPage(cursor, pageSize);
    hasMore = page.has_more;

    for (const item of page.results) {
      scannedCount += 1;
      const rank = scannedCount;
      if (
        itemMatchesStatuses(item, options.statuses) &&
        itemMatchesContentTypes(item, options.contentTypes) &&
        itemMatchesTagIds(item, options.tagIds, options.tagMatch)
      ) {
        items.push({ item, rank });
        if (items.length >= options.limit) {
          break;
        }
      }

      if (scannedCount >= options.scanLimit) {
        break;
      }
    }

    if (scannedCount >= options.scanLimit && page.has_more) {
      scanLimitReached = true;
      break;
    }

    const nextCursor = page.next_cursor ?? null;
    if (!page.has_more || nextCursor === null) {
      hasMore = false;
      break;
    }

    if (seenCursors.has(nextCursor)) {
      throw new MatterProtocolError("Matter pagination returned a repeated cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { items, scannedCount, hasMore, scanLimitReached };
}
