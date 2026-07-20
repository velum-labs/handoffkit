import { describe, expect, it, vi, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildMatterUrl } from "../../src/matter/endpoints.js";
import { MatterProtocolError, MatterValidationError } from "../../src/matter/errors.js";
import { collectPages } from "../../src/matter/pagination.js";
import { MatterRateLimiter } from "../../src/matter/rate-limiter.js";
import { createLogger, redactSecrets } from "../../src/logger.js";
import { itemMatchesTagIds } from "../../src/retrieval/item-filtering.js";
import { resolveTagNames, suggestTagNames } from "../../src/retrieval/tag-resolution.js";
import type { MatterItem, MatterTag } from "../../src/matter/schemas.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("config validation", () => {
  it("records missing token as configuration-error state", () => {
    const config = loadConfig({});
    expect(config.configurationError?.code).toBe("configuration_error");
    expect(config.configurationError?.message).toContain("MATTER_API_TOKEN");
  });

  it("rejects non-HTTPS base URLs unless localhost HTTP is explicitly allowed", () => {
    const bad = loadConfig({ MATTER_API_TOKEN: "mat_token", MATTER_API_BASE_URL: "http://api.example.test" });
    expect(bad.configurationError?.message).toContain("HTTPS");

    const allowed = loadConfig({
      MATTER_API_TOKEN: "mat_token",
      MATTER_API_BASE_URL: "http://127.0.0.1:1234/public/v1",
      MATTER_MCP_ALLOW_HTTP: "true"
    });
    expect(allowed.configurationError).toBeNull();
  });

  it("rejects malformed numeric bounds", () => {
    const config = loadConfig({
      MATTER_API_TOKEN: "mat_token",
      MATTER_MCP_REQUEST_TIMEOUT_MS: "999",
      MATTER_MCP_MAX_RETRIES: "11"
    });
    expect(config.configurationError?.message).toContain("MATTER_MCP_REQUEST_TIMEOUT_MS");
    expect(config.configurationError?.message).toContain("MATTER_MCP_MAX_RETRIES");
  });
});

describe("logger redaction", () => {
  it("redacts mat_ tokens and Authorization headers", () => {
    expect(redactSecrets("Authorization: Bearer mat_ABC123 token mat_XYZ789")).toBe(
      "Authorization: Bearer [REDACTED] token [REDACTED]"
    );

    const chunks: string[] = [];
    const sink = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      }
    } as NodeJS.WritableStream;
    createLogger("debug", sink).info({ message: "using mat_SECRET123 Authorization: Bearer mat_MORE456" });
    expect(chunks.join("")).not.toContain("mat_SECRET123");
    expect(chunks.join("")).not.toContain("mat_MORE456");
  });
});

describe("endpoint allowlist", () => {
  const baseUrl = "https://api.getmatter.com/public/v1";

  it("builds only allowlisted GET endpoint URLs from logical descriptors", () => {
    expect(buildMatterUrl(baseUrl, { kind: "me" }).pathname).toBe("/public/v1/me");
    expect(buildMatterUrl(baseUrl, { kind: "items_list" }, { limit: 100 }).pathname).toBe("/public/v1/items");
    expect(buildMatterUrl(baseUrl, { kind: "search" }, { type: "items" }).pathname).toBe("/public/v1/search");
  });

  it("rejects bad item IDs", () => {
    expect(() => buildMatterUrl(baseUrl, { kind: "item_get", itemId: "../bad" })).toThrow(MatterValidationError);
  });

  it("allows include=markdown only for item get", () => {
    expect(buildMatterUrl(baseUrl, { kind: "item_get", itemId: "itm_ABC123" }, { include: "markdown" }).search).toBe(
      "?include=markdown"
    );
    expect(() => buildMatterUrl(baseUrl, { kind: "tags" }, { include: "markdown" })).toThrow(MatterValidationError);
  });
});

describe("collectPages", () => {
  it("stops at maxItems and preserves order", async () => {
    let calls = 0;
    const result = await collectPages({
      maxItems: 2,
      fetchPage: async () => {
        calls += 1;
        return { results: [1, 2, 3], has_more: true, next_cursor: "next" };
      }
    });
    expect(result.results).toEqual([1, 2]);
    expect(result.hasMore).toBe(true);
    expect(calls).toBe(1);
  });

  it("detects repeated cursors", async () => {
    const cursors = ["same", "same"];
    await expect(
      collectPages({
        maxItems: 10,
        fetchPage: async () => ({ results: [1], has_more: true, next_cursor: cursors.shift() ?? "same" })
      })
    ).rejects.toThrow(MatterProtocolError);
  });

  it("caps pages", async () => {
    const result = await collectPages({
      maxItems: 10,
      maxPages: 2,
      fetchPage: async (cursor) => ({
        results: [cursor ?? "first"],
        has_more: true,
        next_cursor: cursor ? `${cursor}x` : "next"
      })
    });
    expect(result.pagesFetched).toBe(2);
    expect(result.hasMore).toBe(true);
  });
});

describe("rate limiter", () => {
  it("enforces burst window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new MatterRateLimiter({ readPerMinute: 1000 });
    for (let i = 0; i < 5; i += 1) {
      await limiter.acquire("read");
    }

    let done = false;
    const pending = limiter.acquire("read").then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("enforces per-minute read window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new MatterRateLimiter({ burstPerSecond: 100, readPerMinute: 2 });
    await limiter.acquire("read");
    await limiter.acquire("read");

    let done = false;
    const pending = limiter.acquire("read").then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("counts markdown requests against read and markdown budgets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new MatterRateLimiter({ burstPerSecond: 100, readPerMinute: 2, markdownPerMinute: 10 });
    await limiter.acquire("read");
    await limiter.acquire("markdown");

    let done = false;
    const pending = limiter.acquire("read").then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});

describe("tag resolution and filtering", () => {
  const tags: MatterTag[] = [
    { id: "tag_1", name: "Cursor", item_count: 1, created_at: "2026-01-01T00:00:00Z" },
    { id: "tag_2", name: "repo-agent-platform", item_count: 1, created_at: "2026-01-01T00:00:00Z" },
    { id: "tag_3", name: "intent-architecture", item_count: 1, created_at: "2026-01-01T00:00:00Z" }
  ];

  it("resolves tag names case-insensitively", () => {
    expect(resolveTagNames(["cursor", "REPO-AGENT-PLATFORM"], tags).tagIds).toEqual(["tag_1", "tag_2"]);
  });

  it("includes close-name suggestions for unknown tags", () => {
    expect(suggestTagNames("repo-agent", tags.map((tag) => tag.name))).toContain("repo-agent-platform");
    expect(() => resolveTagNames(["repo-agent"], tags)).toThrow(/repo-agent-platform/);
  });

  it("implements tag_match any vs all post-filtering", () => {
    const item = itemWithTags(["tag_1", "tag_2"]);
    expect(itemMatchesTagIds(item, ["tag_2", "tag_3"], "any")).toBe(true);
    expect(itemMatchesTagIds(item, ["tag_2", "tag_3"], "all")).toBe(false);
    expect(itemMatchesTagIds(item, ["tag_1", "tag_2"], "all")).toBe(true);
  });
});

function itemWithTags(tagIds: string[]): MatterItem {
  return {
    id: "itm_ABC",
    title: "Title",
    url: "https://example.com",
    site_name: "example.com",
    author: null,
    status: "archive",
    is_favorite: false,
    content_type: "article",
    word_count: 10,
    reading_progress: 0,
    tags: tagIds.map((id) => ({ id, name: id })),
    updated_at: "2026-01-01T00:00:00Z"
  };
}
