import type { ZodType } from "zod";

import { asHarnessError } from "./errors.js";
import type {
  DriverContext,
  HarnessDriver,
  HarnessInstance
} from "./contract.js";
import type { HarnessKind } from "./kinds.js";
import { runCliCapture } from "./process.js";
import {
  readCachedStatus,
  writeCachedStatus
} from "./status.js";
import type { HarnessStatus } from "./status.js";

const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Resolve source env; an explicit context replaces process env rather than merging. */
export function resolveDriverEnv(
  context: DriverContext | undefined
): Record<string, string | undefined> {
  return context?.env ?? process.env;
}

export type CliVersionProbeInput = {
  kind: HarnessKind;
  command: string;
  cliName: string;
  env: Record<string, string>;
  auth: HarnessStatus["auth"];
  /** Override auth when the command runs unsuccessfully or probing fails. */
  failureAuth?: HarnessStatus["auth"];
  /** Override auth specifically when the executable is not installed. */
  notInstalledAuth?: HarnessStatus["auth"];
  notInstalledMessage: string;
  args?: readonly string[];
  timeoutMs?: number;
};

/** Probe a CLI version into the common installed/version/status shape. */
export async function probeCliVersion(
  input: CliVersionProbeInput
): Promise<HarnessStatus> {
  const checkedAt = new Date().toISOString();
  const args = input.args ?? ["--version"];
  try {
    const result = await runCliCapture(input.command, [...args], {
      env: input.env,
      timeoutMs: input.timeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS
    });
    if (result.exitCode !== 0) {
      return {
        kind: input.kind,
        installed: false,
        auth: input.failureAuth ?? input.auth,
        checkedAt,
        probeError:
          result.stderr.trim() ||
          `${input.cliName} ${args.join(" ")} exited ${result.exitCode}`
      };
    }
    return {
      kind: input.kind,
      installed: true,
      command: input.command,
      version: result.stdout.trim().split(/\s+/).at(-1),
      auth: input.auth,
      checkedAt
    };
  } catch (error) {
    const harnessError = asHarnessError(error);
    const notInstalled = harnessError.code === "not_installed";
    return {
      kind: input.kind,
      installed: false,
      auth: notInstalled
        ? input.notInstalledAuth ?? input.failureAuth ?? input.auth
        : input.failureAuth ?? input.auth,
      checkedAt,
      probeError:
        notInstalled
          ? input.notInstalledMessage
          : harnessError.message
    };
  }
}

export type CachedHarnessDriverInput<Config> = {
  kind: HarnessKind;
  configSchema: ZodType<Config>;
  probeConfig(): Config;
  probeStatus(config: Config, context: DriverContext | undefined): Promise<HarnessStatus>;
  createInstance(
    config: Config,
    context: DriverContext | undefined,
    status: HarnessStatus
  ): Promise<HarnessInstance> | HarnessInstance;
};

/** Build the shared probe/cache/create scaffold around a provider driver. */
export function createCachedHarnessDriver<Config>(
  input: CachedHarnessDriverInput<Config>
): HarnessDriver<Config> {
  return {
    kind: input.kind,
    configSchema: input.configSchema,
    probe: async (context?: DriverContext) => {
      const status = await input.probeStatus(input.probeConfig(), context);
      if (context?.statusCacheDir !== undefined) {
        writeCachedStatus(status, context.statusCacheDir);
      }
      return status;
    },
    createInstance: async (config, context?: DriverContext) => {
      const cached =
        context?.statusCacheDir !== undefined
          ? readCachedStatus(input.kind, context.statusCacheDir)
          : undefined;
      const status = cached ?? (await input.probeStatus(config, context));
      return input.createInstance(config, context, status);
    }
  };
}
