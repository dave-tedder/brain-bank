import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Session 273 hardening: drop the X-Powered-By version disclosure.
  poweredByHeader: false,
};

export default nextConfig;
