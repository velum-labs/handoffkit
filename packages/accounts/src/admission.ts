import type { AccountLimits, CreditSnapshot } from "./types.js";

export function hasUsableCredits(credits: CreditSnapshot | undefined): boolean {
  if (credits === undefined) return false;
  if (credits.unlimited === true) return true;
  return credits.hasCredits === true;
}

export function windowHeadroom(utilization: number): number {
  if (!Number.isFinite(utilization)) return 1;
  return Math.max(0, 1 - utilization);
}

export function memberHeadroom(
  limits: AccountLimits | undefined,
  isWindowRelevant: (key: string, limitName?: string) => boolean = () => true
): number {
  if (limits === undefined) return 1;
  const relevant = Object.entries(limits.windows).filter(([key, window]) =>
    isWindowRelevant(key, window.limitName)
  );
  if (relevant.length === 0) return 1;
  return Math.min(...relevant.map(([, window]) => windowHeadroom(window.utilization)));
}

export function isOverSwitchThreshold(headroom: number, switchThreshold: number): boolean {
  return headroom <= 1 - switchThreshold;
}

export function isPoolEligible(input: {
  limits?: AccountLimits;
  switchThreshold: number;
  coolingUntil?: number;
  credentialExpiresAt?: number;
  hasRefreshToken?: boolean;
  catalogReady?: boolean;
  models?: readonly string[];
  model?: string;
  now?: number;
  isWindowRelevant?: (key: string, limitName?: string) => boolean;
}): boolean {
  const now = input.now ?? Date.now() / 1000;
  if (input.catalogReady === true && (input.models?.length ?? 0) === 0) return false;
  if (
    input.catalogReady === true &&
    input.model !== undefined &&
    input.models !== undefined &&
    !input.models.includes(input.model)
  ) {
    return false;
  }
  if (input.coolingUntil !== undefined && input.coolingUntil > now) return false;
  if (
    input.credentialExpiresAt !== undefined &&
    input.credentialExpiresAt <= now &&
    input.hasRefreshToken !== true
  ) {
    return false;
  }
  const headroom = memberHeadroom(input.limits, input.isWindowRelevant);
  if (!isOverSwitchThreshold(headroom, input.switchThreshold)) return true;
  return hasUsableCredits(input.limits?.credits);
}

export function windowAdmissionStatus(
  utilization: number,
  switchThreshold: number,
  credits: CreditSnapshot | undefined,
  providerStatus?: string
): string {
  if (!isOverSwitchThreshold(windowHeadroom(utilization), switchThreshold)) {
    return providerStatus ?? "ok";
  }
  if (hasUsableCredits(credits)) return "credits-only";
  return "exhausted";
}
