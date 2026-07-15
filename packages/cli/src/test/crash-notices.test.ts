import assert from "node:assert/strict";
import { test } from "node:test";

import { describeServerCrash } from "../fusion/stack.js";

test("SIGKILL produces an actionable managed-process OOM notice", () => {
  const notice = describeServerCrash({
    label: "Fusion synthesis sidecar",
    exitCode: null,
    signal: "SIGKILL"
  });
  assert.match(notice, /Fusion synthesis sidecar/);
  assert.match(notice, /killed by SIGKILL/);
  assert.match(notice, /out of memory/i);
  assert.match(notice, /fusionkit models/);
  assert.match(notice, /restarts on the next turn/);
});

test("ordinary nonzero exits are not mislabeled as OOM", () => {
  const notice = describeServerCrash({
    label: "embedded RouteKit router",
    exitCode: 1,
    signal: null
  });
  assert.match(notice, /exited with code 1/);
  assert.doesNotMatch(notice, /out of memory/i);
});

test("crash consequences and log paths remain visible", () => {
  const notice = describeServerCrash({
    label: "Fusion synthesis sidecar",
    exitCode: null,
    signal: "SIGKILL",
    consequence: "fused turns fail until FusionKit restarts",
    logPath: "/tmp/fusionkit/synthesis-sidecar.log"
  });
  assert.match(notice, /fused turns fail until FusionKit restarts/);
  assert.match(notice, /synthesis-sidecar\.log/);
});
