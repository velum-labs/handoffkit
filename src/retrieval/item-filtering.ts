import type { MatterItem } from "../matter/schemas.js";

export type TagMatchMode = "any" | "all";

export function itemMatchesTagIds(item: MatterItem, tagIds: string[], mode: TagMatchMode): boolean {
  if (tagIds.length === 0) {
    return true;
  }

  const itemTagIds = new Set(item.tags.map((tag) => tag.id));
  if (mode === "any") {
    return tagIds.some((tagId) => itemTagIds.has(tagId));
  }

  return tagIds.every((tagId) => itemTagIds.has(tagId));
}

export function itemMatchesStatuses(item: MatterItem, statuses: string[]): boolean {
  if (statuses.length === 0) {
    return true;
  }
  return item.status !== null && item.status !== undefined && statuses.includes(item.status);
}

export function itemMatchesContentTypes(item: MatterItem, contentTypes: string[] | undefined): boolean {
  if (!contentTypes || contentTypes.length === 0) {
    return true;
  }
  return item.content_type !== null && contentTypes.includes(item.content_type);
}

export function compactItemForList(item: MatterItem) {
  return {
    id: item.id,
    title: item.title,
    url: item.url ?? null,
    site_name: item.site_name,
    author_name: item.author?.name ?? null,
    status: item.status ?? null,
    processing_status: item.processing_status ?? null,
    content_type: item.content_type,
    is_favorite: item.is_favorite,
    word_count: item.word_count ?? null,
    reading_progress: item.reading_progress ?? null,
    excerpt: item.excerpt ?? null,
    tags: item.tags.map((tag) => ({ id: tag.id, name: tag.name })),
    updated_at: item.updated_at
  };
}

export function compactItemForSearch(item: MatterItem, rank: number) {
  return {
    rank,
    id: item.id,
    title: item.title,
    url: item.url ?? null,
    site_name: item.site_name,
    author_name: item.author?.name ?? null,
    status: item.status ?? null,
    content_type: item.content_type,
    excerpt: item.excerpt ?? null,
    word_count: item.word_count ?? null,
    is_favorite: item.is_favorite,
    tags: item.tags.map((tag) => tag.name),
    updated_at: item.updated_at
  };
}
