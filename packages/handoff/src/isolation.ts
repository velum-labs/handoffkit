/**
 * Typed isolation strategies for pulling run output back into the local
 * workspace. `auto` applies in place when the workspace is clean at the
 * contract base ref and branches otherwise; `branch` always lands on a
 * dedicated branch and never touches the working tree.
 */

export type IsolationStrategy = {
  kind: "isolation-strategy";
  id: "auto" | "branch";
};

/** Always materialize results on a dedicated branch. */
export function branch(): IsolationStrategy {
  return { kind: "isolation-strategy", id: "branch" };
}
