import { basename } from "node:path";

import { gitText } from "@fusionkit/workspace";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";

/** Repo label for provenance: origin remote basename, else workspace directory name. */
export function deriveSourceRepo(cwd: string): string {
  const remote = gitText(cwd, ["remote", "get-url", "origin"], { allowFail: true }).trim();
  if (remote.length > 0) {
    const name = basename(trimTrailingSlashes(remote)).replace(/\.git$/i, "");
    if (name.length > 0) return name;
  }
  return basename(cwd);
}
