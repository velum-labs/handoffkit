import assert from "node:assert/strict";
import { test } from "node:test";

import { isInteractive } from "../ui/runtime.js";
import { formatBytes } from "../ui/progress.js";
import { bold, box, brandBanner, brandHeader, cyan, glyph, gradient, stripAnsi, supportsColor } from "../ui/theme.js";

function withNoColor(work: () => void): void {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    work();
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
}

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

test("brandBanner degrades to the one-line header without color", () => {
  withNoColor(() => {
    assert.equal(brandBanner("subtitle"), brandHeader("subtitle"));
  });
});

test("stripAnsi removes styling escapes", () => {
  assert.equal(stripAnsi("\u001b[1m\u001b[36mhi\u001b[39m\u001b[22m"), "hi");
});

test("gradient returns the text unchanged without truecolor", () => {
  withNoColor(() => {
    assert.equal(gradient("fusionkit"), "fusionkit");
  });
});

test("box frames a titled block, aligned to the widest line", () => {
  withNoColor(() => {
    const out = box("t", ["aa", "bbbb"]);
    const lines = out.split("\n");
    assert.equal(lines.length, 4, "top + two body lines + bottom");
    const widths = lines.map((line) => stripAnsi(line).length);
    assert.ok(
      widths.every((width) => width === widths[0]),
      `frame lines should share a width, got ${widths.join(",")}`
    );
    assert.match(out, /bbbb/);
  });
});

test("formatBytes uses binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5 GB");
});
