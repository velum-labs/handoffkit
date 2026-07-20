import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createLogger, type Logger } from "../../src/logger.js";
import { MatterClient } from "../../src/matter/client.js";
import { MatterRateLimiter } from "../../src/matter/rate-limiter.js";

const shouldRunLive = process.env.RUN_LIVE_MATTER_TESTS === "true" && process.env.MATTER_API_TOKEN?.startsWith("mat_");

describe.skipIf(!shouldRunLive)("live Matter API smoke tests", () => {
  it("checks health, lists tags, and lists five items", async () => {
    const config = loadConfig(process.env);
    if (config.configurationError) {
      throw config.configurationError;
    }

    const client = new MatterClient({
      config: {
        apiToken: config.apiToken,
        baseUrl: config.apiBaseUrl,
        userAgent: config.userAgent,
        requestTimeoutMs: config.requestTimeoutMs,
        maxRetries: config.maxRetries
      },
      rateLimiter: new MatterRateLimiter(),
      logger: process.env.LOG_LEVEL === "debug" ? createLogger("debug") : silentLogger
    });

    const account = await client.getMe();
    expect(account.id).toMatch(/^act_/);

    const tags = await client.listTags({ limit: 5 });
    expect(Array.isArray(tags.results)).toBe(true);

    const items = await client.listItems({ limit: 5 });
    expect(Array.isArray(items.results)).toBe(true);
    expect(items.results.length).toBeLessThanOrEqual(5);
  }, 15000);
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};
