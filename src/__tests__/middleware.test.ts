/**
 * Middleware — emplacement effectif et règles d'accès.
 *
 * Le fichier était à la racine du dépôt alors que l'application vit dans
 * `src/app` : Next.js ne le chargeait pas. Déplacé dans `src/`, il devient
 * actif ; ces tests vérifient qu'il protège l'API sans casser les parcours
 * publics (auth, ICS, transmission, cron, webhook, manifeste) ni le mode
 * restreint (compte sans abonnement actif).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '@/middleware';
import { generateAccessToken } from '@/lib/jwt';

const ORIGIN = 'http://localhost:3000';

function req(path: string, init: { method?: string; cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers });
}
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';
const token = (extra: { hasActiveAccount?: boolean; status?: string } = {}) => generateAccessToken({
  id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never,
  status: (extra.status ?? 'ACTIVE') as never, currentAccountId: 9, hasActiveAccount: extra.hasActiveAccount ?? true,
});

describe('emplacement', () => {
  it('le middleware est dans src/ (à côté de app/), plus à la racine où Next.js l’ignorait', () => {
    expect(existsSync(join(process.cwd(), 'src/middleware.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'middleware.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/app'))).toBe(true);
  });

  it('le matcher couvre l’API et les pages protégées', () => {
    expect(config.matcher).toContain('/api/:path*');
    expect(config.matcher).toContain('/accueil/:path*');
  });
});

describe('API', () => {
  it('route applicative sans session : 401', async () => {
    const res = await middleware(req('/api/assets'));
    expect(res.status).toBe(401);
  });

  it('route applicative avec session : laissée à la route', async () => {
    expect(passes(await middleware(req('/api/assets', { cookie: `access_token=${await token()}` })))).toBe(true);
  });

  it('compte sans abonnement actif (mode restreint) : pas de 403 NO_ACTIVE_ACCOUNT', async () => {
    const cookie = `access_token=${await token({ hasActiveAccount: false })}`;
    expect(passes(await middleware(req('/api/documents', { cookie })))).toBe(true);
    expect(passes(await middleware(req('/api/auth/me', { cookie })))).toBe(true);
  });

  it('utilisateur suspendu : 403', async () => {
    const cookie = `access_token=${await token({ status: 'SUSPENDED' })}`;
    expect((await middleware(req('/api/assets', { cookie }))).status).toBe(403);
  });

  it.each([
    '/api/auth/login',
    '/api/auth/verify-email',
    '/api/auth/reset-password',
    '/api/health',
    '/api/users',
    '/api/calendar/0123abcd.ics',
    '/api/transmission/jeton-de-transmission',
    '/api/manifest',
    '/api/push/public-key',
    '/api/legal/cgvu/current',
    '/api/withdrawal/public/start',
    '/api/public/help-feedback',
    '/api/referral/validate/ABC123',
    '/api/cron/purge-blobs',
    '/api/duo/join',
    '/api/purge-pending-uploads',
  ])('route publique sans session : %s', async (path) => {
    expect(passes(await middleware(req(path)))).toBe(true);
  });

  it('webhook Stripe et tâches planifiées : POST sans Origin accepté (signature / CRON_SECRET)', async () => {
    expect(passes(await middleware(req('/api/billing/stripe-webhook', { method: 'POST', origin: null })))).toBe(true);
    expect(passes(await middleware(req('/api/cron/backup', { method: 'POST', origin: null })))).toBe(true);
  });

  it('CSRF : POST depuis une origine étrangère refusé', async () => {
    const cookie = `access_token=${await token()}`;
    const res = await middleware(req('/api/assets', { method: 'POST', cookie, origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_ORIGIN_REJECTED');
  });
});

describe('pages protégées', () => {
  it('sans aucune session : redirection vers /login', async () => {
    const res = await middleware(req('/accueil'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?returnUrl=%2Faccueil');
  });

  it('jeton d’accès expiré mais session renouvelable : page servie (le client renouvelle)', async () => {
    expect(passes(await middleware(req('/assets/12', { cookie: 'refresh_token=xyz' })))).toBe(true);
  });

  it('compte sans abonnement actif : page servie, pas de redirection forcée vers l’onboarding', async () => {
    const cookie = `access_token=${await token({ hasActiveAccount: false })}`;
    expect(passes(await middleware(req('/documents', { cookie })))).toBe(true);
  });

  it('fichier statique sous /assets (public/) : jamais intercepté', async () => {
    expect(passes(await middleware(req('/assets/verebona/mascot/v1/alert/md.webp')))).toBe(true);
  });
});
