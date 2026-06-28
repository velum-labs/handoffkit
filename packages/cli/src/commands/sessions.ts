/**
 * `fusionkit sessions` — inspect and manage durable gateway sessions (WS4).
 *
 *   sessions list            id, tool, model/panel, last activity, turn count
 *   sessions show <id>       full header + the most recent turns
 *   sessions rm <id>         delete a stored session
 *
 * Sessions are persisted by the fusion gateway under ~/.fusionkit/sessions (or
 * $FUSIONKIT_SESSIONS_DIR). Ids are the conversation session key; any unique
 * prefix is accepted by `show`/`rm`/`--resume`, like a git short SHA.
 */
import type { Command } from "commander";

import { defaultSessionsDir, FileSystemSessionStore, formatUsd } from "@fusionkit/model-gateway";
import type { SessionCost, SessionStore, SessionSummary } from "@fusionkit/model-gateway";

import { bold, brandBanner, cyan, dim, glyph, gray, green, red } from "../ui/theme.js";

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

/** A compact human-friendly "time ago" for a timestamp (epoch millis). */
function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
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

function runList(store: SessionStore): number {
  const sessions = store.list();
  console.log(`\n${brandBanner("sessions")}\n`);
  if (sessions.length === 0) {
    console.log(dim(`no sessions yet — run \`fusionkit codex\` (stored in ${store instanceof FileSystemSessionStore ? store.root : "memory"}).`));
    return 0;
  }
  for (const session of sessions) {
    const tool = session.tool ?? "?";
    console.log(
      `${green(session.id)}  ${bold(tool)} ${dim(`· ${panelLabel(session)}`)}` +
        `  ${dim(`· ${session.turnCount} turn${session.turnCount === 1 ? "" : "s"}`)}` +
        `  ${dim(`· ${relativeTime(session.updatedAt)}`)}`
    );
  }
  console.log("");
  console.log(dim(`${sessions.length} session(s). Resume with \`fusionkit <tool> --resume <id>\` or \`--continue\`.`));
  return 0;
}

function preview(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

function runShow(store: SessionStore, ref: string): number {
  const id = resolveSessionId(store, ref);
  const session = id !== undefined ? store.load(id) : undefined;
  if (session === undefined) {
    console.error(red(`no session matches "${ref}".`));
    return 1;
  }
  const { meta, turns } = session;
  console.log(`\n${brandBanner("session")}\n`);
  console.log(`${dim("id:")}      ${green(meta.id)}`);
  console.log(`${dim("tool:")}    ${meta.tool ?? gray("(unknown)")}`);
  if (meta.repo !== undefined) console.log(`${dim("repo:")}    ${meta.repo}`);
  console.log(`${dim("panel:")}   ${(meta.models ?? []).map((model) => `${model.id}=${model.model}`).join(", ") || gray("(unknown)")}`);
  if (meta.judgeModel !== undefined) console.log(`${dim("judge:")}   ${meta.judgeModel}`);
  console.log(`${dim("created:")} ${new Date(meta.createdAt).toISOString()}`);
  console.log(`${dim("updated:")} ${new Date(meta.updatedAt).toISOString()} ${dim(`(${relativeTime(meta.updatedAt)})`)}`);
  console.log(`${dim("turns:")}   ${turns.length}`);
  if (meta.cost !== undefined) console.log(`${dim("cost:")}    ${costLabel(meta.cost)}`);

  const recent = turns.slice(-5);
  if (recent.length > 0) {
    console.log(bold(`\nrecent turns`));
    for (const turn of recent) {
      const lastUser = [...turn.messages].reverse().find((message) => message.role === "user");
      const statuses = turn.candidates.map((candidate) => `${candidate.model_id}:${candidate.status}`).join(", ");
      console.log(`  ${cyan(`turn ${turn.turn}`)} ${dim(`· ${turn.candidates.length} candidate(s) [${statuses}]`)}`);
      if (lastUser !== undefined) console.log(`    ${dim(preview(lastUser.content))}`);
    }
  }
  console.log("");
  console.log(dim(`resume: fusionkit <tool> --resume ${meta.id.slice(0, 8)}`));
  return 0;
}

function runRemove(store: SessionStore, ref: string): number {
  const id = resolveSessionId(store, ref);
  if (id === undefined) {
    console.error(red(`no session matches "${ref}".`));
    return 1;
  }
  const removed = store.remove(id);
  if (removed) console.log(`${green(glyph.tick())} removed session ${cyan(id)}`);
  else console.log(`${gray(glyph.bullet())} ${id} was not stored`);
  return removed ? 0 : 1;
}

export function registerSessions(program: Command): void {
  const store = new FileSystemSessionStore(defaultSessionsDir());

  const sessions = program
    .command("sessions")
    .description("list, inspect, and remove durable gateway sessions")
    .action(() => {
      process.exit(runList(store));
    });

  sessions
    .command("list")
    .description("list stored sessions (id, tool, panel, turns, last activity)")
    .action(() => {
      process.exit(runList(store));
    });

  sessions
    .command("show")
    .argument("<id>", "session id (or a unique prefix)")
    .description("show a session's details and its most recent turns")
    .action((id: string) => {
      process.exit(runShow(store, id));
    });

  sessions
    .command("rm")
    .alias("remove")
    .argument("<id>", "session id (or a unique prefix) to delete")
    .description("delete a stored session")
    .action((id: string) => {
      process.exit(runRemove(store, id));
    });
}
