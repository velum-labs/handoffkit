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
 *
 * `FUSIONKIT_CURSORKIT_SERVE_CLI` overrides the resolved `serveCli` entry. This
 * lets a custom build (or an integration test) point the bridge at an alternate
 * entrypoint; the harness CLI is still derived relative to it.
 */
export function resolveCursorkitCli(): CursorkitCli {
  const override = process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
  const serveCli =
    override !== undefined && override.length > 0
      ? override
      : require.resolve("@velum-labs/cursorkit");
  const harnessCli = join(dirname(serveCli), "testing", "cli.js");
  return { serveCli, harnessCli };
}
