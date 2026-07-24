import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RateLimitTracker,
  sanitizeSubscriptionLabel,
  SubscriptionAccountSet,
  type AccountLimits,
  type SubscriptionCredential,
  type SubscriptionProvider
} from "../index.js";

type FakeCredentialFile = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type FakeProviderState = {
  refreshes: number;
  usageCalls?: number;
  failUsage?: boolean;
};

function fakeProvider(
  state: FakeProviderState,
  modelsByToken: Readonly<Record<string, readonly string[]>> = {}
): SubscriptionProvider {
  return {
    mode: "codex",
    upstreamBaseUrl: "https://example.invalid",
    requestPath: "/responses",
    async discoverModels(credential) {
      return modelsByToken[credential.accessToken] ?? ["gpt-5.3-codex"];
    },
    async loadCredential(path) {
      const raw = JSON.parse(await readFile(path, "utf8")) as FakeCredentialFile;
      return {
        mode: "codex",
        sourcePath: path,
        accessToken: raw.accessToken,
        ...(raw.refreshToken !== undefined ? { refreshToken: raw.refreshToken } : {}),
        ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {})
      };
    },
    authHeaders: (credential) => ({ authorization: `Bearer ${credential.accessToken}` }),
    async refresh(credential) {
      state.refreshes += 1;
      return { ...credential, accessToken: `${credential.accessToken}-refreshed`, expiresAt: Date.now() / 1000 + 3600 };
    },
    async fetchUsage() {
      state.usageCalls = (state.usageCalls ?? 0) + 1;
      if (state.failUsage === true) throw new Error("usage unavailable");
      return {
        windows: {},
        observedAt: Date.now() / 1000,
        source: "usage",
        completeness: "snapshot"
      };
    },
    async fetchAdminUsageCost() {
      return { usage: {}, cost: {} };
    },
    parseLimits(headers) {
      const value = headers.get("x-test-utilization");
      if (value === null) return undefined;
      const observedAt = Date.now() / 1000;
      const limits: AccountLimits = {
        windows: {
          primary: {
            utilization: Number(value),
            observedAt,
            source: "headers"
          }
        },
        observedAt,
        source: "headers",
        completeness: "partial"
      };
      return limits;
    },
    parseStreamEvent: () => undefined,
    classify(status, _headers, body) {
      if (status !== 429) return undefined;
      const quota =
        typeof body === "object" &&
        body !== null &&
        "quota" in body &&
        body.quota === true;
      return {
        category: quota ? "quota_exhausted" : "transient",
        message: "limited",
        ...(quota ? { resetsAt: Date.now() / 1000 + 3600 } : {})
      };
    }
  };
}

function writeMember(directory: string, name: string, credential: FakeCredentialFile): void {
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(credential));
}

type DiscoveryResult = Awaited<ReturnType<SubscriptionProvider["discoverModels"]>>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function reasoningModel(effort: string): DiscoveryResult {
  return [
    {
      id: "gpt-shared",
      reasoning: {
        status: "supported",
        efforts: [{ id: effort }],
        provenance: "provider"
      }
    }
  ];
}

test("pool transparently rotates from a quota-exhausted member", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  const seen: string[] = [];
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      if (credential.accessToken === "token-a") {
        return Promise.resolve(
          new Response(JSON.stringify({ quota: true }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return Promise.resolve(new Response("OK"));
    });
    assert.equal(await response.text(), "OK");
    assert.deepEqual(seen, ["token-a", "token-b"]);
    assert.ok(pool.snapshot().members.find((member) => member.id === "a")?.coolingUntil);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool proactively moves away from a member over the utilization threshold", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory },
    strategy: "sticky",
    switchThreshold: 0.9
  });
  try {
    const first = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(
        new Response(credential.accessToken, {
          headers: { "x-test-utilization": "0.95" }
        })
      )
    );
    assert.equal(await first.text(), "token-a");
    const second = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await second.text(), "token-b");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool retries a short throttle locally, then tries only one alternate account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  const attemptedAccounts: string[] = [];
  try {
    const response = await pool.execute(
      "gpt-5.3-codex",
      (credential) => {
        seen.push(credential.accessToken);
        return Promise.resolve(
          new Response(JSON.stringify({ quota: false }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        );
      },
      undefined,
      {
        onAttempt: (account) => attemptedAccounts.push(account.seat)
      }
    );
    assert.equal(response.status, 429);
    assert.deepEqual(seen, ["token-a", "token-a", "token-b", "token-b"]);
    assert.equal(attemptedAccounts.length, 4);
    assert.match(attemptedAccounts[0]!, /^seat_[0-9a-f]{16}$/);
    assert.equal(attemptedAccounts[0], attemptedAccounts[1]);
    assert.notEqual(attemptedAccounts[1], attemptedAccounts[2]);
    assert.equal(attemptedAccounts[2], attemptedAccounts[3]);
    assert.doesNotMatch(JSON.stringify(attemptedAccounts), /"a"|"b"/);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool recovers from a persistent account-local throttle on one alternate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      return Promise.resolve(
        credential.accessToken === "token-b"
          ? new Response("recovered")
          : new Response(JSON.stringify({ quota: false }), {
              status: 429,
              headers: { "content-type": "application/json" }
            })
      );
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "recovered");
    assert.deepEqual(seen, ["token-a", "token-a", "token-b"]);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool coalesces near-expiry credential refresh before serving", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 - 1
  });
  const state = { refreshes: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential: SubscriptionCredential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await response.text(), "token-a-refreshed");
    assert.equal(state.refreshes, 1);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool unions heterogeneous member catalogs and routes only eligible accounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-models-"));
  writeMember(directory, "personal", { accessToken: "token-personal" });
  writeMember(directory, "work", { accessToken: "token-work" });
  const pool = await SubscriptionAccountSet.open(
    fakeProvider(
      { refreshes: 0 },
      {
        "token-personal": ["gpt-shared", "gpt-personal"],
        "token-work": ["gpt-shared", "gpt-work"]
      }
    ),
    {
      mode: "codex",
      source: { kind: "directory", path: directory },
      strategy: "round_robin"
    }
  );
  try {
    assert.deepEqual(await pool.discoverModels(), [
      "gpt-shared",
      "gpt-personal",
      "gpt-work"
    ]);
    const personal = await pool.execute("gpt-personal", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    const work = await pool.execute("gpt-work", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await personal.text(), "token-personal");
    assert.equal(await work.text(), "token-work");
    assert.deepEqual(
      pool.snapshot().members.map((member) => [member.id, member.models]),
      [
        ["personal", ["gpt-shared", "gpt-personal"]],
        ["work", ["gpt-shared", "gpt-work"]]
      ]
    );
    await assert.rejects(
      pool.execute("gpt-unknown", () => Promise.resolve(new Response("wrong"))),
      /all codex subscription pool members are unavailable/
    );
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capability conflicts resolve by account order across reversed response timing", async () => {
  for (const completionOrder of [
    ["token-a", "token-b"],
    ["token-b", "token-a"]
  ] as const) {
    const directory = mkdtempSync(join(tmpdir(), "routekit-pool-capabilities-"));
    // Directory-backed pools sort filenames, independently of creation order.
    writeMember(directory, "b", { accessToken: "token-b" });
    writeMember(directory, "a", { accessToken: "token-a" });
    const gates: Record<string, ReturnType<typeof deferred<DiscoveryResult>>> = {
      "token-a": deferred<DiscoveryResult>(),
      "token-b": deferred<DiscoveryResult>()
    };
    const provider = fakeProvider({ refreshes: 0 });
    provider.discoverModels = (credential) => gates[credential.accessToken]!.promise;
    const pool = await SubscriptionAccountSet.open(provider, {
      mode: "codex",
      source: { kind: "directory", path: directory }
    });
    try {
      const discovering = pool.discoverModels();
      gates[completionOrder[0]]!.resolve(reasoningModel(completionOrder[0]));
      await Promise.resolve();
      gates[completionOrder[1]]!.resolve(reasoningModel(completionOrder[1]));
      await discovering;
      assert.deepEqual(
        pool.reasoningCapabilities("gpt-shared")?.efforts?.map((effort) => effort.id),
        ["token-a"]
      );
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("capability precedence skips failed and capability-omitting accounts", async () => {
  for (const firstAccount of ["failed", "omitted"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "routekit-pool-capability-fallback-"));
    writeMember(directory, "a", { accessToken: "token-a" });
    writeMember(directory, "b", { accessToken: "token-b" });
    const provider = fakeProvider({ refreshes: 0 });
    provider.discoverModels = async (credential) => {
      if (credential.accessToken === "token-b") return reasoningModel("second-account");
      if (firstAccount === "failed") throw new Error("discovery unavailable");
      return ["gpt-shared"];
    };
    const pool = await SubscriptionAccountSet.open(provider, {
      mode: "codex",
      source: { kind: "directory", path: directory }
    });
    try {
      await pool.discoverModels();
      assert.deepEqual(
        pool.reasoningCapabilities("gpt-shared")?.efforts?.map((effort) => effort.id),
        ["second-account"]
      );
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("subscription labels are normalized in linear time without credential-derived hashes", () => {
  assert.equal(sanitizeSubscriptionLabel("  Work !!! Account --"), "work-account");
  assert.equal(sanitizeSubscriptionLabel("-".repeat(100_000)), "account");
  assert.equal(sanitizeSubscriptionLabel("Team_A.2"), "team_a.2");
});

test("tracker safely migrates hostile object keys into map-backed state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-state-"));
  const statePath = join(directory, ".state.json");
  writeFileSync(
    statePath,
    '{"members":{"__proto__":{"coolingUntil":123},"constructor":{"coolingUntil":456}}}'
  );
  const tracker = new RateLimitTracker(statePath);
  try {
    assert.equal(tracker.coolingUntil("__proto__"), 123);
    tracker.cool("__proto__", 789);
    tracker.cool("prototype", 999);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ id: string; coolingUntil?: number }>;
    };
    assert.ok(Array.isArray(persisted.members));
    assert.equal(
      persisted.members.find((member) => member.id === "__proto__")?.coolingUntil,
      789
    );
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker moves quota and cooldown state to a renamed member", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-rename-state-"));
  const statePath = join(directory, ".state.json");
  const tracker = new RateLimitTracker(statePath, "codex");
  const observedAt = Date.now() / 1000;
  try {
    tracker.update("work", {
      windows: {
        primary: {
          utilization: 0.75,
          observedAt,
          source: "usage"
        }
      },
      observedAt,
      source: "usage",
      completeness: "snapshot"
    });
    tracker.cool("work", 123_456);
    tracker.cool("personal", 999_999);

    tracker.renameMember("work", "personal");

    assert.equal(tracker.limits("work"), undefined);
    assert.equal(tracker.coolingUntil("work"), undefined);
    assert.equal(tracker.limits("personal")?.windows.primary?.utilization, 0.75);
    assert.equal(tracker.coolingUntil("personal"), 123_456);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ id: string; coolingUntil?: number }>;
    };
    assert.deepEqual(
      persisted.members.map((member) => [member.id, member.coolingUntil]),
      [["personal", 123_456]]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker migrates legacy partial observations to canonical windows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-window-state-"));
  const statePath = join(directory, ".state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      members: [{
        id: "primary",
        limits: {
          windows: {
            "5h": { utilization: 0.4 },
            five_hour: { utilization: 0.2 },
            "7d-sonnet": { utilization: 0.6 }
          },
          observedAt: Date.now() / 1000,
          source: "headers"
        }
      }]
    })
  );
  const tracker = new RateLimitTracker(statePath, "claude-code");
  try {
    assert.deepEqual(Object.keys(tracker.limits("primary")?.windows ?? {}), [
      "five_hour",
      "seven_day_sonnet"
    ]);
    assert.equal(tracker.limits("primary")?.windows.five_hour?.utilization, 0.2);
    assert.equal(tracker.limits("primary")?.completeness, "partial");

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ limits?: { windows: Record<string, unknown> } }>;
    };
    assert.deepEqual(Object.keys(persisted.members[0]?.limits?.windows ?? {}), [
      "five_hour",
      "seven_day_sonnet"
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker discards ambiguous legacy usage aggregates", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-legacy-usage-"));
  const statePath = join(directory, ".state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      members: [{
        id: "primary",
        limits: {
          windows: {
            "5h": { utilization: 0.4 },
            five_hour: { utilization: 0.2 }
          },
          observedAt: Date.now() / 1000,
          source: "usage"
        }
      }]
    })
  );
  try {
    const tracker = new RateLimitTracker(statePath, "claude-code");
    assert.equal(tracker.limits("primary"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authoritative usage snapshots replace partial header windows", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-snapshot-"));
  const statePath = join(directory, ".state.json");
  const tracker = new RateLimitTracker(statePath, "claude-code");
  const headerObservedAt = Date.now() / 1000 - 60;
  const usageObservedAt = Date.now() / 1000;
  try {
    tracker.update("primary", {
      windows: {
        "5h": {
          utilization: 0.4,
          observedAt: headerObservedAt,
          source: "headers"
        },
        "7d-opus": {
          utilization: 0.8,
          observedAt: headerObservedAt,
          source: "headers"
        }
      },
      observedAt: headerObservedAt,
      source: "headers",
      completeness: "partial"
    });
    tracker.update("primary", {
      windows: {
        five_hour: {
          utilization: 0.2,
          observedAt: usageObservedAt,
          source: "usage"
        }
      },
      observedAt: usageObservedAt,
      source: "usage",
      completeness: "snapshot"
    });

    const limits = tracker.limits("primary");
    assert.deepEqual(Object.keys(limits?.windows ?? {}), ["five_hour"]);
    assert.equal(limits?.windows.five_hour?.utilization, 0.2);
    assert.equal(limits?.completeness, "snapshot");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a recent partial observation does not suppress an authoritative probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-partial-probe-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const state: FakeProviderState = { refreshes: 0, usageCalls: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.execute("gpt-5.3-codex", () =>
      Promise.resolve(new Response("ok", {
        headers: { "x-test-utilization": "0.4" }
      }))
    );
    assert.equal(pool.snapshot().members[0]?.limits?.completeness, "partial");

    await pool.refreshUsage();
    assert.equal(state.usageCalls, 1);
    assert.equal(pool.snapshot().members[0]?.limits?.completeness, "snapshot");
    assert.deepEqual(
      Object.keys(pool.snapshot().members[0]?.limits?.windows ?? {}),
      []
    );
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage refresh throttles failed provider probes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-usage-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const state: FakeProviderState = {
    refreshes: 0,
    usageCalls: 0,
    failUsage: true
  };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.refreshUsage();
    await pool.refreshUsage();
    assert.equal(state.usageCalls, 1);

    await pool.refreshUsage(0);
    assert.equal(state.usageCalls, 2);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
