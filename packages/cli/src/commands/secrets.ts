import type { Command } from "commander";

import { loadHome, secretStoreFor } from "../config.js";
import { resolveDir } from "../shared/plane.js";

export function registerSecrets(program: Command): void {
  const secrets = program.command("secrets").description("org secret store");

  secrets
    .command("set <name> <value>")
    .description("store a secret in the org store")
    .action((name: string, value: string) => {
      const home = loadHome(resolveDir(program.opts().dir));
      secretStoreFor(home).set(name, value);
      console.log(`secret "${name}" stored (value encrypted at rest)`);
    });

  secrets
    .command("list")
    .description("list stored secret names")
    .action(() => {
      const home = loadHome(resolveDir(program.opts().dir));
      const names = secretStoreFor(home).names();
      console.log(names.length > 0 ? names.join("\n") : "no secrets stored");
    });
}
