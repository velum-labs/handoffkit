import type { FusedEnsembleInfo } from "./types.js";

export type FusedSubagentDescriptionStyle = "fused-answer" | "delegate-task";

export type FusedSubagentDefinition = {
  name: string;
  modelId: string;
  ensembleName: string;
  memberIds: readonly string[];
  isDefault: boolean;
  description: string;
  developerInstructions: string;
};

export function fusedSubagentMembers(ensemble: FusedEnsembleInfo): string {
  return ensemble.memberIds.join(", ");
}

export function fusedSubagentDeveloperInstructions(ensemble: FusedEnsembleInfo): string {
  return (
    `You run on the fused "${ensemble.name}" ensemble. Every reply is already a ` +
    "panel-and-judge fusion. Answer the delegated task directly and completely."
  );
}

export function fusedSubagentDescription(
  ensemble: FusedEnsembleInfo,
  isDefault: boolean,
  style: FusedSubagentDescriptionStyle
): string {
  const members = fusedSubagentMembers(ensemble);
  switch (style) {
    case "fused-answer":
      return isDefault
        ? `Fused answer from the default "${ensemble.name}" ensemble (${members}).`
        : `Fused answer from the "${ensemble.name}" ensemble (${members}).`;
    case "delegate-task": {
      const flavor = isDefault ? "default " : "";
      return (
        `Delegate a task to the ${flavor}"${ensemble.name}" fusion ensemble ` +
        `(${members} fused by a judge). Use when the user asks for the ${ensemble.name} ensemble.`
      );
    }
    default: {
      const unreachable: never = style;
      throw new Error(`unsupported fused sub-agent description style: ${String(unreachable)}`);
    }
  }
}

export function deriveFusedSubagents(
  ensembles: readonly FusedEnsembleInfo[],
  defaultModelId: string,
  style: FusedSubagentDescriptionStyle
): FusedSubagentDefinition[] {
  return ensembles.map((ensemble) => {
    const isDefault = ensemble.modelId === defaultModelId;
    return {
      name: ensemble.modelId,
      modelId: ensemble.modelId,
      ensembleName: ensemble.name,
      memberIds: ensemble.memberIds,
      isDefault,
      description: fusedSubagentDescription(ensemble, isDefault, style),
      developerInstructions: fusedSubagentDeveloperInstructions(ensemble)
    };
  });
}
