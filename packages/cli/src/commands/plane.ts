import { join } from "node:path";

import type { Command } from "commander";

import { Plane, startPlaneServer } from "@fusionkit/plane";

import { loadHome, secretStoreFor } from "../config.js";
import { resolveDir } from "../shared/plane.js";

export function registerPlane(program: Command): void {
  const plane = program.command("plane").description("control plane + control panel");

  plane
    .command("start")
    .description("start the control plane + control panel")
    .option("--port <n>", "bind port")
    .option("--host <host>", "bind host")
    .action(async (opts: { port?: string; host?: string }) => {
      const dir = resolveDir(program.opts().dir);
      const home = loadHome(dir);
      const planeInstance = new Plane({
        dataDir: join(dir, "data"),
        policy: home.policy,
        planePrivateKeyPem: home.planePrivateKeyPem,
        planePublicKeyPem: home.planePublicKeyPem,
        adminToken: home.config.adminToken,
        enrollToken: home.config.enrollToken,
        secretStore: secretStoreFor(home)
      });
      const port = opts.port ? Number(opts.port) : home.config.port;
      const host = opts.host ?? home.config.host;
      const started = await startPlaneServer(planeInstance, { port, host });
      console.log(`warrant plane listening on http://${started.host}:${started.port}`);
      console.log(`control panel: http://${started.host}:${started.port}/ui/`);
    });
}
