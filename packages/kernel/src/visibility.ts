import type { Artifact, ArtifactLeakage, Observation, Signal } from "./types.js";

export function isPrivateLeakage(leakage: ArtifactLeakage): boolean {
  switch (leakage) {
    case "private":
    case "contaminated":
      return true;
    case "none":
    case "public":
      return false;
    default: {
      const exhausted: never = leakage;
      throw new Error(`unsupported leakage class: ${String(exhausted)}`);
    }
  }
}

export function schedulerVisibleArtifact(artifact: Artifact): boolean {
  return artifact.visibility !== "private_eval" && !isPrivateLeakage(artifact.leakage);
}

export function schedulerVisibleObservation(observation: Observation): boolean {
  return observation.visibility !== "private_eval" && !isPrivateLeakage(observation.leakage);
}

export function schedulerVisibleSignal(signal: Signal): boolean {
  return !isPrivateLeakage(signal.leakageRisk);
}

function leakageRank(leakage: ArtifactLeakage): number {
  switch (leakage) {
    case "none":
      return 0;
    case "public":
      return 1;
    case "private":
      return 2;
    case "contaminated":
      return 3;
    default: {
      const exhausted: never = leakage;
      throw new Error(`unsupported leakage class: ${String(exhausted)}`);
    }
  }
}

export function maxLeakage(values: readonly ArtifactLeakage[]): ArtifactLeakage {
  return values.reduce<ArtifactLeakage>(
    (current, next) => (leakageRank(next) > leakageRank(current) ? next : current),
    "none"
  );
}


