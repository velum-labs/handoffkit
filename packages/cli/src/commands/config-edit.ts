/**
 * `fusionkit config edit` — an interactive, menu-driven editor over every
 * fusion setting. Each field shows its current value and provenance, edits are
 * validated by the same `parseFusionConfig` pipeline the runtime uses, and
 * nothing touches disk until the user saves. Non-interactive runs are pointed
 * at the scriptable `fusionkit config set` instead.
 */
import { bold, canPromptInteractively, confirm, cyan, dim, gray, note, select, text } from "@fusionkit/cli-ui";

import { fusionConfigPath, parseFusionConfig } from "../fusion-config.js";
import { FUSION_TOOLS } from "../fusion-quickstart.js";
import type { FusionTool } from "../fusion-quickstart.js";
import {
  loadConfigOrFail,
  persistedShape,
  repoRootFor,
  validateAndWrite
} from "../fusion/config-store.js";
import {
  DEFAULT_ON_RATE_LIMIT,
  DEFAULT_PORTLESS,
  DEFAULT_REASONING,
  DEFAULT_TOOL
} from "../fusion/effective-config.js";
import {
  ON_RATE_LIMIT_POLICIES,
  PANEL_TRUST_HELP,
  PANEL_TRUST_LEVELS,
  PANEL_TRUST_MESSAGE,
  PANEL_TRUST_OPTIONS
} from "../shared/options.js";
import { fail } from "../shared/errors.js";
import type { CommandContext } from "../shared/context.js";

type Shape = Record<string, unknown>;

const DONE = "__done__";
const DISCARD = "__discard__";

function boolLabel(value: unknown, fallback: boolean): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return dim(`${fallback ? "on" : "off"} (default)`);
}

function valueLabel(value: unknown, fallbackLabel: string): string {
  if (value === undefined || value === null) return dim(`${fallbackLabel} (default)`);
  return String(value);
}

/** One editable field: how it renders in the menu and how it prompts. */
type Field = {
  key: string;
  label: string;
  current: (shape: Shape) => string;
  edit: (shape: Shape) => Promise<void>;
};

async function editBoolean(shape: Shape, key: string, message: string, fallback: boolean): Promise<void> {
  const current = typeof shape[key] === "boolean" ? (shape[key] as boolean) : fallback;
  const next = await confirm({ message, defaultValue: current });
  shape[key] = next;
}

async function editNumberOrUnset(
  shape: Shape,
  key: string,
  message: string,
  parse: (raw: string) => number | undefined
): Promise<void> {
  const raw = await text({
    message: `${message} (blank to unset)`,
    defaultValue: shape[key] !== undefined && shape[key] !== null ? String(shape[key]) : ""
  });
  if (raw.trim().length === 0) {
    delete shape[key];
    return;
  }
  const parsed = parse(raw.trim());
  if (parsed === undefined) return;
  shape[key] = parsed;
}

function buildFields(ensembleNames: string[]): Field[] {
  return [
    {
      key: "tool",
      label: "tool",
      current: (shape) => valueLabel(shape.tool, DEFAULT_TOOL),
      edit: async (shape) => {
        const current = (shape.tool as FusionTool | undefined) ?? DEFAULT_TOOL;
        shape.tool = await select<FusionTool>({
          message: "Default coding agent",
          options: FUSION_TOOLS.map((tool) => ({ value: tool, label: tool })),
          defaultIndex: Math.max(0, FUSION_TOOLS.indexOf(current))
        });
      }
    },
    ...(ensembleNames.length > 1
      ? [
          {
            key: "defaultEnsemble",
            label: "default ensemble",
            current: (shape: Shape) => valueLabel(shape.defaultEnsemble, ensembleNames[0] ?? "default"),
            edit: async (shape: Shape) => {
              shape.defaultEnsemble = await select<string>({
                message: "Session-default ensemble",
                options: ensembleNames.map((name) => ({ value: name, label: name })),
                defaultIndex: Math.max(0, ensembleNames.indexOf(String(shape.defaultEnsemble ?? "")))
              });
            }
          }
        ]
      : []),
    {
      key: "local",
      label: "local (MLX default panel)",
      current: (shape) => boolLabel(shape.local, false),
      edit: (shape) => editBoolean(shape, "local", "Use the local MLX trio as the default panel?", false)
    },
    {
      key: "observe",
      label: "observability dashboard",
      current: (shape) => boolLabel(shape.observe, false),
      edit: (shape) => editBoolean(shape, "observe", "Boot the observability dashboard by default?", false)
    },
    {
      key: "portless",
      label: "portless",
      current: (shape) => boolLabel(shape.portless, DEFAULT_PORTLESS),
      edit: (shape) => editBoolean(shape, "portless", "Route services through portless stable URLs?", DEFAULT_PORTLESS)
    },
    {
      key: "port",
      label: "gateway port",
      current: (shape) => valueLabel(shape.port, "ephemeral"),
      edit: (shape) =>
        editNumberOrUnset(shape, "port", "Gateway port", (raw) => {
          const port = Number(raw);
          return Number.isInteger(port) && port >= 0 ? port : undefined;
        })
    },
    {
      key: "onRateLimit",
      label: "on rate limit",
      current: (shape) => valueLabel(shape.onRateLimit, DEFAULT_ON_RATE_LIMIT),
      edit: async (shape) => {
        shape.onRateLimit = await select<string>({
          message: "When a vendor passthrough model hits a rate limit / credit wall",
          options: [
            { value: "fusion", label: "fusion", hint: "continue on the ensemble (default)" },
            { value: "passthrough", label: "passthrough", hint: "surface the vendor error to the tool" },
            { value: "fail", label: "fail", hint: "stop the session" }
          ],
          defaultIndex: Math.max(
            0,
            ON_RATE_LIMIT_POLICIES.indexOf(
              (shape.onRateLimit as (typeof ON_RATE_LIMIT_POLICIES)[number] | undefined) ?? DEFAULT_ON_RATE_LIMIT
            )
          )
        });
      }
    },
    {
      key: "budgetUsd",
      label: "budget (USD)",
      current: (shape) => valueLabel(shape.budgetUsd, "unlimited"),
      edit: (shape) =>
        editNumberOrUnset(shape, "budgetUsd", "Stop the session once it has spent this much (USD)", (raw) => {
          const budget = Number(raw);
          return Number.isFinite(budget) && budget > 0 ? budget : undefined;
        })
    },
    {
      key: "panelTrust",
      label: "panel sandbox",
      current: (shape) => valueLabel(shape.panelTrust, "full"),
      edit: async (shape) => {
        note(PANEL_TRUST_HELP);
        shape.panelTrust = await select<string>({
          message: PANEL_TRUST_MESSAGE,
          options: PANEL_TRUST_OPTIONS,
          defaultIndex: Math.max(
            0,
            PANEL_TRUST_LEVELS.indexOf((shape.panelTrust as (typeof PANEL_TRUST_LEVELS)[number] | undefined) ?? "full")
          )
        });
      }
    },
    {
      key: "reasoning",
      label: "reasoning traces",
      current: (shape) => boolLabel(shape.reasoning, DEFAULT_REASONING),
      edit: (shape) =>
        editBoolean(shape, "reasoning", "Narrate panel/judge progress in the tool's thinking UI?", DEFAULT_REASONING)
    },
    {
      key: "reasoningModel",
      label: "reasoning model",
      current: (shape) => valueLabel(shape.reasoningModel, "templated prose"),
      edit: async (shape) => {
        const raw = await text({
          message: "Narration-writer model (panel member id, provider/model, or MLX repo; blank to unset)",
          defaultValue: typeof shape.reasoningModel === "string" ? shape.reasoningModel : ""
        });
        if (raw.trim().length === 0) delete shape.reasoningModel;
        else shape.reasoningModel = raw.trim();
      }
    }
  ];
}

export async function runConfigEdit(opts: { repo?: string }, ctx: CommandContext): Promise<number> {
  if (!canPromptInteractively()) {
    fail(
      "config edit is interactive — in scripts/CI use `fusionkit config set <path> <value>` " +
        "(see `fusionkit config set --help`)"
    );
  }
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) {
    fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  }

  const { presenter } = ctx;
  const shape: Shape = persistedShape(loadConfigOrFail(root, presenter));
  const ensembleNames = Object.keys((shape.ensembles as Record<string, unknown> | undefined) ?? {});
  const fields = buildFields(ensembleNames);

  presenter.blank();
  presenter.header("config edit");
  presenter.line(dim(`editing ${fusionConfigPath(root)} — nothing is written until you save`));
  presenter.blank();

  let dirty = false;
  for (;;) {
    const choice = await select<string>({
      message: "Edit a setting",
      options: [
        ...fields.map((field) => ({
          value: field.key,
          label: field.label,
          hint: field.current(shape)
        })),
        { value: DONE, label: dirty ? "save and exit" : "exit", hint: dirty ? cyan("writes fusion.json") : undefined },
        ...(dirty ? [{ value: DISCARD, label: "discard changes", hint: gray("exit without writing") }] : [])
      ] as Array<{ value: string; label: string; hint?: string }>,
      defaultIndex: 0
    });
    if (choice === DISCARD) {
      presenter.note("discarded — nothing written");
      return 0;
    }
    if (choice === DONE) break;
    const field = fields.find((candidate) => candidate.key === choice);
    if (field === undefined) continue;
    await field.edit(shape);
    // Validate eagerly so a bad edit is caught at the field, not at save time.
    try {
      parseFusionConfig(shape, fusionConfigPath(root));
      dirty = true;
    } catch (error) {
      presenter.warn(error instanceof Error ? error.message : String(error));
    }
  }

  if (!dirty) {
    presenter.note("no changes");
    return 0;
  }
  validateAndWrite(root, shape);
  presenter.success(`wrote ${cyan(fusionConfigPath(root))}`);
  presenter.line(dim(`review with ${bold("fusionkit config show")}`));
  return 0;
}
