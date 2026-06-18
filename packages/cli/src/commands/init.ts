import { join } from "node:path";

import type { Command } from "commander";

import { initHome } from "../config.js";
import { resolveDir } from "../shared/plane.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("initialize org keys, config, policy")
    .option("--port <n>", "plane port")
    .option("--host <host>", "plane bind host")
    .option("--plane-url <url>", "public plane URL for clients and runners")
    .action((opts: { port?: string; host?: string; planeUrl?: string }) => {
      const dir = resolveDir(program.opts().dir);
      const home = initHome(dir, {
        ...(opts.port ? { port: Number(opts.port) } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.planeUrl ? { planeUrl: opts.planeUrl } : {})
      });
      console.log(`initialized warrant home at ${home.dir}`);
      console.log(`plane url: ${home.config.planeUrl}`);
      console.log(`policy: ${join(home.dir, "policy.json")}`);
      console.log(`enroll token (for runners): ${home.config.enrollToken}`);
      console.log(`admin token (for the control panel): ${home.config.adminToken}`);
    });
}
