import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { MatterClient } from "../src/matter/client.js";
import { MatterRateLimiter } from "../src/matter/rate-limiter.js";

const config = loadConfig();
if (config.configurationError) {
  throw config.configurationError;
}

const logger = createLogger(config.logLevel);
const client = new MatterClient({
  config: {
    apiToken: config.apiToken,
    baseUrl: config.apiBaseUrl,
    userAgent: config.userAgent,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries
  },
  rateLimiter: new MatterRateLimiter(),
  logger
});

const account = await client.getMe();
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      account_id: account.id,
      display_name: account.name ?? null
    },
    null,
    2
  )}\n`
);
