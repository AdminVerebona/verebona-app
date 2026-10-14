/**
 * Lot 53A — retour PO Q21 : durées des jetons (CDC 18 §19.1-§19.3, SESS-01,
 * SESS-02, SESS-03). Accès 15 min PARTOUT (JWT et cookie, toutes routes) ;
 * renouvellement 30 jours glissants par rotation ; jetons historiques
 * toujours bornés à leur ancienne durée (2 h) sans être réémis.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import {
  generateAccessToken, generateRefreshToken, generateSessionTokens, verifyAccessToken, verifyRefreshToken,
  INSECURE_DEFAULT_JWT_SECRET,
} from '@/lib/jwt';
import { ACCESS_TOKEN_TTL_S, LEGACY_ACCESS_TOKEN_MAX_S, REFRESH_TOKEN_TTL_S } from '@/lib/auth/token-lifetimes';
import { setSessionCookies } from '@/lib/auth/session-tokens';

const claims = { id: 5353, email: 'q21@exemple.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never };
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const payload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

describe('PO-Q21 — jeton d’accès 15 min, renouvellement 30 jours (ne pas confondre)', () => {
  it('PO-Q21-SESS-01 le JWT d’accès vit 15 min ; le JWT de renouvellement 30 jours', async () => {
    expect(ACCESS_TOKEN_TTL_S).toBe(15 * 60);
    expect(REFRESH_TOKEN_TTL_S).toBe(30 * 24 * 3600);
    const a = payload(await generateAccessToken(claims));
    const r = payload(await generateRefreshToken(claims));
    expect(a.exp - a.iat).toBe(900);
    expect(r.exp - r.iat).toBe(30 * 24 * 3600);
    const s = await generateSessionTokens(claims);
    expect(payload(s.accessToken).exp - payload(s.accessToken).iat).toBe(900);
    expect(payload(s.refreshToken).sid).toBe(payload(s.accessToken).sid);
  });

  it('PO-Q21-SESS-01b cookies : mêmes durées que les JWT (access 900 s, refresh 30 j), HttpOnly, SameSite=Lax, Path=/', () => {
    const res = NextResponse.json({});
    setSessionCookies(res, { accessToken: 'a', refreshToken: 'r' });
    const a = res.cookies.get('access_token')!;
    const r = res.cookies.get('refresh_token')!;
    expect([a.maxAge, r.maxAge]).toEqual([900, 30 * 24 * 3600]);
    for (const c of [a, r]) expect(c).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('PO-Q21-SESS-01c aucune route ne pose ses propres durées (plus de 2 h après la vérification d’adresse)', () => {
    for (const f of ['src/app/api/auth/login/route.ts', 'src/app/api/auth/refresh/route.ts', 'src/app/api/auth/verify-email/route.ts']) {
      const src = read(f);
      expect(src).toMatch(/setSessionCookies\(response, \{ accessToken/);
      expect(src).not.toMatch(/cookies\.set\('access_token'/);
      expect(src).not.toMatch(/2 \* 60 \* 60/);
    }
    expect(read('src/lib/jwt.ts')).toMatch(/const JWT_ACCESS_EXPIRY_S {2}= ACCESS_TOKEN_TTL_S;/);
  });

  it('PO-Q21-SESS-01d un jeton d’accès v2 expiré (> 15 min) est refusé : le client renouvelle (api-client, 401 → /api/auth/refresh)', async () => {
    const t = await generateAccessToken(claims);
    const real = Date.now;
    try {
      Date.now = () => real() + 16 * 60 * 1000;
      expect(await verifyAccessToken(t)).toBeNull();
    } finally { Date.now = real; }
    expect(read('src/lib/api-client.ts')).toMatch(/fetch\('\/api\/auth\/refresh'/);
  });

  it('PO-Q21-SESS-02 la persistance vient du renouvellement : 30 jours, réémis à chaque rotation (expiration glissante)', async () => {
    const r1 = await generateRefreshToken(claims, { sid: 's1' });
    const p1 = payload(r1);
    expect((await verifyRefreshToken(r1))?.sid).toBe('s1');
    // Rotation : même famille, nouvelle échéance à +30 jours.
    const later = Date.now;
    try {
      Date.now = () => later() + 20 * 24 * 3600 * 1000;
      const r2 = payload((await generateSessionTokens(claims, 's1')).refreshToken);
      expect(r2.sid).toBe('s1');
      expect(r2.exp - p1.exp).toBeGreaterThanOrEqual(20 * 24 * 3600 - 1);
    } finally { Date.now = later; }
  });

  it('PO-Q21-SESS-03 jetons historiques (avant lot 37) : la double lecture reste bornée à leur ancienne durée de 2 h', async () => {
    expect(LEGACY_ACCESS_TOKEN_MAX_S).toBe(2 * 3600);
    const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const mk = (life: number) => {
      const p = { userId: 1, email: 'x@x.fr', role: 'USER', planType: 'STANDARD', status: 'ACTIVE', type: 'access', jti: 'l', iat: now, iatMs: now * 1000, exp: now + life };
      const msg = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(p))}`;
      return `${msg}.${b64u(createHmac('sha256', process.env.JWT_SECRET || INSECURE_DEFAULT_JWT_SECRET).update(msg).digest())}`;
    };
    expect(await verifyAccessToken(mk(2 * 3600))).not.toBeNull();
    expect(await verifyAccessToken(mk(2 * 3600 + 1))).toBeNull();
  });
});
