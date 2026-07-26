import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { contextFor } from "@velum-labs/routekit-cli-core";
import { ROUTEKIT_CONTROL_CAPABILITY } from "@velum-labs/routekit-control";
import type { Command } from "commander";

import {
  activeRemote,
  deleteRemoteToken,
  findRemote,
  normalizeRemoteUrl,
  putRemote,
  readRemoteRegistry,
  readRemoteToken,
  removeRemote,
  useRemote,
  validateRemoteName,
  validateSshHost,
  writeRemoteToken,
  type RouteKitRemote
} from "../remotes.js";
import { remoteControlClient } from "../ssh-control.js";
import { routekitVersion } from "../state.js";

const execFileAsync = promisify(execFile);

async function bootstrapToken(sshHost: string): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        sshHost,
        "routekit",
        "--local",
        "daemon",
        "auth",
        "show",
        "--json"
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (error) {
    const candidate = error as { code?: string; stderr?: string | Buffer; message?: string };
    if (candidate.code === "ENOENT") {
      throw new Error("ssh was not found on PATH; install an SSH client before adding a remote");
    }
    const stderr = typeof candidate.stderr === "string"
      ? candidate.stderr.trim()
      : Buffer.isBuffer(candidate.stderr)
        ? candidate.stderr.toString("utf8").trim()
        : "";
    throw new Error(
      `could not obtain the remote gateway token over SSH${stderr.length > 0 ? `: ${stderr}` : candidate.message !== undefined ? `: ${candidate.message}` : ""}`
    );
  }
  let parsed: { token?: unknown };
  try {
    parsed = JSON.parse(stdout) as { token?: unknown };
  } catch {
    throw new Error("remote RouteKit returned invalid JSON while obtaining the gateway token");
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("remote RouteKit returned no gateway token");
  }
  return parsed.token;
}

async function gatewayHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function details(remote: RouteKitRemote): Promise<{
  name: string;
  gatewayUrl: string;
  sshHost: string;
  addedAt: string;
  active: boolean;
  token: "stored" | "missing";
  healthy: boolean;
  remoteVersion?: string;
  protocol?: string;
}> {
  const [token, healthy, hello] = await Promise.all([
    readRemoteToken(remote.name),
    gatewayHealthy(remote.gatewayUrl),
    remoteControlClient(remote).hello().catch(() => undefined)
  ]);
  return {
    ...remote,
    active: activeRemote()?.name === remote.name,
    token: token === undefined ? "missing" : "stored",
    healthy,
    ...(hello?.packageVersion !== undefined ? { remoteVersion: hello.packageVersion } : {}),
    ...(hello?.protocolVersion !== undefined ? { protocol: hello.protocolVersion } : {})
  };
}

export function registerRemote(program: Command): void {
  const remote = program.command("remote").description("manage shared RouteKit gateways");

  remote
    .command("add <name>")
    .description("add a remote gateway and obtain its token over SSH")
    .requiredOption("--url <https-url>", "public RouteKit gateway URL")
    .requiredOption("--ssh <host>", "SSH host used for remote administration")
    .option("--no-use", "add without making this the active remote")
    .action(
      async (
        name: string,
        options: { url: string; ssh: string; use: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        validateRemoteName(name);
        const gatewayUrl = normalizeRemoteUrl(options.url);
        validateSshHost(options.ssh);
        const candidate: RouteKitRemote = {
          name,
          gatewayUrl,
          sshHost: options.ssh,
          addedAt: new Date().toISOString()
        };
        const previous = findRemote(name);
        const previousToken = previous === undefined
          ? undefined
          : await readRemoteToken(name);
        const token = await bootstrapToken(candidate.sshHost);
        await writeRemoteToken(name, token);
        try {
          const [healthy, hello] = await Promise.all([
            gatewayHealthy(gatewayUrl),
            remoteControlClient(candidate).hello()
          ]);
          if (!healthy) {
            throw new Error(`remote gateway health check failed: ${gatewayUrl}/health`);
          }
          if (hello.product !== undefined && hello.product !== "routekit") {
            throw new Error(`SSH target is not a RouteKit daemon (reported ${hello.product})`);
          }
          if (!hello.capabilities.includes(ROUTEKIT_CONTROL_CAPABILITY)) {
            throw new Error(
              `remote RouteKit does not advertise ${ROUTEKIT_CONTROL_CAPABILITY}; ` +
                "upgrade the remote CLI"
            );
          }
          putRemote(candidate, options.use);
          const active = activeRemote()?.name === name;
          const result = {
            ...candidate,
            active,
            token: "stored" as const,
            healthy: true,
            remoteVersion: hello.packageVersion,
            protocol: hello.protocolVersion
          };
          if (ctx.json) ctx.emit(result);
          else {
            ctx.presenter.success(`added RouteKit remote ${name}`);
            ctx.presenter.line(`  gateway: ${gatewayUrl}`);
            ctx.presenter.line(`  control: ssh ${candidate.sshHost}`);
            if (
              hello.packageVersion !== undefined &&
              hello.packageVersion !== routekitVersion()
            ) {
              ctx.presenter.warn(
                `client v${routekitVersion()} differs from remote v${hello.packageVersion}; ` +
                  "compatible control protocol accepted"
              );
            }
            if (active) ctx.presenter.note(`${name} is now the active remote`);
          }
        } catch (error) {
          if (previousToken === undefined) await deleteRemoteToken(name);
          else await writeRemoteToken(name, previousToken);
          throw error;
        }
      }
    );

  remote
    .command("list")
    .description("list configured remote gateways")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const registry = readRemoteRegistry();
      const rows = await Promise.all(
        registry.remotes.map(async (entry) => ({
          ...entry,
          active: registry.active === entry.name,
          token: (await readRemoteToken(entry.name)) === undefined ? "missing" : "stored"
        }))
      );
      if (ctx.json) ctx.emit({ active: registry.active, remotes: rows });
      else if (rows.length === 0) {
        ctx.presenter.note("no RouteKit remotes configured");
      } else {
        ctx.presenter.table(
          rows.map((entry) => [
            entry.active ? `* ${entry.name}` : entry.name,
            entry.gatewayUrl,
            entry.sshHost,
            entry.token
          ]),
          { head: ["Remote", "Gateway", "SSH", "Token"] }
        );
      }
    });

  remote
    .command("show [name]")
    .description("show and probe one remote gateway")
    .action(async (name: string | undefined, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const selected = name === undefined ? activeRemote() : findRemote(name);
      if (selected === undefined) {
        throw new Error(
          name === undefined ? "no active RouteKit remote" : `unknown RouteKit remote: ${name}`
        );
      }
      const result = await details(selected);
      if (ctx.json) ctx.emit(result);
      else ctx.presenter.keyValue([
        { label: "Name", value: result.name + (result.active ? " (active)" : "") },
        { label: "Gateway", value: result.gatewayUrl },
        { label: "SSH", value: result.sshHost },
        { label: "Health", value: result.healthy ? "reachable" : "unreachable" },
        { label: "Token", value: result.token },
        { label: "Version", value: result.remoteVersion ?? "unavailable" },
        { label: "Protocol", value: result.protocol ?? "unavailable" }
      ]);
    });

  remote
    .command("use [name]")
    .description("select the active remote, or return to local mode")
    .option("--none", "clear the active remote and use the local daemon")
    .action((name: string | undefined, options: { none?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (options.none === true && name !== undefined) {
        throw new Error("provide a remote name or --none, not both");
      }
      if (options.none !== true && name === undefined) {
        throw new Error("provide a remote name or --none");
      }
      useRemote(options.none === true ? undefined : name);
      const result = { active: options.none === true ? null : name };
      if (ctx.json) ctx.emit(result);
      else if (options.none === true) {
        ctx.presenter.success("RouteKit now targets the local daemon");
      }
      else ctx.presenter.success(`RouteKit now targets remote ${name}`);
    });

  remote
    .command("remove <name>")
    .description("remove a remote gateway and its stored token")
    .action(async (name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const removed = await removeRemote(name);
      if (!removed) throw new Error(`unknown RouteKit remote: ${name}`);
      if (ctx.json) ctx.emit({ name, removed: true });
      else ctx.presenter.success(`removed RouteKit remote ${name}`);
    });
}
