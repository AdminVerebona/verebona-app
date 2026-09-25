/**
 * Rotation fiable des jetons de renouvellement : identifiant unique,
 * révocation bloquante et atomique, réutilisation détectée.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const revoked = new Set<string>();
let revokeFails = false;
const activity: Array<{ activityType: string }> = [];
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const user = { id: 1, email: 'a@b.fr', role: 'USER', planType: 'STANDARD', status: 'ACTIVE', isActive: true };
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [user] };
  return {
    ...actual,
    db: chain,
    isTokenRevoked: async (h: string) => revoked.has(h),
    revokeTokenOnce: async (h: string) => {
      if (revokeFails) throw new Error('ECONNRESET');
      await new Promise((r) => setTimeout(r, 1));
      if (revoked.has(h)) return false;
      revoked.add(h); return true;
    },
    getUserSessionCutoff: async () => null,
  };
});
vi.mock('@/services/account-service', () => ({ AccountService: { getUserDefaultAccount: async () => ({ id: 9, subscriptionStatus: 'ACTIVE' }) } }));
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: (a: { activityType: string }) => { activity.push(a); } }));

const { POST: refresh } = await import('../refresh/route');
const { generateRefreshToken, verifyToken } = await import('@/lib/jwt');

const claims = { id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never };
const req = (token: string) => new NextRequest('http://x/api/auth/refresh', { method: 'POST', headers: { cookie: `refresh_token=${token}` } });

beforeEach(() => { revoked.clear(); revokeFails = false; activity.length = 0; });

describe('identifiant unique', () => {
  it('deux jetons émis dans la même seconde, mêmes données, sont distincts', async () => {
    const [a, b] = await Promise.all([generateRefreshToken(claims), generateRefreshToken(claims)]);
    expect(a).not.toBe(b);
    const [pa, pb] = await Promise.all([verifyToken(a), verifyToken(b)]);
    expect(pa?.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(pa?.jti).not.toBe(pb?.jti);
  });
});

describe('rotation', () => {
  it('renouvellement réussi : nouveau jeton distinct, ancien inutilisable (réutilisation détectée)', async () => {
    const ancien = await generateRefreshToken(claims);
    const ok = await refresh(req(ancien));
    expect(ok.status).toBe(200);
    const nouveau = ok.cookies.get('refresh_token')?.value;
    expect(nouveau).toBeTruthy();
    expect(nouveau).not.toBe(ancien);

    const rejeu = await refresh(req(ancien));
    expect(rejeu.status).toBe(401);
    expect(activity.some((a) => a.activityType === 'AUTH_TOKEN_REUSE_DETECTED')).toBe(true);
  });

  it('révocation en échec : pas de succès annoncé, aucun nouveau cookie', async () => {
    revokeFails = true;
    const res = await refresh(req(await generateRefreshToken(claims)));
    expect(res.status).toBe(503);
    expect(res.cookies.get('refresh_token')).toBeUndefined();
    expect(res.cookies.get('access_token')).toBeUndefined();
  });

  it('deux renouvellements concurrents du même jeton : une seule session', async () => {
    const t = await generateRefreshToken(claims);
    const [r1, r2] = await Promise.all([refresh(req(t)), refresh(req(t))]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    const perdant = r1.status === 401 ? r1 : r2;
    expect(perdant.cookies.get('refresh_token')).toBeUndefined();
  });
});
