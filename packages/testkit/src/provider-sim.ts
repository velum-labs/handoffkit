/**
 * Spawn and drive the RouteKit-upstream simulator
 * (python/fusionkit-testkit) from Node.
 *
 * The simulator process is the same one Python tests use in-process; from Node
 * it is scripted over its HTTP control plane (`/__sim/behaviors`) and observed
 * through its journal (`/__sim/journal`) — so cross-stack tests assert on what
 * actually crossed the RouteKit wire, not on mock plumbing.
 */

import { asBehavior } from "./behaviors.js";
import type { SimBehaviorInput, SimDialect, SimJournalEntry } from "./behaviors.js";
import { spawnCaptured } from "./proc.js";
import { uvRunArgv } from "./python.js";

/** Journal query filters (every given field must match). */
export type SimCallFilter = {
  model?: string;
  dialect?: SimDialect;
  status?: number;
  source?: "queued" | "default";
};

export type ProviderSimHandle = {
  /**
   * Base URL. Dialect routes: OpenAI chat at `/v1/chat/completions`, Anthropic
   * at `/v1/messages`, OpenAI Responses (codex) at `/responses`, Google GenAI
   * at `/v1beta/models/{model}:generateContent`.
   */
  url: string;
  port: number;
  /**
   * Queue behaviors for a model (FIFO; unqueued calls get the echo default).
   * Plain strings become text replies.
   */
  queue: (model: string, behaviors: readonly SimBehaviorInput[]) => Promise<void>;
  /** Every request the simulator served, in order. */
  journal: () => Promise<SimJournalEntry[]>;
  journalFor: (model: string) => Promise<SimJournalEntry[]>;
  /** Journal entries matching every given filter, in wire order. */
  calls: (filter?: SimCallFilter) => Promise<SimJournalEntry[]>;
  /** One line per wire call — designed for assertion failure messages. */
  describeJournal: () => Promise<string>;
  /** Clear queues, journal, and default counters. */
  reset: () => Promise<void>;
  /** The simulator process's own output (for diagnosing tooling failures). */
  log: () => string;
  close: () => Promise<void>;
};

export async function startProviderSim(options: { startupTimeoutMs?: number } = {}): Promise<ProviderSimHandle> {
  const runner = uvRunArgv("fusionkit-testkit", "fusionkit-sim", ["--port", "0"]);
  const proc = spawnCaptured(runner);
  const listening = await proc.nextLine(/"event":\s*"listening"/, options.startupTimeoutMs ?? 60_000);
  const parsed = JSON.parse(listening) as { url: string; port: number };
  const url = parsed.url;

  const controlPost = async (path: string, body: unknown): Promise<void> => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`simulator control ${path} failed: ${response.status} ${await response.text()}`);
    }
  };
  const journal = async (): Promise<SimJournalEntry[]> => {
    const response = await fetch(`${url}/__sim/journal`);
    if (!response.ok) throw new Error(`simulator journal failed: ${response.status}`);
    const body = (await response.json()) as { entries: SimJournalEntry[] };
    return body.entries;
  };
  const calls = async (filter: SimCallFilter = {}): Promise<SimJournalEntry[]> =>
    (await journal()).filter(
      (entry) =>
        (filter.model === undefined || entry.model === filter.model) &&
        (filter.dialect === undefined || entry.dialect === filter.dialect) &&
        (filter.status === undefined || entry.status === filter.status) &&
        (filter.source === undefined || entry.source === filter.source)
    );

  return {
    url,
    port: parsed.port,
    queue: (model, behaviors) =>
      controlPost("/__sim/behaviors", { model, behaviors: behaviors.map(asBehavior) }),
    journal,
    journalFor: (model) => calls({ model }),
    calls,
    describeJournal: async () => {
      const entries = await journal();
      if (entries.length === 0) return "(no RouteKit calls journaled)";
      return entries
        .map(
          (entry) =>
            `#${entry.seq} ${entry.dialect} model=${entry.model} status=${entry.status} ` +
            `kind=${entry.kind} source=${entry.source} stream=${entry.stream} ` +
            `reply=${JSON.stringify(entry.reply_preview)}`
        )
        .join("\n");
    },
    reset: () => controlPost("/__sim/reset", {}),
    log: proc.log,
    close: proc.close
  };
}
