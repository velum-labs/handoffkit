export type ModelAccountClass = "api-key" | "subscription" | "proxy";
export type ModelBillingMode =
  | "metered-api"
  | "subscription"
  | "upstream-managed";

export type ModelLabelRoute = {
  provider: string;
  nativeModel: string;
  accountClass?: ModelAccountClass;
  billingMode?: ModelBillingMode;
};

const TOKEN_LABELS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  claude: "Claude",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  gemini: "Gemini",
  o1: "o1",
  o3: "o3",
  qwen: "Qwen",
  deepseek: "DeepSeek"
};

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+\S+/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
];

export function providerBillingMetadata(provider: string): {
  accountClass: ModelAccountClass;
  billingMode: ModelBillingMode;
} {
  switch (provider) {
    case "openai":
    case "anthropic":
    case "google":
    case "openrouter":
      return { accountClass: "api-key", billingMode: "metered-api" };
    case "codex":
    case "claude-code":
      return { accountClass: "subscription", billingMode: "subscription" };
    case "cliproxy":
      return { accountClass: "proxy", billingMode: "upstream-managed" };
    default:
      return { accountClass: "api-key", billingMode: "metered-api" };
  }
}

function nativeModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

function capitalizeToken(token: string): string {
  const mapped = TOKEN_LABELS[token.toLowerCase()];
  if (mapped !== undefined) return mapped;
  if (/^\d/.test(token) || token.includes(".")) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function formatModelHumanName(modelId: string): string {
  const native = nativeModelId(modelId);
  if (/^gpt-\d+(?:\.\d+)?$/.test(native)) {
    return `GPT-${native.slice(4)}`;
  }
  const versionMatch = native.match(/^(.*)-(\d+)-(\d+)$/);
  const basePart = versionMatch ? versionMatch[1]! : native;
  const versionSuffix = versionMatch ? ` ${versionMatch[2]}.${versionMatch[3]!}` : "";
  const words = basePart
    .split("-")
    .filter((token) => token.length > 0)
    .map((token) => capitalizeToken(token));
  return words.join(" ") + versionSuffix;
}

export function formatBillingSourceLabel(route: ModelLabelRoute): string {
  switch (route.provider) {
    case "anthropic":
      return "Anthropic API";
    case "claude-code":
      return "Claude Max";
    case "openai":
      return "OpenAI API";
    case "codex":
      return "ChatGPT subscription";
    case "openrouter":
      return "OpenRouter credits";
    case "google":
      return "Google API";
    case "cliproxy":
      return "Proxy upstream";
    default: {
      const billing = route.accountClass ?? providerBillingMetadata(route.provider).accountClass;
      if (billing === "subscription") return "Subscription";
      if (billing === "proxy") return "Proxy";
      return "API";
    }
  }
}

export function formatBillingModeLabel(billingMode: ModelBillingMode): string {
  switch (billingMode) {
    case "metered-api":
      return "metered API";
    case "subscription":
      return "subscription";
    case "upstream-managed":
      return "upstream managed";
  }
}

export function formatAccountClassLabel(accountClass: ModelAccountClass): string {
  return accountClass;
}

export function sanitizeModelLabel(label: string): string {
  let sanitized = label;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized.trim();
}

export function formatPickerLabel(route: ModelLabelRoute): string {
  const billing = {
    ...providerBillingMetadata(route.provider),
    ...(route.accountClass !== undefined ? { accountClass: route.accountClass } : {}),
    ...(route.billingMode !== undefined ? { billingMode: route.billingMode } : {})
  };
  const label = `${formatModelHumanName(route.nativeModel)} · ${formatBillingSourceLabel({
    ...route,
    ...billing
  })}`;
  return sanitizeModelLabel(label);
}
