import { spawn, execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const EXPECTED_TOOLS = [
  "matter_build_context_bundle",
  "matter_get_annotations",
  "matter_get_item",
  "matter_health",
  "matter_list_items",
  "matter_list_tags",
  "matter_search_items"
].sort();

const children: JsonRpcChild[] = [];

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"], {
    cwd: process.cwd(),
    env: process.env
  });
});

afterEach(async () => {
  while (children.length > 0) {
    await children.pop()?.close();
  }
});

describe("built MCP server contract", () => {
  it("initializes, lists seven tools, rejects invalid input, and returns structured tool errors", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "matter-contract-cache-"));
    const child = new JsonRpcChild(
      spawn(process.execPath, ["dist/index.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MATTER_API_TOKEN: "mat_dummy",
          MATTER_API_BASE_URL: "http://127.0.0.1:9/public/v1",
          MATTER_MCP_ALLOW_HTTP: "true",
          MATTER_MCP_CACHE_DIR: cacheDir,
          MATTER_MCP_MAX_RETRIES: "1",
          LOG_LEVEL: "debug"
        },
        stdio: ["pipe", "pipe", "pipe"]
      })
    );
    children.push(child);

    const initialize = await child.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-contract-test", version: "1.0.0" }
    });
    expect(initialize).toMatchObject({ serverInfo: { name: "matter-cursor-mcp", version: "1.0.0" } });
    child.notify("notifications/initialized", {});

    const toolsList = (await child.request("tools/list", {})) as { tools: Array<Record<string, unknown>> };
    const toolNames = toolsList.tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual(EXPECTED_TOOLS);
    for (const tool of toolsList.tools) {
      expect(tool.description).toEqual(expect.any(String));
      expect((tool.description as string).length).toBeGreaterThan(0);
      expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    }

    const invalidCall = (await child.request("tools/call", {
      name: "matter_get_item",
      arguments: { item_id: "bad", include_markdown: false }
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(invalidCall.isError).toBe(true);
    expect(invalidCall.content[0].text).toMatch(/Invalid input|item_id|schema/i);

    const health = (await child.request("tools/call", {
      name: "matter_health",
      arguments: {}
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(health.isError).toBe(true);
    const payload = JSON.parse(health.content[0].text) as {
      schema_version: string;
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(payload).toMatchObject({
      schema_version: "1.0",
      ok: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
        retryable: expect.any(Boolean)
      }
    });

    expect(child.stdoutParseErrors).toEqual([]);
    await child.waitForStderr();
    expect(child.stderrText.length).toBeGreaterThan(0);
  }, 10000);
});

class JsonRpcChild {
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly stdoutParseErrors: string[] = [];
  stderrText = "";

  constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      while (this.stdoutBuffer.includes("\n")) {
        const index = this.stdoutBuffer.indexOf("\n");
        const line = this.stdoutBuffer.slice(0, index);
        this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
        if (line.trim().length === 0) {
          continue;
        }
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) {
              pending?.reject(new Error(JSON.stringify(message.error)));
            } else {
              pending?.resolve(message.result);
            }
          }
        } catch (error) {
          this.stdoutParseErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
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
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async waitForStderr(): Promise<void> {
    const deadline = Date.now() + 1000;
    while (this.stderrText.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });
  }
}
