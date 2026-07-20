import { MatterProtocolError } from "./errors.js";
import type { MatterListResponse } from "./schemas.js";

export async function collectPages<T>(options: {
  fetchPage: (cursor?: string) => Promise<MatterListResponse<T>>;
  maxItems: number;
  maxPages?: number;
}): Promise<{
  results: T[];
  hasMore: boolean;
  nextCursor: string | null;
  pagesFetched: number;
}> {
  const maxPages = options.maxPages ?? 50;
  const results: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasMore = false;
  let nextCursor: string | null = null;
  let pagesFetched = 0;

  while (results.length < options.maxItems && pagesFetched < maxPages) {
    const page = await options.fetchPage(cursor);
    pagesFetched += 1;

    for (const item of page.results) {
      if (results.length >= options.maxItems) {
        break;
      }
      results.push(item);
    }

    hasMore = page.has_more;
    nextCursor = page.next_cursor ?? null;

    if (!hasMore || nextCursor === null) {
      return { results, hasMore: false, nextCursor: null, pagesFetched };
    }

    if (seenCursors.has(nextCursor)) {
      throw new MatterProtocolError("Matter pagination returned a repeated cursor.");
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { results, hasMore, nextCursor, pagesFetched };
}
