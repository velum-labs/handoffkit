import { hashCanonical } from "./hash.js";
import { keyIdFromPublicPem, signData, verifyData } from "./keys.js";
import type { RunContract, Signature } from "./types.js";

function signablePayload(contract: RunContract): string {
  const { signatures: _signatures, ...unsigned } = contract;
  return hashCanonical(unsigned);
}

/** Content hash of a contract, excluding signatures. */
export function contractHash(contract: RunContract): string {
  return signablePayload(contract);
}

export function signContract(
  contract: RunContract,
  privateKeyPem: string,
  publicKeyPem: string,
  signer: Signature["signer"]
): RunContract {
  const payload = signablePayload(contract);
  const signature: Signature = {
    keyId: keyIdFromPublicPem(publicKeyPem),
    alg: "ed25519",
    signer,
    sig: signData(privateKeyPem, payload)
  };
  return { ...contract, signatures: [...contract.signatures, signature] };
}

export type KeyResolver = (keyId: string) => string | undefined;

export function verifyContractSignature(
  contract: RunContract,
  signer: Signature["signer"],
  resolvePublicKeyPem: KeyResolver
): boolean {
  const payload = signablePayload(contract);
  const signature = contract.signatures.find((s) => s.signer === signer);
  if (!signature) return false;
  const publicKeyPem = resolvePublicKeyPem(signature.keyId);
  if (!publicKeyPem) return false;
  if (keyIdFromPublicPem(publicKeyPem) !== signature.keyId) return false;
  return verifyData(publicKeyPem, payload, signature.sig);
}
