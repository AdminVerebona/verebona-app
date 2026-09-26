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

type Acc = { id: number; isActive: boolean; subscriptionStatus: string };
type Cand = { account: Acc; membershipId: number; role: string; joinedAt?: Date | null };
let candidates: Cand[] = [];
let userRole = 'USER';
const writes: string[] = [];
/** Raccourci des anciens tests : un seul compte, titulaire. */
function setDefaultAccount(a: Acc | null) {
  candidates = a ? [{ account: a, membershipId: 1, role: 'owner' }] : [];
}

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const user = {
    id: 1, email: 'a@b.fr', role: 'USER', planType: 'STANDARD', status: 'ACTIVE', isActive: true,
    firstName: 'A', lastName: 'B', username: null, company: null, locale: 'fr-FR',
  };
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [{ ...user, role: userRole }] };
  const loginRow = () => ({
    id: 1, email: 'a@b.fr', first_name: 'A', last_name: 'B', username: null, company: null,
    password_hash: 'hash', status: 'ACTIVE', is_active: true, role: userRole, plan_type: 'STANDARD', locale: 'fr-FR',
  });
  // `db.$client` : SQL brut du login (tag de gabarit).
  const $client = (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('SELECT id, email')) return Promise.resolve([loginRow()]);
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
  AccountService: {
    getUserDefaultAccount: async () => candidates[0]?.account ?? null,
    // Ordre SQL volontairement quelconque : le tri est fait par la route.
    getUserSessionAccounts: async () => candidates,
  },
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
const { isAccountSuspended, ACCOUNT_SUSPENDED_MESSAGE, resolveSessionAccount, orderSessionAccounts } = await import('@/lib/auth/account-suspension');
const { verifyToken } = await import('@/lib/jwt');

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
  candidates = [];
  userRole = 'USER';
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
    setDefaultAccount({ id: 9, isActive: false, subscriptionStatus: 'ACTIVE' });
    const res = await login(loginRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ACCOUNT_SUSPENDED');
    expect(body.message).toBe(ACCOUNT_SUSPENDED_MESSAGE);
    expect(res.cookies.get('access_token')).toBeUndefined();
    expect(writes.some((q) => q.includes('last_login_at'))).toBe(false);
  });

  it('après réactivation (ACC-A03), les mêmes identifiants ouvrent une session', async () => {
    setDefaultAccount({ id: 9, isActive: true, subscriptionStatus: 'ACTIVE' });
    const res = await login(loginRequest());
    expect(res.status).toBe(200);
    expect(res.cookies.get('access_token')?.value).toBeTruthy();
  });
});

describe('POST /api/auth/refresh — compte suspendu (ACC-A02)', () => {
  it('ne prolonge pas la session et efface les cookies', async () => {
    setDefaultAccount({ id: 9, isActive: false, subscriptionStatus: 'ACTIVE' });
    const res = await refresh(refreshRequest(await generateRefreshToken(claims)));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ACCOUNT_SUSPENDED');
    expect(res.cookies.get('refresh_token')?.value).toBe('');
  });

  it('compte actif : renouvellement normal', async () => {
    setDefaultAccount({ id: 9, isActive: true, subscriptionStatus: 'ACTIVE' });
    const res = await refresh(refreshRequest(await generateRefreshToken(claims)));
    expect(res.status).toBe(200);
  });
});

// ── Plusieurs comptes : ordre stable, compte de la session, administrateurs ──
const actif = (id: number): Acc => ({ id, isActive: true, subscriptionStatus: 'ACTIVE' });
const suspendu = (id: number): Acc => ({ id, isActive: false, subscriptionStatus: 'ACTIVE' });
const currentAccountOf = async (res: Response & { cookies: { get(n: string): { value: string } | undefined } }) =>
  (await verifyToken(res.cookies.get('access_token')!.value))?.currentAccountId;

describe('orderSessionAccounts — ordre stable', () => {
  it('titulaire d’abord, puis ancienneté, puis id — indépendamment de l’ordre d’entrée', () => {
    const a: Cand = { account: actif(1), membershipId: 5, role: 'member', joinedAt: new Date('2024-01-01') };
    const b: Cand = { account: actif(2), membershipId: 4, role: 'owner', joinedAt: new Date('2025-01-01') };
    const c: Cand = { account: actif(3), membershipId: 3, role: 'member', joinedAt: new Date('2023-01-01') };
    const d: Cand = { account: actif(4), membershipId: 2, role: 'member', joinedAt: new Date('2023-01-01') };
    const attendu = [2, 4, 3, 1];
    for (const entree of [[a, b, c, d], [d, c, b, a], [c, a, d, b]]) {
      expect(orderSessionAccounts(entree).map((x) => x.account.id)).toEqual(attendu);
    }
  });
});

describe('resolveSessionAccount', () => {
  it('login : premier compte actif, même si le compte détenu est suspendu', () => {
    const r = resolveSessionAccount(
      [{ account: suspendu(1), membershipId: 1, role: 'owner' }, { account: actif(2), membershipId: 2, role: 'member' }],
      { role: 'USER' },
    );
    expect(r).toMatchObject({ allowed: true, reason: 'ACTIVE_ACCOUNT' });
    expect(r.allowed && r.account?.id).toBe(2);
  });

  it('refresh : le compte de la session est contrôlé, pas le compte « par défaut »', () => {
    const cands: Cand[] = [{ account: actif(1), membershipId: 1, role: 'owner' }, { account: suspendu(2), membershipId: 2, role: 'member' }];
    expect(resolveSessionAccount(cands, { role: 'USER', preferredAccountId: 2 }).allowed).toBe(false);
    const r = resolveSessionAccount(cands, { role: 'USER', preferredAccountId: 1 });
    expect(r.allowed && r.account?.id).toBe(1);
  });

  it('refresh : adhésion disparue → règle du login', () => {
    const r = resolveSessionAccount([{ account: actif(1), membershipId: 1, role: 'owner' }], { role: 'USER', preferredAccountId: 42 });
    expect(r.allowed && r.account?.id).toBe(1);
  });

  it('sans aucun compte : session ouverte sans compte courant', () => {
    expect(resolveSessionAccount([], { role: 'USER' })).toMatchObject({ allowed: true, account: null, reason: 'NO_ACCOUNT' });
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('%s : accès BO conservé, sans compte courant, si tout est suspendu', (role) => {
    const cands: Cand[] = [{ account: suspendu(1), membershipId: 1, role: 'owner' }];
    expect(resolveSessionAccount(cands, { role })).toMatchObject({ allowed: true, account: null, reason: 'BACK_OFFICE_ONLY' });
    expect(resolveSessionAccount(cands, { role, preferredAccountId: 1 })).toMatchObject({ allowed: true, account: null });
  });
});

describe('routes — plusieurs comptes', () => {
  it('login : ouvre la session sur le compte actif quand le compte détenu est suspendu', async () => {
    candidates = [
      { account: actif(2), membershipId: 2, role: 'member' },
      { account: suspendu(1), membershipId: 1, role: 'owner' },
    ];
    const res = await login(loginRequest());
    expect(res.status).toBe(200);
    expect(await currentAccountOf(res)).toBe(2);
  });

  it('login : refus seulement si tous les comptes sont suspendus', async () => {
    candidates = [
      { account: suspendu(2), membershipId: 2, role: 'member' },
      { account: suspendu(1), membershipId: 1, role: 'owner' },
    ];
    expect((await login(loginRequest())).status).toBe(403);
  });

  it('login ADMIN : tous comptes suspendus → session BO sans compte courant', async () => {
    userRole = 'ADMIN';
    setDefaultAccount(suspendu(1));
    const res = await login(loginRequest());
    expect(res.status).toBe(200);
    expect(await currentAccountOf(res)).toBeUndefined();
  });

  it('refresh : refuse si le compte DE LA SESSION est suspendu, même si un autre compte est actif', async () => {
    candidates = [
      { account: actif(1), membershipId: 1, role: 'owner' },
      { account: suspendu(2), membershipId: 2, role: 'member' },
    ];
    const res = await refresh(refreshRequest(await generateRefreshToken({ ...claims, currentAccountId: 2 })));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ACCOUNT_SUSPENDED');
  });

  it('refresh : conserve le compte de la session s’il est actif', async () => {
    candidates = [
      { account: actif(1), membershipId: 1, role: 'owner' },
      { account: actif(2), membershipId: 2, role: 'member' },
    ];
    const res = await refresh(refreshRequest(await generateRefreshToken({ ...claims, currentAccountId: 2 })));
    expect(res.status).toBe(200);
    expect(await currentAccountOf(res)).toBe(2);
  });
});
