import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLifecycleLock,
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  ControlError,
  startControlServer
} from "../index.js";

test("control server authenticates health/calls and negotiates control.v1", async () => {
  const server = await startControlServer({
    product: "testkit",
    packageVersion: "1.2.3",
    capabilities: ["test.v1"],
    handler: async (method, params) => ({ method, params })
  });
  try {
    assert.equal((await fetch(`${server.url}/control/v1/health`)).status, 401);
    const client = new ControlClient({ url: server.url, token: server.token });
    assert.deepEqual(await client.health(), {
      protocol: CONTROL_PROTOCOL_VERSION,
      version: "1.2.3"
    });
    const hello = await client.call<{
      protocolVersion: string;
      capabilities: string[];
    }>("hello");
    assert.equal(hello.protocolVersion, CONTROL_PROTOCOL_VERSION);
    assert.deepEqual(hello.capabilities, ["test.v1"]);
    assert.deepEqual(await client.call("echo", { value: 3 }), {
      method: "echo",
      params: { value: 3 }
    });
  } finally {
    await server.close();
  }
});
test("control transport rejects wrong tokens, hosts, protocols, and content types", async () => {
  let calls = 0;
  const server = await startControlServer({
    handler: async () => {
      calls += 1;
      return {};
    }
  });
  try {
    const wrong = new ControlClient({ url: server.url, token: "wrong" });
    await assert.rejects(wrong.health());
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${server.url}/control/v1/health`,
        {
          headers: {
            authorization: `Bearer ${server.token}`,
            host: "evil.example"
          }
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      request.once("error", reject);
      request.end();
    });
    assert.equal(badHostStatus, 403);
    const text = await fetch(`${server.url}/control/v1/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "text/plain"
      },
      body: "{}"
    });
    assert.equal(text.status, 400);
    const oldProtocol = await fetch(`${server.url}/control/v1/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        protocol: "control.v0",
        id: "old",
        method: "echo"
      })
    });
    assert.equal(oldProtocol.status, 426);
    const body = (await oldProtocol.json()) as {
      error?: { code?: string; details?: { supported?: string[] } };
    };
    assert.equal(body.error?.code, "upgrade_required");
    assert.deepEqual(body.error?.details?.supported, [CONTROL_PROTOCOL_VERSION]);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test("control transport streams NDJSON events and structured failures", async () => {
  const server = await startControlServer({
    handler: (method) => {
      if (method === "fail") {
        throw new ControlError({ code: "conflict", message: "revision changed" });
      }
      return (async function* () {
        yield 1;
        yield 2;
      })();
    }
  });
  try {
    const client = new ControlClient({ url: server.url, token: server.token });
    const values: number[] = [];
    for await (const value of client.stream<number>("events")) values.push(value);
    assert.deepEqual(values, [1, 2]);
    await assert.rejects(
      client.call("fail"),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === "conflict" &&
        error.message === "revision changed"
    );
  } finally {
    await server.close();
  }
});

test("control client rejects truncated streams without a terminal event", async () => {
  const client = new ControlClient({
    url: "http://127.0.0.1:1",
    token: "test",
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        `${JSON.stringify({
          protocol: CONTROL_PROTOCOL_VERSION,
          id: request.id,
          event: "data",
          data: 1
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    }
  });
  await assert.rejects(
    async () => {
      for await (const _value of client.stream("events")) {
        // consume
      }
    },
    /without a terminal event/
  );
});

test("lifecycle lock serializes contenders and reaps dead owners", async () => {
  const home = mkdtempSync(join(tmpdir(), "lifecycle-lock-"));
  const path = join(home, "daemon.lock");
  try {
    const first = await acquireLifecycleLock(path);
    await assert.rejects(
      acquireLifecycleLock(path, { timeoutMs: 100, pollMs: 10 }),
      /owned by pid/
    );
    first.release();
    const second = await acquireLifecycleLock(path, { timeoutMs: 100 });
    second.release();

    writeFileSync(
      path,
      JSON.stringify({
        pid: 2 ** 22 + 123,
        nonce: "dead",
        acquiredAt: new Date(Date.now() - 5_000).toISOString()
      })
    );
    const recovered = await acquireLifecycleLock(path, { timeoutMs: 100 });
    recovered.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a freshly published partial lock is never stolen", async () => {
  const home = mkdtempSync(join(tmpdir(), "lifecycle-partial-"));
  const path = join(home, "daemon.lock");
  try {
    writeFileSync(path, "");
    await assert.rejects(
      acquireLifecycleLock(path, { timeoutMs: 100, pollMs: 10 }),
      /timed out/
    );
    assert.equal(existsSync(path), true);
    const old = new Date(Date.now() - 5_000);
    utimesSync(path, old, old);
    const recovered = await acquireLifecycleLock(path, {
      timeoutMs: 500,
      pollMs: 10
    });
    recovered.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

