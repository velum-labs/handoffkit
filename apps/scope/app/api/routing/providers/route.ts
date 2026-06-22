import { NextResponse } from "next/server";

import { FusionConfigError, loadRoutingConfigFromCwd } from "@/lib/routing/config";
import { resolveProviderStatus } from "@/lib/routing/providers";
import type { ProviderStatus } from "@/lib/routing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return provider status rows (kind, baseUrl, key env presence, connectivity ping)
 * for every entry in the loaded routing config.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const skipPing = url.searchParams.get("ping") === "0";

  try {
    const loaded = loadRoutingConfigFromCwd();
    if (loaded === undefined) {
      return NextResponse.json({ error: "no fusion.json found" }, { status: 404 });
    }
    if (loaded.routing === undefined) {
      return NextResponse.json({ error: "no routing section in fusion.json" }, { status: 404 });
    }

    const providers: ProviderStatus[] = await Promise.all(
      loaded.routing.providers.map((spec) =>
        resolveProviderStatus(spec, { ping: !skipPing })
      )
    );

    return NextResponse.json({ repoRoot: loaded.repoRoot, providers });
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
