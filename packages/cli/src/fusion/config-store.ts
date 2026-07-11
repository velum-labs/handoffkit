/**
 * The one read-modify-write pipeline every config mutation goes through:
 * load `.fusionkit/fusion.json`, expose its raw persisted shape (prompts are
 * files, never inline), and validate with the runtime's own `parseFusionConfig`
 * before writing — so the file on disk can never drift into a state the
 * runtime would reject.
 */
import { resolve } from "node:path";

import { dim } from "@fusionkit/cli-ui";
import type { Presenter } from "@fusionkit/cli-ui";

import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  loadFusionConfig,
  parseFusionConfig,
  writeFusionConfig
} from "../fusion-config.js";
import type { EnsembleConfig, FusionConfig } from "../fusion-config.js";
import { gitToplevel } from "./env.js";
import { fail } from "../shared/errors.js";

export type ConfigShape = Record<string, unknown>;

/** The repo root config is read from: --repo if given, else the cwd's git root. */
export function repoRootFor(opts: { repo?: string }): { root: string; inRepo: boolean } {
  const explicit = opts.repo !== undefined ? resolve(opts.repo) : undefined;
  const detected = gitToplevel(process.cwd());
  const root = explicit ?? detected ?? process.cwd();
  return { root, inRepo: explicit !== undefined || detected !== undefined };
}

/** Load the repo config, failing with a one-line `config error:` on parse problems. */
export function loadConfigOrFail(root: string, presenter?: Presenter): FusionConfig | undefined {
  try {
    return loadFusionConfig(root, (message) => presenter?.note(dim(message)));
  } catch (error) {
    return fail(error instanceof FusionConfigError ? error.message : String(error));
  }
}

/** The raw persisted shape of a loaded config (prompts stripped). */
export function persistedShape(config: FusionConfig | undefined): ConfigShape {
  if (config === undefined) return { version: FUSION_CONFIG_VERSION };
  const { prompts: _prompts, ensembles, ...rest } = config;
  const shape: ConfigShape = { ...rest };
  if (ensembles !== undefined) {
    shape.ensembles = Object.fromEntries(
      Object.entries(ensembles).map(([name, ensemble]) => {
        const { prompts: _ensemblePrompts, ...kept } = ensemble;
        return [name, kept];
      })
    );
  }
  return shape;
}

/** The mutable ensembles map inside a shape (created on demand). */
export function shapeEnsembles(shape: ConfigShape): Record<string, EnsembleConfig> {
  const ensembles = (shape.ensembles ?? {}) as Record<string, EnsembleConfig>;
  shape.ensembles = ensembles;
  return ensembles;
}

/** Validate a mutated raw shape and persist it, failing with the validator's message. */
export function validateAndWrite(root: string, shape: ConfigShape): FusionConfig {
  let validated: FusionConfig;
  try {
    validated = parseFusionConfig(shape, fusionConfigPath(root));
  } catch (error) {
    return fail(error instanceof FusionConfigError ? error.message : String(error));
  }
  writeFusionConfig(root, validated, { force: true });
  return validated;
}
