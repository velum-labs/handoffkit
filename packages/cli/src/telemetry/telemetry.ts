/**
 * Opt-in product telemetry over the official PostHog SDK.
 *
 * Two event kinds, both built from an explicit allow-list — never from raw
 * span attribute bags, so prompts, code, repo paths, and model outputs are
 * structurally excluded (see docs/privacy.md for the published field list):
 *
 *  - `cli.command`   — one per invocation: command name, version, os/arch,
 *                      node major, duration bucket, exit kind, feature flags.
 *  - `fusion.session` — one per fused session trace: panel size, provider
 *                      names, harness kind, judge decision, turn count,
 *                      latency bucket, token totals, error kind.
 *
 * Capture is anonymous by design: `$process_person_profile: false` and
 * `$ip: null` on every event; the distinct id is a random install UUID that
 * `fusionkit telemetry off` deletes. Batching, queueing, and shutdown flush
 * are posthog-node's.
 */
import { arch, platform } from "node:os";

import { PostHog } from "posthog-node";
import { addSpanListener, attrJson, attrNum, attrStr, spanTraceId } from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

import { resolveTelemetry } from "./consent.js";
import type { TelemetryDecision } from "./consent.js";

export const TELEMETRY_DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * The PostHog project key telemetry reports to. Empty by default in source:
 * release builds (and self-hosters) provide it via FUSIONKIT_POSTHOG_KEY.
 * Without a key, telemetry stays inert even when a user opts in.
 */
export function telemetryProjectKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.FUSIONKIT_POSTHOG_KEY;
  return key !== undefined && key.length > 0 ? key : undefined;
}

export function telemetryHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.FUSIONKIT_POSTHOG_HOST;
  return host !== undefined && host.length > 0 ? host : TELEMETRY_DEFAULT_HOST;
}

/** Coarse duration bucket, so timings cannot fingerprint a machine. */
export function durationBucket(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 1_800_000) return "5-30m";
  return ">30m";
}

export type CliCommandEvent = {
  command: string;
  cli_version: string;
  os: string;
  arch: string;
  node_major: number;
  duration_bucket: string;
  exit_kind: string;
  observe: boolean;
  local: boolean;
  is_ci: boolean;
};

export type FusionSessionEvent = {
  panel_size: number;
  providers: string[];
  harness?: string;
  judge_decision?: string;
  turn_count: number;
  duration_bucket: string;
  input_tokens: number;
  output_tokens: number;
  candidate_failures: number;
  error_kind?: string;
};

type SessionAcc = {
  providers: Set<string>;
  candidates: Set<string>;
  turns: Set<number>;
  harness?: string;
  judgeDecision?: string;
  inputTokens: number;
  outputTokens: number;
  candidateFailures: number;
  errorKind?: string;
  firstMs: number;
  lastMs: number;
};

let client: PostHog | undefined;
let installId: string | undefined;
let listenerAttached = false;
const sessions = new Map<string, SessionAcc>();

function spanEndMsOf(span: ReadableSpan): number {
  const [seconds, nanos] = span.endTime;
  return seconds * 1000 + nanos / 1e6;
}

function spanStartMsOf(span: ReadableSpan): number {
  const [seconds, nanos] = span.startTime;
  return seconds * 1000 + nanos / 1e6;
}

/** Fold one finished span into its session aggregate (allow-listed reads only). */
function fold(span: ReadableSpan): FusionSessionEvent | undefined {
  const traceId = spanTraceId(span);
  let acc = sessions.get(traceId);
  if (acc === undefined) {
    acc = {
      providers: new Set(),
      candidates: new Set(),
      turns: new Set(),
      inputTokens: 0,
      outputTokens: 0,
      candidateFailures: 0,
      firstMs: spanStartMsOf(span),
      lastMs: spanEndMsOf(span)
    };
    sessions.set(traceId, acc);
  }
  acc.firstMs = Math.min(acc.firstMs, spanStartMsOf(span));
  acc.lastMs = Math.max(acc.lastMs, spanEndMsOf(span));
  const turn = attrNum(span, "fusion.turn");
  if (turn !== undefined) acc.turns.add(turn);

  if (span.name === "fusion.turn.info" || span.name === "fusion.run") {
    const environment = attrJson<{ harnesses?: string[]; models?: Array<{ provider?: string }> }>(
      span,
      "fusion.environment"
    );
    acc.harness = environment?.harnesses?.[0] ?? acc.harness;
    for (const model of environment?.models ?? []) {
      if (typeof model.provider === "string") acc.providers.add(model.provider);
    }
    if (span.name === "fusion.run" && attrStr(span, "fusion.status") === "failed") {
      acc.errorKind = "run_failed";
    }
  } else if (span.name === "fusion.candidate") {
    const candidateId = attrStr(span, "fusion.candidate.id");
    if (candidateId !== undefined) acc.candidates.add(candidateId);
    if (attrStr(span, "fusion.status") === "failed") acc.candidateFailures += 1;
  } else if (span.name.startsWith("chat")) {
    acc.inputTokens += attrNum(span, "gen_ai.usage.input_tokens") ?? 0;
    acc.outputTokens += attrNum(span, "gen_ai.usage.output_tokens") ?? 0;
  } else if (span.name === "fusion.judge") {
    // The judge span ends the fused turn; the session record ships lazily at
    // shutdown flush so multi-turn sessions aggregate into one event.
    acc.judgeDecision = attrStr(span, "fusion.decision") ?? acc.judgeDecision;
    if (span.status.code === 2) acc.errorKind = "judge_failed";
  }
  return undefined;
}

function sessionEvent(acc: SessionAcc): FusionSessionEvent {
  return {
    panel_size: Math.max(acc.candidates.size, acc.providers.size),
    providers: [...acc.providers].sort(),
    ...(acc.harness !== undefined ? { harness: acc.harness } : {}),
    ...(acc.judgeDecision !== undefined ? { judge_decision: acc.judgeDecision } : {}),
    turn_count: Math.max(acc.turns.size, 1),
    duration_bucket: durationBucket(Math.max(0, acc.lastMs - acc.firstMs)),
    input_tokens: acc.inputTokens,
    output_tokens: acc.outputTokens,
    candidate_failures: acc.candidateFailures,
    ...(acc.errorKind !== undefined ? { error_kind: acc.errorKind } : {})
  };
}

export type InitTelemetryOptions = {
  /** Test hook: inject a capture sink instead of a real PostHog client. */
  capture?: (event: string, properties: Record<string, unknown>) => void;
};

let injectedCapture: InitTelemetryOptions["capture"];

/**
 * Initialize telemetry if (and only if) the user opted in and a project key
 * is configured. Also attaches the span listener that folds fused sessions
 * into allow-listed aggregates. Safe to call more than once.
 */
export function initTelemetry(options: InitTelemetryOptions = {}): TelemetryDecision {
  const decision = resolveTelemetry();
  injectedCapture = options.capture ?? injectedCapture;
  if (!decision.enabled) return decision;
  installId = decision.installId;
  const key = telemetryProjectKey();
  if (client === undefined && injectedCapture === undefined && key !== undefined) {
    client = new PostHog(key, {
      host: telemetryHost(),
      flushAt: 20,
      flushInterval: 10_000,
      disableGeoip: true
    });
  }
  if (!listenerAttached && (client !== undefined || injectedCapture !== undefined)) {
    listenerAttached = true;
    addSpanListener(fold);
  }
  return decision;
}

function capture(event: string, properties: Record<string, unknown>): void {
  if (injectedCapture !== undefined) {
    injectedCapture(event, properties);
    return;
  }
  if (client === undefined || installId === undefined) return;
  client.capture({
    distinctId: installId,
    event,
    properties: {
      ...properties,
      // Anonymous by design: no person profile, no client IP retention.
      $process_person_profile: false,
      $ip: null
    }
  });
}

/** Report one CLI invocation (call after the command settles). */
export function captureCommand(input: {
  command: string;
  cliVersion: string;
  startedAt: number;
  exitKind: string;
  observe?: boolean;
  local?: boolean;
}): void {
  const decision = resolveTelemetry();
  if (!decision.enabled) return;
  const event: CliCommandEvent = {
    command: input.command,
    cli_version: input.cliVersion,
    os: platform(),
    arch: arch(),
    node_major: Number(process.versions.node.split(".")[0]),
    duration_bucket: durationBucket(Date.now() - input.startedAt),
    exit_kind: input.exitKind,
    observe: input.observe === true,
    local: input.local === true,
    is_ci: process.env.CI !== undefined
  };
  capture("cli.command", { ...event });
}

/** Ship pending session aggregates and flush the SDK queue (bounded). */
export async function shutdownTelemetry(): Promise<void> {
  for (const acc of sessions.values()) {
    // Only sessions that actually fused something are worth a record.
    if (acc.candidates.size === 0 && acc.judgeDecision === undefined) continue;
    capture("fusion.session", { ...sessionEvent(acc) });
  }
  sessions.clear();
  const active = client;
  client = undefined;
  if (active !== undefined) {
    // posthog-node flushes on shutdown; bound it so exit never hangs.
    await Promise.race([
      active.shutdown().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
  }
}

/** Test hook: the pending per-session aggregates (allow-listed shape). */
export function pendingSessionEventsForTest(): FusionSessionEvent[] {
  return [...sessions.values()].map(sessionEvent);
}

/** Test hook: reset module state between tests. */
export function resetTelemetryForTest(): void {
  client = undefined;
  installId = undefined;
  injectedCapture = undefined;
  sessions.clear();
}
