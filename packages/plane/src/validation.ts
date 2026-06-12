import { z } from "zod";

/**
 * Boundary validation for request bodies. Signed objects (chained events,
 * receipts) are validated cryptographically by the plane, not re-described
 * here; these schemas guard the unsigned inputs (run requests, actors,
 * tokens) that nothing else checks. Parsing returns structured errors that
 * the server turns into 400s.
 */
// TODO(hardcoded): zod max lengths (e.g. prompt 1M, untrackedFiles 100k) are fixed; should align with policy/deployment limits.

const actorSchema = z.object({
  kind: z.enum(["human", "service"]),
  id: z.string().min(1).max(256)
});

const manifestFileSchema = z.object({
  path: z.string().min(1).max(4096),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative()
});

const workspaceSchema = z.object({
  version: z.literal("warrant.manifest.v1"),
  baseRef: z.string().min(1).max(256),
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  dirtyDiffHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  untrackedFiles: z.array(manifestFileSchema).max(100000),
  deniedPatterns: z.array(z.string().max(512)).max(10000),
  deniedPaths: z.array(z.string().max(4096)).max(100000)
});

const networkSchema = z.object({
  defaultDeny: z.boolean(),
  allowHosts: z.array(z.string().min(1).max(253)).max(1000)
});

const budgetSchema = z.object({
  maxSpendUsd: z.number().nonnegative().optional(),
  maxDurationMin: z.number().positive().optional()
});

const continuationSchema = z.object({
  envelopeHash: z.string().regex(/^[0-9a-f]{64}$/),
  checkpointId: z.string().min(1).max(256),
  tier: z.enum(["semantic", "workspace"])
});

export const runRequestSchema = z.object({
  requestedBy: actorSchema,
  // TODO(brittle): agentKind is free-form string; not tied to policy.agents.allow at validation time.
  agentKind: z.string().min(1).max(64),
  agentVersion: z.string().max(128).optional(),
  prompt: z.string().min(1).max(1_000_000),
  pool: z.string().min(1).max(128),
  secretNames: z.array(z.string().min(1).max(256)).max(256),
  workspace: workspaceSchema,
  network: networkSchema,
  budget: budgetSchema,
  disclosure: z.enum([
    "none",
    "metadata-only",
    "redacted",
    "minimal-context",
    "full"
  ]),
  isolation: z.enum(["process", "hermetic", "vercel-sandbox"]).optional(),
  continuation: continuationSchema.optional()
});

export const createRunBodySchema = z.object({
  dryRun: z.boolean().optional(),
  request: runRequestSchema
});

export const enrollBodySchema = z.object({
  enrollToken: z.string().min(1).max(4096),
  publicKeyPem: z.string().min(1).max(8192),
  pool: z.string().min(1).max(128)
});

export const claimBodySchema = z.object({
  runnerToken: z.string().min(1).max(4096),
  pool: z.string().min(1).max(128)
});

export const approveBodySchema = z.object({
  actor: actorSchema.optional(),
  /** Optional IdP-issued JWT; when present, the approval is bound to its subject. */
  idpToken: z.string().min(1).max(8192).optional()
});

export const cancelBodySchema = z.object({
  actor: actorSchema.optional()
});

export const eventsBodySchema = z.object({
  claimToken: z.string().min(1).max(8192),
  // TODO(lib): suggest @warrant/protocol zod schemas — events are z.unknown(); structure validated only after HTTP accepts body.
  events: z.array(z.unknown()).max(100000)
});

export const completeBodySchema = z.object({
  claimToken: z.string().min(1).max(8192),
  // TODO(lib): suggest @warrant/protocol zod schemas — receipt is z.unknown(); malformed receipts fail late in plane.complete().
  receipt: z.unknown()
});

export const issuePrincipalBodySchema = z.object({
  name: z.string().min(1).max(128),
  role: z.enum(["admin", "requester", "approver", "enroller"])
});

export class ValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid request: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
    );
    throw new ValidationError(issues);
  }
  return result.data;
}
