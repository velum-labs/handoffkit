/** @type {import('next').NextConfig} */
const nextConfig = {
  // The collector uses node:sqlite (built-in), so route handlers run on Node.
  experimental: {},
  // Keep the local dashboard quiet about workspace-root inference.
  outputFileTracingRoot: process.cwd()
};

export default nextConfig;
