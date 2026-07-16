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

function fakeProvider(state: { refreshes: number }): SubscriptionProvider {
  return {
    mode: "codex",
    upstreamBaseUrl: "https://example.invalid",
    requestPath: "/responses",
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
      return { windows: {}, observedAt: Date.now() / 1000, source: "usage" };
    },
    async fetchAdminUsageCost() {
      return { usage: {}, cost: {} };
    },
    parseLimits(headers) {
      const value = headers.get("x-test-utilization");
      if (value === null) return undefined;
      const limits: AccountLimits = {
        windows: { primary: { utilization: Number(value) } },
        observedAt: Date.now() / 1000,
        source: "headers"
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

test("pool absorbs a short throttle on the same account instead of rotating the burst", async () => {
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
        new Response(JSON.stringify({ quota: false }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
      );
    });
    assert.equal(response.status, 429);
    assert.deepEqual(seen, ["token-a", "token-a"]);
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
