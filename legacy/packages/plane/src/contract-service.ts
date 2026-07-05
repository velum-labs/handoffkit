import {
  executionFromRunRequest,
  keyIdFromPublicPem,
  PROTOCOL_VERSIONS,
  signContract,
  type ActorRef,
  type RunContract
} from "@fusionkit/protocol";

import type { RunRequest } from "./store.js";

export type ContractServiceOptions = {
  planePrivateKeyPem: string;
  planePublicKeyPem: string;
  policyHash: string;
  contractTtlMs: number;
  buildSecretClaims: (secretNames: string[], pool: string) => RunContract["secrets"];
};

export class ContractService {
  constructor(private readonly options: ContractServiceOptions) {}

  issue(request: RunRequest, approvedBy: ActorRef[]): RunContract {
    const now = Date.now();
    const unsigned: RunContract = {
      version: PROTOCOL_VERSIONS.contract,
      runId: request.runId,
      issuedAt: new Date(now).toISOString(),
      issuer: {
        keyId: keyIdFromPublicPem(this.options.planePublicKeyPem),
        role: "plane"
      },
      requestedBy: request.requestedBy,
      ...(approvedBy.length > 0 ? { approvedBy } : {}),
      agent: {
        kind: request.agentKind as RunContract["agent"]["kind"],
        ...(request.agentVersion ? { version: request.agentVersion } : {})
      },
      task: { prompt: request.prompt },
      runner: { pool: request.pool },
      workspace: request.workspace,
      policyHash: this.options.policyHash,
      secrets: this.options.buildSecretClaims(request.secretNames, request.pool),
      network: request.network,
      budget: request.budget,
      disclosure: request.disclosure,
      execution: executionFromRunRequest(request),
      ...(request.isolation ? { isolation: request.isolation } : {}),
      ...(request.continuation ? { continuation: request.continuation } : {}),
      expiresAt: new Date(now + this.options.contractTtlMs).toISOString(),
      signatures: []
    };
    return signContract(
      unsigned,
      this.options.planePrivateKeyPem,
      this.options.planePublicKeyPem,
      "plane"
    );
  }
}
