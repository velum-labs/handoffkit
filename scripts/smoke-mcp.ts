import { spawn } from "node:child_process";
import { once } from "node:events";

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: unknown;
};

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MATTER_API_TOKEN: process.env.MATTER_API_TOKEN ?? "mat_dummy",
    LOG_LEVEL: "error"
  },
  stdio: ["pipe", "pipe", "pipe"]
});

const stdoutLines: JsonRpcResponse[] = [];
const stderrChunks: string[] = [];
let stdoutBuffer = "";

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk: string) => {
  stdoutBuffer += chunk;
  while (stdoutBuffer.includes("\n")) {
    const index = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (line.trim().length > 0) {
      stdoutLines.push(JSON.parse(line) as JsonRpcResponse);
    }
  }
});

child.stderr.on("data", (chunk: string) => {
  stderrChunks.push(chunk);
});

function send(message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "matter-cursor-mcp-smoke", version: "1.0.0" }
  }
});

send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

const deadline = Date.now() + 5_000;
while (Date.now() < deadline && !stdoutLines.some((line) => line.id === 2)) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

child.kill("SIGTERM");
await once(child, "exit");

const initialize = stdoutLines.find((line) => line.id === 1);
const toolsList = stdoutLines.find((line) => line.id === 2);
if (!initialize?.result || !toolsList?.result) {
  throw new Error(`MCP smoke failed. stderr=${stderrChunks.join("")}`);
}

const result = toolsList.result as { tools?: Array<{ name?: string }> };
const toolNames = (result.tools ?? []).map((tool) => tool.name).sort();
const expected = [
  "matter_build_context_bundle",
  "matter_get_annotations",
  "matter_get_item",
  "matter_health",
  "matter_list_items",
  "matter_list_tags",
  "matter_search_items"
].sort();
if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
  throw new Error(`Expected tools ${expected.join(", ")}, got ${toolNames.join(", ")}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      tools: toolNames,
      stdout_protocol_messages: stdoutLines.length,
      stderr_bytes: stderrChunks.join("").length
    },
    null,
    2
  )}\n`
);
