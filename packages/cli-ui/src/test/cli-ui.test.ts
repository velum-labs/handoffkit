import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, relativeTime } from "../format.js";
import { PlainPresenter, renderKeyValueLines, renderTableLines } from "../plain.js";
import { isInteractive } from "../runtime.js";
import { bold, box, brandBanner, brandHeader, cyan, glyph, gradient, stripAnsi, supportsColor } from "../theme.js";

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

/** A PlainPresenter capturing its stderr lines for assertions. */
function capturingPresenter(): { presenter: PlainPresenter; lines: () => string[] } {
  let output = "";
  const stream = {
    write: (chunk: string) => {
      output += chunk;
      return true;
    }
  } as unknown as NodeJS.WriteStream;
  return {
    presenter: new PlainPresenter(stream),
    lines: () => output.split("\n").filter((line) => line.length > 0)
  };
}

test("color helpers no-op and glyphs use ASCII when color is disabled", () => {
  withNoColor(() => {
    assert.equal(supportsColor(), false);
    assert.equal(bold("hi"), "hi");
    assert.equal(cyan("hi"), "hi");
    assert.equal(glyph.tick(), "[ok]");
    assert.equal(glyph.cross(), "[x]");
  });
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

test("relativeTime buckets into s/m/h/d", () => {
  assert.equal(relativeTime(Date.now()), "0s ago");
  assert.equal(relativeTime(Date.now() - 90_000), "2m ago");
});

test("renderTableLines aligns columns against visible width", () => {
  withNoColor(() => {
    const lines = renderTableLines(
      [
        ["a", "bb"],
        ["ccc", "d"]
      ],
      { head: ["x", "y"] }
    );
    assert.deepEqual(lines, ["x    y", "a    bb", "ccc  d"]);
  });
});

test("renderKeyValueLines pads labels and appends tags", () => {
  withNoColor(() => {
    const lines = renderKeyValueLines([
      { label: "tool", value: "codex", tag: "(default)" },
      { label: "budget", value: "$5" }
    ]);
    assert.deepEqual(lines, ["  tool    codex (default)", "  budget  $5"]);
  });
});

test("plain presenter checklist prints one line per transition", () => {
  withNoColor(() => {
    const { presenter, lines } = capturingPresenter();
    const checklist = presenter.checklist([{ id: "a", label: "step a" }], { title: "boot" });
    checklist.setActive("a");
    checklist.setDone("a", "ok");
    checklist.stop();
    assert.deepEqual(lines(), ["boot", "> step a", "[ok] step a ok"]);
  });
});

test("plain presenter task settles to a status line", () => {
  withNoColor(() => {
    const { presenter, lines } = capturingPresenter();
    const task = presenter.task("working");
    task.succeed("done working");
    assert.deepEqual(lines(), ["> working", "[ok] done working"]);
  });
});

test("plain presenter progress prints milestones, not every update", () => {
  withNoColor(() => {
    const { presenter, lines } = capturingPresenter();
    const progress = presenter.progress("model");
    progress.update({ downloaded: 10, total: 100 });
    progress.update({ downloaded: 11, total: 100 });
    progress.update({ downloaded: 55, total: 100 });
    progress.succeed();
    const output = lines();
    assert.equal(output.filter((line) => line.includes("10%")).length, 1);
    assert.equal(output.filter((line) => line.includes("50%")).length, 1);
    assert.match(output[output.length - 1] ?? "", /\[ok\] model/);
  });
});

test("plain presenter status renders glyph, detail, and hint", () => {
  withNoColor(() => {
    const { presenter, lines } = capturingPresenter();
    presenter.status("fail", "uv / uvx", "not found", "install uv");
    assert.deepEqual(lines(), ["  [x] uv / uvx not found", "    > install uv"]);
  });
});
