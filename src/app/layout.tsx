import './globals.css';
import { ReactNode } from 'react';
import { Viewport, Metadata } from 'next';
import { ClientShell } from '@/components/ClientShell';
import { THEME_PAGE_COLOR, themeBootScript } from '@/lib/theme';
import { PWA_APPLE_TOUCH_ICON_180, PWA_ICON_ANY_192, PWA_ICON_ANY_512 } from '@/lib/pwa/icons';

/** Version des favicons (onglet du navigateur) : à incrémenter à chaque refonte.
 * Les icônes de l'application installée (apple-touch, Android) ont des noms
 * versionnés : src/lib/pwa/icons.ts (lot 79B). */
const ICONS_VERSION = '71h';

export const metadata: Metadata = {
  metadataBase: new URL('https://verebona.app'),
  title: {
    default: 'Verebona — Organisez vos biens et documents',
    template: '%s — Verebona',
  },
  description: 'Centralisez vos biens, documents et échéances. Retrouvez, anticipez, valorisez.',
  manifest: '/api/manifest',
  // Lot 71H — icônes à la charte Sérénité (lot 66) : tuile pétrole #17474D,
  // cases ivoire #F8F6F1, cube cuivre #D66B53. `?v=` force le rechargement
  // des icônes déjà en cache chez les navigateurs (noms de fichiers inchangés).
  icons: {
    icon: [
      { url: `/favicon.ico?v=${ICONS_VERSION}`, sizes: 'any' },
      { url: `/favicon.svg?v=${ICONS_VERSION}`, type: 'image/svg+xml' },
      { url: `/favicon-16x16.png?v=${ICONS_VERSION}`, sizes: '16x16', type: 'image/png' },
      { url: `/favicon-32x32.png?v=${ICONS_VERSION}`, sizes: '32x32', type: 'image/png' },
      { url: `/favicon-48x48.png?v=${ICONS_VERSION}`, sizes: '48x48', type: 'image/png' },
      { url: `/favicon-64x64.png?v=${ICONS_VERSION}`, sizes: '64x64', type: 'image/png' },
      { url: `/favicon-96x96.png?v=${ICONS_VERSION}`, sizes: '96x96', type: 'image/png' },
      { url: `/favicon-128x128.png?v=${ICONS_VERSION}`, sizes: '128x128', type: 'image/png' },
      { url: `/favicon-256x256.png?v=${ICONS_VERSION}`, sizes: '256x256', type: 'image/png' },
    ],
    // Lot 79B : apple-touch-icon 180 × 180 opaque, coins carrés (iOS applique
    // son masque), nom versionné (plus de `?v=` : iOS mémorise l'URL exacte).
    // Déclaré ici seulement : toutes les pages héritent du layout racine.
    apple: [
      { url: PWA_APPLE_TOUCH_ICON_180, sizes: '180x180', type: 'image/png' },
    ],
    other: [
      { rel: 'android-chrome', url: PWA_ICON_ANY_192, sizes: '192x192' },
      { rel: 'android-chrome', url: PWA_ICON_ANY_512, sizes: '512x512' },
    ],
  },
  appleWebApp: {
    capable: true,
    // `black-translucent` : la page s'étend sous la barre d'état et iOS
    // renseigne `env(safe-area-inset-top)`, que la barre haute mobile, le
    // panneau du compte et l'espace Verebona réservent déjà. Avec `default`,
    // iOS 26 affiche la page sous la barre d'état SANS renseigner l'encart :
    // le champ « Demander à Verebona » et l'avatar passaient sous l'heure et
    // la batterie (préprod, 4 oct. 2026). La barre d'état prend la couleur
    // du fond de la barre haute (`--bg-page`) : ivoire en thème clair, encre
    // en thème sombre (lot 66).
    statusBarStyle: 'black-translucent',
    title: 'Verebona',
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    siteName: 'Verebona',
    locale: 'fr_FR',
    type: 'website',
  },
};

export const viewport: Viewport = {
  // Charte « Sérénité » (lot 66) : fond de page de chaque thème. Variantes
  // selon la préférence du système ; le thème choisi dans l'application
  // remplace ensuite leur valeur (src/lib/theme.ts, applyThemeToDocument).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_PAGE_COLOR.beige },
    { media: '(prefers-color-scheme: dark)', color: THEME_PAGE_COLOR.blue },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        {/* Script bloquant avant tout rendu : thème enregistré, sinon préférence
            du système (lot 66) — même règle que `useThemeToggle` (src/lib/theme.ts). */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeBootScript() }}
        />
      </head>
      <body suppressHydrationWarning>
        { }
        {/* ══════════════════════════════════════════════════════════════
            SCRIPT TIERS RETIRÉ

            Un script d'observation hébergé chez Supabase, avec un
            identifiant de projet Orchids, chargeait sur chaque page — y
            compris en préproduction avec de vraies données.

            Il violait la politique de sécurité du contenu à chaque
            chargement. Celle-ci étant en `report-only`, la violation était
            journalisée sans être bloquée : le script s'exécutait quand même.

            Résidu de l'outil ayant généré le squelette du projet. Personne
            ne l'a demandé, et rien ne dit ce qu'il transmet.
            ══════════════════════════════════════════════════════════════ */}
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}
