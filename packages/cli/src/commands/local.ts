import type { Command } from "commander";

import { LOCAL_TOOLS, runLocal } from "../local.js";
import type { LocalTool } from "../local.js";
import { contextFor } from "../shared/context.js";
import { fail } from "../shared/errors.js";

export function registerLocal(program: Command): void {
  program
    .command("local")
    .description(
      "back a vendor agent with a single local MLX model (no fusion); for a fused local panel use `fusionkit codex --local`"
    )
    .argument("[tool]", `${LOCAL_TOOLS.join(" | ")}`)
    .argument("[args...]", "arguments forwarded to the tool")
    .option("--public-url <url>", "public tunnel URL for Cursor (or FUSIONKIT_PUBLIC_URL)")
    .option("--ide", "Cursor only: wire the Cursor IDE to the gateway (local desktop proxy, no tunnel)")
    .option("--auth-token <token>", "require a bearer token on the gateway")
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText(
      "after",
      "\nfusionkit's own flags must precede the tool name; everything after the tool is forwarded to it."
    )
    .action(
      async (
        tool: string | undefined,
        args: string[],
        opts: { publicUrl?: string; authToken?: string; ide?: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        if (tool === undefined || !(LOCAL_TOOLS as readonly string[]).includes(tool)) {
          fail(`usage: fusionkit local <${LOCAL_TOOLS.join(" | ")}> [args...]`);
        }
        // Setup progress rides the presenter so --quiet silences it; the
        // launched agent itself owns the terminal from here.
        const code = await runLocal(tool as LocalTool, args, {
          log: (line) => ctx.presenter.note(line),
          ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
          ...(opts.ide === true ? { ide: true } : {}),
          ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {})
        });
        process.exitCode = code;
      }
    );
}
