// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOADER = path.resolve(
  __dirname,
  "src/visual-edits/component-tagger-loader.js",
);

/** @type {import("next").NextConfig} */
const nextConfig = {
  transpilePackages: ["@verebona/ui"],
  allowedDevOrigins: ["*.orchids.cloud", "orchids.cloud"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/api/auth/(.*)",
        headers: [
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      {
        source: "/verify-email",
        headers: [
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
  compress: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "verebona-files.s3.gra.io.cloud.ovh.net",
      },
      {
        protocol: "https",
        hostname: "s3.gra.io.cloud.ovh.net",
      },
      {
        protocol: "https",
        hostname: "*.io.cloud.ovh.net",
      },
      {
        protocol: "https",
        hostname: "slelguoygbfzlpylpxfs.supabase.co",
      },
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
      {
        protocol: "https",
        hostname: "*.orchids.cloud",
      },
      {
        protocol: "https",
        hostname: "*.googleusercontent.com",
      },
    ],
    imageSizes: [90, 110, 128, 256, 384],
    minimumCacheTTL: 3600,
  },
  turbopack: {
    rules: {
      "./src/app/**/*.{jsx,tsx}": {
        loaders: [LOADER],
      },
    },
  },
};

export default nextConfig;
