/**
 * Minimal gateway logger. The default preserves the previous stderr behavior
 * without using the global console, while tests and CLIs can inject a presenter-backed
 * implementation.
 */
export type FusionGatewayLogger = {
  warn(message: string): void;
  error(message: string): void;
};

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export const defaultFusionGatewayLogger: FusionGatewayLogger = {
  warn: writeStderr,
  error: writeStderr
};
