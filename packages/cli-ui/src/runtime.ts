/**
 * Interaction-mode detection. The CLI's rich surfaces (Ink components,
 * prompts, live checklists) only render when we are attached to an interactive
 * terminal and not running under CI; otherwise everything degrades to plain
 * line logs so pipes, captures, and `node --test` stay deterministic.
 */

/** True under a recognized CI environment. */
export function isCI(): boolean {
  const env = process.env;
  return Boolean(
    env.CI === "true" ||
      env.CI === "1" ||
      env.CONTINUOUS_INTEGRATION ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.BUILDKITE ||
      env.CIRCLECI
  );
}

/** The stream all UI is written to (stderr; stdout is reserved for tool output). */
export function uiStream(): NodeJS.WriteStream {
  return process.stderr;
}

let forcedNonInteractive = false;

/**
 * Force non-interactive mode for the rest of the process (the `--no-input` /
 * `--json` global flags). Also exports `ROUTEKIT_NO_TUI=1` so spawned children
 * inherit the same posture.
 */
export function forceNonInteractive(): void {
  forcedNonInteractive = true;
  process.env.ROUTEKIT_NO_TUI = "1";
}

/** True when we should render rich, animated UI to `stream`. */
export function isInteractive(stream: NodeJS.WriteStream = uiStream()): boolean {
  if (forcedNonInteractive) return false;
  if (process.env.ROUTEKIT_NO_TUI === "1") return false;
  if (isCI()) return false;
  return Boolean(stream.isTTY);
}

/** True when we can read interactive keypresses (raw mode) from stdin. */
export function canPromptInteractively(): boolean {
  if (forcedNonInteractive) return false;
  return Boolean(process.stdin.isTTY) && !isCI() && process.env.ROUTEKIT_NO_TUI !== "1";
}
