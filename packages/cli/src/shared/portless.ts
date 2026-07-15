import {
  createActivePortlessSession,
  createPortlessSession as createSession,
  detectPortlessProxy,
  reapPortlessProject,
  reapPortlessService
} from "@routekit/runtime";
import type {
  DetectedProxy,
  DiscoverOrSpawnInput,
  DiscoverOrSpawnResult,
  PortlessModule,
  PortlessOptions,
  PortlessSession,
  RouteMapping,
  RouteStoreLike,
  SpawnedService
} from "@routekit/runtime";

export type {
  DetectedProxy,
  DiscoverOrSpawnInput,
  DiscoverOrSpawnResult,
  PortlessModule,
  PortlessSession,
  RouteMapping,
  RouteStoreLike,
  SpawnedService
};

const fusionPortlessOptions = (
  log?: (line: string) => void,
  overrides: Partial<PortlessOptions> = {}
): PortlessOptions => ({
  project: "fusion",
  ownerLabel: "fusion",
  bareNames: ["scope"],
  ...overrides,
  ...(log !== undefined ? { log } : {})
});

export const stateDir = (): string =>
  process.env.PORTLESS_STATE_DIR ??
  `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.portless`;

export const caCertPath = (): string => `${stateDir()}/ca.pem`;
export const tld = (): string => process.env.PORTLESS_TLD ?? "localhost";

export async function detectProxy(): Promise<DetectedProxy | undefined> {
  return detectPortlessProxy({ stateDirectory: stateDir() });
}

export type CreateSessionInput = {
  enabled: boolean;
  log?: (line: string) => void;
};

export async function createPortlessSession(input: CreateSessionInput): Promise<PortlessSession> {
  return createSession(input.enabled, fusionPortlessOptions(input.log));
}

export function activeSession(
  portless: PortlessModule,
  proxy: DetectedProxy,
  input: CreateSessionInput
): PortlessSession {
  return createActivePortlessSession(portless, proxy, fusionPortlessOptions(input.log));
}

export async function reapService(
  name: string,
  log?: (line: string) => void
): Promise<boolean> {
  return reapPortlessService(name, fusionPortlessOptions(log));
}

export async function reapFusionServices(log?: (line: string) => void): Promise<number> {
  return reapPortlessProject(fusionPortlessOptions(log));
}
