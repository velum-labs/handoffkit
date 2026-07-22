import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export type CursorkitCli = {
  serveCli: string;
  harnessCli: string;
};

export function resolveCursorkitCli(): CursorkitCli {
  const override = process.env.ROUTEKIT_CURSORKIT_SERVE_CLI;
  const serveCli =
    override !== undefined && override.length > 0
      ? override
      : require.resolve("@velum-labs/cursorkit");
  return { serveCli, harnessCli: join(dirname(serveCli), "testing", "cli.js") };
}
