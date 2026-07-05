import { z } from "zod";

import {
  ACTOR_KINDS,
  AGENT_KINDS,
  CHECKPOINT_TIERS,
  DISCLOSURE_MODES,
  HEX_HASH_PATTERN,
  parseHostAllowlistEntry,
  parsePoolName,
  parseSecretName,
  parseWorkspaceManifestPath,
  PROTOCOL_VERSIONS,
  SESSION_ISOLATIONS
} from "@fusionkit/protocol";

import { PRINCIPAL_ROLES } from "./store.js";

/**
 * Boundary validation for request bodies. Signed objects (chained events,
 * receipts) are validated cryptographically by the plane, not re-described
 * here; these schemas guard the unsigned inputs (run requests, actors,
 * tokens) that nothing else checks. Parsing returns structured errors that
 * the server turns into 400s.
 */
// The max lengths below are generous DoS guards (a 1M-char prompt, 100k
// untracked files), not policy limits — policy is enforced separately by the
// plane's policy engine. They exist to reject obviously abusive payloads at
// the boundary before any work is done.

const actorSchema = z.object({
  kind: z.enum(ACTOR_KINDS),
  id: z.string().min(1).max(256)
});

const manifestFileSchema = z.object({
  path: z.string().min(1).max(4096).transform(parseWorkspaceManifestPath),
  hash: z.string().regex(HEX_HASH_PATTERN),
  bytes: z.number().int().nonnegative()
});

const workspaceSchema = z.object({
  version: z.literal(PROTOCOL_VERSIONS.manifest),
  baseRef: z.string().min(1).max(256),
  bundleHash: z.string().regex(HEX_HASH_PATTERN),
  dirtyDiffHash: z.string().regex(HEX_HASH_PATTERN).optional(),
  untrackedFiles: z.array(manifestFileSchema).max(100000),
  deniedPatterns: z.array(z.string().max(512)).max(10000),
  deniedPaths: z
    .array(z.string().max(4096).transform(parseWorkspaceManifestPath))
    .max(100000)
});

const networkSchema = z.object({
  defaultDeny: z.boolean(),
  allowHosts: z.array(z.string().min(1).max(253).transform(parseHostAllowlistEntry)).max(1000)
});

const budgetSchema = z.object({
  maxSpendUsd: z.number().nonnegative().optional(),
  maxDurationMin: z.number().positive().optional()
});

const continuationSchema = z.object({
  envelopeHash: z.string().regex(HEX_HASH_PATTERN),
  checkpointId: z.string().min(1).max(256),
  tier: z.enum(CHECKPOINT_TIERS)
});

const executionEnvSchema = z
  .object({
    inherit: z.array(z.string().min(1).max(128)).max(256).optional(),
    secrets: z
      .array(
        z.object({
          env: z.string().min(1).max(256).transform(parseSecretName),
          secretName: z.string().min(1).max(256).transform(parseSecretName)
        })
      )
      .max(256)
      .optional(),
    vars: z.record(z.string().min(1).max(256), z.string().max(100000)).optional(),
    egressProxy: z.boolean().optional()
  })
  .strict();

const executionLogSchema = z
  .object({
    stdout: z.literal("capture"),
    stderr: z.enum(["merge", "capture"]),
    maxBytes: z.number().int().positive().optional()
  })
  .strict();

const executionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shell"),
      script: z.string().min(1).max(1_000_000),
      shell: z.enum(["sh", "bash"]).optional(),
      cwd: z.string().min(1).max(4096).transform(parseWorkspaceManifestPath).optional(),
      timeoutMs: z.number().int().positive().optional(),
      env: executionEnvSchema.optional(),
      log: executionLogSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("argv"),
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(100000)).max(10000),
      cwd: z.string().min(1).max(4096).transform(parseWorkspaceManifestPath).optional(),
      timeoutMs: z.number().int().positive().optional(),
      env: executionEnvSchema.optional(),
      log: executionLogSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      agent: z
        .object({
          kind: z.enum(AGENT_KINDS),
          version: z.string().max(128).optional()
        })
        .strict(),
      prompt: z.string().min(1).max(1_000_000),
      timeoutMs: z.number().int().positive().optional(),
      env: executionEnvSchema.optional(),
      log: executionLogSchema.optional()
    })
    .strict()
]);

export const runRequestSchema = z.object({
  requestedBy: actorSchema,
  // agentKind is validated structurally; whether the kind is *permitted* is
  // the policy engine's decision at contract time, not the schema's.
  agentKind: z.string().min(1).max(64),
  agentVersion: z.string().max(128).optional(),
  prompt: z.string().min(1).max(1_000_000),
  pool: z.string().min(1).max(128).transform(parsePoolName),
  secretNames: z.array(z.string().min(1).max(256).transform(parseSecretName)).max(256),
  workspace: workspaceSchema,
  network: networkSchema,
  budget: budgetSchema,
  disclosure: z.enum(DISCLOSURE_MODES),
  execution: executionSchema.optional(),
  isolation: z.enum(SESSION_ISOLATIONS).optional(),
  continuation: continuationSchema.optional()
});

export const createRunBodySchema = z.object({
  dryRun: z.boolean().optional(),
  request: runRequestSchema
});

export const enrollBodySchema = z.object({
  enrollToken: z.string().min(1).max(4096),
  publicKeyPem: z.string().min(1).max(8192),
  pool: z.string().min(1).max(128).transform(parsePoolName)
});

export const claimBodySchema = z.object({
  runnerToken: z.string().min(1).max(4096),
  pool: z.string().min(1).max(128).transform(parsePoolName)
});

export const approveBodySchema = z.object({
  actor: actorSchema.optional(),
  /** Optional IdP-issued JWT; when present, the approval is bound to its subject. */
  idpToken: z.string().min(1).max(8192).optional()
});

export const cancelBodySchema = z.object({
  actor: actorSchema.optional()
});

// Events and receipts are signed, hash-chained objects. Their integrity is
// verified cryptographically inside the plane (chain verification + runner
// signature), which is a stronger gate than any structural schema. The
// schema here only bounds the envelope shape/size; the crypto check is
// authoritative, so re-describing the full object as zod would be redundant.
export const eventsBodySchema = z.object({
  claimToken: z.string().min(1).max(8192),
  events: z.array(z.unknown()).max(100000)
});

export const completeBodySchema = z.object({
  claimToken: z.string().min(1).max(8192),
  receipt: z.unknown()
});

export const issuePrincipalBodySchema = z.object({
  name: z.string().min(1).max(128),
  role: z.enum(PRINCIPAL_ROLES)
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
