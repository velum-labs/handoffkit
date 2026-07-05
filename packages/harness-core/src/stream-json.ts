export const STREAM_JSON_MAX_TEXT = 4000;
export const STREAM_JSON_MAX_TOOL_INPUT = 600;

export type StreamJsonStepText = {
  text?: string;
};

export type StreamJsonEmitterOptions<Step extends StreamJsonStepText> = {
  stepsForEvent: (event: Record<string, unknown>) => Step[];
  resultStep: (result: string) => Step;
  onStep: (step: Step & { index: number }) => void;
};

export type ParseStreamJsonOptions<Step extends StreamJsonStepText> = {
  stdout: string;
  stepsForEvent: (event: Record<string, unknown>) => Step[];
  resultStep: (result: string) => Step;
  fallbackText?: (step: Step & { index: number }) => string | undefined;
};

export type ParsedStreamJson<Step extends StreamJsonStepText> = {
  steps: Array<Step & { index: number }>;
  finalOutput: string;
  sawResult: boolean;
  isError: boolean;
};

export function truncateStreamJsonText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function stringifyStreamJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A tool_result `content` is either a string or an array of text/parts. */
export function streamJsonResultContentText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) return direct;
  return asArray(content)
    .map((part) => {
      const obj = asObject(part);
      if (obj === undefined) return "";
      if (obj.type === "text") return asString(obj.text) ?? "";
      return "";
    })
    .filter((text) => text.length > 0)
    .join("");
}

export function parseStreamJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return undefined;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return asObject(event);
}

export function createStreamJsonStepEmitter<Step extends StreamJsonStepText>(
  options: StreamJsonEmitterOptions<Step>
): (line: string) => void {
  let index = 0;
  let lastText = "";
  const push = (step: Step): void => {
    const indexed = { index, ...step };
    index += 1;
    if (indexed.text !== undefined) lastText = indexed.text;
    options.onStep(indexed);
  };
  return (line: string): void => {
    const obj = parseStreamJsonLine(line);
    if (obj === undefined) return;
    if (asString(obj.type) === "result") {
      const result = asString(obj.result);
      if (result !== undefined && result.length > 0 && lastText !== result) {
        push(options.resultStep(result));
      }
      return;
    }
    for (const step of options.stepsForEvent(obj)) push(step);
  };
}

export function parseStreamJsonTrajectory<Step extends StreamJsonStepText>(
  options: ParseStreamJsonOptions<Step>
): ParsedStreamJson<Step> {
  const steps: Array<Step & { index: number }> = [];
  let finalOutput = "";
  let sawResult = false;
  let isError = false;
  const push = (step: Step): void => {
    steps.push({ index: steps.length, ...step });
  };
  for (const line of options.stdout.split("\n")) {
    const obj = parseStreamJsonLine(line);
    if (obj === undefined) continue;
    if (asString(obj.type) === "result") {
      sawResult = true;
      if (obj.is_error === true) isError = true;
      const result = asString(obj.result);
      if (result !== undefined && result.length > 0) finalOutput = result;
      continue;
    }
    for (const step of options.stepsForEvent(obj)) push(step);
  }
  if (finalOutput.length === 0) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i];
      const text = step !== undefined ? (options.fallbackText?.(step) ?? step.text) : undefined;
      if (text !== undefined && text.length > 0) {
        finalOutput = text;
        break;
      }
    }
  } else if (steps.at(-1)?.text !== finalOutput) {
    push(options.resultStep(finalOutput));
  }
  return { steps, finalOutput, sawResult, isError };
}
