import type { ModelReasoningCapabilities } from "@routekit/contracts";
import { trimTrailingSlashes } from "@routekit/runtime";

export type LiveModel = {
  id: string;
  provider?: string;
  capabilities: Readonly<Record<string, string>>;
  reasoning?: ModelReasoningCapabilities;
};

export type LiveCatalog = {
  defaultModel: string;
  models: readonly LiveModel[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export async function fetchLiveCatalog(
  gatewayUrl: string,
  input: { authToken?: string; defaultModel?: string } = {}
): Promise<LiveCatalog> {
  const response = await fetch(`${trimTrailingSlashes(gatewayUrl)}/v1/models`, {
    headers:
      input.authToken === undefined
        ? { accept: "application/json" }
        : {
            accept: "application/json",
            authorization: `Bearer ${input.authToken}`
          }
  });
  if (!response.ok) {
    throw new Error(`gateway model discovery returned HTTP ${response.status}`);
  }
  const payload = record(await response.json());
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const models = data.flatMap((value): LiveModel[] => {
    const entry = record(value);
    if (entry === undefined || typeof entry.id !== "string") return [];
    const capabilities = record(entry.capabilities);
    const reasoning = record(entry.reasoning) as
      | ModelReasoningCapabilities
      | undefined;
    return [
      {
        id: entry.id,
        ...(typeof entry.owned_by === "string"
          ? { provider: entry.owned_by }
          : {}),
        capabilities: Object.fromEntries(
          Object.entries(capabilities ?? {}).flatMap(([name, status]) =>
            typeof status === "string" ? [[name, status]] : []
          )
        ),
        ...(reasoning !== undefined ? { reasoning } : {})
      }
    ];
  });
  if (models.length === 0) throw new Error("gateway model discovery returned no models");
  const ids = models.map((model) => model.id);
  const defaultModel =
    input.defaultModel !== undefined && ids.includes(input.defaultModel)
      ? input.defaultModel
      : ids[0]!;
  return { defaultModel, models };
}

