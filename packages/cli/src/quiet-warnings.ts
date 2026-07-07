/**
 * Suppress Node's experimental-feature warnings (e.g. node:sqlite) so the CLI's
 * output stays clean for end users. Only the ExperimentalWarning category is
 * dropped; real warnings still surface. Imported first in index.ts so the patch
 * is in place before any module that loads node:sqlite.
 */
type EmitWarning = typeof process.emitWarning;

const original: EmitWarning = process.emitWarning.bind(process);

function isExperimental(warning: string | Error, typeOrOptions: unknown): boolean {
  if (warning instanceof Error && warning.name === "ExperimentalWarning") return true;
  if (typeof typeOrOptions === "string") return typeOrOptions === "ExperimentalWarning";
  if (typeOrOptions !== null && typeof typeOrOptions === "object" && "type" in typeOrOptions) {
    return (typeOrOptions as { type?: unknown }).type === "ExperimentalWarning";
  }
  return false;
}

process.emitWarning = function patchedEmitWarning(
  warning: string | Error,
  typeOrOptions?: unknown,
  ...rest: unknown[]
): void {
  if (isExperimental(warning, typeOrOptions)) return;
  (original as (...args: unknown[]) => void)(warning, typeOrOptions, ...rest);
} as EmitWarning;
