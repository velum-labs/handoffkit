/**
 * Strip trailing "/" characters in linear time. A quantified end-anchored
 * regular expression can backtrack polynomially on adversarial input.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

export function trimSurroundingSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x2f) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(start, end);
}

export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function assertAuthenticatedBind(host: string, authToken: string | undefined): void {
  if (isLoopbackHost(host)) return;
  if (authToken !== undefined && authToken.trim().length > 0) return;
  throw new Error(`binding to non-loopback host "${host}" requires an auth token`);
}
