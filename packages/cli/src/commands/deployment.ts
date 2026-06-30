import type { Command } from "commander";

import { Plane, startPlaneServer } from "@fusionkit/plane";
import { Runner } from "@fusionkit/runner";

import { loadHome, secretStoreFor } from "../config.js";
import { resolveDir } from "../shared/plane.js";

type PlaneStartOpts = {
  dir?: string;
};

type RunnerStartOpts = {
  dataDir?: string;
  dir?: string;
  enrollToken?: string;
  plane?: string;
  pool?: string;
};

export function registerDeployment(program: Command): void {
  program
    .command("plane")
    .description("run the control plane")
    .command("start")
    .option("--dir <dir>", "plane home directory")
    .description("start the control plane HTTP server")
    .action(async (opts: PlaneStartOpts) => {
      const home = loadHome(resolveDir(opts.dir));
      const plane = new Plane({
        dataDir: home.dir,
        policy: home.policy,
        planePrivateKeyPem: home.planePrivateKeyPem,
        planePublicKeyPem: home.planePublicKeyPem,
        adminToken: home.config.adminToken,
        enrollToken: home.config.enrollToken,
        secretStore: secretStoreFor(home),
        startRetention: true
      });
      const server = await startPlaneServer(plane, {
        host: home.config.host,
        port: home.config.port
      });
      console.error(`plane listening on ${home.config.host}:${server.port}`);
      const stop = async (): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          server.server.close((error) => (error ? reject(error) : resolve()));
        });
        plane.close();
      };
      process.once("SIGTERM", () => {
        void stop().then(() => process.exit(0));
      });
      process.once("SIGINT", () => {
        void stop().then(() => process.exit(0));
      });
    });

  program
    .command("runner")
    .description("run an outbound worker")
    .command("start")
    .option("--dir <dir>", "plane home directory for enroll token lookup")
    .option("--data-dir <dir>", "runner data directory", "/data/runner")
    .option("--enroll-token <token>", "runner enrollment token")
    .option("--plane <url>", "plane URL")
    .option("--pool <pool>", "runner pool", "default")
    .description("start a runner claim loop")
    .action(async (opts: RunnerStartOpts) => {
      const home = loadHome(resolveDir(opts.dir));
      const runner = new Runner({
        planeUrl: opts.plane ?? home.config.planeUrl,
        pool: opts.pool ?? "default",
        dataDir: opts.dataDir ?? "/data/runner",
        enrollToken: opts.enrollToken ?? home.config.enrollToken
      });
      process.once("SIGTERM", () => runner.stop());
      process.once("SIGINT", () => runner.stop());
      await runner.start();
    });
}
