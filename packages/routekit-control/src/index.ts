import { createHash } from "node:crypto";

/**
 * Typed, versioned RouteKit daemon control protocol.
 *
 * This package defines product methods and validates their parameters. It is
 * independent of Commander and UI rendering; the CLI and daemon can evolve
 * independently as long as they negotiate the same protocol capability.
 */
import {
  ControlClient,
  ControlError
} from "@routekit/runtime";
import type {
  ModelCallStatus,
  ModelUsage,
  ProviderErrorKind,
  RequestBillingMode
} from "@routekit/contracts";
import type {
  ControlClientOptions,
  ControlHandler,
  ControlHandlerContext
} from "@routekit/runtime";

export const ROUTEKIT_CONTROL_CAPABILITY = "routekit.control.v1";

export type RouteKitControlMethod =
  | "daemon.status"
  | "daemon.reload"
  | "daemon.prepareShutdown"
  | "config.get"
  | "config.update"
  | "config.import"
  | "providers.status"
  | "providers.set"
  | "models.list"
  | "models.info"
  | "calls.inspect"
  | "accounts.list"
  | "accounts.status"
  | "accounts.enroll"
  | "accounts.enrollActivate"
  | "accounts.remove"
  | "accounts.sync"
  | "accounts.usage"
  | "telemetry.get"
  | "telemetry.set"
  | "doctor.run"
  | "launcher.prepare";

export type RouteKitControlParams = {
  "daemon.status": Record<string, never>;
  "daemon.reload": { expectedRevision?: number };
  "daemon.prepareShutdown": { reason: "stop" | "restart" | "upgrade" };
  "config.get": Record<string, never>;
  "config.update": { expectedRevision: number; document: string };
  "config.import": { expectedRevision: number; document: string; source?: string };
  "providers.status": { live?: boolean };
  "providers.set": { provider: string; enabled: boolean; idempotencyKey?: string };
  "models.list": { provider?: string; refresh?: boolean };
  "models.info": { model: string };
  "calls.inspect": { callId: string };
  "accounts.list": Record<string, never>;
  "accounts.status": Record<string, never>;
  "accounts.enroll": {
    kind: "claude-code" | "codex";
    label: string;
    credential: unknown;
  };
  /** Atomically import connector credentials and enable their router provider. */
  "accounts.enrollActivate": {
    kind: string;
    accounts: Array<{ label: string; credential?: unknown }>;
  };
  /** Registry kind or the raw kind returned by accounts.list for an unclassified file. */
  "accounts.remove": { kind: string; label: string };
  /** Rescan connector account stores and reconcile the managed sidecar. */
  "accounts.sync": Record<string, never>;
  "accounts.usage": Record<string, never>;
  "telemetry.get": Record<string, never>;
  "telemetry.set": { enabled: boolean };
  "doctor.run": Record<string, never>;
  "launcher.prepare": {
    tool: "codex" | "claude" | "cursor" | "opencode";
    model?: string;
    cwd?: string;
  };
};

export type DaemonStatus = {
  pid: number;
  startedAt: string;
  packageVersion: string;
  protocolVersion: string;
  generation: number;
  configRevision: number;
  accountRevision: number;
  controlUrl: string;
  dataUrl: string;
  dataPort: number;
  supervisor: string;
  draining: boolean;
};

export type ConfigSnapshot = {
  path: string;
  document: string;
  revision: number;
  sources: readonly ["global"];
};

export type ModelInfo = {
  id: string;
  provider?: string;
  capabilities?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
};

export type LaunchPreparation = {
  tool: "codex" | "claude" | "cursor" | "opencode";
  model: string;
  gatewayUrl: string;
  authToken?: string;
  env: Record<string, string>;
};

export type RouteKitCallInspection = {
  callId: string;
  status: ModelCallStatus;
  effectiveModel: string;
  nativeModel?: string;
  provider: string;
  billingMode: RequestBillingMode;
  account?: { label: string };
  retries: {
    attempts: number;
    total: number;
    accountFailovers: number;
  };
  usage?: ModelUsage;
  cost: {
    estimateUsd?: number;
    unknownUsage: boolean;
    unknownCost: boolean;
  };
  timing: {
    startedAt: string;
    finishedAt?: string;
    latencyMs?: number;
  };
  error?: {
    kind: ProviderErrorKind;
    retryable?: boolean;
  };
};

export type RouteKitControlResults = {
  "daemon.status": DaemonStatus;
  "daemon.reload": { reloaded: true; configRevision: number; accountRevision: number };
  "daemon.prepareShutdown": { accepted: true };
  "config.get": ConfigSnapshot;
  "config.update": ConfigSnapshot;
  "config.import": ConfigSnapshot;
  "providers.status": {
    providers: Array<{
      provider: string;
      configured: boolean;
      credentialAvailable: boolean;
      models?: readonly string[];
      error?: string;
    }>;
  };
  "providers.set": ConfigSnapshot;
  "models.list": { models: ModelInfo[]; defaultModel?: string; revision: number };
  "models.info": ModelInfo;
  "calls.inspect": RouteKitCallInspection;
  "accounts.list": { accounts: unknown[]; revision: number };
  "accounts.status": {
    accounts: Array<{
      subscriptionKind: string;
      label: string;
      connector: "native" | "cliproxy";
      localOnly?: boolean;
      credentialValid: boolean;
      configured: boolean;
      relayOpen: boolean;
      active: boolean;
      models: string[];
      limits?: unknown;
    }>;
    revision: number;
    recovery: {
      state: "clean" | "recovered";
      recovered: number;
      cleaned: number;
    };
  };
  "accounts.enroll": { enrolled: true; revision: number };
  "accounts.enrollActivate": {
    enrolled: Array<{ subscriptionKind: string; label: string }>;
    activated: true;
    configPath: string;
    configRevision: number;
    accountRevision: number;
  };
  "accounts.remove": { removed: boolean; revision: number };
  "accounts.sync": { synced: true; revision: number };
  "accounts.usage": unknown;
  "telemetry.get": { enabled: boolean };
  "telemetry.set": { enabled: boolean };
  "doctor.run": { checks: Array<{ name: string; ok: boolean; detail?: string }> };
  "launcher.prepare": LaunchPreparation;
};

export type RouteKitMethodHandler<M extends RouteKitControlMethod> = (
  params: RouteKitControlParams[M],
  context: ControlHandlerContext
) => RouteKitControlResults[M] | Promise<RouteKitControlResults[M]>;

export type RouteKitControlHandlers = {
  [M in RouteKitControlMethod]: RouteKitMethodHandler<M>;
};

const METHODS: ReadonlySet<string> = new Set<RouteKitControlMethod>([
  "daemon.status",
  "daemon.reload",
  "daemon.prepareShutdown",
  "config.get",
  "config.update",
  "config.import",
  "providers.status",
  "providers.set",
  "models.list",
  "models.info",
  "calls.inspect",
  "accounts.list",
  "accounts.status",
  "accounts.enroll",
  "accounts.enrollActivate",
  "accounts.remove",
  "accounts.sync",
  "accounts.usage",
  "telemetry.get",
  "telemetry.set",
  "doctor.run",
  "launcher.prepare"
]);

export const MUTATING_ROUTEKIT_METHODS: ReadonlySet<RouteKitControlMethod> = new Set([
  "daemon.reload",
  "daemon.prepareShutdown",
  "config.update",
  "config.import",
  "providers.set",
  "accounts.enroll",
  "accounts.enrollActivate",
  "accounts.remove",
  "accounts.sync",
  "telemetry.set"
]);

function record(value: unknown, method: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} params must be an object`
    });
  }
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string, method: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} requires ${key}`
    });
  }
  return value;
}

function requiredRevision(
  params: Record<string, unknown>,
  method: string
): number {
  const value = params.expectedRevision;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} requires a non-negative expectedRevision`
    });
  }
  return value as number;
}

function requiredEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  method: string,
  allowed: readonly T[]
): T {
  const value = requiredString(params, key, method);
  if (!allowed.includes(value as T)) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} ${key} must be one of: ${allowed.join(", ")}`
    });
  }
  return value as T;
}

/**
 * Validate method-specific structural invariants at the protocol edge. Domain
 * parsers perform deeper validation (provider ids, router schema, credentials).
 */
export function validateRouteKitParams<M extends RouteKitControlMethod>(
  method: M,
  value: unknown
): RouteKitControlParams[M] {
  const params = record(value, method);
  switch (method) {
    case "config.update":
    case "config.import":
      requiredRevision(params, method);
      requiredString(params, "document", method);
      break;
    case "providers.set":
      requiredString(params, "provider", method);
      if (typeof params.enabled !== "boolean") {
        throw new ControlError({ code: "bad_request", message: `${method} requires enabled` });
      }
      break;
    case "models.info":
      requiredString(params, "model", method);
      break;
    case "calls.inspect":
      requiredString(params, "callId", method);
      break;
    case "accounts.enroll":
      requiredEnum(params, "kind", method, ["claude-code", "codex"] as const);
      requiredString(params, "label", method);
      if (params.credential === undefined) {
        throw new ControlError({ code: "bad_request", message: `${method} requires credential` });
      }
      break;
    case "accounts.enrollActivate":
      requiredString(params, "kind", method);
      if (!Array.isArray(params.accounts) || params.accounts.length === 0) {
        throw new ControlError({
          code: "bad_request",
          message: `${method} requires one or more accounts`
        });
      }
      for (const account of params.accounts) {
        const entry = record(account, method);
        requiredString(entry, "label", method);
      }
      break;
    case "accounts.remove":
      // Registry kinds and raw stored kinds are resolved by the daemon.
      requiredString(params, "kind", method);
      requiredString(params, "label", method);
      break;
    case "telemetry.set":
      if (typeof params.enabled !== "boolean") {
        throw new ControlError({ code: "bad_request", message: `${method} requires enabled` });
      }
      break;
    case "launcher.prepare":
      requiredEnum(params, "tool", method, [
        "codex",
        "claude",
        "cursor",
        "opencode"
      ] as const);
      break;
    case "daemon.prepareShutdown":
      requiredEnum(params, "reason", method, ["stop", "restart", "upgrade"] as const);
      break;
    default:
      break;
  }
  return params as RouteKitControlParams[M];
}

export function createRouteKitControlHandler(
  handlers: RouteKitControlHandlers,
  options: { idempotencyCacheSize?: number; idempotencyTtlMs?: number } = {}
): ControlHandler {
  const max = options.idempotencyCacheSize ?? 1024;
  const ttlMs = options.idempotencyTtlMs ?? 5 * 60_000;
  const operations = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown>; completedAt?: number }
  >();
  return async (rawMethod, params, context) => {
    if (!METHODS.has(rawMethod)) {
      throw new ControlError({
        code: "not_found",
        message: `unknown RouteKit control method: ${rawMethod}`
      });
    }
    const method = rawMethod as RouteKitControlMethod;
    const key =
      MUTATING_ROUTEKIT_METHODS.has(method) && context.idempotencyKey !== undefined
        ? `${method}:${context.idempotencyKey}`
        : undefined;
    const validated = validateRouteKitParams(method, params);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(validated))
      .digest("hex");
    if (key !== undefined) {
      const existing = operations.get(key);
      if (
        existing !== undefined &&
        (existing.completedAt === undefined || Date.now() - existing.completedAt <= ttlMs)
      ) {
        if (existing.fingerprint !== fingerprint) {
          throw new ControlError({
            code: "conflict",
            message: "idempotency key was reused with different parameters"
          });
        }
        return await existing.promise;
      }
      if (existing !== undefined) operations.delete(key);
    }
    const handler = handlers[method] as (
      params: RouteKitControlParams[typeof method],
      context: ControlHandlerContext
    ) => unknown | Promise<unknown>;
    const promise = Promise.resolve(handler(validated, context));
    if (key === undefined) return await promise;
    const entry = { fingerprint, promise };
    operations.set(key, entry);
    try {
      const result = await promise;
      (entry as typeof entry & { completedAt?: number }).completedAt = Date.now();
      while (operations.size > max) {
        const oldest = operations.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        operations.delete(oldest);
      }
      return result;
    } catch (error) {
      if (operations.get(key) === entry) operations.delete(key);
      throw error;
    }
  };
}

export class RouteKitControlClient {
  readonly #client: ControlClient;

  constructor(options: ControlClientOptions) {
    this.#client = new ControlClient(options);
  }

  health(): ReturnType<ControlClient["health"]> {
    return this.#client.health();
  }

  hello(): Promise<{
    protocolVersion: string;
    product?: string;
    packageVersion?: string;
    capabilities: readonly string[];
  }> {
    return this.#client.call("hello");
  }

  call<M extends RouteKitControlMethod>(
    method: M,
    params: RouteKitControlParams[M],
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<RouteKitControlResults[M]> {
    return this.#client.call(method, params, options);
  }
}
