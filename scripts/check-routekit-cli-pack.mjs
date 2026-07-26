import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUTEKIT_VERSION = "0.10.1";

async function startMockProvider() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const { createServer } = require("node:http");',
        "const server = createServer((request, response) => {",
        '  response.setHeader("content-type", "application/json");',
        '  if (request.url === "/v1/models") {',
        '    response.end(JSON.stringify({ data: [{ id: "pack-model", object: "model" }] }));',
        "  } else {",
        '    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));',
        "  }",
        "});",
        'server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));',
        'process.on("SIGTERM", () => server.close(() => process.exit(0)));'
      ].join("\n")
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const port = await new Promise((resolvePort, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n", 1)[0];
      if (/^\d+$/.test(line)) resolvePort(Number(line));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`mock provider exited before readiness (${code ?? "signal"})`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await exited;
    }
  };
}

const temporary = mkdtempSync(join(tmpdir(), "routekit-pack-smoke-"));
const install = join(temporary, "install");
try {
  mkdirSync(install, { recursive: true });
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "routekit-install-smoke", private: true }, null, 2)}\n`
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `@velum-labs/routekit@${ROUTEKIT_VERSION}`
    ],
    { cwd: install, stdio: "pipe" }
  );
  if (existsSync(join(install, "node_modules", "@fusionkit"))) {
    throw new Error("smoke install unexpectedly contains @fusionkit packages");
  }
  const output = execFileSync(
    join(install, "node_modules", ".bin", "routekit"),
    ["version"],
    { cwd: install, encoding: "utf8" }
  );
  if (!output.includes("@velum-labs/routekit")) {
    throw new Error(`installed routekit executable returned unexpected output: ${output}`);
  }

  const routekit = join(install, "node_modules", ".bin", "routekit");
  const home = join(temporary, "home");
  const stateHome = join(temporary, "state");
  const configDirectory = join(home, ".config", "routekit");
  mkdirSync(configDirectory, { recursive: true });
  const provider = await startMockProvider();
  writeFileSync(
    join(configDirectory, "router.yaml"),
    "providers:\n  openai: {}\ndefaultModel: openai/pack-model\n"
  );
  const daemonEnv = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_PORTLESS: "0",
    PORTLESS: "0",
    NO_COLOR: "1",
    OPENAI_API_KEY: "pack-test-key",
    OPENAI_BASE_URL: provider.url
  };
  let daemonStarted = false;
  try {
    const started = JSON.parse(
      execFileSync(
        routekit,
        ["start", "--port", "0", "--no-portless", "--json"],
        { cwd: install, env: daemonEnv, encoding: "utf8" }
      )
    );
    daemonStarted = true;
    if (
      started.supervisor !== "detached" ||
      typeof started.pid !== "number" ||
      typeof started.url !== "string"
    ) {
      throw new Error(`packed daemon returned unexpected start status: ${JSON.stringify(started)}`);
    }
    const status = JSON.parse(
      execFileSync(routekit, ["status", "--json"], {
        cwd: install,
        env: daemonEnv,
        encoding: "utf8"
      })
    );
    if (status.daemon?.pid !== started.pid || status.daemon?.dataUrl !== started.url) {
      throw new Error(`packed daemon status did not match start: ${JSON.stringify(status)}`);
    }
    const catalog = JSON.parse(
      execFileSync(routekit, ["models", "list", "--json"], {
        cwd: install,
        env: daemonEnv,
        encoding: "utf8"
      })
    );
    if (!Array.isArray(catalog.models)) {
      throw new Error(`packed daemon returned an invalid model catalog: ${JSON.stringify(catalog)}`);
    }
  } finally {
    if (daemonStarted) {
      execFileSync(routekit, ["stop", "--force", "--json"], {
        cwd: install,
        env: daemonEnv,
        stdio: "pipe"
      });
    }
    await provider.close();
  }
  process.stdout.write(
    `routekit npm install + daemon smoke passed (@velum-labs/routekit@${ROUTEKIT_VERSION})\n`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
