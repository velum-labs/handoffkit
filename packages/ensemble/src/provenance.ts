/**
 * Real-lite producer provenance for the ensemble's protocol records (WS7).
 *
 * Every model-fusion record the ensemble emits (harness run request/result,
 * candidate record, judge synthesis record, tool execution record) stamps a
 * `producer` / `producer_version` / `producer_git_sha`. These used to be
 * hardcoded (`producer_git_sha = "0".repeat(40)`, `producer_version = "0.1.0"`),
 * which the production-readiness audit flagged as faked provenance.
 *
 * Here we resolve the *real* values once at module load:
 *   - `PRODUCER_GIT_SHA`  — a build-time stamp, else a checkout `git rev-parse`,
 *     else the `"unknown"` sentinel (never 40 zeros). See
 *     {@link resolveProducerGitSha} in `@fusionkit/gateway`.
 *   - `PRODUCER_VERSION`  — this package's own `package.json` version.
 *
 * The resolver lives in `@fusionkit/gateway` (an existing ensemble
 * dependency) so the gateway's `model-call-record` producer and the ensemble's
 * record producers share one strategy rather than duplicating it.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readProducerVersion, resolveProducerGitSha } from "@routekit/gateway";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

export const PRODUCER = "handoffkit-ensemble";
export const PRODUCER_VERSION = readProducerVersion(PACKAGE_DIR);
export const PRODUCER_GIT_SHA = resolveProducerGitSha(PACKAGE_DIR);
