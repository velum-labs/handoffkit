import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Allow the portless proxy's hostnames as dev origins (Next blocks unknown
  // cross-origin dev requests).
  allowedDevOrigins: ["docs.fusion.localhost", "*.docs.fusion.localhost"]
};

export default withMDX(config);
