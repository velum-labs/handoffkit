import type { SubscriptionMode } from "@velum-labs/routekit-registry";

import type { ProviderFailure } from "@velum-labs/routekit-contracts";
import type { CapacityPoolStrategy } from "@velum-labs/routekit-gateway";

export type SubscriptionSelectionStrategy = CapacityPoolStrategy;
export type RateLimitObservationSource =
  | "headers"
  | "response"
  | "usage"
  | "stream";

export type SubscriptionCredential = {
  mode: SubscriptionMode;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  sourcePath: string;
};

export type RateLimitWindow = {
  utilization: number;
  status?: string;
  resetsAt?: number;
  windowSeconds?: number;
  limitName?: string;
  observedAt: number;
  source: RateLimitObservationSource;
};

export type CreditSnapshot = {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
};

export type AccountLimits = {
  windows: Record<string, RateLimitWindow>;
  planType?: string;
  credits?: CreditSnapshot;
  observedAt: number;
  source: RateLimitObservationSource;
  /** Whether this observation replaces all windows or updates only those present. */
  completeness: "snapshot" | "partial";
};

export type SubscriptionFailure = Pick<
  ProviderFailure,
  "category" | "message" | "retryAfter" | "resetsAt"
>;

export type SubscriptionMemberStatus = {
  id: string;
  mode: SubscriptionMode;
  label: string;
  sourcePath: string;
  expiresAt?: number;
  coolingUntil?: number;
  active: boolean;
  credentialValid?: boolean;
  relayReady?: boolean;
  models: string[];
  limits?: AccountLimits;
};

export type SubscriptionAccountSetSnapshot = {
  mode: SubscriptionMode;
  strategy: SubscriptionSelectionStrategy;
  switchThreshold: number;
  members: SubscriptionMemberStatus[];
};

