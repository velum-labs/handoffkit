import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

type CliResult = { exitCode: number; stdout: string; stderr: string };

function runCli(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CliResult> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { cwd: input.cwd, env: input.env, timeout: 90_000 },
      (error, stdout, stderr) => {
        const exitCode =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolveRun({ exitCode, stdout, stderr });
      }
    );
  });
}

function json(result: CliResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("gateway service lifecycle: start, idempotency, upgrade, drain-on-stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-service-e2e-"));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  mkdirSync(project, { recursive: true });

  // A mock upstream whose /slow completion takes 2.5s: long enough to still be
  // in flight when the stop begins, short enough to finish within the drain.
  const upstream = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] })
      );
      return;
    }
    request.on("data", () => {});
    request.on("end", () => {
      const respond = (): void => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            created: 0,
            model: "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "drained answer" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
      };
      setTimeout(respond, 2_500);
    });
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const configPath = join(project, "router.yaml");
  writeFileSync(
    configPath,
    ["providers:", "  openai: {}", "defaultModel: openai/mock-model", ""].join("\n")
  );
  const env = {
    ...process.env,
    ROUTEKIT_HOME: stateHome,
    OPENAI_API_KEY: "mock-secret",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    PORTLESS: "0",
    ROUTEKIT_PORTLESS: "0",
    NO_COLOR: "1"
  };
  const cli = { cwd: project, env };
  const base = ["--config", configPath, "gateway"];
  const recordPath = join(stateHome, "services", "gateway.json");
  let daemonPid: number | undefined;

  try {
    // start: detached daemon, readiness-verified, record written.
    const started = json(
      await runCli([...base, "start", "--port", "0", "--no-portless", "--drain-grace", "5", "--json"], cli)
    );
    assert.equal(started.alreadyRunning, false);
    assert.equal(started.supervisor, "detached");
    daemonPid = started.pid as number;
    assert.ok(alive(daemonPid));
    assert.ok(existsSync(recordPath));
    const url = started.url as string;
    assert.equal((await fetch(`${url}/health`)).status, 200);

    // start again: idempotent, same daemon.
    const again = json(
      await runCli([...base, "start", "--port", "0", "--no-portless", "--json"], cli)
    );
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.pid, daemonPid);

    // The record carries the stamps the upgrade flow relies on.
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      version?: string;
      args?: string[];
      supervisor?: string;
    };
    assert.equal(typeof record.version, "string");
    assert.equal(record.supervisor, "detached");
    assert.ok(record.args?.includes("serve"));

    // upgrade without skew is a no-op; --force performs a drain-restart.
    const upToDate = json(await runCli([...base, "upgrade", "--json"], cli));
    assert.equal(upToDate.action, "up-to-date");
    const upgraded = json(
      await runCli([...base, "upgrade", "--force", "--drain-grace", "5", "--json"], cli)
    );
    assert.equal(upgraded.action, "drain-restart");
    assert.equal(upgraded.previousPid, daemonPid);
    assert.notEqual(upgraded.pid, daemonPid);
    assert.equal(alive(daemonPid), false);
    daemonPid = upgraded.pid as number;
    const upgradedUrl = upgraded.url as string;
    assert.equal((await fetch(`${upgradedUrl}/health`)).status, 200);

    // logs: the daemon's output landed in the shared log file.
    const logs = await runCli([...base, "logs", "-n", "50"], cli);
    assert.equal(logs.exitCode, 0);
    assert.match(logs.stdout, /RouteKit gateway listening/);

    // Drain on stop: an in-flight (slow) completion finishes while the
    // gateway refuses new work and then shuts down.
    const inflight = fetch(`${upgradedUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/mock-model",
        messages: [{ role: "user", content: "slow" }]
      })
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const stopRun = runCli([...base, "stop", "--json"], cli);
    const inflightResponse = await inflight;
    assert.equal(inflightResponse.status, 200);
    assert.match(await inflightResponse.text(), /drained answer/);
    const stopped = json(await stopRun);
    assert.equal((stopped.service as { stopped?: boolean }).stopped, true);
    assert.equal(existsSync(recordPath), false);
    const deadline = Date.now() + 5_000;
    while (alive(daemonPid) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(alive(daemonPid), false);
    daemonPid = undefined;
  } finally {
    if (daemonPid !== undefined && alive(daemonPid)) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
