import { PROVIDERS, providerKeyProbe } from "@routekit/registry";
import type { ProviderAuthStyle, ProviderKeyProbe } from "@routekit/registry";

export type UrlEndpointConfig = {
  endpointId: string;
  model: string;
  provider?: string;
  baseUrl: string;
  dialect: "openai" | "anthropic" | "google" | "codex";
  headers?: Record<string, string>;
};

export type AccountEndpointConfig = {
  endpointId: string;
  model: string;
  account: "claude-code" | "codex";
};

export type ModelEndpointConfig = UrlEndpointConfig | AccountEndpointConfig;

function isAccountEndpointConfig(
  endpoint: ModelEndpointConfig
): endpoint is AccountEndpointConfig {
  return "account" in endpoint;
}

export type EndpointHealthProbe = {
  url: string;
  headers: Readonly<Record<string, string>>;
  invalidStatuses: readonly number[];
};

export type EndpointHealthProbePlan =
  | { supported: true; probe: EndpointHealthProbe }
  | { supported: false; reason: string };

export type EndpointHealthResult =
  | { kind: "response"; ok: boolean; status: number; authRejected: boolean }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; error: string };

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

function nativeDialectProbe(
  dialect: UrlEndpointConfig["dialect"]
): ProviderKeyProbe | undefined {
  switch (dialect) {
    case "openai":
      return { path: "/models", auth: "bearer", invalidStatuses: [401, 403] };
    case "anthropic":
      return {
        path: "/models",
        auth: "x-api-key",
        extraHeaders: { "anthropic-version": "2023-06-01" },
        invalidStatuses: [401, 403]
      };
    case "google":
      return {
        path: "/models",
        auth: "x-goog-api-key",
        invalidStatuses: [400, 401, 403]
      };
    case "codex":
      return undefined;
    default: {
      const exhaustive: never = dialect;
      throw new Error(`unknown endpoint dialect: ${String(exhaustive)}`);
    }
  }
}

/** Build the registry-defined authentication header without mutating callers. */
export function providerAuthHeaders(
  auth: ProviderAuthStyle,
  credential: string | undefined
): Record<string, string> {
  if (credential === undefined || credential.length === 0) return {};
  switch (auth) {
    case "bearer":
      return { authorization: `Bearer ${credential}` };
    case "x-api-key":
      return { "x-api-key": credential };
    case "x-goog-api-key":
      return { "x-goog-api-key": credential };
    default: {
      const exhaustive: never = auth;
      throw new Error(`unknown provider authentication style: ${String(exhaustive)}`);
    }
  }
}

function probeUrl(baseUrl: string, probePath: string): string {
  const url = new URL(baseUrl);
  const baseSegments = url.pathname.split("/").filter(Boolean);
  const probeSegments = probePath.split("/").filter(Boolean);
  let overlap = Math.min(baseSegments.length, probeSegments.length);
  while (
    overlap > 0 &&
    !baseSegments
      .slice(baseSegments.length - overlap)
      .every((segment, index) => segment === probeSegments[index])
  ) {
    overlap -= 1;
  }
  url.pathname = `/${[...baseSegments, ...probeSegments.slice(overlap)].join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Resolve a read-only endpoint health probe from registry metadata, falling
 * back to the configured provider-native dialect for custom endpoints.
 */
export function endpointHealthProbe(
  endpoint: ModelEndpointConfig,
  credential?: string
): EndpointHealthProbePlan {
  if (isAccountEndpointConfig(endpoint)) {
    return {
      supported: false,
      reason: "account-backed endpoint health is reported by the subscription pool"
    };
  }
  const registryProbe =
    endpoint.provider !== undefined ? providerKeyProbe(endpoint.provider) : undefined;
  const providerInfo =
    endpoint.provider !== undefined ? PROVIDERS[endpoint.provider] : undefined;
  if (
    registryProbe === undefined &&
    providerInfo?.apiCompatibility === "openai-responses"
  ) {
    return {
      supported: false,
      reason: "no safe read-only health probe is defined for the Codex responses provider"
    };
  }
  const metadata = registryProbe ?? nativeDialectProbe(endpoint.dialect);
  if (metadata === undefined) {
    return {
      supported: false,
      reason: "no safe read-only health probe is defined for the Codex responses dialect"
    };
  }
  return {
    supported: true,
    probe: {
      url: probeUrl(endpoint.baseUrl, metadata.path),
      headers: {
        ...endpoint.headers,
        ...metadata.extraHeaders,
        ...providerAuthHeaders(metadata.auth, credential)
      },
      invalidStatuses: metadata.invalidStatuses
    }
  };
}

/** Execute a provider-native health probe without returning request secrets. */
export async function probeEndpointHealth(
  endpoint: ModelEndpointConfig,
  options: {
    credential?: string;
    timeoutMs?: number;
    fetchImpl?: Fetcher;
  } = {}
): Promise<EndpointHealthResult> {
  const plan = endpointHealthProbe(endpoint, options.credential);
  if (!plan.supported) return { kind: "unsupported", reason: plan.reason };
  try {
    const response = await (options.fetchImpl ?? fetch)(plan.probe.url, {
      headers: plan.probe.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
    });
    return {
      kind: "response",
      ok: response.ok,
      status: response.status,
      authRejected: plan.probe.invalidStatuses.includes(response.status)
    };
  } catch {
    return { kind: "error", error: "health probe request failed" };
  }
}
