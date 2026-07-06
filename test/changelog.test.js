import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { changelogToDocsMdx, extractNotes, promoteUnreleased } from "../scripts/lib/changelog.mjs";

const SAMPLE = `# Changelog

Release notes for the FusionKit monorepo.

## Unreleased

- Added OpenTelemetry tracing end to end.
- Rewrote the scope dashboard as an OTLP span store.

## 0.8.0 - 2026-06-29

- Added failover and durable sessions.
`;

test("promoteUnreleased promotes accumulated notes into the release section", () => {
  const { text, notes, promoted } = promoteUnreleased(SAMPLE, "0.9.0", "2026-07-06");
  assert.equal(promoted, true);
  assert.equal(
    notes,
    "- Added OpenTelemetry tracing end to end.\n- Rewrote the scope dashboard as an OTLP span store."
  );
  assert.match(text, /## Unreleased\n\n## 0\.9\.0 - 2026-07-06\n\n- Added OpenTelemetry tracing end to end\./);
  // The prior release section is preserved below the new one.
  assert.ok(text.indexOf("## 0.9.0") < text.indexOf("## 0.8.0"));
  // A fresh, empty Unreleased section sits on top.
  assert.equal(extractNotes(text, "Unreleased"), null);
});

test("promoteUnreleased is idempotent when the version section already exists", () => {
  const first = promoteUnreleased(SAMPLE, "0.9.0", "2026-07-06");
  const second = promoteUnreleased(first.text, "0.9.0", "2026-07-07");
  assert.equal(second.promoted, false);
  assert.equal(second.text, first.text);
  assert.equal(second.notes, first.notes);
});

test("promoteUnreleased falls back to a stub entry when Unreleased is empty", () => {
  const empty = "# Changelog\n\nPreamble.\n\n## Unreleased\n\n## 0.8.0 - 2026-06-29\n\n- Old.\n";
  const { text, notes, promoted } = promoteUnreleased(empty, "0.9.0", "2026-07-06");
  assert.equal(promoted, false);
  assert.match(notes, /Release cut via the cross-repo coordinator/);
  assert.match(text, /## 0\.9\.0 - 2026-07-06/);
  assert.match(text, /## Unreleased/);
});

test("promoteUnreleased handles a changelog without an Unreleased section", () => {
  const noUnreleased = "# Changelog\n\n## 0.8.0 - 2026-06-29\n\n- Old.\n";
  const { text } = promoteUnreleased(noUnreleased, "0.9.0", "2026-07-06");
  assert.ok(text.indexOf("## Unreleased") < text.indexOf("## 0.9.0"));
  assert.ok(text.indexOf("## 0.9.0") < text.indexOf("## 0.8.0"));
});

test("extractNotes returns the section body for a version", () => {
  assert.equal(extractNotes(SAMPLE, "0.8.0"), "- Added failover and durable sessions.");
  assert.equal(extractNotes(SAMPLE, "9.9.9"), null);
});

test("changelogToDocsMdx emits frontmatter and escapes JSX-significant characters", () => {
  const mdx = changelogToDocsMdx(
    "# Changelog\n\n## Unreleased\n\n- Typed Promise<void> and {braces}, plus `Promise<void>` in code.\n\n```ts\nconst x: Promise<void> = run({});\n```\n"
  );
  assert.match(mdx, /^---\ntitle: Changelog\n/);
  assert.ok(!/^# Changelog/m.test(mdx), "H1 must be dropped (frontmatter title renders it)");
  assert.match(mdx, /Promise\\<void> and \\\{braces\}/);
  // Inline code spans and fenced blocks are left untouched.
  assert.match(mdx, /`Promise<void>`/);
  assert.match(mdx, /const x: Promise<void> = run\(\{\}\);/);
});

test("changelogToDocsMdx escapes backslashes so pre-escaped input cannot bypass escaping", () => {
  const mdx = changelogToDocsMdx("# Changelog\n\n## Unreleased\n\n- A literal \\< sequence and a C:\\path outside code, `\\<` inside code.\n");
  // `\<` in the source becomes `\\\<` (escaped backslash + escaped `<`): no
  // raw `<` survives outside code, so MDX can never parse it as JSX.
  assert.match(mdx, /A literal \\\\\\< sequence/);
  assert.match(mdx, /C:\\\\path/);
  // Inline code is untouched.
  assert.match(mdx, /`\\<` inside code/);
});

test("the committed docs changelog page is in sync with CHANGELOG.md", () => {
  const result = spawnSync(process.execPath, ["scripts/sync-docs-changelog.mjs", "--check"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});
