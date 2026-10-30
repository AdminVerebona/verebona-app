/**
 * Lot 101C — harnais NAVIGATEUR (Chromium réel) du test
 * `l101c-appareils-connectes-navigateur.test.ts` : monte la VRAIE carte
 * Mon compte › Sécurité (`SecurityCard` dans `ReauthProvider`). Les appels
 * réseau sont simulés (`fetch`) : deux appareils, dont celui-ci ; chaque
 * appel est compté. `next/navigation` est remplacé (aucun routeur Next).
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ReauthProvider } from '@/components/account/security/ReauthProvider';
import { SecurityCard } from '@/components/account/security/SecurityCard';

const SESSIONS = [
  { id: 'cur', current: true, clientType: 'PWA', deviceLabel: 'iPhone', browserLabel: 'Safari', createdAt: '2026-10-29T08:00:00.000Z', lastSeenAt: new Date().toISOString() },
  { id: 'pc', current: false, clientType: 'WEB', deviceLabel: 'PC Windows', browserLabel: 'Chrome', createdAt: '2026-10-28T08:00:00.000Z', lastSeenAt: new Date(Date.now() - 9 * 60_000).toISOString() },
];

declare global {
  interface Window {
    __mountSecurite: () => void;
    __appels: string[];
  }
}
window.__appels = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, window.location.href).pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  window.__appels.push(`${method} ${path}`);
  if (path === '/api/users/me/sessions' && method === 'GET') return json({ sessions: SESSIONS, currentListed: true });
  if (path.startsWith('/api/users/me/sessions/') && method === 'DELETE') return json({ success: true });
  if (path === '/api/users/me/sessions/revoke-others') return json({ revoked: 1, securityEmail: true });
  if (path === '/api/users/me/email-change') return json({ pending: null });
  return json({ error: 'non simulé' }, 404);
};

let root: Root | null = null;
window.__mountSecurite = () => {
  root?.unmount();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <main style={{ padding: 16, maxWidth: 760, margin: '0 auto' }}>
        <div style={{ height: 1200 }} data-testid="au-dessus">Mon compte</div>
        <ReauthProvider><SecurityCard /></ReauthProvider>
        <div style={{ height: 1200 }} />
      </main>,
    );
  });
};
