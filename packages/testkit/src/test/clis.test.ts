import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claudeCodeEnv,
  codexExecConfigToml,
  openCodeInvocation
} from "../clis.js";

test("[claude] launch construction injects fusion-mini", () => {
  const env = claudeCodeEnv(
    { gatewayUrl: "http://127.0.0.1:9999", model: "fusion-mini" },
    { PATH: "/test/bin" }
  );

  assert.equal(env.PATH, "/test/bin");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999");
  assert.equal(env.ANTHROPIC_MODEL, "fusion-mini");
});

test("[codex] launch construction injects fusion-mini", () => {
  const config = codexExecConfigToml({
    gatewayUrl: "http://127.0.0.1:9999",
    model: "fusion-mini"
  });

  assert.match(config, /^model = "fusion-mini"$/m);
  assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:9999\/v1"$/m);
});

test("[opencode] launch construction injects fusion-mini", () => {
  const invocation = openCodeInvocation({
    gatewayUrl: "http://127.0.0.1:9999",
    model: "fusion-mini",
    prompt: "Use the selected model."
  });

  assert.deepEqual(invocation.args, [
    "run",
    "--model",
    "fusionkit-local/fusion-mini",
    "--format",
    "json",
    "--auto",
    "Use the selected model."
  ]);
  assert.match(JSON.stringify(invocation.config), /"models":\{"fusion-mini":\{"name":"fusion-mini"\}\}/);
});
