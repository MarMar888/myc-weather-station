import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // We sit inside a multi-workspace checkout; pin the root so Turbopack
  // doesn't infer a parent directory from stray lockfiles.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
