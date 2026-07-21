import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const root = process.cwd();
const packageEntries = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(root, "packages", entry.name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return undefined;
    return {
      directory,
      manifest: JSON.parse(readFileSync(manifestPath, "utf8"))
    };
  })
  .filter((entry) => entry !== undefined);
const byName = new Map(packageEntries.map((entry) => [entry.manifest.name, entry]));
const closure = [];
const pending = ["@routekit/cli"];
const seen = new Set();
while (pending.length > 0) {
  const name = pending.shift();
  if (name === undefined || seen.has(name)) continue;
  seen.add(name);
  if (name.startsWith("@fusionkit/")) {
    throw new Error(`RouteKit package closure reached forbidden dependency ${name}`);
  }
  const entry = byName.get(name);
  if (entry === undefined) continue;
  closure.push(entry);
  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    if (dependency.startsWith("@routekit/") || dependency.startsWith("@fusionkit/")) {
      pending.push(dependency);
    }
  }
}

const temporary = mkdtempSync(join(tmpdir(), "routekit-pack-smoke-"));
const tarballs = join(temporary, "tarballs");
const install = join(temporary, "install");
try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(install, { recursive: true });
  for (const entry of closure) {
    execFileSync(
      "pnpm",
      ["pack", "--pack-destination", tarballs],
      { cwd: entry.directory, stdio: "pipe" }
    );
  }
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "routekit-install-smoke", private: true }, null, 2)}\n`
  );
  const packed = readdirSync(tarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => resolve(tarballs, name));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packed],
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
  if (!output.includes("@routekit/cli")) {
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
        ["daemon", "start", "--port", "0", "--no-portless", "--json"],
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
      execFileSync(routekit, ["daemon", "status", "--json"], {
        cwd: install,
        env: daemonEnv,
        encoding: "utf8"
      })
    );
    if (status.pid !== started.pid || status.dataUrl !== started.url) {
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
      execFileSync(routekit, ["daemon", "stop", "--force", "--json"], {
        cwd: install,
        env: daemonEnv,
        stdio: "pipe"
      });
    }
    await provider.close();
  }
  process.stdout.write(
    `routekit pack/install + daemon smoke passed (${closure.length} packages)\n`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
