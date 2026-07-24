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
  async headers () {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HSTS : impose HTTPS pendant 1 an (production uniquement).
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
          // CSP en mode observation (CDC §15).
          // Volontairement Report-Only : une CSP stricte appliquee d'emblee
          // casserait les scripts inline de Next.js. Observer les violations
          // dans la console, ajuster, puis basculer sur "Content-Security-Policy".
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://api.stripe.com",
              "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
              // Anti-clickjacking : remplace X-Frame-Options et reste
              // compatible avec l'integration en iframe de meme origine.
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
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
