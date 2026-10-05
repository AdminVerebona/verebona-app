/**
 * APP-FUNC-31 §1-2 (CA-03, CA-09, CA-10) et APP-PERF-22 (invalidation à
 * l'écriture) — SessionService.
 *
 *   · aucune lecture de compte ni cache de grâce pendant la validation de
 *     session : un compte en impayé reste authentifiable, ses droits viennent
 *     des entitlements ;
 *   · une écriture authentifiée oublie les lectures en cache du compte et de
 *     l'utilisateur sur l'instance — et seulement les siennes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => null),
}));

import { db } from '@/db';
import { generateAccessToken } from '@/lib/jwt';
import { SessionService } from '@/lib/session-service';
import {
  accountCacheKey,
  serverCacheClear,
  serverCacheGet,
  serverCacheSet,
  userCacheKey,
} from '@/lib/server-cache';

const USER = 880031;
const ACCOUNT = 4242;
const token = (currentAccountId = ACCOUNT) => generateAccessToken({
  id: USER, email: 'impaye@exemple.fr', role: 'USER' as never, planType: 'PREMIUM' as never,
  status: 'ACTIVE' as never, currentAccountId, hasActiveAccount: false,
});
const req = async (method = 'GET', currentAccountId = ACCOUNT) => new NextRequest('http://localhost:3000/api/assets', {
  method,
  headers: { cookie: `access_token=${await token(currentAccountId)}` },
});

beforeEach(() => { serverCacheClear(); vi.restoreAllMocks(); });

describe('CA-09 / CA-10 — plus de contrôle de grâce dans la session', () => {
  it('la session ne lit ni le compte ni un cache de grâce : aucune requête SQL', async () => {
    const select = vi.spyOn(db, 'select');
    const update = vi.spyOn(db, 'update');
    const s = await SessionService.getSession(await req());
    expect(s).toMatchObject({ userId: USER, currentAccountId: ACCOUNT });
    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('CA-03 : un jeton de compte en impayé (hasActiveAccount=false) reste une session valide', async () => {
    await expect(SessionService.getSession(await req())).resolves.toMatchObject({ userId: USER });
  });

  it('le code source ne porte plus ni cache grace:, ni passage en EXPIRED, ni TRIAL_ACTIVATION_PENDING', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/session-service.ts'), 'utf8');
    expect(src).not.toMatch(/`grace:|graceCacheKey|pastDueGrace|PAST_DUE_GRACE/);
    expect(src).not.toMatch(/throw new Error\('TRIAL_ACTIVATION_PENDING'\)/);
    expect(src).not.toMatch(/subscriptionStatus: 'EXPIRED'/);
  });

  it('users/me n’expire plus un compte à la lecture du profil', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/users/me/route.ts'), 'utf8');
    expect(src).not.toMatch(/subscriptionStatus: 'EXPIRED'/);
  });
});

describe('APP-PERF-22 — écriture authentifiée : lectures du compte oubliées (cette instance)', () => {
  it('POST : compte et utilisateur invalidés, autres comptes intacts', async () => {
    serverCacheSet(accountCacheKey(ACCOUNT, 'home-summary'), { v: 1 }, 30_000);
    serverCacheSet(accountCacheKey(ACCOUNT * 10, 'home-summary'), { v: 2 }, 30_000);
    serverCacheSet(userCacheKey(USER, 'me', ACCOUNT), { v: 3 }, 30_000);
    await SessionService.getSession(await req('POST'));
    expect(serverCacheGet(accountCacheKey(ACCOUNT, 'home-summary'))).toBeNull();
    expect(serverCacheGet(userCacheKey(USER, 'me', ACCOUNT))).toBeNull();
    expect(serverCacheGet(accountCacheKey(ACCOUNT * 10, 'home-summary'))).toEqual({ v: 2 });
  });

  it('GET : rien n’est invalidé', async () => {
    serverCacheSet(accountCacheKey(ACCOUNT, 'a-traiter'), { v: 1 }, 30_000);
    await SessionService.getSession(await req('GET'));
    expect(serverCacheGet(accountCacheKey(ACCOUNT, 'a-traiter'))).toEqual({ v: 1 });
  });

  it('T-03 Duo : l’écriture du second utilisateur périme les données PARTAGÉES du compte, pas les paramètres individuels du titulaire', async () => {
    const TITULAIRE = 880099;
    serverCacheSet(accountCacheKey(ACCOUNT, 'home-summary'), { partage: true }, 30_000);
    serverCacheSet(userCacheKey(TITULAIRE, 'me', ACCOUNT), { individuel: true }, 30_000);
    // USER (second utilisateur du Duo, même compte courant) écrit.
    await SessionService.getSession(await req('PATCH'));
    expect(serverCacheGet(accountCacheKey(ACCOUNT, 'home-summary'))).toBeNull();
    expect(serverCacheGet(userCacheKey(TITULAIRE, 'me', ACCOUNT))).toEqual({ individuel: true });
  });
});
