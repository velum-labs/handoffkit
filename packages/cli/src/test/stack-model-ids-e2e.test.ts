import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  freePort,
  judgeAnalysis,
  repoRoot,
  scriptFusedTurn,
  stackToolingSkip,
  startProviderSim
} from "@fusionkit/testkit";
import { parseRouterConfig } from "@routekit/gateway";

import { startFusionStack } from "../fusion/stack.js";

const SKIP = stackToolingSkip();

function initializeRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "fusionkit-model-e2e-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=e2e@fusionkit.local",
      "-c",
      "user.name=fusionkit-e2e",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "fixture"
    ],
    { cwd: directory }
  );
  return directory;
}

test(
  "embedded RouteKit routes namespaced model ids through the full fusion stack",
  { skip: SKIP },
  async () => {
    const sim = await startProviderSim();
    const repo = initializeRepository();
    await scriptFusedTurn(sim, {
      candidates: { "provider-fast": "candidate from namespaced model" },
      judgeModel: "provider-deep",
      answer: "fused through namespaced model ids"
    });
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "test-provider-key";
    process.env.OPENAI_BASE_URL = `${sim.url}/v1`;
    const routerConfig = parseRouterConfig({
      providers: { openai: {} },
      defaultModel: "openai/provider-fast"
    });
    let stack: Awaited<ReturnType<typeof startFusionStack>> | undefined;
    let routekitUrl: string | undefined;
    try {
      stack = await startFusionStack({
        repo,
        outputRoot: join(repo, "runs"),
        ensembles: [
          {
            name: "default",
            members: ["openai/provider-fast"],
            judge: "openai/provider-deep",
            synthesizer: "openai/provider-deep",
            k: 1
          }
        ],
        router: { kind: "embedded", config: routerConfig },
        fusionkitDir: process.cwd(),
        log: () => {}
      });
      routekitUrl = stack.routekitUrl;
      const response = await fetch(`${stack.fusionUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fusion-panel",
          messages: [{ role: "user", content: "compose this" }]
        })
      });
      assert.equal(response.status, 200, await sim.describeJournal());
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      assert.match(
        body.choices[0]?.message.content ?? "",
        /fused through namespaced model ids/
      );
      assert.deepEqual(
        (await sim.journal()).map((entry) => entry.model),
        ["provider-fast", "provider-deep", "provider-deep"]
      );
    } finally {
      await stack?.close();
      await sim.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
      rmSync(repo, { recursive: true, force: true });
    }
    assert.ok(routekitUrl !== undefined);
    await assert.rejects(fetch(`${routekitUrl}/v1/models`));
  }
);

test(
  "subscription-backed model ids drive panel judge and synthesis without leaking credentials",
  { skip: SKIP },
  async () => {
    const repo = initializeRepository();
    const stateHome = join(repo, ".routekit-state");
    const accountDirectory = join(stateHome, "subscriptions", "codex");
    mkdirSync(accountDirectory, { recursive: true });
    writeFileSync(
      join(accountDirectory, "primary.json"),
      JSON.stringify({
        tokens: {
          access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
          refresh_token: "refresh-secret",
          account_id: "acct-private"
        }
      }),
      { mode: 0o600 }
    );
    const previousHome = process.env.ROUTEKIT_HOME;
    process.env.ROUTEKIT_HOME = stateHome;
    const originalFetch = globalThis.fetch;
    const calls: Array<{ model: string; authorization: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://chatgpt.com/backend-api/codex/")) {
        return await originalFetch(input, init);
      }
      if (new URL(url).pathname.endsWith("/models")) {
        return Response.json({
          models: [{ slug: "gpt-panel" }, { slug: "gpt-judge" }, { slug: "gpt-synth" }]
        });
      }
      const request = JSON.parse(String(init?.body)) as {
        model?: string;
        stream?: boolean;
      };
      const headers = new Headers(init?.headers);
      calls.push({
        model: request.model ?? "",
        authorization: headers.get("authorization")
      });
      const text =
        request.model === "gpt-panel"
          ? "account candidate"
          : request.model === "gpt-judge"
            ? judgeAnalysis()
            : "account-backed fused answer";
      if (request.stream === true) {
        return new Response(
          [
            "event: response.output_text.delta",
            `data: ${JSON.stringify({ delta: text })}`,
            "",
            "event: response.completed",
            `data: ${JSON.stringify({
              response: {
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text }]
                  }
                ],
                usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
              }
            })}`,
            "",
            ""
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      return Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text }]
          }
        ],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
      });
    };

    let stack: Awaited<ReturnType<typeof startFusionStack>> | undefined;
    try {
      const routerConfig = parseRouterConfig({
        providers: { codex: {} },
        defaultModel: "codex/gpt-panel"
      });
      stack = await startFusionStack({
        repo,
        outputRoot: join(repo, "runs"),
        ensembles: [
          {
            name: "default",
            members: ["codex/gpt-panel"],
            judge: "codex/gpt-judge",
            synthesizer: "codex/gpt-synth",
            k: 1
          }
        ],
        router: { kind: "embedded", config: routerConfig },
        fusionkitDir: process.cwd(),
        log: () => {}
      });
      const response = await originalFetch(
        `${stack.fusionUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fusion-panel",
            messages: [{ role: "user", content: "compose this" }]
          })
        }
      );
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
      assert.match(responseText, /account-backed fused answer/);
      assert.deepEqual(
        calls.map((call) => call.model),
        ["gpt-panel", "gpt-judge", "gpt-synth"]
      );
      assert.ok(
        calls.every(
          (call) =>
            call.authorization ===
            "Bearer eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9."
        )
      );
      assert.doesNotMatch(responseText, /acct-private|refresh-secret|eyJ/);
    } finally {
      await stack?.close();
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
      else process.env.ROUTEKIT_HOME = previousHome;
      rmSync(repo, { recursive: true, force: true });
    }
  }
);

test(
  "authenticated external routekit daemon CLI uses a Fusion-owned loopback bridge",
  { skip: SKIP },
  async () => {
    const sim = await startProviderSim();
    const repo = initializeRepository();
    const home = join(repo, "routekit-home");
    const configPath = join(home, ".config", "routekit", "router.yaml");
    mkdirSync(join(home, ".config", "routekit"), { recursive: true });
    await scriptFusedTurn(sim, {
      candidates: { "provider-model": "candidate through auth bridge" },
      judgeModel: "provider-model",
      answer: "fused through auth bridge"
    });
    writeFileSync(
      configPath,
      [
        "providers:",
        "  openai: {}",
        "defaultModel: openai/provider-model",
        ""
      ].join("\n")
    );
    const routerPort = await freePort();
    const routerUrl = `http://127.0.0.1:${routerPort}`;
    const routekitCli = join(repoRoot(), "packages", "routekit-cli", "dist", "index.js");
    const routekitEnv = {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: join(repo, ".routekit-state"),
      ROUTEKIT_NO_SUPERVISOR: "1",
      OPENAI_API_KEY: "test-provider-key",
      OPENAI_BASE_URL: `${sim.url}/v1`,
      PORTLESS: "0",
      ROUTEKIT_PORTLESS: "0",
      NO_COLOR: "1"
    };
    const routekitCommand = (args: readonly string[]): Record<string, unknown> =>
      JSON.parse(
        execFileSync(process.execPath, [routekitCli, ...args], {
          cwd: repo,
          env: routekitEnv,
          encoding: "utf8"
        })
      ) as Record<string, unknown>;
    let daemonPid: number | undefined;
    let stack: Awaited<ReturnType<typeof startFusionStack>> | undefined;
    let fusionClosed = false;
    try {
      const started = routekitCommand([
        "start",
        "--port",
        String(routerPort),
        "--auth-token",
        "external-router-secret",
        "--no-portless",
        "--json"
      ]);
      assert.equal(started.alreadyRunning, false);
      assert.equal(started.url, routerUrl);
      daemonPid = started.pid as number;
      const directReady = await fetch(`${routerUrl}/v1/models`, {
        headers: { authorization: "Bearer external-router-secret" }
      });
      assert.equal(directReady.status, 200);

      stack = await startFusionStack({
        repo,
        outputRoot: join(repo, "runs"),
        ensembles: [
          {
            name: "default",
            members: ["openai/provider-model"],
            judge: "openai/provider-model",
            synthesizer: "openai/provider-model",
            k: 1
          }
        ],
        router: {
          kind: "external",
          url: routerUrl,
          authToken: "external-router-secret"
        },
        fusionkitDir: process.cwd(),
        log: () => {}
      });
      const bridgeUrl = stack.routekitUrl;
      assert.notEqual(bridgeUrl, routerUrl);
      const bridged = await fetch(`${bridgeUrl}/v1/models`);
      const bridgedBody = await bridged.text();
      assert.equal(bridged.status, 200, bridgedBody);
      const fused = await fetch(`${stack.fusionUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fusion-panel",
          messages: [{ role: "user", content: "bridge this" }]
        })
      });
      assert.equal(fused.status, 200, await sim.describeJournal());
      assert.match(await fused.text(), /fused through auth bridge/);
      await stack.close();
      fusionClosed = true;
      await assert.rejects(fetch(`${bridgeUrl}/v1/models`));
      const unauthorized = await fetch(`${routerUrl}/v1/models`);
      assert.equal(unauthorized.status, 401);
      const external = await fetch(`${routerUrl}/v1/models`, {
        headers: { authorization: "Bearer external-router-secret" }
      });
      assert.equal(external.status, 200);
      assert.ok(daemonPid !== undefined);
      assert.doesNotThrow(
        () => process.kill(daemonPid!, 0),
        "Fusion close must not kill external RouteKit"
      );
      const stopped = routekitCommand(["stop", "--json"]);
      assert.equal(stopped.stopped, true);
      daemonPid = undefined;
    } finally {
      if (!fusionClosed) await stack?.close();
      if (daemonPid !== undefined) {
        try {
          process.kill(daemonPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await sim.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
);
