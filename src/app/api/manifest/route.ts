import { NextRequest, NextResponse } from 'next/server';

const MOBILE_MANIFEST = {
  name: 'Verebona — One place. Higher value.',
  short_name: 'Verebona',
  description: 'Tous vos biens et tous leurs documents, au même endroit. One place. Higher value.',
  start_url: '/accueil',
  display: 'standalone',
  background_color: '#020B1A',
  theme_color: '#3B82F6',
  orientation: 'portrait-primary',
  scope: '/',
  handle_links: 'preferred',
  icons: [
    { src: '/favicon-96x96.png',          sizes: '96x96',   type: 'image/png', purpose: 'any' },
    { src: '/favicon-128x128.png',        sizes: '128x128', type: 'image/png', purpose: 'any' },
    { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/favicon-256x256.png',        sizes: '256x256', type: 'image/png', purpose: 'any' },
    { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
  categories: ['productivity', 'finance', 'business'],
  shortcuts: [
    { name: 'Accueil',       short_name: 'Accueil',    description: 'Accéder au tableau de bord',  url: '/accueil',   icons: [{ src: '/android-chrome-192x192.png', sizes: '192x192' }] },
    { name: 'Mes biens',     short_name: 'Biens',      description: 'Voir tous mes biens',         url: '/assets',    icons: [{ src: '/android-chrome-192x192.png', sizes: '192x192' }] },
    { name: 'Mes documents', short_name: 'Documents',  description: 'Gérer mes documents',         url: '/documents', icons: [{ src: '/android-chrome-192x192.png', sizes: '192x192' }] },
    { name: 'Agenda',        short_name: 'Agenda',     description: 'Voir mes événements',         url: '/agenda',    icons: [{ src: '/android-chrome-192x192.png', sizes: '192x192' }] },
  ],
};

// Desktop: minimal manifest — no scope, no standalone display, no handle_links.
// This prevents browsers from offering PWA install or intercepting links on desktop.
const DESKTOP_MANIFEST = {
  name: 'Verebona — One place. Higher value.',
  short_name: 'Verebona',
  display: 'browser',
  background_color: '#020B1A',
  theme_color: '#3B82F6',
  icons: [
    { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
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
