/**
 * Compte clôturé (suppression volontaire différée de 30 jours) : le
 * middleware ne laisse passer que l'écran « Compte en cours de suppression »,
 * l'annulation, l'export RGPD et la lecture de l'identité. `SessionService`
 * applique la même règle (défense en profondeur).
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '@/middleware';
import { generateAccessToken } from '@/lib/jwt';
import { SessionService } from '@/lib/session-service';
import {
  isApiAllowedWhilePendingDeletion,
  isPageAllowedWhilePendingDeletion,
} from '@/lib/auth/account-closure';

const ORIGIN = 'http://localhost:3000';

function req(path: string, init: { method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers });
}
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';
const cookieFor = async (status: string) => `access_token=${await generateAccessToken({
  id: 424242, email: 'clos@exemple.fr', role: 'USER' as never, planType: 'STANDARD' as never,
  status: status as never, currentAccountId: 9, hasActiveAccount: true,
})}`;

describe('pages', () => {
  it('toute page protégée renvoie vers « Compte en cours de suppression »', async () => {
    const cookie = await cookieFor('PENDING_DELETION');
    for (const path of ['/accueil', '/assets/12', '/mon-compte', '/documents']) {
      const res = await middleware(req(path, { cookie }));
      expect(res.status, path).toBe(307);
      expect(res.headers.get('location'), path).toBe(`${ORIGIN}/compte-en-suppression`);
    }
  });

  it('l’écran lui-même est servi (sans boucle) et fait partie du matcher', async () => {
    const cookie = await cookieFor('PENDING_DELETION');
    expect(passes(await middleware(req('/compte-en-suppression', { cookie })))).toBe(true);
    expect(config.matcher).toContain('/compte-en-suppression/:path*');
  });

  it('sans session : renvoi à la connexion, retour prévu sur l’écran', async () => {
    const res = await middleware(req('/compte-en-suppression'));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?returnUrl=%2Fcompte-en-suppression`);
  });

  it('compte actif : aucune redirection', async () => {
    expect(passes(await middleware(req('/accueil', { cookie: await cookieFor('ACTIVE') })))).toBe(true);
  });
});

describe('API', () => {
  it.each([
    ['GET', '/api/users/me/deletion'],
    ['DELETE', '/api/users/me/deletion'],
    ['GET', '/api/users/me/gdpr-export'],
    ['POST', '/api/users/me/gdpr-export'],
    ['GET', '/api/users/me/gdpr-export/download'],
    ['GET', '/api/users/me'],
    ['GET', '/api/auth/me'],
  ])('%s %s : autorisée (annuler, exporter, identité)', async (method, path) => {
    const cookie = await cookieFor('PENDING_DELETION');
    expect(passes(await middleware(req(path, { method, cookie })))).toBe(true);
  });

  it.each([
    ['GET', '/api/assets'],
    ['POST', '/api/assets'],
    ['GET', '/api/documents'],
    ['PUT', '/api/users/me'],
    ['POST', '/api/users/me/deletion'],
    ['GET', '/api/notifications'],
    ['POST', '/api/billing/create-checkout-session'],
    ['GET', '/api/admin/gdpr'],
  ])('%s %s : 403 ACCOUNT_PENDING_DELETION', async (method, path) => {
    const cookie = await cookieFor('PENDING_DELETION');
    const res = await middleware(req(path, { method, cookie }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ACCOUNT_PENDING_DELETION');
  });

  it('connexion et renouvellement restent publics (reconnexion pour annuler / exporter)', async () => {
    const cookie = await cookieFor('PENDING_DELETION');
    expect(passes(await middleware(req('/api/auth/login', { method: 'POST', cookie })))).toBe(true);
    expect(passes(await middleware(req('/api/auth/refresh', { method: 'POST', cookie })))).toBe(true);
  });
});

describe('SessionService : défense en profondeur', () => {
  it('refuse une route non autorisée, accepte l’annulation', async () => {
    const cookie = await cookieFor('PENDING_DELETION');
    await expect(SessionService.getSession(req('/api/assets', { cookie }))).rejects.toThrow('ACCOUNT_PENDING_DELETION');
    const refus = SessionService.handleSessionError(new Error('ACCOUNT_PENDING_DELETION'));
    expect(refus.status).toBe(403);
  });
});

describe('règles pures', () => {
  it('liste fermée : chemin ET méthode', () => {
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/deletion/', 'delete')).toBe(true);
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/deletion', 'POST')).toBe(false);
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/deletion-bis', 'GET')).toBe(false);
    expect(isApiAllowedWhilePendingDeletion('/api/users/me', 'DELETE')).toBe(false);
    expect(isPageAllowedWhilePendingDeletion('/compte-en-suppression')).toBe(true);
    expect(isPageAllowedWhilePendingDeletion('/compte-en-suppressionX')).toBe(false);
  });
});
