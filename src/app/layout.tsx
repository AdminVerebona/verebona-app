import './globals.css';
import { ReactNode } from 'react';
import { Viewport, Metadata } from 'next';
import { ClientShell } from '@/components/ClientShell';

export const metadata: Metadata = {
  metadataBase: new URL('https://verebona.app'),
  title: {
    default: 'Verebona — Organisez vos biens et documents',
    template: '%s — Verebona',
  },
  description: 'Centralisez vos biens, documents et échéances. Retrouvez, anticipez, valorisez.',
  manifest: '/api/manifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-48x48.png', sizes: '48x48', type: 'image/png' },
      { url: '/favicon-64x64.png', sizes: '64x64', type: 'image/png' },
      { url: '/favicon-96x96.png', sizes: '96x96', type: 'image/png' },
      { url: '/favicon-128x128.png', sizes: '128x128', type: 'image/png' },
      { url: '/favicon-256x256.png', sizes: '256x256', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon-v2.png', sizes: '180x180', type: 'image/png' },
    ],
    other: [
      { rel: 'android-chrome', url: '/android-chrome-192x192.png', sizes: '192x192' },
      { rel: 'android-chrome', url: '/android-chrome-512x512.png', sizes: '512x512' },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
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
  themeColor: '#020617',
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
        {/* Script bloquant avant tout rendu : lit le thème dans localStorage et l'applique immédiatement */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('verebona-theme');if(t==='beige'||t==='blue'){document.documentElement.setAttribute('data-theme',t);}else{document.documentElement.setAttribute('data-theme','blue');}}catch(e){}})();`,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
        <script
          defer
          src="https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/scripts/orchids-browser-logs.js"
          data-orchids-project-id="5da8aa09-2540-4b03-96bf-bb17130a3250"
        />
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}
