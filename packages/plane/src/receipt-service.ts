import {
  signReceipt,
  verifyRunnerReceipt,
  type ChainedEvent,
  type Receipt,
  type RunContract
} from "@warrant/protocol";

import { badRequest } from "./domain-errors.js";

export type ReceiptServiceConfig = {
  planePrivateKeyPem: string;
  planePublicKeyPem: string;
};

export class ReceiptService {
  constructor(private readonly config: ReceiptServiceConfig) {}

  verifyRunnerReceipt(input: {
    contract: RunContract;
    receipt: Receipt;
    events: ChainedEvent[];
    runnerPublicKeyPem: string;
  }): void {
    const result = verifyRunnerReceipt(input);
    if (!result.ok) {
      throw badRequest(
        `receipt runner verification failed: ${result.problems.join("; ")}`
      );
    }
  }

  countersign(receipt: Receipt): Receipt {
    return signReceipt(
      receipt,
      this.config.planePrivateKeyPem,
      this.config.planePublicKeyPem,
      "plane"
    );
  }
}
