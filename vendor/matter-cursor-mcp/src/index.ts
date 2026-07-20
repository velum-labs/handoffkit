#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { createMatterServer } from "./server.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const server = createMatterServer({ logger });
const transport = new StdioServerTransport();

let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await server.close();
  } catch (error) {
    logger.error({ message: "failed_to_close_server", error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("uncaughtException", (error: Error) => {
  logger.error({ message: "uncaught_exception", error: error.message });
  void shutdown(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error({ message: "unhandled_rejection", error: reason instanceof Error ? reason.message : String(reason) });
  void shutdown(1);
});

try {
  await server.connect(transport);
} catch (error) {
  logger.error({ message: "server_start_failed", error: error instanceof Error ? error.message : String(error) });
  await shutdown(1);
}
