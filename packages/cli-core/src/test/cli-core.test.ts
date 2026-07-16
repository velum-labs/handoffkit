import assert from "node:assert/strict";
import test from "node:test";

import {
  findFlagTypos,
  formatPackageVersion,
  parseIdValue,
  parsePositiveInteger
} from "../index.js";

test("shared option and flag mechanics are deterministic", () => {
  assert.deepEqual(parseIdValue("--model", "writer=openai:gpt"), {
    id: "writer",
    value: "openai:gpt"
  });
  assert.equal(parsePositiveInteger("--count", "3"), 3);
  assert.deepEqual(findFlagTypos(["--budget"], ["--buget"]), [
    { given: "--buget", suggestion: "--budget" }
  ]);
  assert.equal(formatPackageVersion("@routekit/example", "1.2.3"), "@routekit/example@1.2.3");
});
