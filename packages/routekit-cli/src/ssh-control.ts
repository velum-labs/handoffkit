import { spawn } from "node:child_process";

import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { ControlError } from "@velum-labs/routekit-runtime";

import type { RouteKitRemote } from "./remotes.js";
import { routekitVersion } from "./state.js";

type RelayResult = {
  status: number;
  body: unknown;
};

function response(result: RelayResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" }
  });
}

function collectSecrets(
  value: unknown,
  key = "",
  output = new Set<string>(),
  seen = new WeakSet<object>(),
  sensitiveParent = false
): Set<string> {
  const sensitive = sensitiveParent || /token|secret|password|credential|api.?key/i.test(key);
  if (typeof value === "string" && sensitive) {
    if (value.length > 0) output.add(value);
  } else if (Array.isArray(value)) {
    if (seen.has(value)) return output;
    seen.add(value);
    for (const entry of value) collectSecrets(entry, key, output, seen, sensitive);
  } else if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return output;
    seen.add(value);
    for (const [name, entry] of Object.entries(value)) {
      collectSecrets(entry, name, output, seen, sensitive);
    }
  }
  return output;
}

export function redactSensitiveText(text: string, secrets: Iterable<string> = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /("(?:token|secret|password|credential|api[_-]?key)"\s*:\s*")[^"]+/gi,
      "$1[redacted]"
    );
}

function relayError(error: unknown, host: string, secrets: Iterable<string>): never {
  const candidate = error as {
    code?: string;
    stderr?: string | Buffer;
    message?: string;
  };
  if (candidate.code === "ENOENT") {
    throw new ControlError({
      code: "unavailable",
      message: "ssh was not found on PATH; install an SSH client to administer remote gateways"
    });
  }
  const rawStderr = typeof candidate.stderr === "string"
    ? candidate.stderr.trim()
    : Buffer.isBuffer(candidate.stderr)
      ? candidate.stderr.toString("utf8").trim()
      : "";
  const stderr = redactSensitiveText(rawStderr, secrets);
  const message = candidate.message === undefined
    ? undefined
    : redactSensitiveText(candidate.message, secrets);
  const code = /permission denied|authentication failed/i.test(stderr)
    ? "unauthorized"
    : /routekit.*(?:not found|no such file)|command not found.*routekit/i.test(stderr)
      ? "not_found"
      : "unavailable";
  throw new ControlError({
    code,
    message: `RouteKit remote control over SSH to ${host} failed${stderr.length > 0 ? `: ${stderr}` : message !== undefined ? `: ${message}` : ""}`
  });
}

export async function runSshRelay(
  remote: Pick<RouteKitRemote, "sshHost">,
  request: unknown,
  input: { timeoutMs?: number; signal?: AbortSignal | null } = {}
): Promise<RelayResult> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("ssh", [
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${Math.max(1, Math.ceil(Math.min(input.timeoutMs ?? 90_000, 10_000) / 1000))}`,
        "--",
        remote.sshHost,
        "routekit",
        "--local",
        "--quiet",
        "daemon",
        "exec"
      ], { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const capture = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 16 * 1024 * 1024) {
          child.kill("SIGTERM");
          reject(new Error("RouteKit remote control response is too large"));
          return;
        }
        target.push(chunk);
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        child.kill("SIGTERM");
        reject(new Error(`RouteKit remote control over SSH to ${remote.sshHost} was aborted`));
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`RouteKit remote control over SSH to ${remote.sshHost} timed out`));
      }, input.timeoutMs ?? 90_000);
      if (input.signal?.aborted === true) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.stdin.on("error", () => {
        // The child process error/exit is reported through its own handlers.
      });
      child.on("close", (code) => {
        cleanup();
        const output = Buffer.concat(stdout).toString("utf8");
        const errors = Buffer.concat(stderr).toString("utf8");
        if (code === 0) resolve({ stdout: output, stderr: errors });
        else {
          reject(
            Object.assign(new Error(`ssh exited with status ${code ?? "unknown"}`), {
              stderr: errors
            })
          );
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit remote returned invalid JSON over SSH from ${remote.sshHost}`
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Number.isInteger((parsed as { status?: unknown }).status) ||
      ((parsed as { status: number }).status < 200 ||
        (parsed as { status: number }).status > 599) ||
      !("body" in parsed)
    ) {
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit remote returned an invalid control envelope from ${remote.sshHost}`
      });
    }
    return parsed as RelayResult;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    relayError(error, remote.sshHost, collectSecrets(request));
  }
}

export function remoteControlClient(remote: RouteKitRemote): RouteKitControlClient {
  const fetchOverSsh: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url
    );
    const body =
      url.pathname.endsWith("/health")
        ? { kind: "health" }
        : {
            kind: "call",
            request: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown
          };
    return response(
      await runSshRelay(remote, body, {
        timeoutMs: 90_000,
        signal: init?.signal
      })
    );
  };
  return new RouteKitControlClient({
    url: "http://127.0.0.1",
    token: "ssh-relay",
    packageVersion: routekitVersion(),
    cwd: process.cwd(),
    timeoutMs: 90_000,
    fetch: fetchOverSsh
  });
}
