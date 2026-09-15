import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Cloud Run: self-contained server bundle (see Dockerfile at the repo root).
  output: "standalone",
  // Pin Turbopack's workspace root to web/ — the monorepo root has its own
  // package-lock.json (React Native app) which would otherwise confuse the
  // detection and surface a warning on every build.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
