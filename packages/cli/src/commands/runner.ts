import { resolve } from "node:path";

import type { Command } from "commander";

import { Runner } from "@warrant/runner";

import { loadHome } from "../config.js";
import { resolveDir } from "../shared/plane.js";

export function registerRunner(program: Command): void {
  const runner = program.command("runner").description("outbound-only execution runner");

  runner
    .command("start")
    .description("start an outbound-only runner")
    .option("--pool <pool>", "runner pool", "default")
    .option("--plane <url>", "plane URL")
    .option("--enroll-token <token>", "enrollment token")
    .option("--data-dir <dir>", "runner data directory")
    .action(
      async (opts: { pool: string; plane?: string; enrollToken?: string; dataDir?: string }) => {
        const dir = resolveDir(program.opts().dir);
        let planeUrl = opts.plane;
        let enrollToken = opts.enrollToken;
        if (!planeUrl || !enrollToken) {
          const home = loadHome(dir);
          planeUrl = planeUrl ?? home.config.planeUrl;
          enrollToken = enrollToken ?? home.config.enrollToken;
        }
        const instance = new Runner({
          planeUrl,
          pool: opts.pool,
          dataDir: resolve(opts.dataDir ?? ".warrant-runner"),
          enrollToken
        });
        const identity = await instance.ensureEnrolled();
        console.log(
          `runner ${identity.runnerId} polling pool "${identity.pool}" (outbound-only)`
        );
        await instance.start();
      }
    );
}
