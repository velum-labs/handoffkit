/**
 * WS9.1 acceptance: the exit-code epilogue actually ships telemetry.
 *
 * Root cause under test: command actions used to call `process.exit(...)`
 * directly, so the telemetry settle/flush in the entry point never ran and no
 * event ever left the machine despite the feature being "implemented". The
 * contract: commands return/throw, one epilogue settles telemetry, flushes,
 * runs cleanups, then exits. Also pins env-only opt-in: FUSIONKIT_TELEMETRY=1
 * without a consent file must still capture (with an ephemeral install id).
 *
 * The SIGINT test pins the second variant of the same bug: interactive fusion
 * sessions end with Ctrl+C, which exits through the cleanup registry's signal
 * handler (process.exit after runCleanups) and never resumes main's finally —
 * so the telemetry epilogue must also be registered as a cleanup.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

type CapturedEvent = { event?: string; properties?: Record<string, unknown> };

function eventsFromBodies(bodies: string[]): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  for (const body of bodies) {
    try {
      const parsed = JSON.parse(body) as { batch?: CapturedEvent[] } & CapturedEvent;
      if (Array.isArray(parsed.batch)) events.push(...parsed.batch);
      else events.push(parsed);
    } catch {
      // Non-JSON bodies (unlikely) just don't contribute events.
    }
  }
  return events;
}

test("a real CLI run ships a cli.command event to the telemetry sink before exiting", async () => {
  const bodies: string[] = [];
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      bodies.push(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const port = (sink.address() as AddressInfo).port;
  const home = mkdtempSync(join(tmpdir(), "fk-telemetry-e2e-"));
  try {
    const run = spawnSync(process.execPath, [CLI, "version"], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        // Env-only opt-in, deliberately WITHOUT a consent file: an ephemeral
        // install id must be minted so the event is still captured.
        FUSIONKIT_TELEMETRY: "1",
        FUSIONKIT_TELEMETRY_PATH: join(home, "telemetry.json"),
        FUSIONKIT_POSTHOG_KEY: "phc_test_key",
        FUSIONKIT_POSTHOG_HOST: `http://127.0.0.1:${port}`,
        DO_NOT_TRACK: ""
      }
    });
    assert.equal(run.status, 0, `version exited ${run.status}: ${run.stderr}`);

    // The epilogue flushes before exit, but give the sink a moment to record.
    const deadline = Date.now() + 5_000;
    while (bodies.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const events = eventsFromBodies(bodies);
    const commandEvent = events.find((event) => event.event === "cli.command");
    assert.ok(
      commandEvent !== undefined,
      `no cli.command event reached the sink; received bodies: ${bodies.join("\n") || "(none)"}`
    );
    assert.equal(commandEvent.properties?.command, "version");
    assert.equal(commandEvent.properties?.exit_kind, "ok");
  } finally {
    sink.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a SIGINT-terminated CLI run still ships a cli.command event before exiting", async () => {
  const bodies: string[] = [];
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      bodies.push(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const port = (sink.address() as AddressInfo).port;
  const home = mkdtempSync(join(tmpdir(), "fk-telemetry-sigint-"));
  try {
    // `doctor` is async long enough to interrupt mid-run, needs no provider
    // keys, and keeps the event loop responsive so the signal handler fires.
    const child = spawn(process.execPath, [CLI, "doctor"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        FUSIONKIT_TELEMETRY: "1",
        FUSIONKIT_TELEMETRY_PATH: join(home, "telemetry.json"),
        FUSIONKIT_POSTHOG_KEY: "phc_test_key",
        FUSIONKIT_POSTHOG_HOST: `http://127.0.0.1:${port}`,
        DO_NOT_TRACK: ""
      }
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("CLI did not install its signal cleanup handler")),
        30_000
      );
      child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "fusionkit.cli.signal-ready"
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await ready;
    child.kill("SIGINT");
    const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(guard);

    const deadline = Date.now() + 5_000;
    while (bodies.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const events = eventsFromBodies(bodies);
    const commandEvent = events.find((event) => event.event === "cli.command");
    assert.ok(
      commandEvent !== undefined,
      `no cli.command event reached the sink after SIGINT; received bodies: ${bodies.join("\n") || "(none)"}`
    );
    assert.equal(commandEvent.properties?.command, "doctor");
  } finally {
    sink.close();
    rmSync(home, { recursive: true, force: true });
  }
});
