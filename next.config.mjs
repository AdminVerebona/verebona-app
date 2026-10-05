// @ts-check

/** Origine du site public de l'environnement (Centre d'aide). */
const PUBLIC_SITE_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_PUBLIC_SITE_URL || "https://www.verebona.fr").origin;
  } catch {
    return "https://www.verebona.fr";
  }
})();

/** @type {import("next").NextConfig} */
const nextConfig = {
  transpilePackages: ["@verebona/ui"],
  // Moteur PDF des dossiers V12 (CDC Exports V12 DEC-003) : Playwright est
  // chargé tel quel par Node côté serveur, jamais empaqueté (binaires,
  // `require` dynamiques) ni exposé au navigateur.
  serverExternalPackages: ["playwright-core"],
  // Commit du build figé dans l'image (APP-PERF-37) : Scalingo pose
  // SOURCE_VERSION pendant le build. Lu par `src/lib/runtime-identity.ts`.
  env: {
    APP_BUILD_COMMIT: process.env.SOURCE_VERSION || "",
  },
  // APP-PERF-38 : plus d'origines de développement Orchids (`allowedDevOrigins`),
  // ni de chargeur Turbopack « visual-edits » (identité, résidu de l'éditeur
  // Orchids). Inventaire : docs/exploitation/residus-historiques.md.
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
              // Site public : catalogue du Centre d'aide (« Besoin d'aide ») et
              // Centre d'aide intégré dans /aide (CDC Centre d'aide §13, GAP-09).
              `connect-src 'self' https://api.stripe.com ${PUBLIC_SITE_ORIGIN}`,
              `frame-src 'self' https://js.stripe.com https://hooks.stripe.com ${PUBLIC_SITE_ORIGIN}`,
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
    // Stockage OVH (Scalingo/PostgreSQL/OVH). Domaines Supabase et Orchids
    // retirés (APP-PERF-38) : aucun visuel servi par l'application n'y pointe
    // — contrôle des URL stockées avant mise en production dans l'inventaire.
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
        hostname: "*.googleusercontent.com",
      },
    ],
    imageSizes: [90, 110, 128, 256, 384],
    minimumCacheTTL: 3600,
  },
};

export default nextConfig;
