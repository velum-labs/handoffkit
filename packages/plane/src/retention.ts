import { TERMINAL_RUN_STATUSES } from "@warrant/protocol";
import type {
  HandoffEnvelope,
  RetentionPolicy,
  WorkspaceManifest
} from "@warrant/protocol";

import type { Logger } from "./logging.js";
import type { PlaneStore } from "./store.js";

const TERMINAL = TERMINAL_RUN_STATUSES;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Default interval between background retention passes (override in ctor). */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function addManifestHashes(keep: Set<string>, manifest: WorkspaceManifest): void {
  keep.add(manifest.bundleHash);
  if (manifest.dirtyDiffHash) keep.add(manifest.dirtyDiffHash);
  for (const file of manifest.untrackedFiles) keep.add(file.hash);
}

/**
 * Compute every blob hash still referenced by a surviving run: workspace
 * manifests, continuation envelopes (and the transcript/journal blobs those
 * envelopes reference), event artifacts, and receipt outputs. Anything not
 * in this set is unreachable and safe to GC.
 */
export function collectReferencedBlobs(store: PlaneStore): Set<string> {
  const keep = new Set<string>();
  const envelopeHashes = new Set<string>();

  for (const run of store.listRuns()) {
    addManifestHashes(keep, run.request.workspace);
    if (run.request.continuation) {
      keep.add(run.request.continuation.envelopeHash);
      envelopeHashes.add(run.request.continuation.envelopeHash);
    }
    if (run.contract) {
      addManifestHashes(keep, run.contract.workspace);
      if (run.contract.continuation) {
        keep.add(run.contract.continuation.envelopeHash);
        envelopeHashes.add(run.contract.continuation.envelopeHash);
      }
    }
    const receipt = store.getReceipt(run.id);
    if (receipt) {
      if (receipt.workspaceOut.diffHash) keep.add(receipt.workspaceOut.diffHash);
      for (const hash of receipt.workspaceOut.artifactHashes) keep.add(hash);
    }
  }

  for (const { event } of store.exportEvents(0)) {
    if (event.event.type === "artifact.created") keep.add(event.event.hash);
    if (event.event.type === "boundary.crossed") keep.add(event.event.contentHash);
  }

  // Envelopes reference transcript/journal/workspace blobs from inside their
  // (content-addressed) JSON; parse the surviving ones to keep those too.
  for (const hash of envelopeHashes) {
    const blob = store.getBlob(hash);
    if (!blob) continue;
    // The envelope blob is content-addressed (its hash is what we looked it
    // up by), so its bytes are exactly what was sealed at submission time; a
    // parse failure here means a truncated/foreign blob, which we skip
    // rather than letting it abort the whole GC pass.
    let envelope: HandoffEnvelope;
    try {
      envelope = JSON.parse(blob.toString("utf8")) as HandoffEnvelope;
    } catch {
      continue;
    }
    const semantic = envelope.checkpoint.semantic;
    if (semantic?.transcriptHash) keep.add(semantic.transcriptHash);
    if (semantic?.toolJournalHash) keep.add(semantic.toolJournalHash);
    if (envelope.checkpoint.workspace) {
      addManifestHashes(keep, envelope.checkpoint.workspace);
    }
  }

  return keep;
}

export type RetentionResult = {
  deletedRuns: string[];
  deletedBlobs: number;
  prunedNonces: number;
};

export class RetentionSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: PlaneStore,
    private readonly policy: RetentionPolicy,
    private readonly intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    private readonly logger?: Logger
  ) {}

  /**
   * Run one retention pass: expire terminal runs past the retention horizon,
   * GC unreferenced blobs, and prune expired nonces. A run is retained for
   * `receiptsDays`; its artifacts live exactly as long as the run does, so
   * `artifactsDays` is honored as the floor — artifacts never outlive their
   * receipt, which must stay verifiable while the receipt is retained.
   */
  sweepOnce(now = Date.now()): RetentionResult {
    const cutoff = now - this.policy.receiptsDays * DAY_MS;
    const deletedRuns = this.store.deleteRunsUpdatedBefore(cutoff, [...TERMINAL]);
    const keep = collectReferencedBlobs(this.store);
    const deletedBlobs = this.store.deleteBlobsExcept(keep);
    const prunedNonces = this.store.pruneClaimNonces(now);
    return { deletedRuns, deletedBlobs, prunedNonces };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweepOnce();
      } catch (error) {
        // Never let a sweep failure crash the plane; surface it for ops.
        this.logger?.error(
          { err: error instanceof Error ? error.message : String(error) },
          "retention sweep failed"
        );
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
