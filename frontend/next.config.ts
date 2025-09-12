import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Don't fail production builds on ESLint errors
    ignoreDuringBuilds: true,
  },
  typescript: {
    // If type errors block builds in CI, you can allow builds to continue.
    // Consider turning this back off once types are fixed.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
