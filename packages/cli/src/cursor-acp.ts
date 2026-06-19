/**
 * Real Cursor ACP front-door producer. Spawns the Cursorkit bridge (its
 * local-model backend pointed at the running Fusion Harness Gateway) and drives
 * the real cursor-agent CLI in ACP mode, asserting the fusion-synthesized
 * sentinel reaches Cursor via session/update. Returns undefined when the
 * Cursorkit checkout or the cursor-agent CLI are unavailable, so the acceptance
 * suite records the explicit `blocked` / `cursorkit_backend_not_running`
 * outcome instead of a silent pass.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

import type { FrontDoorOutcome, FrontDoorOutcomeProducer } from "@fusionkit/model-gateway";

export type CursorAcpProducerInput = {
  cursorKitDir: string | undefined;
  gatewayUrl: string;
  sentinel: string;
  repo: string;
  command?: string;
  modelName?: string;
  timeoutMs?: number;
};

function commandOnPath(command: string): boolean {
  if (command.includes("/")) return existsSync(command);
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((dir) => existsSync(join(dir, command)));
}

function normalizeModelBaseUrl(gatewayUrl: string): string {
  const trimmed = gatewayUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function buildCursorAcpProducer(
  input: CursorAcpProducerInput
): FrontDoorOutcomeProducer | undefined {
  const command = input.command ?? "cursor-agent";
  if (input.cursorKitDir === undefined || input.cursorKitDir.length === 0) {
    return undefined;
  }
  if (!existsSync(join(input.cursorKitDir, "dist/src/cli.js"))) {
    return undefined;
  }
  if (!commandOnPath(command)) {
    return undefined;
  }
  return () => runCursorAcpOutcome({ ...input, command });
}

async function runCursorAcpOutcome(
  input: Required<Pick<CursorAcpProducerInput, "command">> & CursorAcpProducerInput
): Promise<FrontDoorOutcome> {
  const cursorKitDir = input.cursorKitDir as string;
  const modelName = input.modelName ?? "local-fusion";
  const bridgePort = 9700 + Math.floor(Math.random() * 250);
  const bridgeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("BRIDGE_") || key.startsWith("MODEL_") || key.startsWith("CURSOR_UPSTREAM")) {
      continue;
    }
    bridgeEnv[key] = value;
  }
  Object.assign(bridgeEnv, {
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_ROUTE_INVENTORY: "true",
    CURSOR_UPSTREAM_BASE_URL: "https://api2.cursor.sh",
    MODEL_BASE_URL: normalizeModelBaseUrl(input.gatewayUrl),
    MODEL_API_KEY: "local",
    MODEL_NAME: modelName,
    MODEL_PROVIDER_MODEL: "fusion-panel",
    MODEL_CONTEXT_TOKEN_LIMIT: "128000"
  });

  let bridgeOut = "";
  const bridge = spawn(process.execPath, ["dist/src/cli.js", "serve"], {
    cwd: cursorKitDir,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridge.stdout.on("data", (chunk: Buffer) => {
    bridgeOut += chunk.toString("utf8");
  });
  bridge.stderr.on("data", (chunk: Buffer) => {
    bridgeOut += chunk.toString("utf8");
  });

  const evidence: string[] = [];
  try {
    const deadline = Date.now() + 20_000;
    while (!/bridge listening/.test(bridgeOut) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!/bridge listening/.test(bridgeOut)) {
      return {
        id: "cursor-acp",
        status: "failed",
        reason: "cursorkit_bridge_did_not_start",
        evidence
      };
    }

    const acpText = await driveCursorAgentSentinel({
      command: input.command,
      bridgePort,
      modelName,
      cwd: input.repo,
      sentinel: input.sentinel,
      timeoutMs: input.timeoutMs ?? 120_000
    });
    if (acpText.includes(input.sentinel)) {
      evidence.push(input.sentinel);
      return {
        id: "cursor-acp",
        status: "passed",
        request_path: "/agent.v1.AgentService/Run",
        evidence
      };
    }
    return {
      id: "cursor-acp",
      status: "failed",
      reason: "sentinel_not_observed_in_cursor_session_update",
      evidence
    };
  } catch (error) {
    return {
      id: "cursor-acp",
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      evidence
    };
  } finally {
    bridge.kill("SIGTERM");
  }
}

async function driveCursorAgentSentinel(input: {
  command: string;
  bridgePort: number;
  modelName: string;
  cwd: string;
  sentinel: string;
  timeoutMs: number;
}): Promise<string> {
  const acp = spawn(
    input.command,
    [
      "--endpoint",
      `http://127.0.0.1:${input.bridgePort}`,
      "--model",
      input.modelName,
      "--mode",
      "ask",
      "acp"
    ],
    { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] }
  );
  let acpText = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const rl = createInterface({ input: acp.stdout });
  const send = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  rl.on("line", (line) => {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(Number(message.id));
      if (waiter === undefined) return;
      pending.delete(Number(message.id));
      if (message.error !== undefined) waiter.reject(message.error);
      else waiter.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      if (message.method === "session/update") acpText += JSON.stringify(message.params);
      if (message.id !== undefined) {
        acp.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "skipped", reason: "acceptance" } } })}\n`
        );
      }
    }
  });
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_resolve, reject) =>
        setTimeout(() => reject(new Error("ACP step timed out")), ms)
      )
    ]);
  try {
    await withTimeout(
      send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: { name: "fusionkit-acceptance", version: "0.1.0" }
      }),
      60_000
    );
    await withTimeout(send("authenticate", { methodId: "cursor_login" }), 60_000);
    const session = (await withTimeout(
      send("session/new", { cwd: input.cwd, mcpServers: [] }),
      60_000
    )) as { sessionId?: string; session?: { id?: string } };
    const sessionId = session.sessionId ?? session.session?.id;
    if (sessionId === undefined) return acpText;
    await withTimeout(
      send("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "text",
            text: `Reply with exactly this token and nothing else: ${input.sentinel}`
          }
        ]
      }),
      input.timeoutMs
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return acpText;
  } finally {
    rl.close();
    acp.kill("SIGTERM");
  }
}
