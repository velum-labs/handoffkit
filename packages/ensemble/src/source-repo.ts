import { basename } from "node:path";

import { gitText } from "@fusionkit/workspace";

/** Repo label for provenance: origin remote basename, else workspace directory name. */
export function deriveSourceRepo(cwd: string): string {
  const remote = gitText(cwd, ["remote", "get-url", "origin"], { allowFail: true }).trim();
  if (remote.length > 0) {
    const name = basename(remote.replace(/\/$/, "")).replace(/\.git$/i, "");
    if (name.length > 0) return name;
  }
  return basename(cwd);
}
