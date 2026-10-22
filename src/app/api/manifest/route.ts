import { NextRequest, NextResponse } from 'next/server';
import { PWA_MANIFEST_ICONS, PWA_SHORTCUT_ICONS } from '@/lib/pwa/icons';

// Lot 72G (décision PO du 19/10) : écran de démarrage Android de l'app
// installée en Pétrole #17474D (background_color). theme_color Pétrole aussi :
// sur le splash, la barre d'état est de la même couleur que l'écran (icônes
// claires, lisibles) ; l'icône maskable a déjà un fond Pétrole plein cadre,
// seul le logo ivoire apparaît. Une fois la page chargée, la balise
// `theme-color` par thème (ivoire / sombre, src/app/layout.tsx et
// src/lib/theme.ts) prend le relais pour la barre d'état.
const MOBILE_MANIFEST = {
  name: 'Verebona — One place. Higher value.',
  short_name: 'Verebona',
  description: 'Tous vos biens et tous leurs documents, au même endroit. One place. Higher value.',
  start_url: '/accueil',
  display: 'standalone',
  background_color: '#17474D',
  theme_color: '#17474D',
  orientation: 'portrait-primary',
  scope: '/',
  handle_links: 'preferred',
  // Lot 79B : icônes versionnées de public/pwa/ (src/lib/pwa/icons.ts),
  // « any » et « maskable » distinctes. Plus de favicons à coins transparents
  // ni d'`any maskable` combiné. NE PAS ajouter d'`id` ni modifier
  // `start_url` / `scope` : ils fondent l'identité des installations.
  icons: [...PWA_MANIFEST_ICONS],
  categories: ['productivity', 'finance', 'business'],
  shortcuts: [
    { name: 'Accueil',       short_name: 'Accueil',    description: 'Accéder au tableau de bord',  url: '/accueil',   icons: [...PWA_SHORTCUT_ICONS] },
    { name: 'Mes biens',     short_name: 'Biens',      description: 'Voir tous mes biens',         url: '/assets',    icons: [...PWA_SHORTCUT_ICONS] },
    { name: 'Mes documents', short_name: 'Documents',  description: 'Gérer mes documents',         url: '/documents', icons: [...PWA_SHORTCUT_ICONS] },
    { name: 'Agenda',        short_name: 'Agenda',     description: 'Voir mes événements',         url: '/agenda',    icons: [...PWA_SHORTCUT_ICONS] },
  ],
};

// Desktop: minimal manifest — no scope, no standalone display, no handle_links.
// This prevents browsers from offering PWA install or intercepting links on desktop.
const DESKTOP_MANIFEST = {
  name: 'Verebona — One place. Higher value.',
  short_name: 'Verebona',
  display: 'browser',
  background_color: '#17474D',
  theme_color: '#17474D',
  icons: [...PWA_MANIFEST_ICONS],
};

export async function GET(req: NextRequest) {
  const ua = req.headers.get('user-agent') ?? '';
  const mobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);

  return NextResponse.json(mobile ? MOBILE_MANIFEST : DESKTOP_MANIFEST, {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-store',
    },
  });
}
