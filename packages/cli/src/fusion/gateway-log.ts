/**
 * The gateway request log — the live surface of `fusionkit serve` (and of any
 * launcher until it hands the terminal to the coding agent). Every fused turn
 * renders as dev-server-style lines: a dim HH:MM:SS timestamp, a colored
 * status glyph, and the structured facts of the phase, instead of flat
 * `fusion: ...` prose:
 *
 *   20:15:31 › turn 2 · fusing openai + sonnet (session 321f653e)
 *   20:15:38 ✔ turn 2 · panel done — 2 candidates (openai ✔, sonnet ✔)
 *   20:15:39 • judge_synth gpt-5.5 · 7788+5 tokens · $0.0098 (session $0.0098)
 *
 * The same renderer backs the model-gateway's injected logger, so engine cost
 * lines and turn failures arrive on the same visual grammar. This module also
 * owns the chatter gate: launchers flip it off before a coding agent owns the
 * screen (raw lines would corrupt its TUI), which silences turn/cost lines —
 * warnings and errors still print, since losing them is worse than a redraw.
 * All styling degrades to plain text when color is off (pipes, CI).
 */
import { bold, cyan, dim, glyph, gray, green, red, uiStream, yellow } from "@routekit/cli-ui";
import type { FusionGatewayLogger } from "@fusionkit/model-gateway";

let chatter = true;

/** Enable/disable the gateway's per-turn request log (default on). */
export function setGatewayChatter(enabled: boolean): void {
  chatter = enabled;
}

/** True while the per-turn request log may write to the terminal. */
export function gatewayChatterEnabled(): boolean {
  return chatter;
}

function timestamp(): string {
  return dim(new Date().toTimeString().slice(0, 8));
}

function write(mark: string, text: string): void {
  uiStream().write(`${timestamp()} ${mark} ${text}\n`);
}

/** `turn.start`: the panel fan-out began. */
export function logTurnStart(input: {
  models: readonly string[];
  sessionKey: string;
  turn: number;
  excluded?: readonly string[];
}): void {
  if (!chatter) return;
  const excluded =
    input.excluded !== undefined && input.excluded.length > 0
      ? ` ${yellow(`(excluding ${input.excluded.join(", ")} after a vendor rate-limit)`)}`
      : "";
  write(
    cyan(glyph.arrow()),
    `turn ${input.turn} · ${bold(`fusing ${input.models.join(" + ")}`)} ${dim(`(session ${input.sessionKey.slice(0, 8)})`)}${excluded}`
  );
}

/** Bound a failure reason to one log line; provider bodies can be huge. */
const FAILURE_DETAIL_MAX = 300;

/**
 * One failed panel candidate, as the turn log renders it: the end-reason kind
 * (`exit_error`, `timeout`, `spawn_error`, ...) distinguishes an internal
 * runner failure from a provider/API rejection, and `detail` carries the
 * harness/provider message (e.g. the upstream HTTP status and error body) so
 * a bare "failed" is debuggable straight from the log.
 */
export function candidateFailureReason(candidate: {
  status: string;
  endReason?: string;
  detail?: string;
}): string | undefined {
  if (candidate.status === "succeeded") return undefined;
  const parts = [candidate.endReason, candidate.detail].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  if (parts.length === 0) return undefined;
  const reason = parts.join(": ").replace(/\s+/g, " ").trim();
  return reason.length > FAILURE_DETAIL_MAX ? `${reason.slice(0, FAILURE_DETAIL_MAX - 1)}…` : reason;
}

/** `turn.candidates`: the panel finished and produced candidate trajectories. */
export function logTurnCandidates(input: {
  turn: number;
  candidates: ReadonlyArray<{ modelId: string; status: string; endReason?: string; detail?: string }>;
}): void {
  if (chatter) {
    const marks = input.candidates
      .map((candidate) =>
        candidate.status === "succeeded"
          ? `${candidate.modelId} ${green(glyph.tick())}`
          : `${candidate.modelId} ${red(candidate.status)}`
      )
      .join(dim(", "));
    write(
      green(glyph.tick()),
      `turn ${input.turn} · panel done ${dim("—")} ${input.candidates.length} candidate${input.candidates.length === 1 ? "" : "s"} ${dim("(")}${marks}${dim(")")}`
    );
  }
  // Failed members always explain themselves (like turn.failed / warnings):
  // one line per failure with its end-reason kind + provider/harness detail,
  // so an `exit_error` is attributable without digging into artifacts.
  for (const candidate of input.candidates) {
    const reason = candidateFailureReason(candidate);
    if (reason === undefined) continue;
    write(
      yellow(glyph.warn()),
      `turn ${input.turn} · ${candidate.modelId} ${red(candidate.status)} ${dim("—")} ${yellow(reason)}`
    );
  }
}

/** `turn.failed`: the panel phase failed outright. Always prints. */
export function logTurnFailed(input: { turn: number; message: string }): void {
  write(red(glyph.cross()), `turn ${input.turn} · panel failed ${dim("—")} ${red(input.message)}`);
}

// The engine's cost lines arrive pre-formatted (see `turnCostLine`):
//   "fusion: <stage> cost: <model> <p>+<c> tokens, this turn <usd>; session total <usd>"
const COST_LINE = /^fusion:\s+(\S+)\s+cost:\s+(\S+)\s+(\S+\+\S+ tokens),\s+this turn ([^;]+);\s+session total (.+)$/;

function renderEngineLine(kind: "warn" | "error", message: string): void {
  const cost = COST_LINE.exec(message);
  if (cost !== null) {
    if (!chatter) return; // cost lines are informational; the receipt totals them
    const [, stage, model, tokens, turnCost, sessionTotal] = cost;
    write(
      gray(glyph.bullet()),
      `${stage} ${bold(model ?? "")} ${dim("·")} ${dim(tokens ?? "")} ${dim("·")} ${cyan(turnCost ?? "")} ${dim(`(session ${sessionTotal})`)}`
    );
    return;
  }
  // Warnings/errors always print: losing them is worse than a TUI redraw.
  const text = message.replace(/^fusion:\s*/, "");
  if (kind === "warn" || /budget cap reached/.test(text)) {
    write(yellow(glyph.warn()), yellow(text));
    return;
  }
  write(red(glyph.cross()), red(text));
}

/**
 * The engine-facing logger: model-gateway components (cost meter, front door,
 * vendor proxy, SSE) log through this, landing on the same request-log grammar
 * as the CLI's own turn lines instead of the engine's flat stderr default.
 */
export const requestLogGatewayLogger: FusionGatewayLogger = {
  warn: (message) => renderEngineLine("warn", message),
  error: (message) => renderEngineLine("error", message)
};

/** The "server is up" line that opens a request log. */
export function logServing(): void {
  write(cyan(glyph.arrow()), `${bold("serving")} ${dim("— request log below · Ctrl+C to stop")}`);
}

/** A front-door request arrived (harness-gateway surfaces without turn phases). */
export function logRequestStart(input: { requestId: string; dialect: string; preview: string }): void {
  if (!chatter) return;
  const preview = input.preview.replace(/\s+/g, " ").trim();
  const clipped = preview.length > 60 ? `${preview.slice(0, 59)}…` : preview;
  write(
    cyan(glyph.arrow()),
    `request ${dim(input.requestId)} · ${bold(input.dialect)} ${dim(`· "${clipped}"`)}`
  );
}

/** A front-door request finished (any terminal status). Failures always print. */
export function logRequestDone(input: { requestId: string; status: string; elapsedMs: number }): void {
  const ok = input.status === "succeeded";
  if (!chatter && ok) return;
  const seconds = `${(input.elapsedMs / 1000).toFixed(1)}s`;
  write(
    ok ? green(glyph.tick()) : red(glyph.cross()),
    `request ${dim(input.requestId)} · ${ok ? input.status : red(input.status)} ${dim(`in ${seconds}`)}`
  );
}
