import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../../src/cache/atomic-write.js";
import { FileMatterCache, createMatterCache } from "../../src/cache/file-cache.js";
import { createCachePaths } from "../../src/cache/paths.js";
import { sha256Hex } from "../../src/utils/hash.js";
import { chunkMarkdown } from "../../src/retrieval/markdown-chunker.js";
import { rankChunks } from "../../src/retrieval/chunk-ranking.js";
import { CANDIDATE_RANKING_WEIGHTS, rankCandidates } from "../../src/retrieval/candidate-ranking.js";
import { allocateBudget } from "../../src/retrieval/budget.js";
import { buildContextBundle } from "../../src/retrieval/context-bundle.js";
import type { MatterAnnotation, MatterItem, MatterTag } from "../../src/matter/schemas.js";

const tempDirs: string[] = [];

afterEach(() => {
  tempDirs.length = 0;
});

describe("filesystem cache", () => {
  it("writes atomically with private file permissions", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "entry.json");
    await atomicWriteFile(path, "secret");
    expect(await readFile(path, "utf8")).toBe("secret");
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("handles TTL, updated_at invalidation, cache-off, and corrupted entries as misses", async () => {
    const dir = await tempDir();
    let nowMs = Date.parse("2026-07-20T00:00:00Z");
    const cache = new FileMatterCache({ rootDir: dir, now: () => nowMs });
    const item = sampleItem("itm_CACHE", ["tag_1"], { updated_at: "2026-07-20T00:00:00Z" });

    await cache.setItemMetadata(item);
    expect((await cache.getItemMetadata(item.id)).hit).toBe(true);
    nowMs += 5 * 60_000;
    expect((await cache.getItemMetadata(item.id)).hit).toBe(false);

    await cache.setMarkdown(item.id, item.updated_at, "# markdown");
    expect((await cache.getMarkdown(item.id, item.updated_at)).hit).toBe(true);
    expect((await cache.getMarkdown(item.id, "2026-07-21T00:00:00Z")).hit).toBe(false);

    await cache.setAnnotations(item.id, [sampleAnnotation("ann_1", item.id)], item.updated_at);
    expect((await cache.getAnnotations(item.id, item.updated_at)).hit).toBe(true);
    expect((await cache.getAnnotations(item.id, "2026-07-21T00:00:00Z")).hit).toBe(false);

    await writeFile(createCachePaths(dir).tags, "not json");
    expect((await cache.getTags()).hit).toBe(false);

    const noop = createMatterCache({ enabled: false });
    expect((await noop.getItemMetadata(item.id)).hit).toBe(false);
  });
});

describe("hashing and markdown chunking", () => {
  it("computes stable sha256 hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("tracks heading paths and original offsets", () => {
    const markdown = "# Top\nintro\n\n## Details\nagent memory paragraph\n\n## Other\nmore text";
    const chunks = chunkMarkdown(markdown, { targetChars: 35, overlapChars: 5 });
    expect(chunks[0].heading_path).toEqual(["Top"]);
    expect(chunks[1].text).toBe(markdown.slice(chunks[1].start_char, chunks[1].end_char));
    expect(chunks.some((chunk) => chunk.heading_path.includes("Details"))).toBe(true);
  });

  it("does not split inside fenced code blocks", () => {
    const markdown = `# Code\nbefore\n\n\`\`\`ts\n${"const x = 1;\n".repeat(20)}\`\`\`\n\nafter`;
    const fenceStart = markdown.indexOf("```ts");
    const fenceEnd = markdown.lastIndexOf("```") + 4;
    const chunks = chunkMarkdown(markdown, { targetChars: 80, overlapChars: 10 });
    for (const chunk of chunks) {
      expect(chunk.end_char > fenceStart && chunk.end_char < fenceEnd).toBe(false);
      expect(chunk.start_char > fenceStart && chunk.start_char < fenceEnd).toBe(false);
    }
  });
});

describe("chunk scoring and candidate ranking", () => {
  it("scores stopwords, phrase, heading, annotation boost, and deterministic ties", () => {
    const chunks = [
      { index: 0, heading_path: ["Architecture"], start_char: 0, end_char: 30, text: "the and of unrelated" },
      {
        index: 1,
        heading_path: ["Agent Memory"],
        start_char: 31,
        end_char: 90,
        text: "persistent agent memory helps retrieval"
      },
      {
        index: 2,
        heading_path: ["Agent Memory"],
        start_char: 91,
        end_char: 160,
        text: "persistent agent memory helps retrieval with highlighted evidence"
      }
    ];
    const ranked = rankChunks("the persistent agent memory", chunks, [
      sampleAnnotation("ann_1", "itm_1", { text: "highlighted evidence" })
    ]);
    expect(ranked[0].index).toBe(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(rankChunks("unmatched", chunks.slice(0, 2)).map((chunk) => chunk.index)).toEqual([0, 1]);
  });

  it("applies candidate weights and item-id tie-break", () => {
    const now = Date.parse("2026-07-20T00:00:00Z");
    const ranked = rankCandidates(
      "agent memory",
      [
        {
          item: sampleItem("itm_BBB", ["tag_1"], { is_favorite: true, updated_at: "2026-07-19T00:00:00Z" }),
          matterRank: 1,
          scannedWindow: 10,
          requiredTagIds: ["tag_1"],
          annotations: [sampleAnnotation("ann_1", "itm_BBB", { note: "agent memory note" })]
        },
        {
          item: sampleItem("itm_AAA", ["tag_1"], { updated_at: "2025-01-01T00:00:00Z" }),
          matterRank: null,
          scannedWindow: 10,
          requiredTagIds: ["tag_1"],
          annotations: []
        },
        {
          item: sampleItem("itm_AAB", ["tag_1"], { updated_at: "2025-01-01T00:00:00Z" }),
          matterRank: null,
          scannedWindow: 10,
          requiredTagIds: ["tag_1"],
          annotations: []
        }
      ],
      now
    );

    expect(CANDIDATE_RANKING_WEIGHTS.all_required_tags).toBe(25);
    expect(ranked[0].item.id).toBe("itm_BBB");
    expect(ranked[0].selectionReasons).toContain("query_match_in_user_note");
    expect(ranked[1].item.id).toBe("itm_AAA");
    expect(ranked[2].item.id).toBe("itm_AAB");
  });
});

describe("budget allocation and bundle IDs", () => {
  it("enforces per-item and total caps with annotations before excerpts and omissions", () => {
    const allocation = allocateBudget({
      maxTotalChars: 40,
      maxCharsPerItem: 25,
      minimumExcerptChars: 10,
      sources: [
        {
          itemId: "itm_1",
          annotations: [
            sampleAnnotation("ann_1", "itm_1", { text: "annotation text" }),
            sampleAnnotation("ann_2", "itm_1", { text: "another long annotation" })
          ],
          excerpts: [
            { excerpt_id: "itm_1#chunk-0", heading_path: [], start_char: 0, end_char: 50, score: 1, text: "excerpt text here" }
          ],
          completeMarkdownCharCount: 100
        },
        {
          itemId: "itm_2",
          annotations: [],
          excerpts: [
            { excerpt_id: "itm_2#chunk-0", heading_path: [], start_char: 0, end_char: 50, score: 1, text: "second excerpt text" }
          ],
          completeMarkdownCharCount: 100
        }
      ]
    });

    expect(allocation.returned_total_chars).toBeLessThanOrEqual(40);
    expect(allocation.sources[0].annotations.map((annotation) => annotation.id)).toEqual(["ann_1"]);
    expect(allocation.sources[0].omitted_annotation_ids).toContain("ann_2");
    expect(allocation.sources[0].source_excerpts[0].text.length).toBeGreaterThan(0);
  });

  it("derives deterministic bundle IDs from query and selected item freshness", async () => {
    const now = Date.parse("2026-07-20T00:00:00Z");
    const item = sampleItem("itm_CTX", ["tag_1"], { updated_at: "2026-07-19T00:00:00Z" });
    const deps = {
      client: {
        search: async () => ({ results: [item], has_more: false, next_cursor: null }),
        listItems: async () => ({ results: [], has_more: false, next_cursor: null })
      },
      contentService: {
        getAnnotations: async () => ({
          annotations: [sampleAnnotation("ann_CTX", item.id, { note: "agent memory note" })],
          hasMore: false,
          cacheHit: false
        }),
        getMarkdown: async () => ({
          markdown: "# Agent Memory\npersistent agent memory evidence",
          meta: {
            item_id: item.id,
            item_updated_at: item.updated_at,
            fetched_at: new Date(now).toISOString(),
            sha256: sha256Hex("markdown"),
            char_count: 46
          },
          cacheHit: false
        })
      },
      tagProvider: {
        getTags: async () => ({ tags: [sampleTag("tag_1", "cursor")], cacheHit: false })
      },
      now: () => now
    };
    const input = {
      query: "agent memory",
      tag_names: ["cursor"],
      tag_match: "all" as const,
      statuses: ["queue", "archive"] as Array<"queue" | "archive">,
      content_types: ["article"] as Array<"article">,
      max_items: 1,
      max_total_chars: 5000,
      max_chars_per_item: 1000,
      candidate_scan_limit: 10,
      include_annotations: true,
      include_unannotated_items: true,
      force_refresh: false
    };

    const first = await buildContextBundle(input, deps as never);
    const second = await buildContextBundle(input, deps as never);
    expect(first.bundle_id).toBe(second.bundle_id);
    expect(first.sources[0].provenance.matter_item_id).toBe("itm_CTX");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matter-cache-test-"));
  tempDirs.push(dir);
  return dir;
}

function sampleTag(id: string, name: string): MatterTag {
  return { object: "tag", id, name, item_count: 1, created_at: "2026-01-01T00:00:00Z" };
}

function sampleItem(id: string, tagIds: string[], overrides: Partial<MatterItem> = {}): MatterItem {
  return {
    object: "item",
    id,
    title: `Item ${id}`,
    url: "https://example.com",
    site_name: "example.com",
    author: { object: "author", id: "aut_1", name: "Author" },
    status: "archive",
    is_favorite: false,
    content_type: "article",
    word_count: 100,
    reading_progress: 0,
    image_url: null,
    excerpt: "Excerpt",
    library_position: null,
    inbox_position: null,
    tags: tagIds.map((tagId) => ({ object: "tag", id: tagId, name: tagId })),
    updated_at: "2026-01-01T00:00:00Z",
    processing_status: "completed",
    ...overrides
  };
}

function sampleAnnotation(id: string, itemId: string, overrides: Partial<MatterAnnotation> = {}): MatterAnnotation {
  return {
    object: "annotation",
    id,
    item_id: itemId,
    text: "highlighted source text",
    note: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}
