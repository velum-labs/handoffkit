import { randomBytes } from "node:crypto";

import { signData, verifyData } from "@warrant/protocol";

import { badRequest, unauthorized } from "./domain-errors.js";

export type ClaimTokenPayload = {
  runId: string;
  runnerId: string;
  nonce: string;
  exp: string;
};

export type VerifiedClaimToken = ClaimTokenPayload & { expMs: number };

export type ClaimTokenServiceOptions = {
  planePrivateKeyPem: string;
  planePublicKeyPem: string;
  claimTokenTtlMs: number;
};

export class ClaimTokenService {
  constructor(private readonly options: ClaimTokenServiceOptions) {}

  issue(input: { runId: string; runnerId: string }): string {
    const payload: ClaimTokenPayload = {
      runId: input.runId,
      runnerId: input.runnerId,
      nonce: randomBytes(16).toString("base64url"),
      exp: new Date(Date.now() + this.options.claimTokenTtlMs).toISOString()
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url"
    );
    const sig = signData(this.options.planePrivateKeyPem, encoded);
    return `${encoded}.${Buffer.from(sig, "base64").toString("base64url")}`;
  }

  parse(token: string): VerifiedClaimToken {
    const [encoded, sigB64url] = token.split(".");
    if (!encoded || !sigB64url) throw badRequest("malformed claim token");
    const sig = Buffer.from(sigB64url, "base64url").toString("base64");
    if (!verifyData(this.options.planePublicKeyPem, encoded, sig)) {
      throw unauthorized("claim token signature invalid");
    }
    let payload: Partial<ClaimTokenPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8")
      ) as Partial<ClaimTokenPayload>;
    } catch {
      throw badRequest("claim token payload is not valid JSON");
    }
    if (
      typeof payload.runId !== "string" ||
      typeof payload.runnerId !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.exp !== "string"
    ) {
      throw badRequest("claim token payload is missing required fields");
    }
    const expMs = new Date(payload.exp).getTime();
    if (!Number.isFinite(expMs)) throw badRequest("claim token expiry is invalid");
    if (expMs < Date.now()) throw unauthorized("claim token expired");
    return {
      runId: payload.runId,
      runnerId: payload.runnerId,
      nonce: payload.nonce,
      exp: payload.exp,
      expMs
    };
  }
}
