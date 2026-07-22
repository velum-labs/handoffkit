/**
 * The Ink components behind the presenter's live surfaces: a spinner task, a
 * multi-step checklist, and a byte-download progress bar. Each is driven by a
 * mutable {@link Store} that the imperative controller updates.
 */
import { Box, Text } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import { formatBytes, formatEta } from "../format.js";
import type { ProgressUpdate, StepStatus } from "../presenter.js";
import { SPINNER_FRAMES, glyph, supportsColor } from "../theme.js";

import { Store } from "./store.js";

export type LiveFrameState = {
  lines: readonly string[];
};

export function LiveFrameView({ store }: { store: Store<LiveFrameState> }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <Box flexDirection="column">
      {state.lines.map((line, index) => (
        <Text key={`${index}:${line}`}>{line}</Text>
      ))}
    </Box>
  );
}

/** Animate through the braille spinner frames while mounted. */
export function useSpinnerFrame(intervalMs = 80): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((previous) => (previous + 1) % SPINNER_FRAMES.length);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }, [intervalMs]);
  return SPINNER_FRAMES[frame] ?? "-";
}

// ---------------------------------------------------------------------------
// Task (single spinner line)
// ---------------------------------------------------------------------------

export type TaskState = {
  text: string;
  settled?: { kind: "success" | "fail" | "warn" | "info"; text: string };
};

function settledGlyph(kind: "success" | "fail" | "warn" | "info"): { symbol: string; color: string } {
  switch (kind) {
    case "success":
      return { symbol: glyph.tick(), color: "green" };
    case "fail":
      return { symbol: glyph.cross(), color: "red" };
    case "warn":
      return { symbol: glyph.warn(), color: "yellow" };
    case "info":
      return { symbol: glyph.bullet(), color: "cyan" };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown settle kind: ${String(exhaustive)}`);
    }
  }
}

export function TaskView({ store }: { store: Store<TaskState> }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const frame = useSpinnerFrame();
  if (state.settled !== undefined) {
    const { symbol, color } = settledGlyph(state.settled.kind);
    return (
      <Text>
        <Text color={color}>{symbol}</Text> {state.settled.text}
      </Text>
    );
  }
  return (
    <Text>
      <Text color="cyan">{frame}</Text> {state.text}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export type ChecklistStep = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
};

export type ChecklistState = {
  title?: string;
  steps: ChecklistStep[];
};

function elapsedLabel(step: ChecklistStep): string {
  if (step.startedAt === undefined) return "";
  const end = step.endedAt ?? Date.now();
  const seconds = (end - step.startedAt) / 1000;
  if (seconds < 0.05) return "";
  return ` ${seconds.toFixed(1)}s`;
}

function StepRow({ step, frame }: { step: ChecklistStep; frame: string }): ReactElement {
  let symbol: ReactElement;
  switch (step.status) {
    case "pending":
      symbol = <Text color="gray">{glyph.pending()}</Text>;
      break;
    case "active":
      symbol = <Text color="cyan">{frame}</Text>;
      break;
    case "done":
      symbol = <Text color="green">{glyph.tick()}</Text>;
      break;
    case "failed":
      symbol = <Text color="red">{glyph.cross()}</Text>;
      break;
    case "skipped":
      symbol = <Text color="yellow">{glyph.bullet()}</Text>;
      break;
    default: {
      const exhaustive: never = step.status;
      throw new Error(`unknown step status: ${String(exhaustive)}`);
    }
  }
  return (
    <Text>
      {symbol} {step.label}
      {step.detail !== undefined ? <Text dimColor> {step.detail}</Text> : null}
      <Text color="gray">{elapsedLabel(step)}</Text>
    </Text>
  );
}

export function ChecklistView({ store }: { store: Store<ChecklistState> }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const frame = useSpinnerFrame();
  return (
    <Box flexDirection="column">
      {state.title !== undefined ? <Text dimColor>{state.title}</Text> : null}
      {state.steps.map((step) => (
        <StepRow key={step.id} step={step} frame={frame} />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Download progress
// ---------------------------------------------------------------------------

export type ProgressState = {
  label: string;
  downloaded: number;
  total?: number;
  startedAt: number;
  settled?: { kind: "success" | "fail"; text: string };
};

const BAR_WIDTH = 24;

function ProgressBarLine({ state, frame }: { state: ProgressState; frame: string }): ReactElement {
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const speed = elapsed > 0 ? state.downloaded / elapsed : 0;
  const speedLabel = speed > 0 ? `${formatBytes(speed)}/s` : "";

  if (state.total !== undefined && state.total > 0) {
    const fraction = Math.max(0, Math.min(1, state.downloaded / state.total));
    const filledChar = supportsColor() ? "\u2588" : "#";
    const emptyChar = supportsColor() ? "\u2591" : "-";
    const filled = Math.round(fraction * BAR_WIDTH);
    const pct = `${Math.floor(fraction * 100)}%`.padStart(4);
    const sizes = `${formatBytes(state.downloaded)} / ${formatBytes(state.total)}`;
    const remaining = speed > 0 ? formatEta((state.total - state.downloaded) / speed) : "--:--";
    return (
      <Text>
        {state.label}
        {"  "}
        <Text color="cyan">{filledChar.repeat(filled)}</Text>
        <Text dimColor>{emptyChar.repeat(BAR_WIDTH - filled)}</Text> <Text color="cyan">{pct}</Text>
        {"  "}
        <Text dimColor>
          {sizes}
          {"  "}
          {speedLabel}
          {"  "}eta {remaining}
        </Text>
      </Text>
    );
  }
  return (
    <Text>
      {state.label}
      {"  "}
      <Text color="cyan">{frame}</Text>{" "}
      <Text dimColor>
        {formatBytes(state.downloaded)}
        {speedLabel.length > 0 ? `  ${speedLabel}` : ""}
      </Text>
    </Text>
  );
}

export function ProgressView({ store }: { store: Store<ProgressState> }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const frame = useSpinnerFrame(90);
  if (state.settled !== undefined) {
    const ok = state.settled.kind === "success";
    return (
      <Text>
        <Text color={ok ? "green" : "red"}>{ok ? glyph.tick() : glyph.cross()}</Text> {state.settled.text}
      </Text>
    );
  }
  return <ProgressBarLine state={state} frame={frame} />;
}
