import { existsSync, readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  type ModelReasoningCapabilities,
  ProviderFailureError,
  isRetryableProviderFailure
} from "@velum-labs/routekit-contracts";
import { CapacityPool, SseDecoder, SseParseError } from "@velum-labs/routekit-gateway";
import type { CapacityLease } from "@velum-labs/routekit-gateway";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

import { resolveSubscriptionAccounts } from "./account-source.js";
import type { SubscriptionAccountSource } from "./account-source.js";
import { subscriptionCredentialLabel } from "./credentials.js";
import {
  canonicalRateLimitWindowKey,
  type SubscriptionProvider
} from "./provider.js";
import type {
  AccountLimits,
  SubscriptionCredential,
  SubscriptionMemberStatus,
  SubscriptionAccountSetSnapshot,
  SubscriptionSelectionStrategy
} from "./types.js";

export type SubscriptionAccountSetOptions = {
  mode: SubscriptionMode;
  source?: SubscriptionAccountSource;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  refreshSkewSeconds?: number;
  fallbackCooldownSeconds?: number;
};

export type SubscriptionExecutionObserver = {
  onAttempt?(account: { seat: string }): void;
};

type PersistedMemberState = {
  limits?: AccountLimits;
  coolingUntil?: number;
};

type PersistedTrackerFile = {
  members: Array<{ id: string; limits?: AccountLimits; coolingUntil?: number }>;
};

type TrackerStateRead = {
  state: Map<string, PersistedMemberState>;
  migrated: boolean;
};

type PoolMember = {
  id: string;
  label: string;
  sourcePath: string;
  credential: SubscriptionCredential;
  models: Set<string>;
  coolingUntil?: number;
  lastUsed: number;
  inFlight: number;
  switchedAt: number;
};

const DEFAULT_SWITCH_THRESHOLD = 0.9;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 300;
const RAMP_WINDOW_MS = 30_000;
const RAMP_STEP_MS = 250;
const ATTRIBUTION_SEAT_KEY = randomBytes(32);

function attributionSeat(label: string): string {
  return `seat_${createHmac("sha256", ATTRIBUTION_SEAT_KEY)
    .update(label)
    .digest("hex")
    .slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedRateLimitWindow(
  value: unknown,
  observedAt: number,
  source: AccountLimits["source"],
  migration?: { required: boolean }
): AccountLimits["windows"][string] | undefined {
  if (!isRecord(value) || typeof value.utilization !== "number") return undefined;
  const windowObservedAt =
    typeof value.observedAt === "number" ? value.observedAt : observedAt;
  const windowSource =
    value.source === "headers" ||
    value.source === "response" ||
    value.source === "usage" ||
    value.source === "stream"
      ? value.source
      : source;
  if (
    migration !== undefined &&
    (typeof value.observedAt !== "number" || value.source !== windowSource)
  ) {
    migration.required = true;
  }
  return {
    utilization: value.utilization,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.resetsAt === "number" ? { resetsAt: value.resetsAt } : {}),
    ...(typeof value.windowSeconds === "number" ? { windowSeconds: value.windowSeconds } : {}),
    ...(typeof value.limitName === "string" ? { limitName: value.limitName } : {}),
    observedAt: windowObservedAt,
    source: windowSource
  };
}

function parsedAccountLimits(
  value: unknown,
  mode?: SubscriptionMode,
  migration?: { required: boolean }
): AccountLimits | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.windows) ||
    typeof value.observedAt !== "number" ||
    (
      value.source !== "headers" &&
      value.source !== "response" &&
      value.source !== "usage" &&
      value.source !== "stream"
    )
  ) {
    return undefined;
  }
  let completeness: AccountLimits["completeness"];
  if (value.completeness === "snapshot" || value.completeness === "partial") {
    completeness = value.completeness;
  } else {
    if (migration !== undefined) migration.required = true;
    // Legacy `usage` state may already contain union-merged header windows.
    // Its provenance is irrecoverably ambiguous, so discard and re-probe.
    if (value.source === "usage") return undefined;
    completeness = "partial";
  }
  const windows = Object.create(null) as AccountLimits["windows"];
  for (const [key, raw] of Object.entries(value.windows)) {
    const window = parsedRateLimitWindow(
      raw,
      value.observedAt,
      value.source,
      migration
    );
    if (window === undefined) continue;
    const canonicalKey =
      mode === undefined ? key : canonicalRateLimitWindowKey(mode, key);
    if (canonicalKey !== key && migration !== undefined) migration.required = true;
    Object.defineProperty(
      windows,
      canonicalKey,
      {
        value: window,
        enumerable: true,
        configurable: true,
        writable: true
      }
    );
  }
  return {
    windows,
    observedAt: value.observedAt,
    source: value.source,
    completeness,
    ...(typeof value.planType === "string" ? { planType: value.planType } : {}),
    ...(isRecord(value.credits) ? { credits: value.credits } : {})
  };
}

function parsedMemberState(
  value: unknown,
  mode?: SubscriptionMode,
  migration?: { required: boolean }
): PersistedMemberState | undefined {
  if (!isRecord(value)) return undefined;
  const limits = parsedAccountLimits(value.limits, mode, migration);
  const coolingUntil =
    typeof value.coolingUntil === "number" && Number.isFinite(value.coolingUntil)
      ? value.coolingUntil
      : undefined;
  if (limits === undefined && coolingUntil === undefined) return {};
  return {
    ...(limits !== undefined ? { limits } : {}),
    ...(coolingUntil !== undefined ? { coolingUntil } : {})
  };
}

function readTrackerState(
  path: string,
  mode?: SubscriptionMode
): TrackerStateRead {
  const state = new Map<string, PersistedMemberState>();
  const migration = { required: false };
  if (!existsSync(path)) return { state, migrated: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { state, migrated: false };
    if (Array.isArray(parsed.members)) {
      for (const entry of parsed.members) {
        if (!isRecord(entry) || typeof entry.id !== "string") continue;
        const member = parsedMemberState(entry, mode, migration);
        if (member !== undefined) state.set(entry.id, member);
      }
      return { state, migrated: migration.required };
    }
    // One-time migration from the original object-keyed state format.
    if (isRecord(parsed.members)) {
      migration.required = true;
      for (const [id, raw] of Object.entries(parsed.members)) {
        const member = parsedMemberState(raw, mode, migration);
        if (member !== undefined) state.set(id, member);
      }
    }
    return { state, migrated: migration.required };
  } catch {
    return { state, migrated: false };
  }
}

function mergeLimits(
  previous: AccountLimits | undefined,
  next: AccountLimits,
  mode?: SubscriptionMode
): AccountLimits {
  const windows = Object.create(null) as AccountLimits["windows"];
  const sources =
    next.completeness === "snapshot"
      ? [next.windows]
      : [previous?.windows, next.windows];
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, window] of Object.entries(source)) {
      Object.defineProperty(
        windows,
        mode === undefined ? key : canonicalRateLimitWindowKey(mode, key),
        {
          value: window,
          enumerable: true,
          configurable: true,
          writable: true
        }
      );
    }
  }
  return next.completeness === "snapshot"
    ? { ...next, windows }
    : {
        ...previous,
        ...next,
        windows,
        observedAt: next.observedAt,
        source: next.source
      };
}

export class RateLimitTracker {
  readonly #statePath: string;
  readonly #mode: SubscriptionMode | undefined;
  readonly #state: Map<string, PersistedMemberState>;

  constructor(statePath: string, mode?: SubscriptionMode) {
    this.#statePath = statePath;
    this.#mode = mode;
    const loaded = readTrackerState(statePath, mode);
    this.#state = loaded.state;
    if (loaded.migrated) this.#persist();
  }

  limits(memberId: string): AccountLimits | undefined {
    return this.#state.get(memberId)?.limits;
  }

  coolingUntil(memberId: string): number | undefined {
    return this.#state.get(memberId)?.coolingUntil;
  }

  update(memberId: string, limits: AccountLimits): void {
    const member = this.#state.get(memberId) ?? {};
    member.limits = mergeLimits(member.limits, limits, this.#mode);
    this.#state.set(memberId, member);
    this.#persist();
  }

  cool(memberId: string, until: number): void {
    const member = this.#state.get(memberId) ?? {};
    member.coolingUntil = until;
    this.#state.set(memberId, member);
    this.#persist();
  }

  clearCooling(memberId: string): void {
    const member = this.#state.get(memberId);
    if (member === undefined || member.coolingUntil === undefined) return;
    delete member.coolingUntil;
    this.#persist();
  }

  resetAfterRefresh(memberId: string): void {
    const member = this.#state.get(memberId) ?? {};
    delete member.limits;
    delete member.coolingUntil;
    this.#state.set(memberId, member);
    this.#persist();
  }

  renameMember(sourceId: string, targetId: string): void {
    const source = this.#state.get(sourceId);
    const removedSource = this.#state.delete(sourceId);
    const removedStaleTarget = this.#state.delete(targetId);
    if (source !== undefined) this.#state.set(targetId, source);
    if (removedSource || removedStaleTarget || source !== undefined) this.#persist();
  }

  #persist(): void {
    const file: PersistedTrackerFile = {
      members: [...this.#state].map(([id, member]) => ({ id, ...member }))
    };
    writeFileAtomic(this.#statePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

export class SubscriptionAccountSetExhaustedError extends ProviderFailureError {
  readonly resetAt: number | undefined;

  constructor(mode: SubscriptionMode, resetAt?: number) {
    const message =
      resetAt === undefined
        ? `all ${mode} subscription pool members are unavailable`
        : `all ${mode} subscription pool members are unavailable until ${new Date(resetAt * 1000).toISOString()}`;
    super({
      category: "quota_exhausted",
      message,
      ...(resetAt !== undefined ? { resetsAt: resetAt } : {})
    });
    this.resetAt = resetAt;
  }
}

export class SubscriptionAccountSet {
  readonly #provider: SubscriptionProvider;
  readonly #options: Required<
    Pick<
      SubscriptionAccountSetOptions,
      "strategy" | "switchThreshold" | "refreshSkewSeconds" | "fallbackCooldownSeconds"
    >
  > & SubscriptionAccountSetOptions;
  readonly #members: PoolMember[];
  readonly #capacityPool: CapacityPool<PoolMember> | undefined;
  readonly #tracker: RateLimitTracker;
  readonly #refreshes = new Map<string, Promise<void>>();
  readonly #reasoning = new Map<string, ModelReasoningCapabilities>();
  #usageProbe: Promise<void> | undefined;
  #lastUsageProbeAt: number | undefined;
  #activeId: string | undefined;
  #catalogReady = false;
  #probeTimer: NodeJS.Timeout | undefined;
  #closed = false;

  private constructor(
    provider: SubscriptionProvider,
    options: SubscriptionAccountSetOptions,
    members: PoolMember[],
    tracker: RateLimitTracker
  ) {
    this.#provider = provider;
    this.#options = {
      ...options,
      strategy: options.strategy ?? "sticky",
      switchThreshold: options.switchThreshold ?? DEFAULT_SWITCH_THRESHOLD,
      refreshSkewSeconds: options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS,
      fallbackCooldownSeconds:
        options.fallbackCooldownSeconds ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS
    };
    this.#members = members;
    this.#capacityPool =
      members.length === 0
        ? undefined
        : new CapacityPool(
            members.map((member) => ({ id: member.id, value: member })),
            { strategy: this.#options.strategy }
          );
    this.#tracker = tracker;
  }

  static async open(
    provider: SubscriptionProvider,
    options: SubscriptionAccountSetOptions
  ): Promise<SubscriptionAccountSet> {
    const source = options.source ?? { kind: "auto" as const };
    const accounts = await resolveSubscriptionAccounts(options.mode, source);
    const tracker = new RateLimitTracker(
      join(accounts.stateDirectory, ".state.json"),
      provider.mode
    );
    const members: PoolMember[] = [];
    for (const sourcePath of accounts.paths) {
      try {
        const credential = await provider.loadCredential(sourcePath);
        const id = subscriptionCredentialLabel(sourcePath);
        members.push({
          id,
          label: id,
          sourcePath,
          credential,
          models: new Set(),
          ...(tracker.coolingUntil(id) !== undefined
            ? { coolingUntil: tracker.coolingUntil(id) }
            : {}),
          lastUsed: 0,
          inFlight: 0,
          switchedAt: 0
        });
      } catch {
        // A broken member remains visible on disk for `proxy status`, but is
        // excluded from serving until the operator re-enrolls it.
      }
    }
    const accountSet = new SubscriptionAccountSet(provider, options, members, tracker);
    accountSet.#startProbe();
    return accountSet;
  }

  get mode(): SubscriptionMode {
    return this.#provider.mode;
  }

  get size(): number {
    return this.#members.length;
  }

  snapshot(): SubscriptionAccountSetSnapshot {
    return {
      mode: this.mode,
      strategy: this.#options.strategy,
      switchThreshold: this.#options.switchThreshold,
      members: this.#members.map((member) => this.#memberStatus(member))
    };
  }

  statusSnapshot(): SubscriptionAccountSetSnapshot {
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      members: snapshot.members.map((status) => {
        const member = this.#members.find((candidate) => candidate.id === status.id)!;
        const credentialValid =
          member.credential.accessToken.length > 0 &&
          (member.credential.expiresAt === undefined ||
            member.credential.expiresAt > Date.now() / 1000 ||
            (member.credential.refreshToken?.length ?? 0) > 0);
        return {
          ...status,
          credentialValid,
          relayReady:
            credentialValid &&
            (member.coolingUntil === undefined || member.coolingUntil <= Date.now())
        };
      })
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly string[]> {
    this.#reasoning.clear();
    const discoveries = await Promise.allSettled(
      this.#members.map(async (member) => {
        member.models.clear();
        await this.#ensureFresh(member, signal);
        const discovered = await this.#provider.discoverModels(
          member.credential,
          signal
        );
        const normalized = discovered.map((model) =>
          typeof model === "string" ? { id: model } : model
        );
        member.models = new Set(normalized.map((model) => model.id));
        return normalized;
      })
    );
    // Promise.allSettled preserves input order. Merge after all discoveries
    // finish so conflicts resolve by configured account order, not timing.
    for (const discovery of discoveries) {
      if (discovery.status !== "fulfilled") continue;
      for (const model of discovery.value) {
        if (model.reasoning !== undefined && !this.#reasoning.has(model.id)) {
          this.#reasoning.set(model.id, model.reasoning);
        }
      }
    }
    this.#catalogReady = true;
    return this.listModelIds();
  }

  listModelIds(): readonly string[] {
    const models = new Set<string>();
    for (const member of this.#members) {
      for (const model of member.models) models.add(model);
    }
    return [...models];
  }

  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.#reasoning.get(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#probeTimer !== undefined) {
      clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
    await Promise.allSettled([
      ...this.#refreshes.values(),
      ...(this.#usageProbe !== undefined ? [this.#usageProbe] : [])
    ]);
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await Promise.allSettled(
      this.#members.map(async (member) => {
        await this.#ensureFresh(member, signal);
        const limits = await this.#provider.fetchUsage(member.credential, signal);
        this.#tracker.update(member.id, limits);
      })
    );
  }

  /**
   * Refresh stale or missing usage without allowing rapid callers to hammer
   * provider quota endpoints. Failed attempts are throttled as well.
   */
  async refreshUsage(maxAgeMs = 60_000, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new RangeError("usage refresh age must be a non-negative finite number");
    }
    if (this.#members.length === 0) return;
    const now = Date.now();
    const allFresh = this.#members.every((member) => {
      const limits = this.#tracker.limits(member.id);
      return (
        limits?.completeness === "snapshot" &&
        now - limits.observedAt * 1000 < maxAgeMs
      );
    });
    if (allFresh) return;
    if (this.#usageProbe !== undefined) return await this.#usageProbe;
    if (
      this.#lastUsageProbeAt !== undefined &&
      now - this.#lastUsageProbeAt < maxAgeMs
    ) {
      return;
    }
    this.#lastUsageProbeAt = now;
    const probe = this.probe(signal).finally(() => {
      if (this.#usageProbe === probe) this.#usageProbe = undefined;
    });
    this.#usageProbe = probe;
    await probe;
  }

  async execute(
    model: string | undefined,
    operation: (credential: SubscriptionCredential) => Promise<Response>,
    signal?: AbortSignal,
    observer?: SubscriptionExecutionObserver
  ): Promise<Response> {
    if (this.#members.length === 0) throw new SubscriptionAccountSetExhaustedError(this.mode);
    const excluded = new Set<string>();
    const absorbed = new Set<string>();
    let transientFailovers = 0;

    while (excluded.size < this.#members.length) {
      const lease = await this.#acquire(model, excluded, signal);
      const member = lease.value;
      try {
        observer?.onAttempt?.({ seat: attributionSeat(member.label) });
        const response = await operation(member.credential);
        const headerLimits = this.#provider.parseLimits(response.headers);
        if (headerLimits !== undefined) this.#tracker.update(member.id, headerLimits);
        if (response.ok) return this.#observeStream(member, response);

        const text = await response.text();
        const parsed = this.#parseJson(text);
        const bodyLimits = this.#provider.parseLimits(response.headers, parsed);
        if (bodyLimits !== undefined) this.#tracker.update(member.id, bodyLimits);
        const failure = this.#provider.classify(response.status, response.headers, parsed);
        const passthrough = new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
        if (failure === undefined || !isRetryableProviderFailure(failure.category)) return passthrough;

        if (failure.category === "transient") {
          if (!absorbed.has(member.id)) {
            absorbed.add(member.id);
            const delaySeconds = Math.min(60, failure.retryAfter ?? 0.5);
            await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
            continue;
          }
          // One retry absorbs a short prompt-cache-sensitive throttle on the
          // same account. If it persists and another eligible account exists,
          // try exactly one alternate: a transient 429 is account-local in
          // practice, but marching a provider-wide burst through the entire
          // pool would amplify it.
          const now = Date.now() / 1000;
          const hasAlternative = this.#members.some(
            (candidate) =>
              candidate.id !== member.id &&
              !excluded.has(candidate.id) &&
              this.#eligible(candidate, model, now)
          );
          if (transientFailovers === 0 && hasAlternative) {
            transientFailovers += 1;
            excluded.add(member.id);
            continue;
          }
          return passthrough;
        }

        // Only an actual spent quota window rotates accounts. Authentication,
        // context, and unknown failures were already returned above.
        const until =
          failure.resetsAt ??
          Date.now() / 1000 +
            (failure.retryAfter ?? this.#options.fallbackCooldownSeconds);
        this.#penalize(member, until);
        excluded.add(member.id);
      } finally {
        this.#release(member);
        lease.release();
      }
    }

    // The loop only falls through here after every member was rotated off a
    // quota wall (throttles and non-failover responses return inline above), so
    // surface exhaustion with the soonest reset rather than leaking a raw
    // provider 429 that may carry no retry-after.
    throw new SubscriptionAccountSetExhaustedError(this.mode, this.#soonestReset(model));
  }

  #memberStatus(member: PoolMember): SubscriptionMemberStatus {
    return {
      id: member.id,
      mode: this.mode,
      label: member.label,
      sourcePath: member.sourcePath,
      ...(member.credential.expiresAt !== undefined
        ? { expiresAt: member.credential.expiresAt }
        : {}),
      ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
      active: member.id === this.#activeId,
      models: [...member.models],
      ...(this.#tracker.limits(member.id) !== undefined
        ? { limits: this.#tracker.limits(member.id) }
        : {})
    };
  }

  async #acquire(
    model: string | undefined,
    excluded: Set<string>,
    signal?: AbortSignal
  ): Promise<CapacityLease<PoolMember>> {
    const now = Date.now() / 1000;
    for (const member of this.#members) {
      if (member.coolingUntil !== undefined && member.coolingUntil <= now) {
        delete member.coolingUntil;
        this.#tracker.clearCooling(member.id);
      }
    }
    const eligible = this.#members.filter(
      (member) => !excluded.has(member.id) && this.#eligible(member, model, now)
    );
    if (eligible.length === 0) {
      throw new SubscriptionAccountSetExhaustedError(this.mode, this.#soonestReset(model));
    }
    const ineligible = new Set([
      ...excluded,
      ...this.#members.filter((member) => !eligible.includes(member)).map((member) => member.id)
    ]);
    if (this.#capacityPool === undefined) {
      throw new SubscriptionAccountSetExhaustedError(this.mode);
    }
    for (const member of this.#members) {
      this.#capacityPool.update(member.id, {
        quotaUtilization: 1 - this.#headroom(member, model),
        ...(member.coolingUntil !== undefined
          ? { coolingUntil: member.coolingUntil * 1000 }
          : { coolingUntil: undefined })
      });
    }
    const lease = this.#capacityPool.acquire(model ?? "default", ineligible);
    const member = lease.value;
    try {
      await this.#ensureFresh(member, signal);
      if (this.#activeId !== member.id) {
        this.#activeId = member.id;
        member.switchedAt = Date.now();
      }
      await this.#waitForRamp(member, signal);
      member.inFlight += 1;
      member.lastUsed = Date.now();
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  #release(member: PoolMember): void {
    member.inFlight = Math.max(0, member.inFlight - 1);
  }

  #eligible(member: PoolMember, model: string | undefined, now: number): boolean {
    if (this.#catalogReady && member.models.size === 0) return false;
    if (this.#catalogReady && model !== undefined && !member.models.has(model)) {
      return false;
    }
    if (member.coolingUntil !== undefined && member.coolingUntil > now) return false;
    if (
      member.credential.expiresAt !== undefined &&
      member.credential.expiresAt <= now &&
      member.credential.refreshToken === undefined
    ) {
      return false;
    }
    return this.#headroom(member, model) > 1 - this.#options.switchThreshold;
  }

  #headroom(member: PoolMember, model: string | undefined): number {
    const limits = this.#tracker.limits(member.id);
    if (limits === undefined) return 1;
    const relevant = Object.entries(limits.windows).filter(([key, window]) =>
      this.#windowRelevant(key, window.limitName, model)
    );
    if (relevant.length === 0) return 1;
    return Math.min(...relevant.map(([, window]) => 1 - window.utilization));
  }

  #windowRelevant(key: string, limitName: string | undefined, model: string | undefined): boolean {
    const lowered = (model ?? "").toLowerCase();
    const descriptor = `${key} ${limitName ?? ""}`.toLowerCase();
    for (const family of ["sonnet", "opus", "haiku", "spark"]) {
      if (descriptor.includes(family)) return lowered.includes(family);
    }
    return true;
  }

  #soonestReset(model: string | undefined): number | undefined {
    const now = Date.now() / 1000;
    const resets: number[] = [];
    for (const member of this.#members) {
      if (this.#catalogReady && member.models.size === 0) continue;
      if (this.#catalogReady && model !== undefined && !member.models.has(model)) {
        continue;
      }
      if (member.coolingUntil !== undefined && member.coolingUntil > now) {
        resets.push(member.coolingUntil);
      }
      const limits = this.#tracker.limits(member.id);
      if (limits === undefined) continue;
      for (const [key, window] of Object.entries(limits.windows)) {
        if (
          window.resetsAt !== undefined &&
          window.resetsAt > now &&
          this.#windowRelevant(key, window.limitName, model)
        ) {
          resets.push(window.resetsAt);
        }
      }
    }
    return resets.length > 0 ? Math.min(...resets) : undefined;
  }

  #penalize(member: PoolMember, until: number): void {
    member.coolingUntil = until;
    this.#tracker.cool(member.id, until);
    if (this.#activeId === member.id) this.#activeId = undefined;
  }

  async #ensureFresh(member: PoolMember, signal?: AbortSignal): Promise<void> {
    const expiresAt = member.credential.expiresAt;
    if (
      expiresAt === undefined ||
      expiresAt - Date.now() / 1000 > this.#options.refreshSkewSeconds
    ) {
      return;
    }
    const existing = this.#refreshes.get(member.id);
    if (existing !== undefined) return existing;
    const refresh = (async () => {
      member.credential = await this.#provider.refresh(member.credential, signal);
      this.#tracker.resetAfterRefresh(member.id);
      delete member.coolingUntil;
    })().finally(() => this.#refreshes.delete(member.id));
    this.#refreshes.set(member.id, refresh);
    return refresh;
  }

  async #waitForRamp(member: PoolMember, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const elapsed = Date.now() - member.switchedAt;
      if (elapsed >= RAMP_WINDOW_MS) return;
      const cap = 1 + Math.floor(elapsed / RAMP_STEP_MS);
      if (member.inFlight < cap) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, RAMP_STEP_MS);
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("account operation aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  #observeStream(member: PoolMember, response: Response): Response {
    if (response.body === null || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    const decoder = new SseDecoder();
    const tracker = this.#tracker;
    const provider = this.#provider;
    const observe = (events: ReturnType<SseDecoder["feed"]>): void => {
      for (const event of events) {
        const raw = event.data.trim();
        if (raw.length === 0 || raw === "[DONE]") continue;
        try {
          const limits = provider.parseStreamEvent(JSON.parse(raw));
          if (limits !== undefined) tracker.update(member.id, limits);
        } catch {
          // Usage observation must not alter malformed provider streams.
        }
      }
    };
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        observe(decoder.feed(chunk));
      },
      flush() {
        try {
          observe(decoder.flush());
        } catch (error) {
          if (!(error instanceof SseParseError)) throw error;
          // Observation remains best-effort; the original truncated bytes
          // have already passed through unchanged.
        }
      }
    });
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  #parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  #startProbe(): void {
    const interval = this.#options.probeIntervalMs ?? 0;
    if (interval <= 0) return;
    this.#probeTimer = setInterval(() => {
      void this.refreshUsage(0);
    }, Math.max(60_000, interval));
    this.#probeTimer.unref();
    void this.refreshUsage(0);
  }
}

