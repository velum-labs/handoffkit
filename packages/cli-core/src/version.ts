import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readPackageVersion(fromModuleUrl: string, relativePkgPath = "../package.json"): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL(relativePkgPath, fromModuleUrl)), "utf8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function probeBinaryVersion(
  binary: string,
  options: { available?: (binary: string) => boolean; timeoutMs?: number } = {}
): string | null {
  if (options.available?.(binary) === false) return null;
  try {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 2_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (result.status !== 0) return "unknown";
    const line = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0]?.trim();
    return line && line.length > 0 ? line : "unknown";
  } catch {
    return null;
  }
}

export function formatPackageVersion(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}
