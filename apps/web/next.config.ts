import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The pnpm workspace keeps runtime dependencies at the monorepo root.
  // Trace from there so Vercel packages every server route with its dependencies.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
