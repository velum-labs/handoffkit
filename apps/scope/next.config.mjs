/** @type {import('next').NextConfig} */
const nextConfig = {
  // The collector uses node:sqlite (built-in), so route handlers run on Node.
  experimental: {},
  // Allow the portless proxy's hostnames as dev origins (Next blocks unknown
  // cross-origin dev requests). Covers `.localhost` and worktree subdomains.
  allowedDevOrigins: ["scope.localhost", "*.scope.localhost"],
  // Emit a self-contained server (.next/standalone/server.js bundling a minimal
  // Node server + only the traced node_modules) so the dashboard can be staged
  // into and shipped with the @fusionkit/cli npm package — no separate install.
  output: "standalone",
  // The dashboard renders no <Image>; disabling optimization keeps Next from
  // tracing the native `sharp` binaries into the bundle, so the shipped CLI
  // stays platform-independent (pure JS) and an order of magnitude smaller.
  images: { unoptimized: true },
  // Drop deps the running server never loads from the standalone bundle: the
  // native `sharp`/`@img` image codecs (image optimization is off above) and
  // the build-only `typescript`/`caniuse-lite`. This keeps the tarball shipped
  // inside @fusionkit/cli pure-JS and small.
  outputFileTracingExcludes: {
    "*": [
      "node_modules/sharp/**",
      "node_modules/@img/**",
      "node_modules/typescript/**",
      "node_modules/caniuse-lite/**"
    ]
  },
  // Keep the local dashboard quiet about workspace-root inference, and (because
  // standalone traces files relative to this root) keep the emitted layout flat
  // at .next/standalone/server.js instead of nested under a monorepo path.
  outputFileTracingRoot: process.cwd()
};

export default nextConfig;
