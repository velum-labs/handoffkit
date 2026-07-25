import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { terminateGroup } from "@velum-labs/routekit-runtime";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

type SpawnedCli = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  close(): Promise<void>;
};

function spawnCli(args: readonly string[], input: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedCli {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      terminateGroup(child, 1_000);
      await exited;
    }
  };
}

async function waitForJsonLine(
  processHandle: SpawnedCli,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = processHandle.stdout().trim();
    if (output.startsWith("{")) {
      try {
        return JSON.parse(output) as Record<string, unknown>;
      } catch {
        // emitJson pretty-prints; wait until the complete object has arrived.
      }
    }
    if (processHandle.child.exitCode !== null) {
      throw new Error(
        `routekit exited during startup (${processHandle.child.exitCode})\n` +
          `${processHandle.stdout()}\n${processHandle.stderr()}`
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(
    `timed out waiting for routekit --json readiness\n` +
      `${processHandle.stdout()}\n${processHandle.stderr()}`
  );
}

async function waitForExit(processHandle: SpawnedCli, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) return processHandle.child.exitCode;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  await processHandle.close();
  throw new Error(
    `timed out waiting for routekit to exit\n` +
      `${processHandle.stdout()}\n${processHandle.stderr()}`
  );
}

async function requestJson(
  url: string,
  path: string,
  body?: Record<string, unknown>
): Promise<Response> {
  return await fetch(`${url}${path}`, {
    headers: { authorization: "Bearer test-gateway-token" },
    ...(body !== undefined
      ? {
          method: "POST",
          headers: {
            authorization: "Bearer test-gateway-token",
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        }
      : {})
  });
}

test("real routekit daemon run process reports JSON readiness and serves every supported door", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-run-process-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const stateHome = join(root, "state");
  mkdirSync(join(project, ".routekit"), { recursive: true });
  const upstreamRequests: Array<{
    url: string;
    authorization?: string;
    body: Record<string, unknown>;
  }> = [];
  const upstream = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "provider-model", object: "model", owned_by: "mock" }]
        })
      );
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      upstreamRequests.push({
        url: request.url ?? "",
        ...(typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {}),
        body
      });
      if (request.url === "/v1/embeddings") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            model: "provider-model",
            usage: { prompt_tokens: 1, total_tokens: 1 }
          })
        );
        return;
      }
      if (body.stream === true) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.write(
          'data: {"id":"chatcmpl-routekit-stream","object":"chat.completion.chunk","created":0,"model":"provider-model","choices":[{"index":0,"delta":{"role":"assistant","content":"mock stream answer"},"finish_reason":null}]}\n\n'
        );
        response.end(
          'data: {"id":"chatcmpl-routekit-stream","object":"chat.completion.chunk","created":0,"model":"provider-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        );
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-routekit-process",
          object: "chat.completion",
          created: 0,
          model: "provider-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "mock upstream answer" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        })
      );
    });
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const configPath = join(project, ".routekit", "router.yaml");
  writeFileSync(
    configPath,
    [
      "providers:",
      "  openai: {}",
      "defaultModel: openai/provider-model",
      ""
    ].join("\n")
  );
  const authTokenFile = join(root, "data-token");
  writeFileSync(authTokenFile, "test-gateway-token\n", { mode: 0o600 });
  const cliEnv = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    OPENAI_API_KEY: "mock-secret",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    PORTLESS: "0",
    ROUTEKIT_PORTLESS: "0",
    NO_COLOR: "1"
  };
  const routekit = spawnCli(
    [
      "daemon",
      "run",
      "--config-path",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-portless",
      "--auth-token-file",
      authTokenFile,
      "--json"
    ],
    {
      cwd: project,
      env: cliEnv
    }
  );
  try {
    const readiness = await waitForJsonLine(routekit);
    assert.equal(readiness.event, "listening");
    assert.equal(typeof readiness.controlUrl, "string");
    assert.equal(typeof readiness.pid, "number");
    assert.equal(typeof readiness.dataUrl, "string");
    const routekitUrl = readiness.dataUrl as string;
    const unauthorized = await fetch(`${routekitUrl}/v1/models`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await fetch(`${routekitUrl}/health`)).status, 200);

    const importer = spawnCli(
      ["config", "import", "--from", configPath, "--json"],
      { cwd: project, env: cliEnv }
    );
    assert.equal(await waitForExit(importer), 1);
    assert.match(
      `${importer.stdout()}${importer.stderr()}`,
      /running with foreground config/
    );
    assert.equal(
      existsSync(join(home, ".config", "routekit", "router.yaml")),
      false
    );

    const models = await requestJson(routekitUrl, "/v1/models");
    assert.equal(models.status, 200);
    assert.deepEqual(
      ((await models.json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id),
      ["openai/provider-model"]
    );
    for (const catalogPath of [
      "/models",
      "/v1/cursor/models",
      "/backend-api/codex/models"
    ]) {
      assert.equal((await requestJson(routekitUrl, catalogPath)).status, 200);
    }

    const openai = await requestJson(routekitUrl, "/v1/chat/completions", {
      model: "openai/provider-model",
      messages: [{ role: "user", content: "openai door" }]
    });
    assert.equal(openai.status, 200);
    const callId = openai.headers.get("x-routekit-model-call-id");
    assert.ok(callId);
    assert.match(await openai.text(), /mock upstream answer/);
    const canonicalConfig = join(home, ".config", "routekit", "router.yaml");
    mkdirSync(dirname(canonicalConfig), { recursive: true });
    writeFileSync(canonicalConfig, readFileSync(configPath, "utf8"));
    const inspection = spawnCli(
      ["calls", "inspect", callId, "--json"],
      { cwd: root, env: cliEnv }
    );
    assert.equal(
      await waitForExit(inspection),
      0,
      `${inspection.stdout()}\n${inspection.stderr()}`
    );
    const attributed = JSON.parse(inspection.stdout()) as {
      callId?: string;
      effectiveModel?: string;
      provider?: string;
      billingMode?: string;
    };
    assert.equal(attributed.callId, callId);
    assert.equal(attributed.effectiveModel, "openai/provider-model");
    assert.equal(attributed.provider, "openai");
    assert.equal(attributed.billingMode, "api_key");

    const streamed = await requestJson(routekitUrl, "/v1/chat/completions", {
      model: "openai/provider-model",
      stream: true,
      messages: [{ role: "user", content: "streaming door" }]
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
    const streamedText = await streamed.text();
    assert.match(streamedText, /mock stream answer/);
    assert.match(streamedText, /\[DONE\]/);

    const chatAlias = await requestJson(routekitUrl, "/chat/completions", {
      model: "openai/provider-model",
      messages: [{ role: "user", content: "chat alias" }]
    });
    assert.equal(chatAlias.status, 200);

    const malformed = await fetch(`${routekitUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json"
      },
      body: "{"
    });
    assert.equal(malformed.status, 400);

    const unknownModel = await requestJson(routekitUrl, "/v1/chat/completions", {
      model: "openai/does-not-exist",
      messages: [{ role: "user", content: "unknown model" }]
    });
    assert.equal(unknownModel.status, 400);

    const beforeOversized = upstreamRequests.length;
    const oversized = await fetch(`${routekitUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ padding: "x".repeat(16 * 1024 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.equal(upstreamRequests.length, beforeOversized);

    const missingRoute = await requestJson(routekitUrl, "/v1/not-a-route");
    assert.equal(missingRoute.status, 404);

    const anthropic = await requestJson(routekitUrl, "/v1/messages", {
      model: "openai/provider-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "anthropic door" }]
    });
    assert.equal(anthropic.status, 200);
    assert.equal(((await anthropic.json()) as { type?: string }).type, "message");

    const responses = await requestJson(routekitUrl, "/v1/responses", {
      model: "openai/provider-model",
      input: "responses door"
    });
    assert.equal(responses.status, 200);
    assert.equal(((await responses.json()) as { object?: string }).object, "response");
    const codexResponses = await requestJson(
      routekitUrl,
      "/backend-api/codex/responses",
      {
        model: "openai/provider-model",
        input: "codex responses alias"
      }
    );
    assert.equal(codexResponses.status, 200);

    const cursor = await requestJson(routekitUrl, "/v1/cursor/chat/completions", {
      model: "openai/provider-model",
      input: "cursor door"
    });
    assert.equal(cursor.status, 200);

    const tokenCount = await requestJson(routekitUrl, "/v1/messages/count_tokens", {
      model: "openai/provider-model",
      messages: [{ role: "user", content: "count these tokens" }]
    });
    assert.equal(tokenCount.status, 200);
    assert.equal(typeof ((await tokenCount.json()) as { input_tokens?: number }).input_tokens, "number");

    const embeddings = await requestJson(routekitUrl, "/v1/embeddings", {
      model: "openai/provider-model",
      input: "embed this"
    });
    assert.equal(embeddings.status, 200);
    assert.deepEqual(
      ((await embeddings.json()) as { data: Array<{ embedding: number[] }> }).data[0]?.embedding,
      [0.1, 0.2]
    );

    assert.equal(upstreamRequests.length, 8);
    for (const request of upstreamRequests) {
      assert.ok(
        request.url === "/v1/chat/completions" ||
          request.url === "/v1/embeddings"
      );
      assert.equal(request.authorization, "Bearer mock-secret");
      assert.equal(request.body.model, "provider-model");
    }
  } finally {
    await routekit.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      upstream.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
    rmSync(root, { recursive: true, force: true });
  }
});
