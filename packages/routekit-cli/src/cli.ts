import { contextFor, readPackageVersion } from "@velum-labs/routekit-cli-core";
import { Command } from "commander";

import { registerCommands } from "./commands/index.js";

export function routekitVersion(): string {
  return readPackageVersion(import.meta.url);
}

export function buildProgram(): Command {
  const version = routekitVersion();
  const program = new Command()
    .name("routekit")
    .description("configure and run model routes for coding tools")
    .version(`@velum-labs/routekit ${version}`, "-v, --version", "print the RouteKit CLI version")
    .enablePositionalOptions();
  registerCommands(program);
  program.addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  routekit accounts login codex --name work",
      "  routekit start",
      "  routekit status --watch",
      "  routekit stop",
      "  routekit usage --watch 10",
      "  routekit models list --provider openai"
    ].join("\n")
  );
  program
    .command("version")
    .description("show the RouteKit CLI version")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      if (ctx.json) ctx.emit({ package: "@velum-labs/routekit", version });
      else process.stdout.write(`@velum-labs/routekit ${version}\n`);
    });
  return program;
}
