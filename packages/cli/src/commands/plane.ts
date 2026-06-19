import { join } from "node:path";

import type { Command } from "commander";

import { Plane, startPlaneServer } from "@fusionkit/plane";

import { loadHome, secretStoreFor } from "../config.js";
import { resolveDir } from "../shared/plane.js";
import { createPortlessSession } from "../shared/portless.js";

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
      // Register a stable portless name for the control panel (enabled unless
      // PORTLESS=0 or no proxy is detected; falls back to the loopback URL).
      const portless = await createPortlessSession({
        enabled: process.env.PORTLESS !== "0",
        log: (line) => console.error(line)
      });
      const baseUrl = portless.register("plane", started.port);
      console.log(`warrant plane listening on ${baseUrl}`);
      console.log(`control panel: ${baseUrl}/ui/`);
    });
}
