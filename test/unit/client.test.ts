import { describe, expect, it } from "vitest";
import { MatterClient, type MatterFetch } from "../../src/matter/client.js";
import {
  MatterAuthenticationError,
  MatterForbiddenError,
  MatterNotFoundError,
  MatterRateLimitError,
  MatterValidationError
} from "../../src/matter/errors.js";
import type { Logger } from "../../src/logger.js";

describe("MatterClient retry policy and error mapping", () => {
  it("honors Retry-After on 429 and then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = makeClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ error: { code: "rate_limited", message: "slow down" } }, 429, {
            "Retry-After": "1"
          });
        }
        return accountResponse();
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    await expect(client.getMe()).resolves.toMatchObject({ id: "act_1" });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("does not retry 401 or 404", async () => {
    let calls = 0;
    const unauthorized = makeClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: { code: "unauthorized", message: "bad token" } }, 401);
      }
    });
    await expect(unauthorized.getMe()).rejects.toThrow(MatterAuthenticationError);
    expect(calls).toBe(1);

    calls = 0;
    const notFound = makeClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: { code: "not_found", message: "missing" } }, 404);
      }
    });
    await expect(notFound.getItem("itm_ABC")).rejects.toThrow(MatterNotFoundError);
    expect(calls).toBe(1);
  });

  it("uses maxRetries for retryable 500 responses", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = makeClient({
      maxRetries: 3,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: { code: "internal_error", message: "temporary" } }, 500);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    await expect(client.getMe()).rejects.toMatchObject({ code: "transient_error", retryable: true });
    expect(calls).toBe(4);
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it("maps Matter error bodies to typed errors", async () => {
    await expect(
      makeClient({
        fetchImpl: async () => jsonResponse({ error: { code: "forbidden", message: "no pro" } }, 403)
      }).getMe()
    ).rejects.toThrow(MatterForbiddenError);

    await expect(
      makeClient({
        fetchImpl: async () =>
          jsonResponse({ error: { code: "validation_error", message: "bad", field: "limit" } }, 422)
      }).listTags({ limit: 999 })
    ).rejects.toThrow(MatterValidationError);

    await expect(
      makeClient({
        fetchImpl: async () => jsonResponse({ error: { code: "rate_limited", message: "slow" } }, 429),
        maxRetries: 0
      }).getMe()
    ).rejects.toThrow(MatterRateLimitError);
  });

  it("always sends GET requests", async () => {
    const methods: Array<string | undefined> = [];
    const client = makeClient({
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return accountResponse();
      }
    });
    await client.getMe();
    expect(methods).toEqual(["GET"]);
  });
});

function makeClient(options: {
  fetchImpl: MatterFetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  return new MatterClient({
    config: {
      apiToken: "mat_test",
      baseUrl: "https://api.getmatter.com/public/v1",
      userAgent: "matter-cursor-mcp/1.0.0",
      requestTimeoutMs: 20_000,
      maxRetries: options.maxRetries ?? 3
    },
    fetchImpl: options.fetchImpl,
    rateLimiter: { acquire: async () => {} },
    logger: silentLogger,
    sleep: options.sleep,
    random: () => 0
  });
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function accountResponse(): Response {
  return jsonResponse(
    {
      object: "account",
      id: "act_1",
      name: "Tester",
      email: "tester@example.com",
      rate_limit: { read: 120, write: 60, save: 60, search: 30, markdown: 20, burst: 5 },
      created_at: "2026-01-01T00:00:00Z"
    },
    200
  );
}
