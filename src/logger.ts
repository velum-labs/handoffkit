import type { LogLevel } from "./config.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface LogFields {
  request_id?: string;
  tool_name?: string;
  endpoint_category?: string;
  http_status?: number;
  duration_ms?: number;
  cache_hit?: boolean;
  retry_count?: number;
  returned_item_count?: number;
  truncated?: boolean;
  message?: string;
  error?: string;
}

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/mat_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/Authorization\s*:\s*Bearer\s+[^\s,}]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/"Authorization"\s*:\s*"Bearer\s+[^"]+"/gi, "\"Authorization\":\"Bearer [REDACTED]\"");
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  return value;
}

export function createLogger(level: LogLevel = "info", sink: NodeJS.WritableStream = process.stderr): Logger {
  function write(logLevel: LogLevel, fields: LogFields): void {
    if (LEVEL_PRIORITY[logLevel] < LEVEL_PRIORITY[level]) {
      return;
    }

    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: logLevel
    };

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        record[key] = redactUnknown(value);
      }
    }

    sink.write(`${redactSecrets(JSON.stringify(record))}\n`);
  }

  return {
    debug: (fields) => write("debug", fields),
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields)
  };
}
