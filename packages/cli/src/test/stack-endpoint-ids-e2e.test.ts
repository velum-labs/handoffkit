import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  freePort,
  repoRoot,
  scriptFusedTurn,
  spawnCaptured,
  stackToolingSkip,
  startProviderSim
} from "@fusionkit/testkit";
import { parseRouterConfig } from "@routekit/gateway";

import { startFusionStack } from "../fusion/stack.js";

const SKIP = stackToolingSkip();

function initializeRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "fusionkit-endpoint-e2e-"));
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
  "embedded RouteKit routes opaque endpoint ids through the full fusion stack",
  { skip: SKIP },
  async () => {
    const sim = await startProviderSim();
    const repo = initializeRepository();
    const routerConfig = parseRouterConfig({
      endpoints: [
        {
          endpointId: "fast",
          model: "provider-fast",
          provider: "simulator",
          baseUrl: `${sim.url}/v1`,
          dialect: "openai"
        },
        {
          endpointId: "deep",
          model: "provider-deep",
          provider: "simulator",
          baseUrl: `${sim.url}/v1`,
          dialect: "openai"
        }
      ],
      defaultEndpointId: "fast"
    });
    const stack = await startFusionStack({
      repo,
      outputRoot: join(repo, "runs"),
      ensembles: [
        {
          name: "default",
          members: ["fast"],
          judge: "deep",
          synthesizer: "deep",
          k: 1
        }
      ],
      router: { kind: "embedded", config: routerConfig },
      fusionkitDir: process.cwd(),
      log: () => {}
    });
    const routekitUrl = stack.endpoints.fast;
    try {
      await scriptFusedTurn(sim, {
        candidates: { "provider-fast": "candidate from opaque fast" },
        judgeModel: "provider-deep",
        answer: "fused through opaque endpoint ids"
      });
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
        /fused through opaque endpoint ids/
      );
      assert.deepEqual(
        (await sim.journal()).map((entry) => entry.model),
        ["provider-fast", "provider-deep", "provider-deep"]
      );
    } finally {
      await stack.close();
      await sim.close();
      rmSync(repo, { recursive: true, force: true });
    }
    await assert.rejects(fetch(`${routekitUrl}/v1/models`));
  }
);

test(
  "authenticated external routekit serve CLI uses a Fusion-owned loopback bridge",
  { skip: SKIP },
  async () => {
    const sim = await startProviderSim();
    const repo = initializeRepository();
    const configPath = join(repo, "routekit.yaml");
    writeFileSync(
      configPath,
      [
        "endpoints:",
        "  - endpointId: opaque",
        "    model: provider-model",
        "    provider: simulator",
        `    baseUrl: ${sim.url}/v1`,
        "    dialect: openai",
        "defaultEndpointId: opaque",
        ""
      ].join("\n")
    );
    const routerPort = await freePort();
    const routerUrl = `http://127.0.0.1:${routerPort}`;
    const routekit = spawnCaptured({
      command: process.execPath,
      args: [
        join(repoRoot(), "packages", "routekit-cli", "dist", "index.js"),
        "--config",
        configPath,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(routerPort),
        "--auth-token",
        "external-router-secret",
        "--no-portless",
        "--json"
      ],
      cwd: repo,
      env: {
        ...process.env,
        ROUTEKIT_HOME: join(repo, ".routekit-state"),
        PORTLESS: "0",
        NO_COLOR: "1"
      }
    });
    let stack: Awaited<ReturnType<typeof startFusionStack>> | undefined;
    let fusionClosed = false;
    try {
      await routekit.nextLine(/"authenticated": true/, 10_000);
      const ready = JSON.parse(routekit.log()) as {
        url?: string;
        authenticated?: boolean;
      };
      assert.equal(ready.authenticated, true);
      assert.equal(ready.url, routerUrl);
      const directReady = await fetch(`${routerUrl}/v1/models`, {
        headers: { authorization: "Bearer external-router-secret" }
      });
      assert.equal(directReady.status, 200, routekit.log());

      stack = await startFusionStack({
        repo,
        outputRoot: join(repo, "runs"),
        ensembles: [
          {
            name: "default",
            members: ["opaque"],
            judge: "opaque",
            synthesizer: "opaque",
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
      const bridgeUrl = stack.endpoints.opaque;
      assert.notEqual(bridgeUrl, routerUrl);
      const bridged = await fetch(`${bridgeUrl}/v1/models`);
      const bridgedBody = await bridged.text();
      assert.equal(bridged.status, 200, bridgedBody);
      await scriptFusedTurn(sim, {
        candidates: { "provider-model": "candidate through auth bridge" },
        judgeModel: "provider-model",
        answer: "fused through auth bridge"
      });
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
      assert.equal(routekit.child.exitCode, null, "Fusion close must not kill external RouteKit");
    } finally {
      if (!fusionClosed) await stack?.close();
      await routekit.close();
      await sim.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
);
