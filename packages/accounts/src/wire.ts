import { z } from "zod";

import type { SubscriptionAccountSetSnapshot } from "./types.js";

/**
 * The typed wire contract for the proxy's native usage endpoint. The gateway
 * server serializes account-set snapshots through this schema and
 * `SubscriptionProxyClient` parses responses through it, so the producer and
 * consumer share one source of truth instead of casting an inline shape.
 */
export const SUBSCRIPTION_USAGE_PATH = "/usage";

const rateLimitWindowSchema = z.object({
  utilization: z.number(),
  status: z.string().optional(),
  resetsAt: z.number().optional(),
  windowSeconds: z.number().optional(),
  limitName: z.string().optional()
});

const creditSnapshotSchema = z.object({
  hasCredits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  balance: z.string().optional()
});

const accountLimitsSchema = z.object({
  windows: z.record(z.string(), rateLimitWindowSchema),
  planType: z.string().optional(),
  credits: creditSnapshotSchema.optional(),
  observedAt: z.number(),
  source: z.enum(["headers", "usage", "stream"])
});

const memberStatusSchema = z.object({
  id: z.string(),
  mode: z.enum(["claude-code", "codex"]),
  label: z.string(),
  sourcePath: z.string(),
  expiresAt: z.number().optional(),
  coolingUntil: z.number().optional(),
  active: z.boolean(),
  models: z.array(z.string()),
  limits: accountLimitsSchema.optional()
});

const accountSetSnapshotSchema = z.object({
  mode: z.enum(["claude-code", "codex"]),
  strategy: z.enum(["sticky", "round_robin", "capacity_weighted"]),
  switchThreshold: z.number(),
  members: z.array(memberStatusSchema)
});

/** `GET /usage` response: the live snapshot of every configured account set. */
export const subscriptionUsageResponseSchema = z.object({
  accountSets: z.array(accountSetSnapshotSchema)
});

export type SubscriptionUsageResponse = z.infer<typeof subscriptionUsageResponseSchema>;

/** Build the usage response from account-set snapshots (skips undefined sets). */
export function snapshotsToUsage(
  snapshots: readonly (SubscriptionAccountSetSnapshot | undefined)[]
): SubscriptionUsageResponse {
  return {
    accountSets: snapshots.filter(
      (snapshot): snapshot is SubscriptionAccountSetSnapshot => snapshot !== undefined
    )
  };
}

// Compile-time guarantee that the schema stays aligned with the domain type.
type _AccountSetParity = SubscriptionAccountSetSnapshot extends z.infer<
  typeof accountSetSnapshotSchema
>
  ? true
  : never;
const _accountSetParity: _AccountSetParity = true;
void _accountSetParity;
