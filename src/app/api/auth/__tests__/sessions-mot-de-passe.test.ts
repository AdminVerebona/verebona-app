/**
 * Après un changement de mot de passe, tous les jetons déjà émis sont
 * refusés : un autre navigateur ne peut plus renouveler sa session.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let cutoff: Date | null = null;
const revoked = new Set<string>();
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const user = { id: 1, email: 'a@b.fr', role: 'USER', planType: 'STANDARD', status: 'ACTIVE', isActive: true };
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [user] };
  return {
    ...actual,
    db: chain,
    isTokenRevoked: async (h: string) => revoked.has(h),
    revokeToken: async (h: string) => { revoked.add(h); },
    revokeTokenOnce: async (h: string) => { if (revoked.has(h)) return false; revoked.add(h); return true; },
    getUserSessionCutoff: async () => cutoff,
  };
});
vi.mock('@/services/account-service', () => ({ AccountService: { getUserDefaultAccount: async () => ({ id: 9, subscriptionStatus: 'ACTIVE' }) } }));
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: () => {} }));

const { POST: refresh } = await import('../refresh/route');
const { generateRefreshToken, generateAccessToken } = await import('@/lib/jwt');
const { isIssuedBefore } = await import('@/db');
const { SessionService } = await import('@/lib/session-service');
const { serverCacheClear } = await import('@/lib/server-cache');

const claims = { id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never };
const req = (cookies: Record<string, string>) => new NextRequest('http://x/api/auth/refresh', {
  method: 'POST', headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
});
const pause = () => new Promise((r) => setTimeout(r, 3));

beforeEach(() => { cutoff = null; revoked.clear(); serverCacheClear(); });

describe('borne de révocation', () => {
  it('compare à la milliseconde d’émission', () => {
    const c = new Date(1_000_500);
    expect(isIssuedBefore({ iatMs: 1_000_400 }, c)).toBe(true);
    expect(isIssuedBefore({ iatMs: 1_000_600 }, c)).toBe(false);
    expect(isIssuedBefore({ iat: 1000 }, c)).toBe(true); // ancien jeton sans iatMs
    expect(isIssuedBefore({ iatMs: 1 }, null)).toBe(false);
  });
});

describe('/api/auth/refresh après changement de mot de passe', () => {
  it('un ancien jeton de renouvellement ne crée plus de session, et ses cookies sont effacés', async () => {
    const ancien = await generateRefreshToken(claims);
    await pause();
    cutoff = new Date();
    const res = await refresh(req({ refresh_token: ancien }));
    expect(res.status).toBe(401);
    expect(res.cookies.get('refresh_token')?.value).toBe('');
    expect(res.cookies.get('access_token')?.value).toBe('');
  });

  it('un jeton émis après la révocation (session conservée) reste valide', async () => {
    cutoff = new Date();
    await pause();
    const neuf = await generateRefreshToken(claims);
    const res = await refresh(req({ refresh_token: neuf }));
    expect(res.status).toBe(200);
  });

  it('les jetons d’accès antérieurs sont refusés (autres appareils déconnectés)', async () => {
    const acces = await generateAccessToken(claims);
    await pause();
    cutoff = new Date();
    await expect(SessionService.getSession(req({ access_token: acces }))).rejects.toThrow('INVALID_TOKEN');
  });
});

describe('routes de mot de passe', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
  it('changement : révocation globale, jeton courant révoqué, session conservée seulement sur demande', () => {
    const src = read('src/app/api/users/me/change-password/route.ts');
    expect(src).toContain("revokeAllUserSessions(session.userId, 'PASSWORD_CHANGED')");
    expect(src).toContain('await revokeToken(await hashToken(presented)');
    expect(src).toContain('body?.keepCurrentSession === true');
    expect(src).toContain('clearSessionCookies(response)');
    expect(src.indexOf('revokeAllUserSessions')).toBeLessThan(src.indexOf("type: 'PASSWORD_CHANGED'"));
  });
  it('réinitialisation : même révocation', () => {
    expect(read('src/app/api/auth/reset-password/route.ts')).toContain("revokeAllUserSessions(user.id, 'PASSWORD_RESET')");
  });
});
