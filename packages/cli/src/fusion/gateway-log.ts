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
import { bold, cyan, dim, glyph, gray, green, red, uiStream, yellow } from "@fusionkit/cli-ui";
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

/** `turn.candidates`: the panel finished and produced candidate trajectories. */
export function logTurnCandidates(input: {
  turn: number;
  candidates: ReadonlyArray<{ modelId: string; status: string }>;
}): void {
  if (!chatter) return;
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
