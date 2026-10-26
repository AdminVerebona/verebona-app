/**
 * APP-PERF-20 — erreurs de session et refus d'accès uniformes.
 *
 * T-01 : jetons absents, invalides et révoqués → codes attendus, pas de 500.
 * T-02 : droit manquant / fichier absent → messages distincts, pas de rotation.
 * T-03 : base coupée pendant la lecture de la borne de révocation →
 *        indisponibilité explicite, aucun cache de faux « non révoqué ».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cutoff = vi.hoisted(() => ({ value: null as Date | null, fail: false }));
vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => {
    if (cutoff.fail) throw new Error('connect ECONNREFUSED');
    return cutoff.value;
  }),
}));

import { generateAccessToken } from '@/lib/jwt';
import { serverCacheDelete, serverCacheGet } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';
import { isRevokedByCutoff, verifySessionAccessToken } from '@/lib/auth/session-guard';
import { SESSION_UNAVAILABLE_CODE, sessionErrorToResponse } from '@/lib/auth/session-errors';
import { isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';

const USER = 777002;
const token = () => generateAccessToken({
  id: USER, email: 'y@exemple.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never,
});
const req = (path: string, init: { cookie?: string; method?: string } = {}) => new NextRequest(`http://localhost:3000${path}`, {
  method: init.method ?? 'GET',
  headers: init.cookie ? { cookie: init.cookie } : {},
});

beforeEach(() => {
  cutoff.value = null;
  cutoff.fail = false;
  serverCacheDelete(sessionCutoffCacheKey(USER));
});

describe('CA-01 — mapping identique des erreurs de session', () => {
  it.each([
    ['AUTH_REQUIRED', 401, 'AUTH_REQUIRED'],
    ['INVALID_TOKEN', 401, 'INVALID_TOKEN'],
    ['ACCOUNT_SUSPENDED', 403, 'ACCOUNT_SUSPENDED'],
    ['ACCOUNT_PENDING_DELETION', 403, 'ACCOUNT_PENDING_DELETION'],
    ['INSUFFICIENT_PERMISSIONS', 403, 'INSUFFICIENT_PERMISSIONS'],
    ['FORBIDDEN', 403, 'ACCESS_DENIED'],
    [SESSION_UNAVAILABLE_CODE, 503, SESSION_UNAVAILABLE_CODE],
  ])('%s → %i %s, message et requestId', async (levee, status, code) => {
    const res = sessionErrorToResponse(new Error(levee), 'req-1');
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toMatchObject({ code, requestId: 'req-1' });
    expect(typeof body.message).toBe('string');
    expect(res.headers.get('x-request-id')).toBe('req-1');
    expect(isSessionError(new Error(levee))).toBe(true);
  });

  it('SessionService.handleSessionError et sessionErrorResponse suivent le même contrat', async () => {
    const a = await SessionService.handleSessionError(new Error('INVALID_TOKEN'), 'r').json();
    const b = await sessionErrorResponse(new Error('INVALID_TOKEN'), 'r').json();
    expect({ ...a, timestamp: 0 }).toEqual({ ...b, timestamp: 0 });
  });

  it('erreur inconnue : 500 journalisé, sans message technique au client', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = sessionErrorToResponse(new Error('relation "x" does not exist'), 'r2');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toMatch(/relation/);
    expect(spy).toHaveBeenCalled();
    expect(isSessionError(new Error('relation "x" does not exist'))).toBe(false);
  });

  it('refus normal : non journalisé comme panne', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sessionErrorToResponse(new Error('AUTH_REQUIRED'));
    sessionErrorToResponse(new Error('INSUFFICIENT_PERMISSIONS'));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('CA-03 — base indisponible : jamais de faux « non révoqué »', () => {
  it('T-03 : lecture de la borne en échec → SESSION_UNAVAILABLE, rien en cache', async () => {
    cutoff.fail = true;
    await expect(isRevokedByCutoff({ userId: USER, iatMs: Date.now() })).rejects.toThrow(SESSION_UNAVAILABLE_CODE);
    expect(serverCacheGet(sessionCutoffCacheKey(USER)) ?? null).toBeNull();

    // Retour de la base : la révocation est bien appliquée (aucun faux négatif mis en cache).
    const t = await token();
    await new Promise((r) => setTimeout(r, 5));
    cutoff.fail = false;
    cutoff.value = new Date();
    expect(await verifySessionAccessToken(t, req('/api/notifications'))).toBeNull();
  });

  it('getSession : base coupée → 503 explicite via le contrat commun', async () => {
    cutoff.fail = true;
    const t = await token();
    let erreur: unknown;
    try { await SessionService.getSession(req('/api/assets', { cookie: `access_token=${t}` })); } catch (e) { erreur = e; }
    expect((erreur as Error).message).toBe(SESSION_UNAVAILABLE_CODE);
    expect(SessionService.handleSessionError(erreur).status).toBe(503);
  });
});

describe('T-01 — routes ciblées : refus normaux, pas de 500', () => {
  it('trial-status sans session : 401 AUTH_REQUIRED (était 500)', async () => {
    const { GET } = await import('@/app/api/billing/trial-status/route');
    const res = await GET(req('/api/billing/trial-status'));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('AUTH_REQUIRED');
  });

  it('trial-status avec un jeton invalide : 401 INVALID_TOKEN', async () => {
    const { GET } = await import('@/app/api/billing/trial-status/route');
    const res = await GET(req('/api/billing/trial-status', { cookie: 'access_token=abc.def.ghi' }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_TOKEN');
  });

  it('view : les refus de session passent par le contrat commun (plus de messages anglais libres)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/files/[id]/view/route.ts'), 'utf8');
    expect(src).toMatch(/if \(isSessionError\(error\)\) return sessionErrorResponse\(error, requestId\);/);
  });
});
