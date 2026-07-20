import type { MatterAccount, MatterAnnotation, MatterItem, MatterListResponse, MatterTag } from "../matter/schemas.js";
import { sha256Hex } from "../utils/hash.js";

export interface CacheResult<T> {
  value: T | null;
  hit: boolean;
}

export interface MarkdownCacheEntry {
  markdown: string;
  meta: {
    item_id: string;
    item_updated_at: string;
    fetched_at: string;
    sha256: string;
    char_count: number;
  };
}

export interface MatterCache {
  getAccount(nowMs?: number): Promise<CacheResult<MatterAccount>>;
  setAccount(account: MatterAccount, nowMs?: number): Promise<void>;
  getTags(nowMs?: number): Promise<CacheResult<MatterTag[]>>;
  setTags(tags: MatterTag[], nowMs?: number): Promise<void>;
  getSearch(queryKey: string, nowMs?: number): Promise<CacheResult<MatterListResponse<MatterItem>>>;
  setSearch(queryKey: string, results: MatterListResponse<MatterItem>, nowMs?: number): Promise<void>;
  getItemMetadata(itemId: string, nowMs?: number): Promise<CacheResult<MatterItem>>;
  setItemMetadata(item: MatterItem, nowMs?: number): Promise<void>;
  getMarkdown(itemId: string, itemUpdatedAt: string): Promise<CacheResult<MarkdownCacheEntry>>;
  setMarkdown(itemId: string, itemUpdatedAt: string, markdown: string, nowMs?: number): Promise<MarkdownCacheEntry>;
  getAnnotations(itemId: string, itemUpdatedAt?: string | null): Promise<CacheResult<MatterAnnotation[]>>;
  setAnnotations(itemId: string, annotations: MatterAnnotation[], itemUpdatedAt?: string | null, nowMs?: number): Promise<void>;
}

export class NoopMatterCache implements MatterCache {
  async getAccount(): Promise<CacheResult<MatterAccount>> {
    return { value: null, hit: false };
  }

  async setAccount(): Promise<void> {}

  async getTags(): Promise<CacheResult<MatterTag[]>> {
    return { value: null, hit: false };
  }

  async setTags(): Promise<void> {}

  async getSearch(): Promise<CacheResult<MatterListResponse<MatterItem>>> {
    return { value: null, hit: false };
  }

  async setSearch(): Promise<void> {}

  async getItemMetadata(): Promise<CacheResult<MatterItem>> {
    return { value: null, hit: false };
  }

  async setItemMetadata(): Promise<void> {}

  async getMarkdown(): Promise<CacheResult<MarkdownCacheEntry>> {
    return { value: null, hit: false };
  }

  async setMarkdown(
    itemId: string,
    itemUpdatedAt: string,
    markdown: string,
    nowMs = Date.now()
  ): Promise<MarkdownCacheEntry> {
    return {
      markdown,
      meta: {
        item_id: itemId,
        item_updated_at: itemUpdatedAt,
        fetched_at: new Date(nowMs).toISOString(),
        sha256: sha256Hex(markdown),
        char_count: markdown.length
      }
    };
  }

  async getAnnotations(): Promise<CacheResult<MatterAnnotation[]>> {
    return { value: null, hit: false };
  }

  async setAnnotations(): Promise<void> {}
}
