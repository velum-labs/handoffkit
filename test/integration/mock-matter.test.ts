import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { MatterClient } from "../../src/matter/client.js";
import { MatterAuthenticationError, MatterForbiddenError } from "../../src/matter/errors.js";
import { collectPages } from "../../src/matter/pagination.js";
import type { Logger } from "../../src/logger.js";

interface RequestRecord {
  method: string | undefined;
  path: string;
}

const servers: Array<{ close: () => Promise<void>; records: RequestRecord[] }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("MatterClient integration with mock Matter server", () => {
  it("covers /me success", async () => {
    const mock = await startMock((req, res) => {
      if (req.url?.startsWith("/public/v1/me")) {
        return writeJson(res, accountBody(), 200);
      }
      return writeJson(res, { error: { code: "not_found", message: "missing" } }, 404);
    });
    const client = makeClient(mock.baseUrl);

    await expect(client.getMe()).resolves.toMatchObject({ id: "act_1", name: "Tester" });
    assertAllowlisted(mock.records);
  });

  it("covers 401 and 403 from /me", async () => {
    const unauthorized = await startMock((_req, res) => {
      writeJson(res, { error: { code: "unauthorized", message: "bad token" } }, 401);
    });
    await expect(makeClient(unauthorized.baseUrl).getMe()).rejects.toThrow(MatterAuthenticationError);
    assertAllowlisted(unauthorized.records);

    const forbidden = await startMock((_req, res) => {
      writeJson(res, { error: { code: "forbidden", message: "no pro" } }, 403);
    });
    await expect(makeClient(forbidden.baseUrl).getMe()).rejects.toThrow(MatterForbiddenError);
    assertAllowlisted(forbidden.records);
  });

  it("covers paginated /tags", async () => {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/public/v1/tags" && !url.searchParams.get("cursor")) {
        return writeJson(res, listBody([tag("tag_1", "cursor")], true, "page_2"), 200);
      }
      if (url.pathname === "/public/v1/tags" && url.searchParams.get("cursor") === "page_2") {
        return writeJson(res, listBody([tag("tag_2", "repo-agent-platform")], false, null), 200);
      }
      return writeJson(res, { error: { code: "not_found", message: "missing" } }, 404);
    });

    const result = await collectPages({
      fetchPage: (cursor) => makeClient(mock.baseUrl).listTags({ limit: 100, cursor }),
      maxItems: 10
    });

    expect(result.results.map((entry) => entry.name)).toEqual(["cursor", "repo-agent-platform"]);
    assertAllowlisted(mock.records);
  });

  it("covers paginated /items with tag filtering", async () => {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/public/v1/items") {
        return writeJson(res, { error: { code: "not_found", message: "missing" } }, 404);
      }

      const requestedTagIds = url.searchParams.getAll("tag_id");
      const allItems = [
        item("itm_A", ["tag_1"], "archive"),
        item("itm_B", ["tag_2"], "queue"),
        item("itm_C", ["tag_1", "tag_2"], "archive")
      ];
      const filtered = requestedTagIds.length
        ? allItems.filter((entry) => entry.tags.some((entryTag: { id: string }) => requestedTagIds.includes(entryTag.id)))
        : allItems;
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        return writeJson(res, listBody(filtered.slice(0, 1), filtered.length > 1, "items_2"), 200);
      }
      return writeJson(res, listBody(filtered.slice(1), false, null), 200);
    });

    const client = makeClient(mock.baseUrl);
    const result = await collectPages({
      fetchPage: (cursor) => client.listItems({ tagIds: ["tag_1"], limit: 1, cursor }),
      maxItems: 10
    });

    expect(result.results.map((entry) => entry.id)).toEqual(["itm_A", "itm_C"]);
    expect(mock.records.some((record) => record.path.includes("tag_id=tag_1"))).toBe(true);
    assertAllowlisted(mock.records);
  });

  it("covers /search pagination", async () => {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/public/v1/search") {
        return writeJson(res, { error: { code: "not_found", message: "missing" } }, 404);
      }
      if (!url.searchParams.get("cursor")) {
        return writeJson(res, { object: "search_results", items: listBody([item("itm_A", ["tag_1"])], true, "s2") }, 200);
      }
      return writeJson(res, { object: "search_results", items: listBody([item("itm_B", ["tag_2"])], false, null) }, 200);
    });

    const client = makeClient(mock.baseUrl);
    const result = await collectPages({
      fetchPage: (cursor) => client.search({ query: "agent memory", limit: 1, cursor }),
      maxItems: 10
    });

    expect(result.results.map((entry) => entry.id)).toEqual(["itm_A", "itm_B"]);
    assertAllowlisted(mock.records);
  });

  it("covers 429 with Retry-After", async () => {
    let calls = 0;
    const mock = await startMock((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.setHeader("Retry-After", "0");
        return writeJson(res, { error: { code: "rate_limited", message: "slow" } }, 429);
      }
      return writeJson(res, accountBody(), 200);
    });

    await expect(makeClient(mock.baseUrl).getMe()).resolves.toMatchObject({ id: "act_1" });
    expect(calls).toBe(2);
    assertAllowlisted(mock.records);
  });

  it("covers 500 then success retry", async () => {
    let calls = 0;
    const mock = await startMock((_req, res) => {
      calls += 1;
      if (calls === 1) {
        return writeJson(res, { error: { code: "internal_error", message: "temporary" } }, 500);
      }
      return writeJson(res, accountBody(), 200);
    });

    await expect(makeClient(mock.baseUrl).getMe()).resolves.toMatchObject({ id: "act_1" });
    expect(calls).toBe(2);
    assertAllowlisted(mock.records);
  });
});

async function startMock(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const records: RequestRecord[] = [];
  const server = createServer((req, res) => {
    records.push({ method: req.method, path: req.url ?? "" });
    void handler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server.");
  }

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  const mock = {
    baseUrl: `http://127.0.0.1:${address.port}/public/v1`,
    records,
    close
  };
  servers.push(mock);
  return mock;
}

function makeClient(baseUrl: string): MatterClient {
  const config = loadConfig({
    MATTER_API_TOKEN: "mat_test",
    MATTER_API_BASE_URL: baseUrl,
    MATTER_MCP_ALLOW_HTTP: "true"
  });
  if (config.configurationError) {
    throw config.configurationError;
  }

  return new MatterClient({
    config: {
      apiToken: config.apiToken,
      baseUrl: config.apiBaseUrl,
      userAgent: config.userAgent,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries
    },
    rateLimiter: { acquire: async () => {} },
    logger: silentLogger,
    sleep: async () => {},
    random: () => 0
  });
}

function assertAllowlisted(records: RequestRecord[]): void {
  for (const record of records) {
    expect(record.method).toBe("GET");
    const pathname = new URL(record.path, "http://127.0.0.1").pathname;
    expect(
      pathname === "/public/v1/me" ||
        pathname === "/public/v1/tags" ||
        pathname === "/public/v1/items" ||
        pathname === "/public/v1/search" ||
        /^\/public\/v1\/items\/itm_[A-Za-z0-9]+$/.test(pathname) ||
        /^\/public\/v1\/items\/itm_[A-Za-z0-9]+\/annotations$/.test(pathname)
    ).toBe(true);
  }
}

function writeJson(res: ServerResponse, body: unknown, status: number): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function listBody(results: unknown[], hasMore: boolean, nextCursor: string | null) {
  return {
    object: "list",
    results,
    has_more: hasMore,
    next_cursor: nextCursor
  };
}

function accountBody() {
  return {
    object: "account",
    id: "act_1",
    name: "Tester",
    email: "tester@example.com",
    rate_limit: { read: 120, write: 60, save: 60, search: 30, markdown: 20, burst: 5 },
    created_at: "2026-01-01T00:00:00Z"
  };
}

function tag(id: string, name: string) {
  return {
    object: "tag",
    id,
    name,
    item_count: 1,
    created_at: "2026-01-01T00:00:00Z"
  };
}

function item(id: string, tagIds: string[], status: "queue" | "archive" = "archive") {
  return {
    object: "item",
    id,
    title: `Item ${id}`,
    url: "https://example.com",
    site_name: "example.com",
    author: { object: "author", id: "aut_1", name: "Author" },
    status,
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
    processing_status: "completed"
  };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};
