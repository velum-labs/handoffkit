/**
 * Ink prompt components: select, multi-select, confirm, and free text. Each
 * renders live while the user decides, then settles into a single answer line
 * (message + chosen value) that persists after unmount — so a finished wizard
 * reads as a tidy transcript of the choices made.
 *
 * Ctrl+C aborts via `onAbort` (the facade exits 130, matching the CLI's
 * SIGINT convention).
 */
import { Box, Text, useInput } from "ink";
import { useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import { fuzzyFilter } from "../fuzzy.js";
import { glyph } from "../theme.js";

import { useSpinnerFrame } from "./components.js";
import { Store } from "./store.js";

export type PromptOption<T> = { value: T; label: string; hint?: string };

type SelectProps<T> = {
  message: string;
  options: ReadonlyArray<PromptOption<T>>;
  defaultIndex: number;
  onSubmit: (value: T, label: string) => void;
  onAbort: () => void;
  /** Esc pressed (wizard back-navigation); omitted = Esc is ignored. */
  onBack?: (() => void) | undefined;
};

function AnswerLine({ message, answer }: { message: string; answer: string }): ReactElement {
  return (
    <Text>
      <Text color="green">{glyph.tick()}</Text> <Text bold>{message}</Text> <Text dimColor>· {answer}</Text>
    </Text>
  );
}

/** How many options to show around the cursor before scrolling the window. */
const WINDOW = 10;

function windowBounds(cursor: number, total: number): { start: number; end: number } {
  if (total <= WINDOW) return { start: 0, end: total };
  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), total - WINDOW));
  return { start, end: start + WINDOW };
}

export function SelectPrompt<T>({
  message,
  options,
  defaultIndex,
  onSubmit,
  onAbort,
  onBack
}: SelectProps<T>): ReactElement {
  const [cursor, setCursor] = useState(defaultIndex);
  const [answer, setAnswer] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") {
      onAbort();
      return;
    }
    if (key.escape && onBack !== undefined) {
      onBack();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((previous) => (previous - 1 + options.length) % options.length);
    } else if (key.downArrow || input === "j") {
      setCursor((previous) => (previous + 1) % options.length);
    } else if (key.return) {
      const option = options[cursor];
      if (option !== undefined) {
        setAnswer(option.label);
        onSubmit(option.value, option.label);
      }
    }
  });

  if (answer !== undefined) return <AnswerLine message={message} answer={answer} />;

  const { start, end } = windowBounds(cursor, options.length);
  return (
    <Box flexDirection="column">
      <Text bold>{message}</Text>
      {start > 0 ? <Text dimColor>  … {start} more above</Text> : null}
      {options.slice(start, end).map((option, offset) => {
        const index = start + offset;
        const active = index === cursor;
        return (
          <Text key={index}>
            <Text color="cyan">{active ? glyph.pointer() : " "}</Text>{" "}
            {active ? <Text color="cyan">{option.label}</Text> : <Text>{option.label}</Text>}
            {option.hint !== undefined ? <Text dimColor> — {option.hint}</Text> : null}
          </Text>
        );
      })}
      {end < options.length ? <Text dimColor>  … {options.length - end} more below</Text> : null}
      <Text dimColor>  (arrows to move, enter to select)</Text>
    </Box>
  );
}

type MultiSelectProps<T> = {
  message: string;
  options: ReadonlyArray<PromptOption<T>>;
  defaultSelected: ReadonlySet<number>;
  onSubmit: (values: T[], labels: string[]) => void;
  onAbort: () => void;
};

export function MultiSelectPrompt<T>({
  message,
  options,
  defaultSelected,
  onSubmit,
  onAbort
}: MultiSelectProps<T>): ReactElement {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set(defaultSelected));
  const [answer, setAnswer] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") {
      onAbort();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((previous) => (previous - 1 + options.length) % options.length);
    } else if (key.downArrow || input === "j") {
      setCursor((previous) => (previous + 1) % options.length);
    } else if (input === " ") {
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
    } else if (input === "a") {
      setSelected((previous) =>
        previous.size === options.length ? new Set() : new Set(options.map((_, index) => index))
      );
    } else if (key.return) {
      const indices = [...selected].sort((left, right) => left - right);
      const chosen = indices
        .map((index) => options[index])
        .filter((option): option is PromptOption<T> => option !== undefined);
      const labels = chosen.map((option) => option.label);
      setAnswer(labels.length > 0 ? labels.join(", ") : "(none)");
      onSubmit(
        chosen.map((option) => option.value),
        labels
      );
    }
  });

  if (answer !== undefined) return <AnswerLine message={message} answer={answer} />;

  const { start, end } = windowBounds(cursor, options.length);
  return (
    <Box flexDirection="column">
      <Text bold>{message}</Text>
      {start > 0 ? <Text dimColor>  … {start} more above</Text> : null}
      {options.slice(start, end).map((option, offset) => {
        const index = start + offset;
        const active = index === cursor;
        const checked = selected.has(index);
        return (
          <Text key={index}>
            <Text color="cyan">{active ? glyph.pointer() : " "}</Text>{" "}
            <Text color={checked ? "green" : undefined}>
              {checked ? glyph.checkboxOn() : glyph.checkboxOff()}
            </Text>{" "}
            {active ? <Text color="cyan">{option.label}</Text> : <Text>{option.label}</Text>}
            {option.hint !== undefined ? <Text dimColor> — {option.hint}</Text> : null}
          </Text>
        );
      })}
      {end < options.length ? <Text dimColor>  … {options.length - end} more below</Text> : null}
      <Text dimColor>  (space to toggle, a for all, enter to accept)</Text>
    </Box>
  );
}

type ConfirmProps = {
  message: string;
  defaultValue: boolean;
  onSubmit: (value: boolean) => void;
  onAbort: () => void;
  onBack?: (() => void) | undefined;
};

export function ConfirmPrompt({ message, defaultValue, onSubmit, onAbort, onBack }: ConfirmProps): ReactElement {
  const [choice, setChoice] = useState(defaultValue);
  const [answer, setAnswer] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") {
      onAbort();
      return;
    }
    if (key.escape && onBack !== undefined) {
      onBack();
      return;
    }
    // Batched input ("n\r") answers directly; a bare newline accepts the choice.
    const lowered = input.trim().toLowerCase();
    if (lowered === "y" || lowered.startsWith("y")) {
      setAnswer("yes");
      onSubmit(true);
    } else if (lowered === "n" || lowered.startsWith("n")) {
      setAnswer("no");
      onSubmit(false);
    } else if (key.leftArrow || key.rightArrow || key.tab) {
      setChoice((previous) => !previous);
    } else if (key.return || /[\r\n]/.test(input)) {
      setAnswer(choice ? "yes" : "no");
      onSubmit(choice);
    }
  });

  if (answer !== undefined) return <AnswerLine message={message} answer={answer} />;
  return (
    <Text>
      <Text bold>{message}</Text>{" "}
      <Text color={choice ? "cyan" : undefined} bold={choice}>
        yes
      </Text>
      <Text dimColor> / </Text>
      <Text color={choice ? undefined : "cyan"} bold={!choice}>
        no
      </Text>
      <Text dimColor>  (y/n, arrows to switch, enter to accept)</Text>
    </Text>
  );
}

type TextProps = {
  message: string;
  defaultValue: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onAbort: () => void;
  onBack?: (() => void) | undefined;
};

/** Strip control characters from typed/pasted input. */
function printable(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export function TextPrompt({ message, defaultValue, placeholder, onSubmit, onAbort, onBack }: TextProps): ReactElement {
  const [value, setValue] = useState("");
  const [answer, setAnswer] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") {
      onAbort();
      return;
    }
    if (key.escape && onBack !== undefined) {
      onBack();
      return;
    }
    // Rapid/pasted input arrives as one chunk, possibly with an embedded
    // newline: everything before the first newline is typed text, the newline
    // submits (matching what typing the same keys slowly would do).
    const newlineIndex = input.search(/[\r\n]/);
    if (key.return || newlineIndex !== -1) {
      const prefix = newlineIndex === -1 ? printable(input) : printable(input.slice(0, newlineIndex));
      const merged = value + prefix;
      const final = merged.length > 0 ? merged : defaultValue;
      setAnswer(final.length > 0 ? final : "(empty)");
      onSubmit(final);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((previous) => previous.slice(0, -1));
      return;
    }
    // Ignore other control sequences (arrows etc); append printable input.
    if (input.length > 0 && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) {
      setValue((previous) => previous + printable(input));
    }
  });

  if (answer !== undefined) return <AnswerLine message={message} answer={answer} />;

  const hint = placeholder ?? (defaultValue.length > 0 ? defaultValue : undefined);
  return (
    <Text>
      <Text bold>{message}</Text>{" "}
      {value.length > 0 ? <Text>{value}</Text> : hint !== undefined ? <Text dimColor>{hint}</Text> : null}
      <Text color="cyan">{"\u2588"}</Text>
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Fuzzy select (type-to-filter picker, optionally fed by a live loader)
// ---------------------------------------------------------------------------

/** Live option feed: the facade refreshes `options` while the picker is open. */
export type FuzzyFeed<T> = {
  options: ReadonlyArray<PromptOption<T>>;
  /** True while a background refresh is in flight (renders a spinner note). */
  loading: boolean;
  /** A dim note about the feed, e.g. "refreshing model catalog…". */
  note?: string;
};

type FuzzySelectProps<T> = {
  message: string;
  feed: Store<FuzzyFeed<T>>;
  placeholder?: string | undefined;
  onSubmit: (value: T, label: string) => void;
  onAbort: () => void;
  onBack?: (() => void) | undefined;
};

/** Render `label` with the fuzzy-matched positions highlighted. */
function HighlightedLabel({
  label,
  positions,
  active
}: {
  label: string;
  positions: readonly number[];
  active: boolean;
}): ReactElement {
  if (positions.length === 0) {
    return active ? <Text color="cyan">{label}</Text> : <Text>{label}</Text>;
  }
  const matched = new Set(positions);
  const parts: ReactElement[] = [];
  let run = "";
  let runMatched = matched.has(0);
  const flush = (index: number): void => {
    if (run.length === 0) return;
    parts.push(
      runMatched ? (
        <Text key={index} color="cyan" bold>
          {run}
        </Text>
      ) : active ? (
        <Text key={index} color="cyan">
          {run}
        </Text>
      ) : (
        <Text key={index}>{run}</Text>
      )
    );
    run = "";
  };
  for (let index = 0; index < label.length; index++) {
    const isMatch = matched.has(index);
    if (isMatch !== runMatched) {
      flush(index);
      runMatched = isMatch;
    }
    run += label[index] ?? "";
  }
  flush(label.length);
  return <Text>{parts}</Text>;
}

export function FuzzySelectPrompt<T>({
  message,
  feed,
  placeholder,
  onSubmit,
  onAbort,
  onBack
}: FuzzySelectProps<T>): ReactElement {
  const state = useSyncExternalStore(feed.subscribe, feed.get, feed.get);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const frame = useSpinnerFrame();

  const results = fuzzyFilter(query, state.options, (option) => option.label);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") {
      onAbort();
      return;
    }
    if (key.escape) {
      if (query.length > 0) setQuery("");
      else if (onBack !== undefined) onBack();
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setCursor((previous) => (results.length === 0 ? 0 : (previous - 1 + results.length) % results.length));
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setCursor((previous) => (results.length === 0 ? 0 : (previous + 1) % results.length));
      return;
    }
    if (key.return) {
      const picked = results[Math.min(cursor, Math.max(0, results.length - 1))];
      if (picked !== undefined) {
        setAnswer(picked.item.label);
        onSubmit(picked.item.value, picked.item.label);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((previous) => previous.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
      setQuery((previous) => previous + printable(input));
      setCursor(0);
    }
  });

  if (answer !== undefined) return <AnswerLine message={message} answer={answer} />;

  const boundedCursor = Math.min(cursor, Math.max(0, results.length - 1));
  const { start, end } = windowBounds(boundedCursor, results.length);
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{message}</Text>{" "}
        {query.length > 0 ? (
          <Text>{query}</Text>
        ) : placeholder !== undefined ? (
          <Text dimColor>{placeholder}</Text>
        ) : null}
        <Text color="cyan">{"\u2588"}</Text>
        {state.loading ? (
          <Text dimColor>
            {"  "}
            {frame} {state.note ?? "refreshing…"}
          </Text>
        ) : null}
      </Text>
      {results.length === 0 ? (
        <Text dimColor>  no matches{query.length > 0 ? ` for "${query}"` : ""} (esc clears)</Text>
      ) : null}
      {start > 0 ? <Text dimColor>  … {start} more above</Text> : null}
      {results.slice(start, end).map((result, offset) => {
        const index = start + offset;
        const active = index === boundedCursor;
        return (
          <Text key={`${index}-${result.item.label}`}>
            <Text color="cyan">{active ? glyph.pointer() : " "}</Text>{" "}
            <HighlightedLabel label={result.item.label} positions={result.match.positions} active={active} />
            {result.item.hint !== undefined ? <Text dimColor> — {result.item.hint}</Text> : null}
          </Text>
        );
      })}
      {end < results.length ? <Text dimColor>  … {results.length - end} more below</Text> : null}
      <Text dimColor>  (type to filter, arrows to move, enter to select)</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Ghost text (free text with an inline autocomplete suggestion)
// ---------------------------------------------------------------------------

type GhostTextProps = {
  message: string;
  /** Ranked suggestion candidates; the first prefix-completion wins. */
  suggestions: ReadonlyArray<string>;
  placeholder?: string | undefined;
  defaultValue: string;
  onSubmit: (value: string) => void;
  onAbort: () => void;
  onBack?: (() => void) | undefined;
};

/** The inline (ghost) completion for `value`: the remainder of the best prefix match. */
export function ghostRemainder(value: string, suggestions: ReadonlyArray<string>): string | undefined {
  if (value.length === 0) return undefined;
  const lower = value.toLowerCase();
  for (const suggestion of suggestions) {
    if (suggestion.toLowerCase().startsWith(lower) && suggestion.length > value.length) {
      return suggestion.slice(value.length);
    }
  }
  return undefined;
}

export function GhostTextPrompt({
  message,
  suggestions,
  placeholder,
  defaultValue,
  onSubmit,
  onAbort,
  onBack
}: GhostTextProps): ReactElement {
  const [value, setValue] = useState("");
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const ghost = ghostRemainder(value, suggestions);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") {
      onAbort();
      return;
    }
    if (key.escape && onBack !== undefined) {
      onBack();
      return;
    }
    if (key.tab || (key.rightArrow && ghost !== undefined)) {
      if (ghost !== undefined) setValue((previous) => previous + ghost);
      return;
    }
    const newlineIndex = input.search(/[\r\n]/);
    if (key.return || newlineIndex !== -1) {
      const prefix = newlineIndex === -1 ? printable(input) : printable(input.slice(0, newlineIndex));
      const merged = value + prefix;
      const final = merged.length > 0 ? merged : defaultValue;
      setAnswer(final.length > 0 ? final : "(empty)");
      onSubmit(final);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((previous) => previous.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setValue((previous) => previous + printable(input));
    }
  });

  if (answer !== undefined) return <AnswerLine message={message} answer={answer} />;

  const hint = placeholder ?? (defaultValue.length > 0 ? defaultValue : undefined);
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{message}</Text>{" "}
        {value.length > 0 ? <Text>{value}</Text> : hint !== undefined ? <Text dimColor>{hint}</Text> : null}
        {ghost !== undefined ? <Text dimColor>{ghost}</Text> : null}
        <Text color="cyan">{"\u2588"}</Text>
      </Text>
      {ghost !== undefined ? <Text dimColor>  (tab completes the suggestion)</Text> : null}
    </Box>
  );
}
