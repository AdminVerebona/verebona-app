/**
 * Compte suspendu par l'administration — CDC Back-Office V1 ACC-A02 / ACC-A03,
 * REC-ACC-02 / REC-ACC-03.
 *
 * Le drapeau `accounts.is_active` n'était lu ni par le login ni par le
 * refresh : un compte « suspendu » restait utilisable. Ces tests vérifient que
 * les deux routes refusent désormais d'ouvrir ou de prolonger une session
 * (403 ACCOUNT_SUSPENDED, message en français), et qu'une réactivation rend la
 * connexion possible avec les mêmes identifiants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let defaultAccount: { id: number; isActive: boolean; subscriptionStatus: string } | null = null;
const writes: string[] = [];

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const user = {
    id: 1, email: 'a@b.fr', role: 'USER', planType: 'STANDARD', status: 'ACTIVE', isActive: true,
    firstName: 'A', lastName: 'B', username: null, company: null, locale: 'fr-FR',
  };
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [user] };
  const loginRow = {
    id: 1, email: 'a@b.fr', first_name: 'A', last_name: 'B', username: null, company: null,
    password_hash: 'hash', status: 'ACTIVE', is_active: true, role: 'USER', plan_type: 'STANDARD', locale: 'fr-FR',
  };
  // `db.$client` : SQL brut du login (tag de gabarit).
  const $client = (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('SELECT id, email')) return Promise.resolve([loginRow]);
    writes.push(q.trim());
    return Promise.resolve([]);
  };
  const db = { ...chain, $client, delete: () => ({ where: async () => { writes.push('guide'); } }) };
  return {
    ...actual,
    db,
    isTokenRevoked: async () => false,
    revokeTokenOnce: async () => true,
    getUserSessionCutoff: async () => null,
  };
});
vi.mock('@/services/account-service', () => ({
  AccountService: { getUserDefaultAccount: async () => defaultAccount },
}));
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: () => Promise.resolve() }));
vi.mock('@/lib/rate-limiter', () => ({
  checkAuthRateLimit: () => ({ allowed: true, limit: 5, retryAfterSeconds: 0 }),
  resetAuthRateLimit: () => {},
  getClientIp: () => '127.0.0.1',
}));
vi.mock('bcrypt', () => ({ default: { compare: async () => true, hash: async () => 'hash' } }));

const { POST: login } = await import('../login/route');
const { POST: refresh } = await import('../refresh/route');
const { generateRefreshToken } = await import('@/lib/jwt');
const { isAccountSuspended, ACCOUNT_SUSPENDED_MESSAGE } = await import('@/lib/auth/account-suspension');

const loginRequest = () => new NextRequest('http://x/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'a@b.fr', password: 'secret' }),
});
const refreshRequest = (token: string) => new NextRequest('http://x/api/auth/refresh', {
  method: 'POST', headers: { cookie: `refresh_token=${token}` },
});
const claims = { id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never };

beforeEach(() => {
  defaultAccount = null;
  writes.length = 0;
});

describe('isAccountSuspended', () => {
  it('seul un drapeau explicitement faux suspend', () => {
    expect(isAccountSuspended({ isActive: false })).toBe(true);
    expect(isAccountSuspended({ isActive: true })).toBe(false);
    expect(isAccountSuspended({})).toBe(false);
    expect(isAccountSuspended(null)).toBe(false);
  });
});

describe('POST /api/auth/login — compte suspendu (ACC-A02)', () => {
  it('refuse 403 ACCOUNT_SUSPENDED, message français, sans écrire la dernière connexion', async () => {
    defaultAccount = { id: 9, isActive: false, subscriptionStatus: 'ACTIVE' };
    const res = await login(loginRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ACCOUNT_SUSPENDED');
    expect(body.message).toBe(ACCOUNT_SUSPENDED_MESSAGE);
    expect(res.cookies.get('access_token')).toBeUndefined();
    expect(writes.some((q) => q.includes('last_login_at'))).toBe(false);
  });

  it('après réactivation (ACC-A03), les mêmes identifiants ouvrent une session', async () => {
    defaultAccount = { id: 9, isActive: true, subscriptionStatus: 'ACTIVE' };
    const res = await login(loginRequest());
    expect(res.status).toBe(200);
    expect(res.cookies.get('access_token')?.value).toBeTruthy();
  });
});

describe('POST /api/auth/refresh — compte suspendu (ACC-A02)', () => {
  it('ne prolonge pas la session et efface les cookies', async () => {
    defaultAccount = { id: 9, isActive: false, subscriptionStatus: 'ACTIVE' };
    const res = await refresh(refreshRequest(await generateRefreshToken(claims)));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ACCOUNT_SUSPENDED');
    expect(res.cookies.get('refresh_token')?.value).toBe('');
  });

  it('compte actif : renouvellement normal', async () => {
    defaultAccount = { id: 9, isActive: true, subscriptionStatus: 'ACTIVE' };
    const res = await refresh(refreshRequest(await generateRefreshToken(claims)));
    expect(res.status).toBe(200);
  });
});
