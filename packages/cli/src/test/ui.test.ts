import assert from "node:assert/strict";
import { test } from "node:test";

import { isInteractive } from "../ui/runtime.js";
import { bold, cyan, glyph, supportsColor } from "../ui/theme.js";

test("color helpers no-op and glyphs use ASCII when color is disabled", () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    assert.equal(supportsColor(), false);
    assert.equal(bold("hi"), "hi");
    assert.equal(cyan("hi"), "hi");
    assert.equal(glyph.tick(), "[ok]");
    assert.equal(glyph.cross(), "[x]");
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test("isInteractive is false under the test runner (no TTY)", () => {
  assert.equal(isInteractive(), false);
});
