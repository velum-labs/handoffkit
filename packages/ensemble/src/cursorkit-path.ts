import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export type CursorkitCli = {
  /** Absolute path to the bridge entrypoint (`cursorkit serve`). */
  serveCli: string;
  /** Absolute path to the bundled test-harness CLI (suite probes). */
  harnessCli: string;
};

/**
 * Resolve the bundled `@velum-labs/cursorkit` CLIs from node_modules. The
 * package exports `"."` -> `dist/src/cli.js`; the harness CLI lives next to it
 * at `dist/src/testing/cli.js` (not exposed via the exports map, so it is
 * derived from the resolved `"."` entry rather than resolved directly).
 */
export function resolveCursorkitCli(): CursorkitCli {
  const serveCli = require.resolve("@velum-labs/cursorkit");
  const harnessCli = join(dirname(serveCli), "testing", "cli.js");
  return { serveCli, harnessCli };
}
