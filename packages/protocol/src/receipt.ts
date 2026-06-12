import { contractHash, verifyContractSignature } from "./contract.js";
import { hashCanonical } from "./hash.js";
import { keyIdFromPublicPem, signData, verifyData } from "./keys.js";
import { verifyChain } from "./chain.js";
import type {
  ChainedEvent,
  Receipt,
  ReceiptBundle,
  RunEvent,
  Signature
} from "./types.js";

function signablePayload(receipt: Receipt): string {
  const { signatures: _signatures, ...unsigned } = receipt;
  return hashCanonical(unsigned);
}

export function signReceipt(
  receipt: Receipt,
  privateKeyPem: string,
  publicKeyPem: string,
  signer: Signature["signer"]
): Receipt {
  const payload = signablePayload(receipt);
  const signature: Signature = {
    keyId: keyIdFromPublicPem(publicKeyPem),
    alg: "ed25519",
    signer,
    sig: signData(privateKeyPem, payload)
  };
  return { ...receipt, signatures: [...receipt.signatures, signature] };
}

function verifyReceiptSignature(
  receipt: Receipt,
  signer: Signature["signer"],
  publicKeyPem: string
): boolean {
  const payload = signablePayload(receipt);
  const signature = receipt.signatures.find((s) => s.signer === signer);
  if (!signature) return false;
  if (keyIdFromPublicPem(publicKeyPem) !== signature.keyId) return false;
  return verifyData(publicKeyPem, payload, signature.sig);
}

export type BundleVerification = {
  ok: boolean;
  problems: string[];
};

function terminalEventMatches(event: RunEvent, status: Receipt["status"]): boolean {
  switch (status) {
    case "completed":
      return event.type === "run.completed";
    case "failed":
      return event.type === "run.failed";
    case "cancelled":
      return event.type === "run.cancelled";
    default: {
      const exhausted: never = status;
      throw new Error(`unreachable status: ${String(exhausted)}`);
    }
  }
}

/**
 * Fully offline verification of a receipt bundle. Trusts nothing but the
 * keys embedded in the bundle, which callers should pin or resolve from
 * the org's published key manifest.
 */
export function verifyReceiptBundle(bundle: ReceiptBundle): BundleVerification {
  const problems: string[] = [];
  const { contract, receipt, events, keys } = bundle;

  const expectedContractHash = contractHash(contract);
  if (receipt.contractHash !== expectedContractHash) {
    problems.push("receipt.contractHash does not match the bundled contract");
  }

  if (
    !verifyContractSignature(contract, "plane", (keyId) =>
      keyId === keyIdFromPublicPem(keys.planePublicKeyPem)
        ? keys.planePublicKeyPem
        : undefined
    )
  ) {
    problems.push("contract plane signature invalid");
  }

  if (!verifyReceiptSignature(receipt, "runner", keys.runnerPublicKeyPem)) {
    problems.push("receipt runner signature invalid");
  }
  if (!verifyReceiptSignature(receipt, "plane", keys.planePublicKeyPem)) {
    problems.push("receipt plane countersignature invalid");
  }

  const chain = verifyChain(events, expectedContractHash);
  if (!chain.ok) {
    problems.push(
      `event chain broken at seq ${chain.brokenAtSeq}: ${chain.reason}`
    );
  }

  const last = events[events.length - 1];
  if (!last) {
    problems.push("event chain is empty");
  } else {
    if (receipt.eventsHead !== last.hash) {
      problems.push("receipt.eventsHead does not match the last event hash");
    }
    if (receipt.eventCount !== events.length) {
      problems.push("receipt.eventCount does not match the event chain");
    }
    if (!terminalEventMatches(last.event, receipt.status)) {
      problems.push("terminal event does not match receipt status");
    }
  }

  if (receipt.workspaceIn.baseRef !== contract.workspace.baseRef) {
    problems.push("receipt.workspaceIn.baseRef does not match the contract");
  }
  const manifestHash = hashCanonical(contract.workspace);
  if (receipt.workspaceIn.manifestHash !== manifestHash) {
    problems.push("receipt.workspaceIn.manifestHash does not match the contract");
  }

  const releasedInEvents = events
    .filter((e) => e.event.type === "secret.released")
    .map((e) => (e.event.type === "secret.released" ? e.event.name : ""))
    .sort();
  const releasedInReceipt = receipt.secretsReleased.map((r) => r.name).sort();
  // TODO(brittle): secret list equality via JSON.stringify
  if (JSON.stringify(releasedInEvents) !== JSON.stringify(releasedInReceipt)) {
    problems.push("secretsReleased does not match secret.released events");
  }

  if (receipt.workspaceOut.diffHash !== "") {
    const artifactHashes = new Set(
      events
        .filter((e) => e.event.type === "artifact.created")
        .map((e) => (e.event.type === "artifact.created" ? e.event.hash : ""))
    );
    if (!artifactHashes.has(receipt.workspaceOut.diffHash)) {
      problems.push("workspaceOut.diffHash has no matching artifact.created event");
    }
  }

  return { ok: problems.length === 0, problems };
}
