import { CliError } from "@routekit/cli-core";
import type { Command } from "commander";

/** Options shared by `start` and `daemon service install`. */
export type GatewayServeCliOptions = {
  host: string;
  port: string;
  authToken?: string;
  portless?: boolean;
  drainGrace?: string;
};

export const DEFAULT_DRAIN_GRACE_SECONDS = 30;

export function attachServeOptions(command: Command): Command {
  return command
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "8080")
    .option("--auth-token <token>", "authentication token (required for non-loopback hosts)")
    .option("--no-portless", "disable the stable local route")
    .option(
      "--drain-grace <seconds>",
      "grace for in-flight requests on shutdown/upgrade (default: $ROUTEKIT_DRAIN_GRACE or 30)"
    );
}

/**
 * Resolve the drain grace in milliseconds: explicit flag, else the
 * `ROUTEKIT_DRAIN_GRACE` environment (seconds), else 30s.
 */
export function drainGraceMs(raw: string | undefined): number {
  const value = raw ?? process.env.ROUTEKIT_DRAIN_GRACE;
  if (value === undefined || value.length === 0) return DEFAULT_DRAIN_GRACE_SECONDS * 1000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) {
    throw new CliError({ message: "--drain-grace must be between 0 and 3600 seconds" });
  }
  return Math.round(seconds * 1000);
}
