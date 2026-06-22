import { NextResponse } from "next/server";

import { FusionConfigError, loadRoutingConfigFromCwd } from "@/lib/routing/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the parsed `FusionRoutingConfig` from `.fusionkit/fusion.json` for the
 * resolved repo root (`SCOPE_REPO_ROOT` or walk-up from cwd).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const loaded = loadRoutingConfigFromCwd();
    if (loaded === undefined) {
      return NextResponse.json(
        {
          error: "no fusion.json found",
          hint: "Add .fusionkit/fusion.json at your repo root or set SCOPE_REPO_ROOT"
        },
        { status: 404 }
      );
    }

    if (loaded.routing === undefined) {
      return NextResponse.json({
        repoRoot: loaded.repoRoot,
        configPath: loaded.configPath,
        routing: null,
        error: "fusion.json has no routing section"
      });
    }

    return NextResponse.json({
      repoRoot: loaded.repoRoot,
      configPath: loaded.configPath,
      routing: loaded.routing
    });
  } catch (error) {
    if (error instanceof FusionConfigError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
