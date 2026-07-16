import type { SubscriptionMode } from "@routekit/registry";

import type { ProviderFailure } from "@routekit/contracts";
import type { CapacityPoolStrategy } from "@routekit/gateway";

export type SubscriptionSelectionStrategy = CapacityPoolStrategy;

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
  source: "headers" | "usage" | "stream";
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
  limits?: AccountLimits;
};

export type SubscriptionAccountSetSnapshot = {
  mode: SubscriptionMode;
  strategy: SubscriptionSelectionStrategy;
  switchThreshold: number;
  members: SubscriptionMemberStatus[];
};

