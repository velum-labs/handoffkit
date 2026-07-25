/** OpenAI Chat usage fields consumed by the Responses adapters. */
export type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: Record<string, unknown> | null;
  completion_tokens_details?: Record<string, unknown> | null;
};

/**
 * Translate Chat Completions token accounting to the Responses vocabulary.
 * Detail objects are copied so compatible current and future counters survive;
 * notably cached_tokens and reasoning_tokens retain their native values.
 */
export function chatUsageToResponses(
  usage: OpenAiUsage | null | undefined
): Record<string, unknown> | null {
  if (usage == null) return null;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens =
    usage.total_tokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const inputDetails = usage.prompt_tokens_details;
  const outputDetails = usage.completion_tokens_details;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    inputDetails == null &&
    outputDetails == null
  ) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(inputDetails != null ? { input_tokens_details: { ...inputDetails } } : {}),
    ...(outputDetails != null ? { output_tokens_details: { ...outputDetails } } : {})
  };
}
