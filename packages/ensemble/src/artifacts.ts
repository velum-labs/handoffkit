import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ModelFusionArtifactKind } from "@fusionkit/protocol";
import { artifactHash } from "@routekit/contracts";
import { ensureRunOutputDir } from "@routekit/runtime";

import type { HarnessArtifact } from "./harness.js";

export type ArtifactStore = {
  root: string;
  writeText(input: {
    artifactId: string;
    kind: ModelFusionArtifactKind;
    content: string;
    suffix?: string;
  }): HarnessArtifact & { path: string };
  writeJson(input: {
    artifactId: string;
    kind: ModelFusionArtifactKind;
    value: unknown;
  }): HarnessArtifact & { path: string };
};

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

export function createArtifactStore(root: string): ArtifactStore {
  const resolvedRoot = resolve(root);
  ensureRunOutputDir(resolvedRoot, { dataDirectoryNames: [".fusionkit"] });
  return {
    root: resolvedRoot,
    writeText(input) {
      const hash = artifactHash(input.content);
      const hashPart = hash.replace("sha256:", "");
      const path = join(
        resolvedRoot,
        `${safeFileName(input.artifactId)}-${hashPart}${input.suffix ?? ".txt"}`
      );
      writeFileSync(path, input.content);
      return {
        artifact_id: input.artifactId,
        kind: input.kind,
        hash,
        uri: pathToFileURL(path).toString(),
        redaction_status: "synthetic",
        path
      };
    },
    writeJson(input) {
      return this.writeText({
        artifactId: input.artifactId,
        kind: input.kind,
        content: JSON.stringify(input.value, null, 2) + "\n",
        suffix: ".json"
      });
    }
  };
}
