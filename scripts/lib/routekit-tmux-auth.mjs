import assert from "node:assert/strict";

export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

export function tmuxClientEnvironment(env = process.env) {
  return Object.fromEntries(
    [
      ["PATH", env.PATH],
      ["HOME", env.HOME],
      ["TMPDIR", env.TMPDIR],
      ["LANG", env.LANG ?? "en_US.UTF-8"],
      ["TERM", "xterm-256color"],
      [
        CURSOR_API_KEY_ENV,
        typeof env[CURSOR_API_KEY_ENV] === "string" &&
        env[CURSOR_API_KEY_ENV].length > 0
          ? env[CURSOR_API_KEY_ENV]
          : undefined
      ]
    ].filter((entry) => entry[1] !== undefined)
  );
}

export function ensureTmuxCursorAuthUpdate(runTmux) {
  const current = runTmux("show-options", "-gqv", "update-environment");
  if (
    current.status !== 0 &&
    /no server running|(?:failed|error) connecting .*(?:no such file|connection refused)/i.test(
      current.stderr
    )
  ) {
    return;
  }
  assert.equal(current.status, 0, "failed to inspect tmux update-environment");
  const names = current.stdout.split(/\r?\n/).filter(Boolean);
  if (names.includes(CURSOR_API_KEY_ENV)) return;
  const updated = runTmux(
    "set-option",
    "-ag",
    "update-environment",
    CURSOR_API_KEY_ENV
  );
  assert.equal(updated.status, 0, "failed to configure tmux auth forwarding");
}

export function cursorAuthTmuxSessionArgs() {
  return ["-e", CURSOR_API_KEY_ENV];
}
