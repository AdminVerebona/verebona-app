/**
 * Rotation fiable des jetons de renouvellement : identifiant unique,
 * révocation bloquante et atomique, réutilisation détectée.
 *
 * Lot 37 (C2, CDC 18 §19.3) : réutilisation d'un jeton déjà tourné →
 * fenêtre de grâce (requêtes concurrentes légitimes, rien n'est émis) ou
 * incident (révocation de toutes les sessions, cookies effacés).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const revoked = new Map<string, { revokedAt: Date; reason: 'rotated' | 'logout' | null }>();
let revokeFails = false;
let revokeAllFails = false;
const securityEmails: number[] = [];
const revokeAll: Array<{ userId: number; reason: string }> = [];
const activity: Array<{ activityType: string; details?: Record<string, unknown> }> = [];
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const user = { id: 1, email: 'a@b.fr', role: 'USER', planType: 'STANDARD', status: 'ACTIVE', isActive: true };
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [user] };
  return {
    ...actual,
    db: chain,
    isTokenRevoked: async (h: string) => revoked.has(h),
    getRevokedTokenInfo: async (h: string) => revoked.get(h) ?? null,
    revokeTokenOnce: async (h: string, _u: number, _e: Date, reason: 'rotated' | 'logout' = 'rotated') => {
      if (revokeFails) throw new Error('ECONNRESET');
      await new Promise((r) => setTimeout(r, 1));
      if (revoked.has(h)) return false;
      revoked.set(h, { revokedAt: new Date(), reason }); return true;
    },
    revokeAllUserSessions: async (userId: number, reason: string) => {
      if (revokeAllFails) throw new Error('ECONNRESET');
      revokeAll.push({ userId, reason }); return new Date();
    },
    getUserSessionCutoff: async () => null,
  };
});
vi.mock('@/services/account-service', () => ({ AccountService: {
  getUserDefaultAccount: async () => ({ id: 9, subscriptionStatus: 'ACTIVE' }),
  getUserSessionAccounts: async () => [{ account: { id: 9, subscriptionStatus: 'ACTIVE' }, membershipId: 1, role: 'owner' }],
} }));
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: (a: { activityType: string }) => { activity.push(a); } }));
// Lot 38 (volet B) : e-mail de sécurité planifié après la réponse.
vi.mock('@/services/auth/sessions-revoked-email.service', () => ({
  scheduleSessionsRevokedEmail: (userId: number) => { securityEmails.push(userId); },
}));

const { POST: refresh } = await import('../refresh/route');
const { generateRefreshToken, verifyRefreshToken, verifyAccessToken } = await import('@/lib/jwt');
const { hashToken } = await import('@/db');
const { REFRESH_REUSE_GRACE_MS, classifyRefreshReplay } = await import('@/lib/auth/refresh-replay');

const claims = { id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never };
const req = (token: string) => new NextRequest('http://x/api/auth/refresh', { method: 'POST', headers: { cookie: `refresh_token=${token}` } });

beforeEach(() => { revoked.clear(); revokeFails = false; revokeAllFails = false; activity.length = 0; revokeAll.length = 0; securityEmails.length = 0; });
afterEach(() => { vi.useRealTimers(); });

/** Fait vieillir la révocation d'un jeton (au-delà de la fenêtre de grâce). */
async function vieillir(token: string, ms: number) {
  const h = await hashToken(token);
  const r = revoked.get(h)!;
  revoked.set(h, { ...r, revokedAt: new Date(r.revokedAt.getTime() - ms) });
}

describe('identifiant unique', () => {
  it('deux jetons émis dans la même seconde, mêmes données, sont distincts', async () => {
    const [a, b] = await Promise.all([generateRefreshToken(claims), generateRefreshToken(claims)]);
    expect(a).not.toBe(b);
    const [pa, pb] = await Promise.all([verifyRefreshToken(a), verifyRefreshToken(b)]);
    expect(pa?.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(pa?.jti).not.toBe(pb?.jti);
  });
});

describe('rotation', () => {
  it('renouvellement réussi : nouveau jeton distinct, même famille de session (sid)', async () => {
    const ancien = await generateRefreshToken(claims, { sid: 'famille-1' });
    const ok = await refresh(req(ancien));
    expect(ok.status).toBe(200);
    const nouveau = ok.cookies.get('refresh_token')?.value;
    expect(nouveau).toBeTruthy();
    expect(nouveau).not.toBe(ancien);
    expect((await verifyRefreshToken(nouveau!))?.sid).toBe('famille-1');
    expect((await verifyAccessToken(ok.cookies.get('access_token')!.value))?.sid).toBe('famille-1');
  });

  it('révocation en échec : pas de succès annoncé, aucun nouveau cookie', async () => {
    revokeFails = true;
    const res = await refresh(req(await generateRefreshToken(claims)));
    expect(res.status).toBe(503);
    expect(res.cookies.get('refresh_token')).toBeUndefined();
    expect(res.cookies.get('access_token')).toBeUndefined();
  });

  it('C2-01 deux renouvellements concurrents du même jeton : une seule session émise, l’autre gérée sans déconnexion', async () => {
    const t = await generateRefreshToken(claims);
    const [r1, r2] = await Promise.all([refresh(req(t)), refresh(req(t))]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const avecCookies = [r1, r2].filter((r) => r.cookies.get('refresh_token')?.value);
    expect(avecCookies).toHaveLength(1); // une seule paire émise
    const perdant = r1 === avecCookies[0] ? r2 : r1;
    expect(perdant.cookies.get('access_token')).toBeUndefined();
    expect(await perdant.json()).toMatchObject({ success: true, rotation: 'concurrent' });
    expect(revokeAll).toHaveLength(0); // aucun incident
  });

  it('C2-02 rejeu dans la fenêtre de grâce (onglet, mobile) : 200 sans cookie, aucune révocation', async () => {
    const ancien = await generateRefreshToken(claims);
    expect((await refresh(req(ancien))).status).toBe(200);
    await vieillir(ancien, REFRESH_REUSE_GRACE_MS - 5_000);
    const rejeu = await refresh(req(ancien));
    expect(rejeu.status).toBe(200);
    expect(rejeu.cookies.get('refresh_token')).toBeUndefined();
    expect(rejeu.cookies.get('access_token')).toBeUndefined();
    expect(revokeAll).toHaveLength(0);
  });

  it('C2-03 rejeu après la fenêtre de grâce : incident — toutes les sessions révoquées, cookies effacés, 401 SESSION_REVOKED', async () => {
    const ancien = await generateRefreshToken(claims);
    expect((await refresh(req(ancien))).status).toBe(200);
    await vieillir(ancien, REFRESH_REUSE_GRACE_MS + 1_000);
    const rejeu = await refresh(req(ancien));
    expect(rejeu.status).toBe(401);
    expect((await rejeu.json()).code).toBe('SESSION_REVOKED');
    expect(rejeu.cookies.get('refresh_token')?.value).toBe('');
    expect(rejeu.cookies.get('access_token')?.value).toBe('');
    expect(revokeAll).toEqual([{ userId: 1, reason: 'REFRESH_TOKEN_REUSE' }]);
    expect(activity.some((a) => a.activityType === 'AUTH_TOKEN_REUSE_DETECTED' && a.details?.severity === 'security_incident')).toBe(true);
    // Lot 38 (volet B) : e-mail de sécurité planifié (après la réponse).
    expect(securityEmails).toEqual([1]);
  });

  it('L38-B-01 aucun e-mail de sécurité dans la fenêtre de grâce, pour une déconnexion ou un motif inconnu', async () => {
    const ancien = await generateRefreshToken(claims);
    expect((await refresh(req(ancien))).status).toBe(200);
    await vieillir(ancien, REFRESH_REUSE_GRACE_MS - 5_000);
    await refresh(req(ancien));
    const deco = await generateRefreshToken(claims);
    revoked.set(await hashToken(deco), { revokedAt: new Date(Date.now() - 3_600_000), reason: 'logout' });
    await refresh(req(deco));
    const ancienFormat = await generateRefreshToken(claims);
    revoked.set(await hashToken(ancienFormat), { revokedAt: new Date(Date.now() - 3_600_000), reason: null });
    await refresh(req(ancienFormat));
    expect(securityEmails).toEqual([]);
  });

  it('L38-B-02 révocation globale en échec : aucun e-mail (il affirmerait une déconnexion qui n’a pas eu lieu)', async () => {
    const ancien = await generateRefreshToken(claims);
    expect((await refresh(req(ancien))).status).toBe(200);
    await vieillir(ancien, REFRESH_REUSE_GRACE_MS + 1_000);
    revokeAllFails = true;
    expect((await refresh(req(ancien))).status).toBe(401);
    expect(securityEmails).toEqual([]);
  });

  it('C2-04 jeton révoqué par une déconnexion : refus simple, sans révocation globale ni effacement', async () => {
    const t = await generateRefreshToken(claims);
    revoked.set(await hashToken(t), { revokedAt: new Date(Date.now() - 3_600_000), reason: 'logout' });
    const res = await refresh(req(t));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_TOKEN');
    expect(res.cookies.get('refresh_token')).toBeUndefined();
    expect(revokeAll).toHaveLength(0);
  });

  it('C2-05 révocation antérieure au lot 37 (motif inconnu) : refus simple, comme avant', async () => {
    const t = await generateRefreshToken(claims);
    revoked.set(await hashToken(t), { revokedAt: new Date(Date.now() - 3_600_000), reason: null });
    const res = await refresh(req(t));
    expect(res.status).toBe(401);
    expect(revokeAll).toHaveLength(0);
  });

  it('C1-10 un jeton d’ACCÈS présenté au renouvellement est refusé', async () => {
    const { generateAccessToken } = await import('@/lib/jwt');
    const res = await refresh(req(await generateAccessToken(claims)));
    expect(res.status).toBe(401);
    expect(res.cookies.get('refresh_token')).toBeUndefined();
  });
});

describe('C2-06 classification (pure)', () => {
  const now = 1_000_000_000;
  it('tourné récemment → concurrent ; ancien → incident ; déconnexion ou inconnu → refus simple', () => {
    expect(classifyRefreshReplay({ revokedAt: new Date(now - 1_000), reason: 'rotated' }, now)).toBe('concurrent');
    expect(classifyRefreshReplay({ revokedAt: new Date(now - REFRESH_REUSE_GRACE_MS), reason: 'rotated' }, now)).toBe('concurrent');
    expect(classifyRefreshReplay({ revokedAt: new Date(now - REFRESH_REUSE_GRACE_MS - 1), reason: 'rotated' }, now)).toBe('reuse');
    expect(classifyRefreshReplay({ revokedAt: new Date(now + 2_000), reason: 'rotated' }, now)).toBe('concurrent');
    expect(classifyRefreshReplay({ revokedAt: new Date(now - 1_000), reason: 'logout' }, now)).toBe('ended');
    expect(classifyRefreshReplay({ revokedAt: new Date(now - 1_000), reason: null }, now)).toBe('ended');
  });
  it('fenêtre explicite de 30 s', () => {
    expect(REFRESH_REUSE_GRACE_MS).toBe(30_000);
  });
});
