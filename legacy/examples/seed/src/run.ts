/**
 * Seed an external plane with showcase runs. Used by the Docker Compose
 * deployment so the control panel has real content on first boot.
 *
 *   node dist/run.js --dir /data/.warrant [--pool default]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { seedShowcase } from "./index.js";

type SeedConfig = {
  planeUrl: string;
  adminToken: string;
};

/** How patiently the seeder waits for the compose plane to come up. */
const PLANE_HEALTH_POLL_MS = 1_000;
const PLANE_WAIT_TIMEOUT_MS = 120_000;

async function waitForPlane(planeUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${planeUrl}/v1/health`);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // plane not up yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`plane at ${planeUrl} did not become healthy in ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, PLANE_HEALTH_POLL_MS));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      pool: { type: "string", default: "default" }
    }
  });
  if (!values.dir) throw new Error("--dir pointing at the warrant home is required");
  const config = JSON.parse(
    readFileSync(join(values.dir, "config.json"), "utf8")
  ) as SeedConfig;

  console.log(`waiting for plane at ${config.planeUrl}...`);
  await waitForPlane(config.planeUrl, PLANE_WAIT_TIMEOUT_MS);

  console.log("seeding showcase runs...");
  const seeded = await seedShowcase({
    planeUrl: config.planeUrl,
    adminToken: config.adminToken,
    pool: values.pool ?? "default"
  });
  for (const runId of seeded.runIds) console.log(`  ${runId}`);
  console.log("done. Open the control panel and sign in with the admin token:");
  console.log(`  ${config.planeUrl}/ui/`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
