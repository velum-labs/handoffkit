// Shared changelog logic for the release coordinator (scripts/release.mjs) and
// the docs changelog page generator (scripts/sync-docs-changelog.mjs).
//
// The changelog format is the conventional one used in CHANGELOG.md:
//
//   # Changelog
//
//   <preamble paragraph(s)>
//
//   ## Unreleased
//
//   - notes accumulated between releases
//
//   ## X.Y.Z - YYYY-MM-DD
//   ...

const UNRELEASED_HEADING = "## Unreleased";

const FALLBACK_NOTE = "- Release cut via the cross-repo coordinator (`scripts/release.mjs`).";

// Split a changelog into { intro, sections } where intro is everything before
// the first `## ` heading and each section is { heading, body } (body keeps
// its trailing newlines).
function parseSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let intro = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      current = { heading: line, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  return {
    intro: intro.join("\n"),
    sections: sections.map((s) => ({ heading: s.heading, body: s.body.join("\n") }))
  };
}

function renderSections(intro, sections) {
  const parts = [intro.trim()];
  for (const section of sections) {
    const body = section.body.trim();
    parts.push(body ? `${section.heading}\n\n${body}` : section.heading);
  }
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function sectionVersion(heading) {
  const m = heading.match(/^##\s+(\S+)/);
  return m ? m[1] : null;
}

// Return the trimmed body of the `## <version>` section, or null when absent.
export function extractNotes(text, version) {
  const { sections } = parseSections(text);
  const section = sections.find((s) => sectionVersion(s.heading) === version);
  if (!section) return null;
  const body = section.body.trim();
  return body || null;
}

// Promote the `## Unreleased` section into a `## <version> - <date>` release
// section, leaving a fresh empty Unreleased section on top. Returns the new
// changelog text plus the release notes for that version.
//
// Cases handled:
// - `## <version>` already exists: no-op (idempotent apply re-runs).
// - Unreleased has content: it becomes the release section verbatim.
// - Unreleased missing or empty: a fallback entry is inserted so the release
//   always has a section.
export function promoteUnreleased(text, version, date) {
  if (!text || !text.trim()) {
    text = "# Changelog\n";
  }
  const existing = extractNotes(text, version);
  if (existing !== null) {
    return { text, notes: existing, promoted: false };
  }

  const { intro, sections } = parseSections(text);
  const heading = `## ${version} - ${date}`;
  const unreleasedIdx = sections.findIndex((s) => sectionVersion(s.heading) === "Unreleased");
  const unreleasedBody = unreleasedIdx === -1 ? "" : sections[unreleasedIdx].body.trim();

  const notes = unreleasedBody || FALLBACK_NOTE;
  const release = { heading, body: notes };
  const unreleased = { heading: UNRELEASED_HEADING, body: "" };

  let next;
  if (unreleasedIdx === -1) {
    next = [unreleased, release, ...sections];
  } else {
    next = [...sections];
    next.splice(unreleasedIdx, 1, unreleased, release);
  }
  return {
    text: renderSections(intro, next),
    notes,
    promoted: Boolean(unreleasedBody)
  };
}

// Escape `<` and `{` outside code fences and inline code spans so the markdown
// changelog can be embedded in an MDX page without being parsed as JSX.
function escapeForMdx(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // Split on inline code spans; escape only the non-code segments.
    out.push(
      line
        .split(/(`[^`]*`)/)
        .map((seg) => (seg.startsWith("`") ? seg : seg.replace(/</g, "\\<").replace(/\{/g, "\\{")))
        .join("")
    );
  }
  return out.join("\n");
}

// Render the changelog markdown as a Fumadocs MDX page. The `# Changelog` H1
// is dropped (the frontmatter title renders it) and JSX-significant characters
// are escaped outside code.
export function changelogToDocsMdx(text) {
  const body = escapeForMdx(text.replace(/^# Changelog\s*\n/, "").trim());
  return [
    "---",
    "title: Changelog",
    "description: Release notes for the FusionKit packages.",
    "---",
    "",
    "{/* Generated from CHANGELOG.md by scripts/sync-docs-changelog.mjs. Do not edit by hand. */}",
    "",
    body,
    ""
  ].join("\n");
}
