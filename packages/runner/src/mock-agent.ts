/**
 * Built-in mock agent used for tests and demos without vendor CLIs or
 * API keys. It behaves like a tiny coding agent:
 *
 * - appends its task to MOCK_AGENT.md in the workspace
 * - reports whether the MOCK_SECRET env var was injected (never its value)
 * - when the task mentions "network", attempts an egress call through the
 *   session proxy so governed network enforcement can be observed
 * - exits non-zero when the task mentions "fail"
 */
import { appendFileSync } from "node:fs";
import { request } from "node:http";

const prompt = process.argv[2] ?? "";

appendFileSync(
  "MOCK_AGENT.md",
  `## task\n${prompt}\n\nsecret:${process.env.MOCK_SECRET ? "present" : "absent"}\n`
);

function tryNetwork(): Promise<void> {
  const proxy = process.env.HTTP_PROXY;
  if (!proxy) return Promise.resolve();
  const proxyUrl = new URL(proxy);
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        path: "http://denied.example.com/probe",
        method: "GET",
        headers: { host: "denied.example.com" }
      },
      (res) => {
        console.log(`network probe status: ${res.statusCode}`);
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", () => {
      console.log("network probe failed to reach proxy");
      resolve();
    });
    req.end();
  });
}

async function main(): Promise<void> {
  console.log(`mock agent received task: ${prompt}`);
  if (prompt.includes("network")) {
    await tryNetwork();
  }
  if (prompt.includes("fail")) {
    console.error("mock agent failing as instructed");
    process.exit(1);
  }
  console.log("mock agent done");
}

void main();
