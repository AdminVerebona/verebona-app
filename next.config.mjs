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
              // Site public : catalogue du Centre d'aide (« Besoin d'aide »).
              // Plus de cadre du site public (Centre d'aide intégré /aide
              // supprimé au lot 63B : /aide redirige vers le site public).
              `connect-src 'self' https://api.stripe.com ${PUBLIC_SITE_ORIGIN}`,
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
      // ── Lot 108G : CSP APPLIQUÉE dans l'application iOS / Android ──────────
      // (interface distante, décision PO du 03/11/2026). Seule la vue de l'app
      // (marqueur `VerebonaApp/` de l'agent utilisateur, posé par la coque) la
      // reçoit : le site web garde sa CSP d'observation ci-dessus, inchangé.
      // Directives qui protègent le pont natif sans casser les scripts de
      // Next.js : aucun cadre tiers (le pont est joignable depuis un cadre),
      // aucun plugin `object`, pas de `<base>` détourné, formulaires vers
      // l'origine seulement, intégration en cadre limitée à l'origine.
      // `script-src` reste celui du site (scripts en ligne de Next.js) : risque
      // résiduel documenté dans docs/mobile/architecture-distante.md § 5.
      {
        source: "/(.*)",
        has: [{ type: "header", key: "user-agent", value: ".*VerebonaApp/.*" }],
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "object-src 'none'",
              "base-uri 'self'",
              "frame-src 'self' blob: data:",
              "frame-ancestors 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
      // ── Lot 79B : icônes de l'application installée ──────────────────────
      // `public/pwa/` : noms versionnés (src/lib/pwa/icons.ts), un fichier
      // n'est JAMAIS modifié sur place → cache long et immuable.
      {
        source: "/pwa/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      // Anciens noms (installations antérieures, convention iOS
      // `/apple-touch-icon.png`), service worker et manifeste statique :
      // toujours revalidés auprès du serveur, jamais resservis périmés.
      {
        source: "/:file(apple-touch-icon\\.png|apple-touch-icon-v2\\.png|android-chrome-192x192\\.png|android-chrome-512x512\\.png|sw\\.js|manifest\\.json)",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
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
  // ══════════════════════════════════════════════════════════════════════
  // BUILD SCALINGO : PAS DE LINT NI DE VÉRIFICATION DES TYPES DANS `next build`
  // (12/10/2026). La vérification complète des types du projet demande
  // désormais ~2,8 Go de tas, au-delà du plafond du conteneur de build
  // (~2,5 Go) → « JavaScript heap out of memory » dès que le cache
  // incrémental de `.next/cache` est invalidé. Les deux contrôles restent
  // BLOQUANTS en CI (`npm run typecheck`, `npm run lint`, workflow CI) ;
  // le build ne fait plus que compiler.
  // ══════════════════════════════════════════════════════════════════════
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: {
    // Réduit le pic mémoire de la compilation webpack (Next 15).
    webpackMemoryOptimizations: true,
    // Lot 104 (build Scalingo en manque de mémoire, 02/11/2026) : un seul
    // processus de collecte des pages au lieu d'un par cœur.
    cpus: 1,
    // Lot 109H (conteneur web tué pour quota mémoire, 03/11/2026) : `next
    // start` NE précharge plus les 596 pages et routes au démarrage. Mesure
    // locale du build lot 108 (processus au repos, aucune requête) : RSS
    // 555 Mo → 170-190 Mo, tas V8 439 Mo → 83 Mo ; après appel de TOUTES les
    // entrées : 322 Mo. Chaque page est chargée à sa première requête (une
    // fois par conteneur). Lu au démarrage du serveur (pas au build) :
    // NEXT_PRELOAD_ENTRIES=true remet le préchargement (retour arrière sans
    // nouveau build, simple redémarrage). Guide : docs/exploitation/memoire-scalingo-109h.md.
    preloadEntriesOnStart: process.env.NEXT_PRELOAD_ENTRIES === 'true',
    // Le code serveur n'est jamais envoyé au navigateur : sa minification
    // ne sert à rien et coûte une grosse part de la mémoire du build.
    serverMinification: false,
  },
  // Lot 104 : pas de cache webpack persistant en production (Scalingo repart
  // d'un dossier .next vide) et une seule tâche webpack à la fois.
  webpack: (config, { dev }) => {
    if (!dev) {
      config.cache = false;
      config.parallelism = 1;
    }
    return config;
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
