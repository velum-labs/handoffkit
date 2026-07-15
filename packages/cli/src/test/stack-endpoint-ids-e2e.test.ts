import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  scriptFusedTurn,
  stackToolingSkip,
  startProviderSim
} from "@fusionkit/testkit";
import { parseRouterConfig } from "@routekit/gateway";
import { startRouter } from "@routekit/router";

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
  "authenticated external RouteKit uses a Fusion-owned loopback bridge",
  { skip: SKIP },
  async () => {
    const sim = await startProviderSim();
    const repo = initializeRepository();
    const router = await startRouter({
      config: parseRouterConfig({
        endpoints: [
          {
            endpointId: "opaque",
            model: "provider-model",
            provider: "simulator",
            baseUrl: `${sim.url}/v1`,
            dialect: "openai"
          }
        ],
        defaultEndpointId: "opaque"
      }),
      host: "127.0.0.1",
      port: 0,
      authToken: "external-router-secret"
    });
    const stack = await startFusionStack({
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
        url: router.url,
        authToken: "external-router-secret"
      },
      log: () => {}
    });
    const bridgeUrl = stack.endpoints.opaque;
    try {
      assert.notEqual(bridgeUrl, router.url);
      const bridged = await fetch(`${bridgeUrl}/v1/models`);
      assert.equal(bridged.status, 200);
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
      await assert.rejects(fetch(`${bridgeUrl}/v1/models`));
      const unauthorized = await fetch(`${router.url}/v1/models`);
      assert.equal(unauthorized.status, 401);
      const external = await fetch(`${router.url}/v1/models`, {
        headers: { authorization: "Bearer external-router-secret" }
      });
      assert.equal(external.status, 200);
    } finally {
      await router.close();
      await sim.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
);
