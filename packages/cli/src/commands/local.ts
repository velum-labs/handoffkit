import type { Command } from "commander";

import { LOCAL_TOOLS, runLocal } from "../local.js";
import type { LocalTool } from "../local.js";
import { fail } from "../shared/errors.js";

export function registerLocal(program: Command): void {
  program
    .command("local")
    .description("back a vendor agent with a local model")
    .argument("[tool]", `${LOCAL_TOOLS.join(" | ")}`)
    .argument("[args...]", "arguments forwarded to the tool")
    .option("--public-url <url>", "public tunnel URL for Cursor (or FUSIONKIT_PUBLIC_URL)")
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
        opts: { publicUrl?: string; authToken?: string }
      ) => {
        if (tool === undefined || !(LOCAL_TOOLS as readonly string[]).includes(tool)) {
          fail(`usage: fusionkit local <${LOCAL_TOOLS.join(" | ")}> [args...]`);
        }
        const options: { publicUrl?: string; authToken?: string } = {
          ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
          ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {})
        };
        const code = await runLocal(tool as LocalTool, args, options);
        process.exit(code);
      }
    );
}
