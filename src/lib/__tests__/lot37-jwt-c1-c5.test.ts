/**
 * Lot 37 — C1 (type de jeton vérifié partout) et C5 (aucun secret JWT de
 * repli en production). CDC 18 §19, §32, SEC-07.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => null),
}));

import {
  generateAccessToken, generateRefreshToken, generateSessionTokens, verifyAccessToken, verifyRefreshToken, verifyToken,
  jwtSecretProblem, assertJwtSecretConfigured, JWT_KID, JWT_AUDIENCE, LEGACY_TOKENS_ACCEPTED_UNTIL,
  INSECURE_DEFAULT_JWT_SECRET, JWT_SECRET_MIN_LENGTH,
} from '@/lib/jwt';
import { SessionService } from '@/lib/session-service';
import { verifySessionAccessToken } from '@/lib/auth/session-guard';
import { middleware } from '@/middleware';
import { serverCacheClear } from '@/lib/server-cache';

const claims = { id: 4242, email: 'c1@exemple.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, currentAccountId: 7 };
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
/** Jeton au format d'AVANT le lot 37 : sans `kid`, signé avec le secret brut. */
function legacyToken(type: 'access' | 'refresh', over: Record<string, unknown> = {}, secret = process.env.JWT_SECRET || INSECURE_DEFAULT_JWT_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const life = type === 'access' ? 2 * 3600 : 30 * 86400;
  const payload = {
    userId: claims.id, email: claims.email, role: 'USER', planType: 'STANDARD', status: 'ACTIVE', currentAccountId: 7,
    type, jti: 'legacy-jti', iat: now, iatMs: now * 1000, exp: now + life, ...over,
  };
  const msg = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${msg}.${b64u(createHmac('sha256', secret).update(msg).digest())}`;
}
const decodeHeader = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());
const decodePayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

beforeEach(() => serverCacheClear());
afterEach(() => { vi.unstubAllEnvs(); });

describe('C1 — jetons typés', () => {
  it('C1-01 un jeton d’accès est accepté comme accès, refusé comme renouvellement', async () => {
    const t = await generateAccessToken(claims);
    expect((await verifyAccessToken(t))?.userId).toBe(4242);
    expect(await verifyRefreshToken(t)).toBeNull();
  });

  it('C1-02 un jeton de renouvellement est refusé comme accès (verifyAccessToken ET l’alias historique verifyToken)', async () => {
    const t = await generateRefreshToken(claims);
    expect((await verifyRefreshToken(t))?.userId).toBe(4242);
    expect(await verifyAccessToken(t)).toBeNull();
    expect(await verifyToken(t)).toBeNull();
  });

  it('C1-03 kid, audience, usage et famille de session distincts ; paire d’une session = même sid', async () => {
    const { accessToken, refreshToken, sid } = await generateSessionTokens(claims);
    expect(decodeHeader(accessToken).kid).toBe(JWT_KID.access);
    expect(decodeHeader(refreshToken).kid).toBe(JWT_KID.refresh);
    expect(decodePayload(accessToken)).toMatchObject({ token_use: 'access', aud: JWT_AUDIENCE.access, type: 'access', sid, iss: 'verebona' });
    expect(decodePayload(refreshToken)).toMatchObject({ token_use: 'refresh', aud: JWT_AUDIENCE.refresh, type: 'refresh', sid });
  });

  it('C1-04 clés distinctes : un jeton de renouvellement réétiqueté « accès » (kid/type/aud) ne passe pas la signature', async () => {
    const t = await generateRefreshToken(claims);
    const [, , sig] = t.split('.');
    const payload = { ...decodePayload(t), type: 'access', token_use: 'access', aud: JWT_AUDIENCE.access };
    const forged = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: JWT_KID.access }))}.${b64u(JSON.stringify(payload))}.${sig}`;
    expect(await verifyAccessToken(forged)).toBeNull();
    // Même en conservant l'en-tête d'origine : le contrôle d'usage refuse.
    const sameHeader = `${t.split('.')[0]}.${b64u(JSON.stringify(payload))}.${sig}`;
    expect(await verifyAccessToken(sameHeader)).toBeNull();
  });

  it('C1-05 double lecture : un jeton historique (sans kid) reste valide pour SON usage seulement', async () => {
    const acces = legacyToken('access');
    const renouv = legacyToken('refresh');
    expect((await verifyAccessToken(acces))?.userId).toBe(4242);
    expect(await verifyRefreshToken(acces)).toBeNull();
    expect((await verifyRefreshToken(renouv))?.userId).toBe(4242);
    expect(await verifyAccessToken(renouv)).toBeNull();
  });

  it('C1-06 double lecture BORNÉE : durée de l’ancien émetteur, expiration, date limite, signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyAccessToken(legacyToken('access', { exp: now + 3 * 3600 }))).toBeNull(); // > 2 h : jamais émis ainsi
    expect(await verifyAccessToken(legacyToken('access', { iat: now - 7300, exp: now - 100 }))).toBeNull(); // expiré
    expect(await verifyRefreshToken(legacyToken('refresh', { exp: now + 31 * 86400 }))).toBeNull(); // > 30 j
    expect(await verifyAccessToken(legacyToken('access', { aud: JWT_AUDIENCE.access }))).toBeNull(); // hybride
    expect(await verifyAccessToken(legacyToken('access', {}, 'autre-secret'))).toBeNull();
    const after = Math.floor(LEGACY_TOKENS_ACCEPTED_UNTIL / 1000) + 10;
    vi.useFakeTimers({ now: (after + 60) * 1000 });
    try {
      expect(await verifyAccessToken(legacyToken('access', { iat: after, exp: after + 3600 }))).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('C1-07 SessionService.getSession refuse un jeton de renouvellement — en-tête Bearer comme cookie access_token', async () => {
    const r = await generateRefreshToken(claims);
    const bearer = new NextRequest('http://localhost:3000/api/users/me', { headers: { authorization: `Bearer ${r}` } });
    const cookie = new NextRequest('http://localhost:3000/api/users/me', { headers: { cookie: `access_token=${r}` } });
    await expect(SessionService.getSession(bearer)).rejects.toThrow('INVALID_TOKEN');
    await expect(SessionService.getSession(cookie)).rejects.toThrow('INVALID_TOKEN');
    const a = await generateAccessToken(claims);
    expect((await SessionService.getSession(new NextRequest('http://localhost:3000/api/users/me', { headers: { cookie: `access_token=${a}` } }))).userId).toBe(4242);
  });

  it('C1-08 middleware : un jeton de renouvellement n’ouvre pas l’API (401 INVALID_TOKEN)', async () => {
    const r = await generateRefreshToken(claims);
    const res = await middleware(new NextRequest('http://localhost:3000/api/assets', {
      headers: { authorization: `Bearer ${r}`, origin: 'http://localhost:3000' },
    }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_TOKEN');
    const pageSansRenouv = await middleware(new NextRequest('http://localhost:3000/accueil', { headers: { cookie: `access_token=${r}` } }));
    expect(pageSansRenouv.status).toBe(307); // renvoi à la connexion
  });

  it('C1-09 routes hors SessionService (verifySessionAccessToken) : jeton de renouvellement refusé', async () => {
    const req = new NextRequest('http://localhost:3000/api/notifications');
    expect(await verifySessionAccessToken(await generateRefreshToken(claims), req)).toBeNull();
    expect((await verifySessionAccessToken(await generateAccessToken(claims), req))?.userId).toBe(4242);
  });

  it('C1-11 tous les vérificateurs du dépôt sont typés (aucun verifyToken générique hors alias)', () => {
    expect(read('src/middleware.ts')).not.toMatch(/\bverifyToken\(/);
    expect(read('src/lib/session-service.ts')).not.toMatch(/\bverifyToken\(/);
    expect(read('src/app/api/auth/refresh/route.ts')).toMatch(/verifyRefreshToken\(refreshToken\)/);
    expect(read('src/app/api/auth/logout/route.ts')).toMatch(/verifyRefreshToken\(refreshToken\)/);
  });
});

describe('C5 — secret JWT en production', () => {
  const fort = 'x'.repeat(JWT_SECRET_MIN_LENGTH);

  it('C5-01 diagnostic : absent, trop court, valeur connue, conforme', () => {
    expect(jwtSecretProblem({})).toBe('missing');
    expect(jwtSecretProblem({ JWT_SECRET: '   ' })).toBe('missing');
    expect(jwtSecretProblem({ JWT_SECRET: 'court' })).toBe('too_short');
    expect(jwtSecretProblem({ JWT_SECRET: INSECURE_DEFAULT_JWT_SECRET })).toBe('known_default');
    expect(jwtSecretProblem({ JWT_SECRET: 'CHANGEME' })).toBe('known_default');
    expect(jwtSecretProblem({ JWT_SECRET: fort })).toBeNull();
  });

  it('C5-02 démarrage : refusé en production (message clair), jamais hors production', () => {
    expect(() => assertJwtSecretConfigured({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET est absent.*refuse de démarrer/);
    expect(() => assertJwtSecretConfigured({ NODE_ENV: 'production', JWT_SECRET: 'abc' })).toThrow(/trop court/);
    expect(() => assertJwtSecretConfigured({ NODE_ENV: 'production', JWT_SECRET: INSECURE_DEFAULT_JWT_SECRET })).toThrow(/valeur publique connue/);
    expect(() => assertJwtSecretConfigured({ NODE_ENV: 'production', JWT_SECRET: fort })).not.toThrow();
    expect(() => assertJwtSecretConfigured({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertJwtSecretConfigured({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('C5-03 aucune signature ni vérification avec la valeur de repli en production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', '');
    await expect(generateAccessToken(claims)).rejects.toThrow(/\[jwt\]/);
    await expect(verifyAccessToken(legacyToken('access', {}, INSECURE_DEFAULT_JWT_SECRET))).rejects.toThrow(/\[jwt\]/);
    vi.stubEnv('JWT_SECRET', fort);
    const t = await generateAccessToken(claims);
    expect((await verifyAccessToken(t))?.userId).toBe(4242);
  });

  it('C5-04 le secret est lu à l’appel, jamais à l’import (le build ne l’exige pas)', () => {
    const src = read('src/lib/jwt.ts');
    expect(src).not.toMatch(/^const JWT_SECRET\s*=/m);
    expect(src).toMatch(/function currentSecret\(\)/);
  });

  it('C5-05 le démarrage contrôle JWT_SECRET avant toute autre étape', () => {
    const src = read('src/instrumentation-node.ts');
    const i = src.indexOf('\n  assertJwtSecretConfigured();');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(src.indexOf('\n  emailVerificationSecret();'));
    expect(i).toBeLessThan(src.indexOf('assertMigrationBootPolicy(await ensureMigrations())'));
  });

  it('C5-06 les noms de variables lus en préproduction sont inchangés (JWT_SECRET, .env.example, catalogue BO)', () => {
    expect(read('.env.example')).toMatch(/^JWT_SECRET=$/m);
    expect(read('src/services/admin/ops/env-catalog.ts')).toMatch(/JWT_SECRET: 'Signature des sessions/);
    expect(read('src/lib/jwt.ts')).toMatch(/env\.JWT_SECRET/);
  });
});
