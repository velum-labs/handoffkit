import type { Command } from "commander";

import { Plane, startPlaneServer } from "@fusionkit/plane";
import { Runner } from "@fusionkit/runner";
import { PlaneClient } from "@fusionkit/sdk";

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
    .command("ui")
    .option("--dir <dir>", "plane home directory")
    .description("print the control-panel login token")
    .action((opts: { dir?: string }) => {
      const home = loadHome(resolveDir(opts.dir));
      console.log(`login token ${home.config.adminToken}`);
      console.log(`url ${home.config.planeUrl}/ui/`);
    });

  program
    .command("runs")
    .option("--dir <dir>", "plane home directory")
    .description("list runs from the configured plane")
    .action(async (opts: { dir?: string }) => {
      const home = loadHome(resolveDir(opts.dir));
      const client = new PlaneClient(home.config.planeUrl, home.config.adminToken);
      const result = await client.listRuns();
      for (const run of result.runs) {
        console.log(`${run.runId}\t${run.status}\t${run.agentKind}\t${run.pool}`);
      }
      if (result.runs.length === 0) console.log("no runs");
    });

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
