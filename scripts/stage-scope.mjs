// Stage the observability dashboard (apps/scope) Next.js standalone build into
// the @fusionkit/cli package so `fusionkit --observe` works for npm-installed
// users with no separate install. Run AFTER `pnpm build` inside apps/scope.
//
// The Next standalone output is a self-contained server (a minimal Node server
// + only the traced, pure-JS node_modules). We assemble the canonical
// standalone layout:
//   <dest>/server.js          the standalone entrypoint (reads PORT/HOSTNAME)
//   <dest>/.next/...          server chunks + (copied) static assets
//   <dest>/public/...         public assets, when present
//   <dest>/node_modules/...   traced runtime deps (flat, real files)
//
// The staged tree lives at packages/cli/scope/ (gitignored) and is published
// via the cli package's `files: ["dist", "scope"]`.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scopeDir = join(repoRoot, "apps", "scope");
const standaloneDir = join(scopeDir, ".next", "standalone");
const staticDir = join(scopeDir, ".next", "static");
const publicDir = join(scopeDir, "public");
const dest = join(repoRoot, "packages", "cli", "scope");

if (!existsSync(join(standaloneDir, "server.js"))) {
  console.error(
    "stage-scope: missing apps/scope/.next/standalone/server.js\n" +
      "  Build the dashboard first: cd apps/scope && pnpm install && pnpm build"
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

// 1) The standalone bundle (server.js, .next/server, node_modules, package.json).
cpSync(standaloneDir, dest, { recursive: true, dereference: true });

// 2) Static assets are emitted outside the standalone tree by design; the
//    standalone server serves them from <dest>/.next/static.
cpSync(staticDir, join(dest, ".next", "static"), { recursive: true, dereference: true });

// 3) Public assets, when the app has any.
if (existsSync(publicDir)) {
  cpSync(publicDir, join(dest, "public"), { recursive: true, dereference: true });
}

// 4) Drop the empty SQLite file Next created under cwd during static
//    generation; the CLI always points the server at a fresh per-run db.
rmSync(join(dest, ".scopekit"), { recursive: true, force: true });

console.log(`stage-scope: staged dashboard into ${dest}`);
