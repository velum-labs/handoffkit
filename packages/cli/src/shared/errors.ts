/**
 * Shared CLI failure helper: print a one-line `error: ...` to stderr and exit
 * non-zero. Used for validation that commander does not express directly, so
 * the wording (which tests assert) stays under our control.
 */
export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}
