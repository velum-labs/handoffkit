/**
 * File contents baked into the demo template sandbox: a tiny JS repo with a
 * planted bug (so Codex has something real to fix), the fusion config, and the
 * PTY launch wrapper.
 */
import { DEMO_ENV_FILE, DEMO_FUSION_CONFIG, DEMO_REPO_DIR } from "./constants";

const STATS_JS = `/** Tiny numeric helpers for the fusionkit demo. */

function mean(values) {
  if (values.length === 0) throw new Error("mean of empty list");
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values) {
  if (values.length === 0) throw new Error("median of empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  // BUG: averages the wrong pair for even-length input.
  return (sorted[mid] + sorted[mid + 1]) / 2;
}

module.exports = { mean, median };
`;

const TEST_JS = `const assert = require("node:assert");
const { mean, median } = require("./stats");

assert.strictEqual(mean([1, 2, 3]), 2, "mean of [1,2,3]");
assert.strictEqual(median([5, 1, 3]), 3, "median of odd-length list");
assert.strictEqual(median([4, 1, 3, 2]), 2.5, "median of even-length list");
assert.strictEqual(median([10, 20]), 15, "median of a pair");

console.log("all tests passed");
`;

const README_MD = `# fusionkit demo repo

A tiny playground for the fusionkit landing-page demo. One of the helpers in
\`stats.js\` has a bug — run \`node test.js\` to see it, then ask the agent to fix it.
`;

export const DEMO_REPO_FILES = [
  { path: `${DEMO_REPO_DIR}/README.md`, content: README_MD },
  { path: `${DEMO_REPO_DIR}/stats.js`, content: STATS_JS },
  { path: `${DEMO_REPO_DIR}/test.js`, content: TEST_JS },
  {
    path: `${DEMO_REPO_DIR}/.fusionkit/fusion.json`,
    content: `${JSON.stringify(DEMO_FUSION_CONFIG, null, 2)}\n`
  }
] as const;

/**
 * The PTY session executes this wrapper: it loads the provider key (written
 * per-session by the API route, never sent to the browser), fixes up PATH for
 * uv, and hands the terminal to the real product command.
 */
export const DEMO_SHELL_SCRIPT = `#!/bin/bash
set -a
[ -f ${DEMO_ENV_FILE} ] && . ${DEMO_ENV_FILE}
set +a
export PATH="$HOME/.local/bin:$PATH"
cd ${DEMO_REPO_DIR} || exit 1
printf '\\033[1mfusionkit demo\\033[0m — this repo has a failing test (try: node test.js).\\n'
printf 'Ask codex to find and fix it; every answer is fused from a panel of open models.\\n\\n'
exec fusionkit codex --yes
`;
