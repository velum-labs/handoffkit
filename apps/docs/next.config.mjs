import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/**
 * Permanent redirects from the pre-taxonomy URL scheme (flat pages plus the
 * "cli"/"sdks" sections) to the intent-based sections (guides/reference/...).
 */
const movedPages = [
  ["/docs/getting-started/configuration", "/docs/reference/configuration"],
  ["/docs/getting-started/inference-endpoint", "/docs/guides/inference-endpoint"],
  ["/docs/getting-started/rate-limit-handoff", "/docs/guides/rate-limit-handoff"],
  ["/docs/cli/commands", "/docs/reference/commands"],
  ["/docs/cli/models-and-panels", "/docs/reference/models-and-panels"],
  ["/docs/cli/cost-and-models", "/docs/guides/cost-and-models"],
  ["/docs/cli/observability", "/docs/guides/observability"],
  ["/docs/cli/troubleshooting", "/docs/guides/troubleshooting"],
  ["/docs/sdks/packages", "/docs/reference/packages"],
  ["/docs/examples", "/docs/guides/examples"],
  ["/docs/privacy", "/docs/concepts/privacy"],
  ["/docs/taxonomy", "/docs"],
  ["/docs/operations/release-publishing", "/docs"]
];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // This is a standalone app with its own lockfile; scope file tracing to it so
  // Next doesn't infer the monorepo root (and warn about multiple lockfiles).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // Allow the portless proxy's hostnames as dev origins (Next blocks unknown
  // cross-origin dev requests).
  allowedDevOrigins: ["docs.fusion.localhost", "*.docs.fusion.localhost"],
  redirects: async () =>
    movedPages.map(([source, destination]) => ({ source, destination, permanent: true }))
};

export default withMDX(config);
