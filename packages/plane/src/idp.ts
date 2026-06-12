import { createLocalJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

/**
 * Verifies IdP-issued approval assertions so a consent decision is bound to
 * a real, externally-authenticated subject rather than to whoever holds an
 * admin token. The plane is configured with the IdP issuer, audience, and a
 * JWKS (resolved out-of-band by the operator and passed in); approvals
 * present a JWT, which is verified against that JWKS.
 */
export type IdpConfig = {
  issuer: string;
  audience: string;
  /** JWKS contents (the operator fetches and pins these). */
  jwks: { keys: Record<string, unknown>[] };
};

export type VerifiedApproval = {
  subject: string;
  issuer: string;
};

export class IdpVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly getKey: JWTVerifyGetKey;

  constructor(config: IdpConfig) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    // TODO(brittle): JWKS is statically pinned at startup; no rotation/refresh if the IdP rotates signing keys.
    this.getKey = createLocalJWKSet(
      config.jwks as Parameters<typeof createLocalJWKSet>[0]
    );
  }

  async verify(token: string): Promise<VerifiedApproval> {
    const { payload }: { payload: JWTPayload } = await jwtVerify(
      token,
      this.getKey,
      { issuer: this.issuer, audience: this.audience }
    );
    if (!payload.sub) {
      throw new Error("IdP token has no subject (sub) claim");
    }
    // TODO(brittle): returns configured issuer, not payload.iss; a misconfigured verifier could mask token issuer mismatch.
    return { subject: payload.sub, issuer: this.issuer };
  }
}
