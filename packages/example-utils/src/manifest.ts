/**
 * The examples manifest is the single source of demo metadata (id, title,
 * summary, interactive flag): `scripts/demo.mjs`, `test/demos.test.js`,
 * `scripts/check-repo.mjs`, and the banners the demos print all read the
 * same file, so the listing, the acceptance suite, and the narration can
 * never drift apart.
 */
import { readFileSync } from "node:fs";

import { banner } from "./narrate.js";

export type DemoInfo = {
  id: string;
  directory: string;
  title: string;
  summary: string;
  interactive: boolean;
  location?: "examples" | "legacy/examples";
};

const MANIFEST_URL = new URL("../../../examples/manifest.json", import.meta.url);

let cached: DemoInfo[] | undefined;

function demos(): DemoInfo[] {
  if (!cached) {
    const parsed = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as {
      demos: DemoInfo[];
    };
    cached = parsed.demos;
  }
  return cached;
}

/** Look up one demo's manifest entry by id (e.g. "01"). */
export function demoInfo(id: string): DemoInfo {
  const info = demos().find((demo) => demo.id === id);
  if (!info) throw new Error(`demo "${id}" is not in examples/manifest.json`);
  return info;
}

/** Print the standard demo banner from the manifest entry for `id`. */
export function demoBanner(id: string): void {
  const info = demoInfo(id);
  banner(info.id, info.title, info.summary);
}
