import type {
  HandoffEnvelope,
  RetentionPolicy,
  RunStatus,
  WorkspaceManifest
} from "@warrant/protocol";

import type { PlaneStore } from "./store.js";

// TODO(hardcoded): terminal statuses and sweep interval default (1h) are not configurable outside RetentionSweeper ctor.
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
const DAY_MS = 24 * 60 * 60 * 1000;

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
    let envelope: HandoffEnvelope;
    try {
      // TODO(brittle): envelope JSON parsed without schema validation; malformed blobs are silently skipped during GC.
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
    private readonly intervalMs = 60 * 60 * 1000
  ) {}

  /** Run one retention pass: expire old terminal runs, GC blobs, prune nonces. */
  sweepOnce(now = Date.now()): RetentionResult {
    // TODO(brittle): only receiptsDays drives run deletion; policy.artifactsDays is defined but never applied separately.
    const cutoff = now - this.policy.receiptsDays * DAY_MS;
    const deletedRuns = this.store.deleteRunsUpdatedBefore(cutoff, TERMINAL);
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
      } catch {
        // TODO(brittle): sweeper errors are swallowed with no logging; retention failures go unnoticed until disk fills.
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
