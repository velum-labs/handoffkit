#!/usr/bin/env node

import { assertCommittedFusionRouterAlignment } from "./lib/fusion-router-alignment.mjs";

try {
  assertCommittedFusionRouterAlignment();
  console.log("Fusion and RouteKit committed configs are aligned");
} catch (error) {
  console.error(
    `Fusion/RouteKit config alignment failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
}
