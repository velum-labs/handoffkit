/**
 * Shared CLI failure helper: print a one-line `error: ...` to stderr (or a
 * structured `{ error }` payload in --json mode) and exit non-zero. Used for
 * validation that commander does not express directly, so the wording (which
 * tests assert) stays under our control.
 */
import { uiStream } from "@fusionkit/cli-ui";

import { emitJson, isJsonMode } from "./context.js";

export function fail(message: string): never {
  if (isJsonMode()) {
    emitJson({ error: { code: "error", message } });
    process.exit(1);
  }
  uiStream().write(`error: ${message}\n`);
  process.exit(1);
}
