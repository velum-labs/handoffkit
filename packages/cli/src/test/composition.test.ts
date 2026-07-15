import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "yaml";

import { buildProgram } from "../cli.js";
import {
  fusionAgentProfiles,
  fusionToolLaunchSpec
} from "../fusion-quickstart.js";
import {
  sidecarConfigYaml,
  sidecarEnvironment
} from "../fusion/stack.js";

const ensembles = [
  {
    name: "default",
    members: ["fast", "deep"],
    judge: "deep",
    synthesizer: "deep"
  }
];

function credentialFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(credentialFieldNames);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, nested]) => [
    ...(/(?:api[_-]?key|auth|credential|secret|(?:^|[_-])token(?:$|[_-]))/i.test(name)
      ? [name]
      : []),
    ...credentialFieldNames(nested)
  ]);
}

test("Fusion CLI contains only fusion product launch surfaces", () => {
  const names = buildProgram().commands.map((command) => command.name());
  for (const expected of [
    "codex",
    "claude",
    "cursor",
    "opencode",
    "serve",
    "init",
    "config",
    "ensemble",
    "prompts",
    "sessions",
    "setup",
    "doctor",
    "models",
    "telemetry",
    "completion",
    "version",
    "stop"
  ]) {
    assert.ok(names.includes(expected), expected);
  }
  for (const removed of ["proxy", "install", "uninstall", "accounts"]) {
    assert.ok(!names.includes(removed), removed);
  }
  for (const command of buildProgram().commands) {
    assert.ok(!command.options.some((option) => option.long === "--direct"));
  }
});

test("all launchers receive one neutral ToolLaunchSpec", () => {
  const profiles = fusionAgentProfiles(ensembles);
  const spec = fusionToolLaunchSpec({
    gatewayUrl: "http://127.0.0.1:9000",
    defaultEnsemble: "default",
    ensembles,
    args: ["--help"],
    cwd: "/tmp/repo"
  });
  assert.deepEqual(spec.agentProfiles, profiles);
  assert.equal(spec.defaultModel, "fusion-panel");
  assert.deepEqual(spec.models.map((model) => model.id), ["fusion-panel"]);
});

test("Python sidecar receives RouteKit endpoint ids without provider credentials", () => {
  const secret = "external-router-secret-value";
  const yaml = sidecarConfigYaml({
    endpointIds: ["fast", "deep"],
    routekitUrl: "http://127.0.0.1:8787/v1",
    judge: "deep"
  });
  const document = parse(
    yaml
  ) as { endpoints: Array<Record<string, unknown>> };
  assert.deepEqual(credentialFieldNames(document), []);
  assert.doesNotMatch(yaml, new RegExp(secret));
  assert.deepEqual(
    document.endpoints.map((endpoint) => endpoint.model),
    ["fast", "deep"]
  );
  for (const endpoint of document.endpoints) {
    assert.equal(endpoint.base_url, "http://127.0.0.1:8787");
    assert.equal(endpoint.api_key, undefined);
    assert.equal(endpoint.api_key_env, undefined);
  }
});

test("Python sidecar environment excludes router and provider credentials", () => {
  const secret = "external-router-secret-value";
  const env = sidecarEnvironment({
    PATH: "/usr/bin",
    ROUTEKIT_EXTERNAL_TOKEN: secret,
    OPENAI_API_KEY: "provider-openai-secret",
    ANTHROPIC_API_KEY: "provider-anthropic-secret",
    RANDOM_CREDENTIAL: "other-secret"
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.deepEqual(
    Object.keys(env).filter((name) => /(?:key|auth|credential|secret|token)/i.test(name)),
    []
  );
  assert.ok(!Object.values(env).includes(secret));
  assert.ok(!Object.values(env).some((value) => value.includes("provider-")));
});
