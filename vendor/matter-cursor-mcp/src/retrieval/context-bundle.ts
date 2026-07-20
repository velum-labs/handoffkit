import type { MatterClient } from "../matter/client.js";
import type { MatterAnnotation, MatterItem, MatterTag } from "../matter/schemas.js";
import { sha256Hex } from "../utils/hash.js";
import { allocateBudget, type BudgetSourceInput, type CandidateExcerpt } from "./budget.js";
import { rankCandidates, type CandidateForRanking } from "./candidate-ranking.js";
import { rankChunks } from "./chunk-ranking.js";
import { CONTENT_SAFETY_NOTICE, MatterContentService } from "./content-service.js";
import { itemMatchesContentTypes, itemMatchesStatuses, itemMatchesTagIds, type TagMatchMode } from "./item-filtering.js";
import { chunkMarkdown } from "./markdown-chunker.js";
import { resolveTagNames } from "./tag-resolution.js";

export interface TagProvider {
  getTags(): Promise<{ tags: MatterTag[]; cacheHit: boolean }>;
}

export interface BuildContextBundleInput {
  query: string;
  tag_names: string[];
  tag_match: TagMatchMode;
  statuses: Array<"queue" | "archive">;
  content_types: Array<"article" | "video" | "podcast" | "pdf" | "tweet" | "newsletter">;
  max_items: number;
  max_total_chars: number;
  max_chars_per_item: number;
  candidate_scan_limit: number;
  include_annotations: boolean;
  include_unannotated_items: boolean;
  force_refresh: boolean;
}

export interface ContextBundleDependencies {
  client: MatterClient;
  contentService: MatterContentService;
  tagProvider: TagProvider;
  now?: () => number;
  annotationConcurrency?: number;
}

interface Candidate {
  item: MatterItem;
  matterRank: number | null;
}

export async function buildContextBundle(input: BuildContextBundleInput, deps: ContextBundleDependencies) {
  const now = deps.now ?? (() => Date.now());
  const resolvedTags = input.tag_names.length > 0 ? resolveTagNames(input.tag_names, (await deps.tagProvider.getTags()).tags) : {
    requestedNames: [],
    tagIds: [],
    tags: []
  };

  const discovery = await discoverCandidates(input, deps.client, resolvedTags.tagIds);
  const candidatesAfterFilters = discovery.candidates.length;
  const enriched = await enrichCandidates(input, discovery.candidates, deps);
  const rankable = enriched
    .filter((candidate) => input.include_unannotated_items || candidate.annotations.length > 0)
    .map(
      (candidate): CandidateForRanking => ({
        item: candidate.item,
        matterRank: candidate.matterRank,
        scannedWindow: Math.max(1, discovery.scannedCount),
        requiredTagIds: resolvedTags.tagIds,
        annotations: candidate.annotations
      })
    );
  const ranked = rankCandidates(input.query, rankable, now());
  const selected = ranked.slice(0, input.max_items);
  const omitted = ranked.slice(input.max_items);

  const retrieved = await Promise.all(
    selected.map(async (candidate) => {
      const markdownResult = await deps.contentService.getMarkdown(candidate.item, {
        forceRefresh: input.force_refresh
      });
      const annotations = input.include_annotations
        ? candidate.annotations
        : [];
      const chunks = markdownResult.markdown ? chunkMarkdown(markdownResult.markdown) : [];
      const rankedChunks = rankChunks(input.query, chunks, annotations);
      const excerpts: CandidateExcerpt[] = rankedChunks.map((chunk) => ({
        excerpt_id: `${candidate.item.id}#chunk-${chunk.index}`,
        heading_path: chunk.heading_path,
        start_char: chunk.start_char,
        end_char: chunk.end_char,
        score: Number(chunk.score.toFixed(3)),
        text: chunk.text
      }));
      return {
        candidate,
        annotations,
        excerpts,
        markdownMeta: markdownResult.meta,
        markdownIncluded: markdownResult.markdown !== null,
        completeMarkdownCharCount: markdownResult.meta?.char_count ?? 0
      };
    })
  );

  const budget = allocateBudget({
    sources: retrieved.map(
      (entry): BudgetSourceInput => ({
        itemId: entry.candidate.item.id,
        annotations: entry.annotations,
        excerpts: entry.excerpts,
        completeMarkdownCharCount: entry.completeMarkdownCharCount
      })
    ),
    maxTotalChars: input.max_total_chars,
    maxCharsPerItem: input.max_chars_per_item
  });
  const allocationByItem = new Map(budget.sources.map((source) => [source.itemId, source]));
  const selectedIdsForBundle = [...selected]
    .sort((a, b) => a.item.id.localeCompare(b.item.id))
    .map((candidate) => `${candidate.item.id}:${candidate.item.updated_at}`)
    .join("|");

  const sources = retrieved.map((entry, index) => {
    const allocation = allocationByItem.get(entry.candidate.item.id);
    if (!allocation) {
      throw new Error("Missing budget allocation for selected item.");
    }

    return {
      selection_rank: index + 1,
      selection_score: entry.candidate.selectionScore,
      selection_reasons: entry.candidate.selectionReasons,
      item: itemForBundle(entry.candidate.item),
      annotations: allocation.annotations,
      source_excerpts: allocation.source_excerpts,
      provenance: {
        matter_item_id: entry.candidate.item.id,
        matter_item_updated_at: entry.candidate.item.updated_at,
        source_url: entry.candidate.item.url ?? null,
        markdown_sha256: entry.markdownMeta?.sha256 ?? null
      },
      truncation: {
        markdown_was_truncated_for_bundle: allocation.markdown_was_truncated_for_bundle,
        complete_markdown_char_count: allocation.complete_markdown_char_count,
        returned_source_excerpt_chars: allocation.returned_source_excerpt_chars
      }
    };
  });

  const warnings = [...budget.warnings];
  for (const entry of retrieved) {
    if (!entry.markdownIncluded) {
      warnings.push(`Markdown was not available for ${entry.candidate.item.id}.`);
    }
  }
  if (discovery.scanLimitReached) {
    warnings.push("Candidate scan limit was reached during discovery.");
  }

  return {
    schema_version: "1.0",
    bundle_id: `ctx_${sha256Hex(`${input.query}|${selectedIdsForBundle}`).slice(0, 32)}`,
    query: input.query,
    generated_at: new Date(now()).toISOString(),
    selection_policy: {
      algorithm: "matter-search-plus-annotations-lexical-v1",
      max_items: input.max_items,
      max_total_chars: input.max_total_chars,
      max_chars_per_item: input.max_chars_per_item,
      candidate_scan_limit: input.candidate_scan_limit
    },
    sources,
    coverage: {
      candidates_scanned: discovery.scannedCount,
      candidates_after_filters: candidatesAfterFilters,
      sources_selected: selected.length,
      sources_omitted: omitted.length,
      returned_annotation_chars: budget.returned_annotation_chars,
      returned_source_excerpt_chars: budget.returned_source_excerpt_chars,
      returned_total_chars: budget.returned_total_chars,
      budget_exhausted: budget.budget_exhausted,
      scan_limit_reached: discovery.scanLimitReached
    },
    omitted_sources: omitted.map((candidate) => ({
      item_id: candidate.item.id,
      title: candidate.item.title,
      reason: "lower_rank_than_selected_sources"
    })),
    content_safety_notice: CONTENT_SAFETY_NOTICE,
    warnings
  };
}

async function discoverCandidates(input: BuildContextBundleInput, client: MatterClient, tagIds: string[]) {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let scannedCount = 0;
  let scanLimitReached = false;

  while (scannedCount < input.candidate_scan_limit) {
    const pageSize = Math.min(100, input.candidate_scan_limit - scannedCount);
    const page = await client.search({ query: input.query, limit: pageSize, cursor });
    for (const item of page.results) {
      scannedCount += 1;
      const rank = scannedCount;
      if (
        itemMatchesStatuses(item, input.statuses) &&
        itemMatchesContentTypes(item, input.content_types) &&
        itemMatchesTagIds(item, tagIds, input.tag_match) &&
        !seen.has(item.id)
      ) {
        candidates.push({ item, matterRank: rank });
        seen.add(item.id);
      }
      if (scannedCount >= input.candidate_scan_limit) {
        break;
      }
    }
    if (scannedCount >= input.candidate_scan_limit && page.has_more) {
      scanLimitReached = true;
      break;
    }
    if (!page.has_more || !page.next_cursor) {
      break;
    }
    cursor = page.next_cursor;
  }

  if (candidates.length < input.max_items && tagIds.length > 0) {
    cursor = undefined;
    while (candidates.length < input.max_items && scannedCount < input.candidate_scan_limit) {
      const pageSize = Math.min(100, input.candidate_scan_limit - scannedCount);
      const page = await client.listItems({
        statuses: input.statuses,
        contentTypes: input.content_types,
        tagIds,
        order: "updated",
        limit: pageSize,
        cursor
      });
      for (const item of page.results) {
        scannedCount += 1;
        if (
          itemMatchesStatuses(item, input.statuses) &&
          itemMatchesContentTypes(item, input.content_types) &&
          itemMatchesTagIds(item, tagIds, input.tag_match) &&
          !seen.has(item.id)
        ) {
          candidates.push({ item, matterRank: null });
          seen.add(item.id);
        }
        if (candidates.length >= input.max_items || scannedCount >= input.candidate_scan_limit) {
          break;
        }
      }
      if (scannedCount >= input.candidate_scan_limit && page.has_more) {
        scanLimitReached = true;
        break;
      }
      if (!page.has_more || !page.next_cursor) {
        break;
      }
      cursor = page.next_cursor;
    }
  }

  return { candidates, scannedCount, scanLimitReached };
}

async function enrichCandidates(
  input: BuildContextBundleInput,
  candidates: Candidate[],
  deps: ContextBundleDependencies
) {
  const top = candidates.slice(0, 30);
  const rest = candidates.slice(30).map((candidate) => ({ ...candidate, annotations: [] as MatterAnnotation[] }));
  if (!input.include_annotations) {
    return candidates.map((candidate) => ({ ...candidate, annotations: [] as MatterAnnotation[] }));
  }

  const enrichedTop = await mapWithConcurrency(top, deps.annotationConcurrency ?? 3, async (candidate) => {
    const annotations = await deps.contentService.getAnnotations(candidate.item.id, {
      limit: 1_000,
      forceRefresh: input.force_refresh,
      parentUpdatedAt: candidate.item.updated_at
    });
    return { ...candidate, annotations: annotations.annotations };
  });
  return [...enrichedTop, ...rest];
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function itemForBundle(item: MatterItem) {
  return {
    id: item.id,
    title: item.title,
    url: item.url ?? null,
    author_name: item.author?.name ?? null,
    site_name: item.site_name,
    content_type: item.content_type,
    status: item.status ?? null,
    tags: item.tags.map((tag) => tag.name),
    updated_at: item.updated_at
  };
}
