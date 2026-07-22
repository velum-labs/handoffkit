import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MatterAccountSchema, MatterAnnotationSchema, MatterItemSchema, MatterTagSchema } from "../matter/schemas.js";
import type { MatterItem, MatterListResponse } from "../matter/schemas.js";
import { sha256Hex } from "../utils/hash.js";
import { atomicWriteFile, ensurePrivateDir } from "./atomic-write.js";
import { type CacheResult, type MarkdownCacheEntry, type MatterCache, NoopMatterCache } from "./cache.js";
import { createCachePaths, type CachePaths } from "./paths.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_MINUTE_MS = 60_000;

const JsonAccountEntrySchema = z
  .object({
    fetched_at: z.string(),
    account: MatterAccountSchema
  })
  .passthrough();

const JsonTagsEntrySchema = z
  .object({
    fetched_at: z.string(),
    tags: z.array(MatterTagSchema)
  })
  .passthrough();

const JsonMetadataEntrySchema = z
  .object({
    fetched_at: z.string(),
    item: MatterItemSchema
  })
  .passthrough();

const JsonSearchEntrySchema = z
  .object({
    fetched_at: z.string(),
    results: z
      .object({
        object: z.literal("list").optional(),
        results: z.array(MatterItemSchema),
        has_more: z.boolean(),
        next_cursor: z.string().nullable().optional()
      })
      .passthrough()
  })
  .passthrough();

const JsonAnnotationsEntrySchema = z
  .object({
    fetched_at: z.string(),
    item_updated_at: z.string().nullable().optional(),
    annotations: z.array(MatterAnnotationSchema)
  })
  .passthrough();

const MarkdownMetaSchema = z
  .object({
    item_id: z.string(),
    item_updated_at: z.string(),
    fetched_at: z.string(),
    sha256: z.string(),
    char_count: z.number().int().nonnegative()
  })
  .passthrough();

export interface FileMatterCacheOptions {
  rootDir?: string;
  enabled?: boolean;
  now?: () => number;
}

export function createMatterCache(options: FileMatterCacheOptions = {}): MatterCache {
  if (options.enabled === false) {
    return new NoopMatterCache();
  }

  return new FileMatterCache(options);
}

export class FileMatterCache implements MatterCache {
  readonly paths: CachePaths;
  private readonly now: () => number;

  constructor(options: FileMatterCacheOptions = {}) {
    this.paths = createCachePaths(options.rootDir);
    this.now = options.now ?? (() => Date.now());
  }

  async getAccount(nowMs = this.now()): Promise<CacheResult<z.infer<typeof MatterAccountSchema>>> {
    const entry = await readJson(this.paths.account, JsonAccountEntrySchema);
    if (!entry || isExpired(entry.fetched_at, FIVE_MINUTES_MS, nowMs)) {
      return miss();
    }
    return hit(entry.account);
  }

  async setAccount(account: z.infer<typeof MatterAccountSchema>, nowMs = this.now()): Promise<void> {
    await this.writeJson(this.paths.account, {
      fetched_at: new Date(nowMs).toISOString(),
      account
    });
  }

  async getTags(nowMs = this.now()): Promise<CacheResult<z.infer<typeof MatterTagSchema>[]>> {
    const entry = await readJson(this.paths.tags, JsonTagsEntrySchema);
    if (!entry || isExpired(entry.fetched_at, FIVE_MINUTES_MS, nowMs)) {
      return miss();
    }
    return hit(entry.tags);
  }

  async setTags(tags: z.infer<typeof MatterTagSchema>[], nowMs = this.now()): Promise<void> {
    await this.writeJson(this.paths.tags, {
      fetched_at: new Date(nowMs).toISOString(),
      tags
    });
  }

  async getSearch(queryKey: string, nowMs = this.now()): Promise<CacheResult<MatterListResponse<MatterItem>>> {
    const entry = await readJson(this.paths.search(queryKey), JsonSearchEntrySchema);
    if (!entry || isExpired(entry.fetched_at, ONE_MINUTE_MS, nowMs)) {
      return miss();
    }
    return hit(entry.results);
  }

  async setSearch(queryKey: string, results: MatterListResponse<MatterItem>, nowMs = this.now()): Promise<void> {
    await this.writeJson(this.paths.search(queryKey), {
      fetched_at: new Date(nowMs).toISOString(),
      results
    });
  }

  async getItemMetadata(
    itemId: string,
    nowMs = this.now()
  ): Promise<CacheResult<z.infer<typeof MatterItemSchema>>> {
    const entry = await readJson(this.paths.itemMetadata(itemId), JsonMetadataEntrySchema);
    if (!entry || entry.item.id !== itemId || isExpired(entry.fetched_at, FIVE_MINUTES_MS, nowMs)) {
      return miss();
    }
    return hit(entry.item);
  }

  async setItemMetadata(item: z.infer<typeof MatterItemSchema>, nowMs = this.now()): Promise<void> {
    await this.writeJson(this.paths.itemMetadata(item.id), {
      fetched_at: new Date(nowMs).toISOString(),
      item
    });
  }

  async getMarkdown(itemId: string, itemUpdatedAt: string): Promise<CacheResult<MarkdownCacheEntry>> {
    try {
      const [markdown, metaRaw] = await Promise.all([
        readFile(this.paths.itemMarkdown(itemId), "utf8"),
        readFile(this.paths.itemMarkdownMeta(itemId), "utf8")
      ]);
      const meta = MarkdownMetaSchema.parse(JSON.parse(metaRaw));
      if (meta.item_id !== itemId || meta.item_updated_at !== itemUpdatedAt || meta.char_count !== markdown.length) {
        return miss();
      }
      if (meta.sha256 !== sha256Hex(markdown)) {
        return miss();
      }
      return hit({ markdown, meta });
    } catch {
      return miss();
    }
  }

  async setMarkdown(
    itemId: string,
    itemUpdatedAt: string,
    markdown: string,
    nowMs = this.now()
  ): Promise<MarkdownCacheEntry> {
    const meta = {
      item_id: itemId,
      item_updated_at: itemUpdatedAt,
      fetched_at: new Date(nowMs).toISOString(),
      sha256: sha256Hex(markdown),
      char_count: markdown.length
    };
    await ensurePrivateDir(this.paths.itemDir(itemId));
    await Promise.all([
      atomicWriteFile(this.paths.itemMarkdown(itemId), markdown),
      atomicWriteFile(this.paths.itemMarkdownMeta(itemId), `${JSON.stringify(meta, null, 2)}\n`)
    ]);
    return { markdown, meta };
  }

  async getAnnotations(
    itemId: string,
    itemUpdatedAt?: string | null
  ): Promise<CacheResult<z.infer<typeof MatterAnnotationSchema>[]>> {
    const entry = await readJson(this.paths.itemAnnotations(itemId), JsonAnnotationsEntrySchema);
    if (!entry) {
      return miss();
    }
    if (itemUpdatedAt && entry.item_updated_at !== itemUpdatedAt) {
      return miss();
    }
    return hit(entry.annotations);
  }

  async setAnnotations(
    itemId: string,
    annotations: z.infer<typeof MatterAnnotationSchema>[],
    itemUpdatedAt?: string | null,
    nowMs = this.now()
  ): Promise<void> {
    await this.writeJson(this.paths.itemAnnotations(itemId), {
      fetched_at: new Date(nowMs).toISOString(),
      item_updated_at: itemUpdatedAt ?? null,
      annotations
    });
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await ensurePrivateDir(this.paths.root);
    await ensurePrivateDir(this.paths.tmpDir);
    await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isExpired(fetchedAt: string, ttlMs: number, nowMs: number): boolean {
  const fetchedMs = Date.parse(fetchedAt);
  return Number.isNaN(fetchedMs) || nowMs - fetchedMs >= ttlMs;
}

function hit<T>(value: T): CacheResult<T> {
  return { value, hit: true };
}

function miss<T>(): CacheResult<T> {
  return { value: null, hit: false };
}
