/**
 * `fusionkit sessions` — inspect and manage durable gateway sessions (WS4).
 *
 *   sessions list            id, tool, model/panel, last activity, turn count
 *   sessions show <id>       full header + the most recent turns
 *   sessions rm <id>         delete a stored session
 *
 * Sessions are persisted by the fusion gateway under ~/.fusionkit/sessions (or
 * $FUSIONKIT_SESSIONS_DIR). Ids are the conversation session key; any unique
 * prefix is accepted by `show`/`rm`/`--resume`, like a git short SHA. Every
 * subcommand supports `--json` for scripting.
 */
import type { Command } from "commander";

import { defaultSessionsDir, FileSystemSessionStore, formatUsd } from "@fusionkit/model-gateway";
import type { SessionCost, SessionStore, SessionSummary } from "@fusionkit/model-gateway";

import { bold, cyan, dim, gray, green, relativeTime } from "@fusionkit/cli-ui";

import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { argOrPick } from "../shared/pickers.js";

import { registerPaletteAction } from "./palette.js";

/**
 * Resolve a session reference (a full id or a unique prefix) to a stored id.
 * Returns `undefined` when nothing matches or a prefix is ambiguous.
 */
export function resolveSessionId(store: SessionStore, ref: string): string | undefined {
  if (store.load(ref) !== undefined) return ref;
  const matches = store.list().filter((session) => session.id.startsWith(ref));
  if (matches.length === 1) return matches[0]?.id;
  return undefined;
}

/** A compact summary of a session's running cost (WS7), e.g. `$0.0421 · 12.3k tokens · 4 turns (1 unpriced)`. */
function costLabel(cost: SessionCost): string {
  const tokens = cost.totalTokens >= 1000 ? `${(cost.totalTokens / 1000).toFixed(1)}k` : `${cost.totalTokens}`;
  const unpriced = cost.unknownCostTurns > 0 ? ` ${dim(`(${cost.unknownCostTurns} unpriced)`)}` : "";
  return `${formatUsd(cost.totalUsd, cost.currency)} ${dim(`· ${tokens} tokens · ${cost.meteredTurns} priced turn${cost.meteredTurns === 1 ? "" : "s"}`)}${unpriced}`;
}

function panelLabel(session: SessionSummary): string {
  const models = session.models ?? [];
  if (models.length === 0) return session.defaultModel ?? "(unknown)";
  return models.map((model) => model.id).join("+");
}

function summaryPayload(session: SessionSummary): Record<string, unknown> {
  return {
    id: session.id,
    tool: session.tool ?? null,
    repo: session.repo ?? null,
    models: session.models ?? [],
    turnCount: session.turnCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cost: session.cost ?? null
  };
}

function runList(store: SessionStore, ctx: CommandContext): number {
  const sessions = store.list();
  if (ctx.json) {
    ctx.emit({ sessions: sessions.map(summaryPayload) });
    return 0;
  }
  const { presenter } = ctx;
  presenter.blank();
  presenter.header("sessions");
  presenter.blank();
  if (sessions.length === 0) {
    presenter.line(
      dim(`no sessions yet — run \`fusionkit codex\` (stored in ${store instanceof FileSystemSessionStore ? store.root : "memory"}).`)
    );
    return 0;
  }
  presenter.table(
    sessions.map((session) => [
      green(session.id),
      bold(session.tool ?? "?"),
      dim(panelLabel(session)),
      dim(`${session.turnCount} turn${session.turnCount === 1 ? "" : "s"}`),
      dim(relativeTime(session.updatedAt))
    ])
  );
  presenter.blank();
  presenter.line(dim(`${sessions.length} session(s). Resume with \`fusionkit <tool> --resume <id>\` or \`--continue\`.`));
  return 0;
}

function preview(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

function runShow(store: SessionStore, ref: string, ctx: CommandContext): number {
  const id = resolveSessionId(store, ref);
  const session = id !== undefined ? store.load(id) : undefined;
  if (session === undefined) {
    if (ctx.json) {
      ctx.emit({ error: { code: "not-found", message: `no session matches "${ref}"` } });
      return 1;
    }
    ctx.presenter.error(`no session matches "${ref}".`);
    return 1;
  }
  const { meta, turns } = session;
  if (ctx.json) {
    ctx.emit({ session: { meta, turns } });
    return 0;
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.header("session");
  presenter.blank();
  presenter.keyValue([
    { label: "id", value: green(meta.id) },
    { label: "tool", value: meta.tool ?? gray("(unknown)") },
    ...(meta.repo !== undefined ? [{ label: "repo", value: meta.repo }] : []),
    {
      label: "panel",
      value: (meta.models ?? []).map((model) => `${model.id}=${model.model}`).join(", ") || gray("(unknown)")
    },
    ...(meta.judgeModel !== undefined ? [{ label: "judge", value: meta.judgeModel }] : []),
    { label: "created", value: new Date(meta.createdAt).toISOString() },
    {
      label: "updated",
      value: `${new Date(meta.updatedAt).toISOString()} ${dim(`(${relativeTime(meta.updatedAt)})`)}`
    },
    { label: "turns", value: String(turns.length) },
    ...(meta.cost !== undefined ? [{ label: "cost", value: costLabel(meta.cost) }] : [])
  ]);

  const recent = turns.slice(-5);
  if (recent.length > 0) {
    presenter.blank();
    presenter.heading("recent turns");
    for (const turn of recent) {
      const lastUser = [...turn.messages].reverse().find((message) => message.role === "user");
      const statuses = turn.candidates.map((candidate) => `${candidate.model_id}:${candidate.status}`).join(", ");
      presenter.line(`  ${cyan(`turn ${turn.turn}`)} ${dim(`· ${turn.candidates.length} candidate(s) [${statuses}]`)}`);
      if (lastUser !== undefined) presenter.line(`    ${dim(preview(lastUser.content))}`);
    }
  }
  presenter.blank();
  presenter.line(dim(`resume: fusionkit <tool> --resume ${meta.id.slice(0, 8)}`));
  return 0;
}

function runRemove(store: SessionStore, ref: string, ctx: CommandContext): number {
  const id = resolveSessionId(store, ref);
  if (id === undefined) {
    if (ctx.json) {
      ctx.emit({ error: { code: "not-found", message: `no session matches "${ref}"` } });
      return 1;
    }
    ctx.presenter.error(`no session matches "${ref}".`);
    return 1;
  }
  const removed = store.remove(id);
  if (ctx.json) {
    ctx.emit({ removed, id });
    return removed ? 0 : 1;
  }
  if (removed) ctx.presenter.success(`removed session ${cyan(id)}`);
  else ctx.presenter.note(`${id} was not stored`);
  return removed ? 0 : 1;
}

/** The omitted-id picker: recency-ordered sessions with tool/turns/cost hints. */
async function pickSessionId(store: SessionStore, verb: string): Promise<string> {
  return argOrPick<string>({
    given: undefined,
    message: `Which session to ${verb}?`,
    placeholder: "type to filter",
    missing: `missing session id — pass an id or unique prefix (see \`fusionkit sessions\`)`,
    empty: "no stored sessions yet — run `fusionkit codex` first",
    options: () =>
      store.list().map((session) => ({
        value: session.id,
        label: session.id.slice(0, 12),
        hint: `${session.tool ?? "?"} · ${session.turnCount} turn${session.turnCount === 1 ? "" : "s"} · ${relativeTime(session.updatedAt)}`
      }))
  });
}

export function registerSessions(program: Command): void {
  registerPaletteAction({ label: "Browse stored sessions", hint: "fusionkit sessions", argv: ["sessions"] });
  const store = new FileSystemSessionStore(defaultSessionsDir());

  const sessions = program
    .command("sessions")
    .description("list, inspect, and remove durable gateway sessions")
    .option("--json", "emit machine-readable JSON")
    .action((_opts: { json?: boolean }, command: Command) => {
      process.exitCode = runList(store, contextFor(command));
    });

  sessions
    .command("list")
    .description("list stored sessions (id, tool, panel, turns, last activity)")
    .option("--json", "emit machine-readable JSON")
    .action((_opts: { json?: boolean }, command: Command) => {
      process.exitCode = runList(store, contextFor(command));
    });

  sessions
    .command("show")
    .argument("[id]", "session id (or a unique prefix); omit on a TTY to pick")
    .description("show a session's details and its most recent turns")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string | undefined, _opts: { json?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      process.exitCode = runShow(store, id ?? (await pickSessionId(store, "show")), ctx);
    });

  sessions
    .command("rm")
    .alias("remove")
    .argument("[id]", "session id (or a unique prefix) to delete; omit on a TTY to pick")
    .description("delete a stored session")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string | undefined, _opts: { json?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      process.exitCode = runRemove(store, id ?? (await pickSessionId(store, "delete")), ctx);
    });
}
