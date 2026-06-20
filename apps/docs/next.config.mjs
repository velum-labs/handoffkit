import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // This is a standalone app with its own lockfile; scope file tracing to it so
  // Next doesn't infer the monorepo root (and warn about multiple lockfiles).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // Allow the portless proxy's hostnames as dev origins (Next blocks unknown
  // cross-origin dev requests).
  allowedDevOrigins: ["docs.fusion.localhost", "*.docs.fusion.localhost"]
};

export default withMDX(config);
