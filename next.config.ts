import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "maps.googleapis.com" },
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  // Stagehand is a heavy server-only SDK. Keep it out of the webpack
  // bundle so it's require()'d at runtime from node_modules — this also
  // sidesteps its zod-v4 import surface during the build. Only loaded
  // when BOOKING_ENGINE=stagehand actually runs it.
  serverExternalPackages: ["@browserbasehq/stagehand"],
};

export default nextConfig;
