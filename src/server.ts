import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type MatterCache } from "./cache/cache.js";
import { createMatterCache } from "./cache/file-cache.js";
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
import {
  annotationForOutput,
  CONTENT_SAFETY_NOTICE,
  itemForDetail,
  MatterContentService
} from "./retrieval/content-service.js";
import { buildContextBundle } from "./retrieval/context-bundle.js";

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

const getAnnotationsInputSchema = z
  .object({
    item_id: z.string().regex(/^itm_[A-Za-z0-9]+$/),
    limit: z.number().int().min(1).max(1000).default(500),
    force_refresh: z.boolean().default(false)
  })
  .strict();

const getItemInputSchema = z
  .object({
    item_id: z.string().regex(/^itm_[A-Za-z0-9]+$/),
    include_markdown: z.boolean().default(true),
    include_annotations: z.boolean().default(true),
    max_markdown_chars: z.number().int().min(1000).max(300000).default(120000),
    force_refresh: z.boolean().default(false)
  })
  .strict();

const buildContextBundleInputSchema = z
  .object({
    query: z.string().min(2),
    tag_names: z.array(z.string().min(1)).default([]),
    tag_match: TAG_MATCH_SCHEMA.default("all"),
    statuses: z.array(SEARCH_STATUS_SCHEMA).default(["queue", "archive"]),
    content_types: z.array(CONTENT_TYPE_SCHEMA).default(["article", "tweet", "pdf", "newsletter"]),
    max_items: z.number().int().min(1).max(20).default(8),
    max_total_chars: z.number().int().min(5000).max(200000).default(60000),
    max_chars_per_item: z.number().int().min(1000).max(50000).default(12000),
    candidate_scan_limit: z.number().int().min(10).max(500).default(100),
    include_annotations: z.boolean().default(true),
    include_unannotated_items: z.boolean().default(true),
    force_refresh: z.boolean().default(false)
  })
  .strict();

export interface TagListCache {
  getTags(): Promise<{ tags: MatterTag[]; cacheHit: boolean }>;
}

export class InMemoryTagListCache implements TagListCache {
  private cached: { tags: MatterTag[]; expiresAt: number } | null = null;

  constructor(
    private readonly client: MatterClient,
    private readonly cache: MatterCache,
    private readonly ttlMs = 5 * 60_000,
    private readonly now = () => Date.now()
  ) {}

  async getTags(): Promise<{ tags: MatterTag[]; cacheHit: boolean }> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return { tags: this.cached.tags, cacheHit: true };
    }

    const fileCached = await this.cache.getTags(this.now());
    if (fileCached.hit && fileCached.value) {
      this.cached = { tags: fileCached.value, expiresAt: this.now() + this.ttlMs };
      return { tags: fileCached.value, cacheHit: true };
    }

    const collected = await collectPages({
      fetchPage: (cursor) => this.client.listTags({ limit: 100, cursor }),
      maxItems: 10_000,
      maxPages: 50
    });
    this.cached = { tags: collected.results, expiresAt: this.now() + this.ttlMs };
    await this.cache.setTags(collected.results, this.now());
    return { tags: collected.results, cacheHit: false };
  }
}

export interface CreateMatterServerOptions {
  env?: EnvLike;
  fetchImpl?: MatterFetch;
  logger?: Logger;
  rateLimiter?: { acquire(category: "read" | "search" | "markdown"): Promise<void> };
  tagCache?: TagListCache;
  cache?: MatterCache;
  contentService?: MatterContentService;
  now?: () => number;
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
  const cache =
    options.cache ??
    createMatterCache({
      rootDir: config.cacheDir,
      enabled: config.cacheMode === "on",
      now: options.now
    });
  const tagCache = options.tagCache ?? new InMemoryTagListCache(client, cache);
  const contentService = options.contentService ?? new MatterContentService(client, cache, options.now);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerTools(server, { config, logger, client, tagCache, cache, contentService, now: options.now ?? (() => Date.now()) });
  return server;
}

interface ToolContext {
  config: MatterMcpConfig;
  logger: Logger;
  client: MatterClient;
  tagCache: TagListCache;
  cache: MatterCache;
  contentService: MatterContentService;
  now: () => number;
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
        const cached = await context.cache.getAccount(context.now());
        const account = cached.hit && cached.value ? cached.value : await context.client.getMe();
        if (!cached.hit) {
          await context.cache.setAccount(account, context.now());
        }
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

  server.registerTool(
    "matter_get_annotations",
    {
      title: "Get Matter annotations",
      description: "Retrieve all highlights and user notes for one Matter item without interpreting or summarizing them.",
      inputSchema: getAnnotationsInputSchema
    },
    async (args) =>
      runTool(context, "matter_get_annotations", async () => {
        const metadata = await context.contentService.getMetadata(args.item_id, {
          forceRefresh: args.force_refresh
        });
        const annotations = await context.contentService.getAnnotations(args.item_id, {
          limit: args.limit,
          forceRefresh: args.force_refresh,
          parentUpdatedAt: metadata.item.updated_at
        });

        return {
          schema_version: "1.0",
          item_id: args.item_id,
          annotations: annotations.annotations.map(annotationForOutput),
          returned_count: annotations.annotations.length,
          has_more: annotations.hasMore,
          cache: {
            hit: annotations.cacheHit
          }
        };
      })
  );

  server.registerTool(
    "matter_get_item",
    {
      title: "Get Matter item",
      description: "Retrieve one Matter item with optional parsed Markdown and annotations for selected sources.",
      inputSchema: getItemInputSchema
    },
    async (args) =>
      runTool(context, "matter_get_item", async () => {
        const metadata = await context.contentService.getMetadata(args.item_id, {
          forceRefresh: args.force_refresh
        });
        const warnings: string[] = [];
        let markdown: string | null = null;
        let markdownMetadata = {
          included: false,
          complete_char_count: 0,
          returned_char_count: 0,
          truncated: false,
          sha256: null as string | null
        };
        let markdownHit = false;

        if (metadata.item.processing_status === "processing") {
          warnings.push("Matter item is still processing; markdown was not requested.");
        } else if (args.include_markdown) {
          const markdownResult = await context.contentService.getMarkdown(metadata.item, {
            forceRefresh: args.force_refresh
          });
          markdownHit = markdownResult.cacheHit;
          if (markdownResult.markdown !== null && markdownResult.meta) {
            const returned = markdownResult.markdown.slice(0, args.max_markdown_chars);
            markdown = returned;
            markdownMetadata = {
              included: true,
              complete_char_count: markdownResult.meta.char_count,
              returned_char_count: returned.length,
              truncated: markdownResult.markdown.length > returned.length,
              sha256: markdownResult.meta.sha256
            };
            if (markdownMetadata.truncated) {
              warnings.push("Markdown was truncated only in the MCP response; the complete markdown remains cached.");
            }
          }
        }

        const annotations = args.include_annotations
          ? await context.contentService.getAnnotations(args.item_id, {
              limit: 1000,
              forceRefresh: args.force_refresh,
              parentUpdatedAt: metadata.item.updated_at
            })
          : { annotations: [], hasMore: false, cacheHit: false };

        return {
          schema_version: "1.0",
          item: itemForDetail(metadata.item),
          markdown,
          markdown_metadata: markdownMetadata,
          annotations: annotations.annotations.map(annotationForOutput),
          warnings,
          content_safety_notice: CONTENT_SAFETY_NOTICE,
          cache: {
            metadata_hit: metadata.cacheHit,
            markdown_hit: markdownHit,
            annotations_hit: annotations.cacheHit
          }
        };
      })
  );

  server.registerTool(
    "matter_build_context_bundle",
    {
      title: "Build Matter context bundle",
      description:
        "Build a bounded, deterministic, provenance-preserving evidence bundle for broad repository research tasks.",
      inputSchema: buildContextBundleInputSchema
    },
    async (args) =>
      runTool(context, "matter_build_context_bundle", async () =>
        buildContextBundle(args, {
          client: context.client,
          contentService: context.contentService,
          tagProvider: context.tagCache,
          now: context.now
        })
      )
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
