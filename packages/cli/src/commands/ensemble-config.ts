import type { Command } from "commander";

import type { EnsembleConfig } from "@fusionkit/config";
import { fusionModelId } from "@fusionkit/registry";
import { contextFor, fail } from "@routekit/cli-core";
import type { CommandContext } from "@routekit/cli-core";

import {
  FusionConfigError,
  fusionConfigPath,
  validateEnsembleName
} from "../fusion-config.js";
import {
  loadConfigOrFail,
  persistedShape,
  repoRootFor,
  shapeEnsembles,
  validateAndWrite
} from "../fusion/config-store.js";
import { collect } from "../shared/options.js";

type EnsembleOptions = {
  repo?: string;
  json?: boolean;
  member?: string[];
  judge?: string;
  synthesizer?: string;
  yes?: boolean;
};

function validateName(name: string, action: string): void {
  try {
    validateEnsembleName(name, action);
  } catch (error) {
    fail(error instanceof FusionConfigError ? error.message : String(error));
  }
}

function list(options: EnsembleOptions, context: CommandContext): number {
  const { root } = repoRootFor(options);
  const config = loadConfigOrFail(root, context.presenter);
  const entries = Object.entries(config?.ensembles ?? {}).map(
    ([name, ensemble]) => ({
      name,
      modelId: fusionModelId(name),
      default: name === config?.defaultEnsemble,
      ...ensemble
    })
  );
  if (context.json) context.emit({ ensembles: entries });
  else process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  return 0;
}

function ensembleFromOptions(
  options: EnsembleOptions,
  current?: EnsembleConfig
): EnsembleConfig {
  const members = options.member ?? current?.members;
  const judge = options.judge ?? current?.judge ?? members?.[0];
  if (members === undefined || members.length === 0 || judge === undefined) {
    fail(
      "an ensemble needs --member <provider/model> (repeatable) and --judge <provider/model>"
    );
  }
  return {
    members,
    judge,
    ...(options.synthesizer !== undefined
      ? { synthesizer: options.synthesizer }
      : current?.synthesizer !== undefined
        ? { synthesizer: current.synthesizer }
        : {}),
    ...(current?.k !== undefined ? { k: current.k } : {})
  };
}

function add(
  name: string,
  options: EnsembleOptions,
  context: CommandContext
): number {
  validateName(name, "ensemble add");
  const { root, inRepo } = repoRootFor(options);
  if (!inRepo) fail("not inside a git repository");
  const shape = persistedShape(loadConfigOrFail(root, context.presenter));
  const ensembles = shapeEnsembles(shape);
  if (ensembles[name] !== undefined) fail(`ensemble "${name}" already exists`);
  ensembles[name] = ensembleFromOptions(options);
  validateAndWrite(root, shape);
  if (context.json) context.emit({ added: name });
  else context.presenter.success(`added ${name} (${fusionModelId(name)})`);
  return 0;
}

function edit(
  name: string,
  options: EnsembleOptions,
  context: CommandContext
): number {
  const { root } = repoRootFor(options);
  const shape = persistedShape(loadConfigOrFail(root, context.presenter));
  const ensembles = shapeEnsembles(shape);
  const current = ensembles[name];
  if (current === undefined) fail(`unknown ensemble "${name}"`);
  ensembles[name] = ensembleFromOptions(options, current);
  validateAndWrite(root, shape);
  if (context.json) context.emit({ edited: name });
  else context.presenter.success(`updated ${name}`);
  return 0;
}

function remove(
  name: string,
  options: EnsembleOptions,
  context: CommandContext
): number {
  const { root } = repoRootFor(options);
  const shape = persistedShape(loadConfigOrFail(root, context.presenter));
  const ensembles = shapeEnsembles(shape);
  if (ensembles[name] === undefined) fail(`unknown ensemble "${name}"`);
  if (Object.keys(ensembles).length === 1) {
    fail("FusionKit config must keep at least one ensemble");
  }
  delete ensembles[name];
  if (shape.defaultEnsemble === name) delete shape.defaultEnsemble;
  validateAndWrite(root, shape);
  if (context.json) context.emit({ removed: name });
  else context.presenter.success(`removed ${name}`);
  return 0;
}

function rename(
  from: string,
  to: string,
  options: EnsembleOptions,
  context: CommandContext
): number {
  validateName(to, "ensemble rename");
  const { root } = repoRootFor(options);
  const shape = persistedShape(loadConfigOrFail(root, context.presenter));
  const ensembles = shapeEnsembles(shape);
  const current = ensembles[from];
  if (current === undefined) fail(`unknown ensemble "${from}"`);
  if (ensembles[to] !== undefined) fail(`ensemble "${to}" already exists`);
  delete ensembles[from];
  ensembles[to] = current;
  if (shape.defaultEnsemble === from) shape.defaultEnsemble = to;
  validateAndWrite(root, shape);
  if (context.json) context.emit({ renamed: { from, to } });
  else context.presenter.success(`renamed ${from} to ${to}`);
  return 0;
}

function addDefinitionOptions(command: Command): Command {
  return command
    .option(
      "--member <model-id>",
      "namespaced RouteKit model id (repeatable)",
      collect
    )
    .option("--judge <model-id>", "namespaced RouteKit judge model id")
    .option(
      "--synthesizer <model-id>",
      "namespaced RouteKit synthesizer model id"
    )
    .option("--repo <dir>")
    .option("--json");
}

export function registerEnsembleConfig(ensemble: Command): void {
  ensemble
    .command("list")
    .option("--repo <dir>")
    .option("--json")
    .action((options: EnsembleOptions, action: Command) => {
      process.exitCode = list(options, contextFor(action));
    });
  addDefinitionOptions(ensemble.command("add <name>")).action(
    (name: string, options: EnsembleOptions, action: Command) => {
      process.exitCode = add(name, options, contextFor(action));
    }
  );
  addDefinitionOptions(ensemble.command("edit <name>")).action(
    (name: string, options: EnsembleOptions, action: Command) => {
      process.exitCode = edit(name, options, contextFor(action));
    }
  );
  ensemble
    .command("remove <name>")
    .alias("rm")
    .option("--repo <dir>")
    .option("--json")
    .action((name: string, options: EnsembleOptions, action: Command) => {
      process.exitCode = remove(name, options, contextFor(action));
    });
  ensemble
    .command("rename <from> <to>")
    .option("--repo <dir>")
    .option("--json")
    .action(
      (
        from: string,
        to: string,
        options: EnsembleOptions,
        action: Command
      ) => {
        process.exitCode = rename(from, to, options, contextFor(action));
      }
    );
}

export function ensembleConfigPath(options: EnsembleOptions): string {
  return fusionConfigPath(repoRootFor(options).root);
}
