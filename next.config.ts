import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Single source of truth for the app version: package.json (bump with `npm version`).
const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as {
  version: string;
};

const nextConfig: NextConfig = {
  // Surface the npm version to the client for the footer badge.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // We sit inside a multi-workspace checkout; pin the root so Turbopack
  // doesn't infer a parent directory from stray lockfiles.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
