import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

interface RequestRecord {
  method: string | undefined;
  path: string;
}

const closeFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closeFns.length > 0) {
    await closeFns.pop()?.();
  }
});

describe("Phase 3-4 MCP integration with mock Matter", () => {
  it("caches markdown for matter_get_item and avoids a second markdown request", async () => {
    let markdownRequests = 0;
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/public/v1/items/itm_CACHE" && url.searchParams.get("include") === "markdown") {
        markdownRequests += 1;
        return writeJson(res, item("itm_CACHE", { markdown: "# Cached\nbody" }), 200);
      }
      if (url.pathname === "/public/v1/items/itm_CACHE") {
        return writeJson(res, item("itm_CACHE"), 200);
      }
      return notFound(res);
    });
    const mcp = await startMcp(mock.baseUrl);
    const first = await callTool(mcp, "matter_get_item", {
      item_id: "itm_CACHE",
      include_annotations: false
    });
    const second = await callTool(mcp, "matter_get_item", {
      item_id: "itm_CACHE",
      include_annotations: false
    });

    expect(first.cache.markdown_hit).toBe(false);
    expect(second.cache.markdown_hit).toBe(true);
    expect(markdownRequests).toBe(1);
    assertAllowlisted(mock.records);
  });

  it("invalidates markdown and annotations cache when updated_at changes", async () => {
    let version = 1;
    let markdownRequests = 0;
    let annotationsRequests = 0;
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const updated = version === 1 ? "2026-07-20T00:00:00Z" : "2026-07-21T00:00:00Z";
      if (url.pathname === "/public/v1/items/itm_INV/annotations") {
        annotationsRequests += 1;
        return writeJson(res, listBody([annotation(`ann_${version}`, "itm_INV")], false, null), 200);
      }
      if (url.pathname === "/public/v1/items/itm_INV" && url.searchParams.get("include") === "markdown") {
        markdownRequests += 1;
        return writeJson(res, item("itm_INV", { updated_at: updated, markdown: `# Version ${version}` }), 200);
      }
      if (url.pathname === "/public/v1/items/itm_INV") {
        return writeJson(res, item("itm_INV", { updated_at: updated }), 200);
      }
      return notFound(res);
    });
    const mcp = await startMcp(mock.baseUrl);
    await callTool(mcp, "matter_get_item", { item_id: "itm_INV" });
    version = 2;
    const refreshed = await callTool(mcp, "matter_get_item", { item_id: "itm_INV", force_refresh: true });

    expect(refreshed.markdown).toContain("Version 2");
    expect(refreshed.annotations[0].id).toBe("ann_2");
    expect(markdownRequests).toBe(2);
    expect(annotationsRequests).toBe(2);
    assertAllowlisted(mock.records);
  });

  it("paginates matter_get_annotations with page size 100", async () => {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/public/v1/items/itm_ANN") {
        return writeJson(res, item("itm_ANN"), 200);
      }
      if (url.pathname === "/public/v1/items/itm_ANN/annotations" && !url.searchParams.get("cursor")) {
        expect(url.searchParams.get("limit")).toBe("100");
        return writeJson(
          res,
          listBody(Array.from({ length: 100 }, (_, index) => annotation(`ann_${index}`, "itm_ANN")), true, "ann_page_2"),
          200
        );
      }
      if (url.pathname === "/public/v1/items/itm_ANN/annotations" && url.searchParams.get("cursor") === "ann_page_2") {
        expect(url.searchParams.get("limit")).toBe("100");
        return writeJson(
          res,
          listBody(Array.from({ length: 100 }, (_, index) => annotation(`ann_${index + 100}`, "itm_ANN")), true, "ann_page_3"),
          200
        );
      }
      return notFound(res);
    });
    const mcp = await startMcp(mock.baseUrl);
    const result = await callTool(mcp, "matter_get_annotations", { item_id: "itm_ANN", limit: 150 });

    expect(result.returned_count).toBe(150);
    expect(result.has_more).toBe(true);
    assertAllowlisted(mock.records);
  });

  it("returns a processing warning without requesting markdown", async () => {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/public/v1/items/itm_PROC" && url.searchParams.get("include") === "markdown") {
        throw new Error("Markdown should not be requested for processing items.");
      }
      if (url.pathname === "/public/v1/items/itm_PROC") {
        return writeJson(res, item("itm_PROC", { processing_status: "processing", title: null, site_name: null, content_type: null }), 200);
      }
      return notFound(res);
    });
    const mcp = await startMcp(mock.baseUrl);
    const result = await callTool(mcp, "matter_get_item", { item_id: "itm_PROC", include_annotations: false });

    expect(result.markdown).toBeNull();
    expect(result.warnings.join(" ")).toContain("processing");
    assertAllowlisted(mock.records);
  });

  it("builds a valid context bundle and enforces budget end-to-end", async () => {
    const longMarkdown = `# Agent Memory\n${"persistent agent memory evidence ".repeat(300)}`;
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/public/v1/tags") {
        return writeJson(res, listBody([tag("tag_1", "cursor")], false, null), 200);
      }
      if (url.pathname === "/public/v1/search") {
        return writeJson(
          res,
          {
            object: "search_results",
            items: listBody([item("itm_BUNDLE", { tags: ["tag_1"] })], false, null)
          },
          200
        );
      }
      if (url.pathname === "/public/v1/items/itm_BUNDLE/annotations") {
        return writeJson(
          res,
          listBody([annotation("ann_BUNDLE", "itm_BUNDLE", { note: "agent memory note" })], false, null),
          200
        );
      }
      if (url.pathname === "/public/v1/items/itm_BUNDLE" && url.searchParams.get("include") === "markdown") {
        return writeJson(res, item("itm_BUNDLE", { tags: ["tag_1"], markdown: longMarkdown }), 200);
      }
      return notFound(res);
    });
    const mcp = await startMcp(mock.baseUrl);
    const result = await callTool(mcp, "matter_build_context_bundle", {
      query: "agent memory",
      tag_names: ["cursor"],
      max_items: 1,
      max_total_chars: 5000,
      max_chars_per_item: 1000,
      candidate_scan_limit: 10
    });

    ContextBundleSchema.parse(result);
    expect(result.sources).toHaveLength(1);
    expect(result.coverage.returned_total_chars).toBeLessThanOrEqual(5000);
    const perItemChars =
      result.sources[0].annotations.reduce((sum: number, entry: { text: string; note: string | null }) => sum + entry.text.length + (entry.note?.length ?? 0), 0) +
      result.sources[0].source_excerpts.reduce((sum: number, entry: { text: string }) => sum + entry.text.length, 0);
    expect(perItemChars).toBeLessThanOrEqual(1000);
    assertAllowlisted(mock.records);
  });
});

const ContextBundleSchema = z
  .object({
    schema_version: z.literal("1.0"),
    bundle_id: z.string().startsWith("ctx_"),
    query: z.string(),
    generated_at: z.string(),
    selection_policy: z.object({
      algorithm: z.literal("matter-search-plus-annotations-lexical-v1"),
      max_items: z.number(),
      max_total_chars: z.number(),
      max_chars_per_item: z.number(),
      candidate_scan_limit: z.number()
    }),
    sources: z.array(
      z.object({
        selection_rank: z.number(),
        selection_score: z.number(),
        selection_reasons: z.array(z.string()),
        item: z.object({ id: z.string(), tags: z.array(z.string()), updated_at: z.string() }).passthrough(),
        annotations: z.array(z.object({ id: z.string(), text: z.string(), note: z.string().nullable() }).passthrough()),
        source_excerpts: z.array(
          z.object({
            excerpt_id: z.string(),
            heading_path: z.array(z.string()),
            start_char: z.number(),
            end_char: z.number(),
            score: z.number(),
            text: z.string()
          })
        ),
        provenance: z.object({
          matter_item_id: z.string(),
          matter_item_updated_at: z.string(),
          source_url: z.string().nullable(),
          markdown_sha256: z.string().nullable()
        }),
        truncation: z.object({
          markdown_was_truncated_for_bundle: z.boolean(),
          complete_markdown_char_count: z.number(),
          returned_source_excerpt_chars: z.number()
        })
      })
    ),
    coverage: z.object({
      candidates_scanned: z.number(),
      candidates_after_filters: z.number(),
      sources_selected: z.number(),
      sources_omitted: z.number(),
      returned_annotation_chars: z.number(),
      returned_source_excerpt_chars: z.number(),
      returned_total_chars: z.number(),
      budget_exhausted: z.boolean(),
      scan_limit_reached: z.boolean()
    }),
    omitted_sources: z.array(z.object({ item_id: z.string(), title: z.string().nullable(), reason: z.string() })),
    content_safety_notice: z.string(),
    warnings: z.array(z.string())
  })
  .passthrough();

async function startMock(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const records: RequestRecord[] = [];
  const server = createServer((req, res) => {
    records.push({ method: req.method, path: req.url ?? "" });
    Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock server did not bind.");
  }
  closeFns.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return { baseUrl: `http://127.0.0.1:${address.port}/public/v1`, records };
}

async function startMcp(baseUrl: string) {
  const cacheDir = await mkdtemp(join(tmpdir(), "matter-mcp-cache-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATTER_API_TOKEN: "mat_test",
      MATTER_API_BASE_URL: baseUrl,
      MATTER_MCP_ALLOW_HTTP: "true",
      MATTER_MCP_CACHE_DIR: cacheDir,
      LOG_LEVEL: "error"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = new JsonRpcProcess(child);
  closeFns.push(async () => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  });
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "phase34-test", version: "1.0.0" }
  });
  client.notify("notifications/initialized", {});
  return client;
}

async function callTool(client: JsonRpcProcess, name: string, args: Record<string, unknown>) {
  const result = await client.request("tools/call", { name, arguments: args });
  const content = (result as { content: Array<{ type: string; text: string }>; isError?: boolean }).content;
  if ((result as { isError?: boolean }).isError) {
    throw new Error(content[0].text);
  }
  return JSON.parse(content[0].text);
}

class JsonRpcProcess {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (value: unknown) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      while (this.buffer.includes("\n")) {
        const index = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (message.id !== undefined) {
          const resolve = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolve?.(message.error ? Promise.reject(new Error(JSON.stringify(message.error))) : message.result);
        }
      }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5_000);
      this.pending.set(id, (value) => {
        clearTimeout(timeout);
        Promise.resolve(value).then(resolve, reject);
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}

function assertAllowlisted(records: RequestRecord[]): void {
  for (const record of records) {
    expect(record.method).toBe("GET");
    const url = new URL(record.path, "http://127.0.0.1");
    const pathname = url.pathname;
    expect(
      pathname === "/public/v1/me" ||
        pathname === "/public/v1/tags" ||
        pathname === "/public/v1/items" ||
        pathname === "/public/v1/search" ||
        /^\/public\/v1\/items\/itm_[A-Za-z0-9]+$/.test(pathname) ||
        /^\/public\/v1\/items\/itm_[A-Za-z0-9]+\/annotations$/.test(pathname)
    ).toBe(true);
    if (url.searchParams.get("include") === "markdown") {
      expect(/^\/public\/v1\/items\/itm_[A-Za-z0-9]+$/.test(pathname)).toBe(true);
    }
  }
}

function writeJson(res: ServerResponse, body: unknown, status: number): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  writeJson(res, { error: { code: "not_found", message: "missing" } }, 404);
}

function listBody(results: unknown[], hasMore: boolean, nextCursor: string | null) {
  return { object: "list", results, has_more: hasMore, next_cursor: nextCursor };
}

function tag(id: string, name: string) {
  return { object: "tag", id, name, item_count: 1, created_at: "2026-01-01T00:00:00Z" };
}

function annotation(id: string, itemId: string, overrides: Record<string, unknown> = {}) {
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

function item(id: string, overrides: Record<string, unknown> = {}) {
  const { tags: tagIdsRaw, ...rest } = overrides;
  const tags = (tagIdsRaw as string[] | undefined) ?? [];
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
    tags: tags.map((tagId) => ({ object: "tag", id: tagId, name: tagId === "tag_1" ? "cursor" : tagId })),
    updated_at: "2026-07-20T00:00:00Z",
    processing_status: "completed",
    ...rest
  };
}
