/**
 * Spawn and drive the provider simulator (python/fusionkit-testkit) from Node.
 *
 * The simulator process is the same one Python tests use in-process; from Node
 * it is scripted over its HTTP control plane (`/__sim/behaviors`) and observed
 * through its journal (`/__sim/journal`) — so cross-stack tests assert on what
 * actually crossed the provider wire, not on mock plumbing.
 */

import type { SimBehavior, SimJournalEntry } from "./behaviors.js";
import { spawnCaptured } from "./proc.js";
import { uvRunArgv } from "./python.js";

export type ProviderSimHandle = {
  /** Base URL: OpenAI wire at `/v1/chat/completions`, Anthropic at `/v1/messages`. */
  url: string;
  port: number;
  /** Queue behaviors for a model (FIFO; unqueued calls get the echo default). */
  queue: (model: string, behaviors: readonly SimBehavior[]) => Promise<void>;
  /** Every request the simulator served, in order. */
  journal: () => Promise<SimJournalEntry[]>;
  journalFor: (model: string) => Promise<SimJournalEntry[]>;
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

  return {
    url,
    port: parsed.port,
    queue: (model, behaviors) => controlPost("/__sim/behaviors", { model, behaviors }),
    journal,
    journalFor: async (model) => (await journal()).filter((entry) => entry.model === model),
    reset: () => controlPost("/__sim/reset", {}),
    log: proc.log,
    close: proc.close
  };
}
