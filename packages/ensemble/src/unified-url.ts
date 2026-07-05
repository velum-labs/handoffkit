export function normalizeFusionBackendUrl(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeFusionBackendUrl(baseUrl);
  return normalized.endsWith("/v1")
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}
