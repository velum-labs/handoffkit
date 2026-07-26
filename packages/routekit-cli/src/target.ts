import type { Command } from "commander";

import {
  activeRemote,
  findRemote,
  readRemoteToken,
  type RouteKitRemote
} from "./remotes.js";

export type TargetSelection = { local: boolean; remote?: string };
export type RouteKitTarget =
  | { kind: "local" }
  | { kind: "remote"; remote: RouteKitRemote; authToken: string };

let selection: TargetSelection = { local: false };

export function setTargetSelection(next: TargetSelection): void {
  selection = next.local ? { local: true } : next;
}

export function setTargetSelectionFromCommand(command: Command): void {
  const options = command.optsWithGlobals<{ local?: boolean; remote?: string }>();
  setTargetSelection({
    local: options.local === true,
    ...(options.remote !== undefined ? { remote: options.remote } : {})
  });
}

export function resetTargetSelectionForTest(): void {
  selection = { local: false };
}

export function selectedRemoteMetadata(): RouteKitRemote | undefined {
  if (selection.local) return undefined;
  if (selection.remote !== undefined) {
    const remote = findRemote(selection.remote);
    if (remote === undefined) throw new Error(`unknown RouteKit remote: ${selection.remote}`);
    return remote;
  }
  return activeRemote();
}

export async function resolveTarget(): Promise<RouteKitTarget> {
  const remote = selectedRemoteMetadata();
  if (remote === undefined) return { kind: "local" };
  const authToken = await readRemoteToken(remote.name);
  if (authToken === undefined) {
    throw new Error(
      `no gateway token is stored for remote "${remote.name}"; run \`routekit remote add ${remote.name} --url ${remote.gatewayUrl} --ssh ${remote.sshHost}\``
    );
  }
  return { kind: "remote", remote, authToken };
}

export function assertLocalTarget(operation: string): void {
  const remote = selectedRemoteMetadata();
  if (remote === undefined) return;
  throw new Error(
    `${operation} manages the local daemon; run it on the remote with \`ssh ${remote.sshHost} routekit ${operation}\` or pass --local`
  );
}
