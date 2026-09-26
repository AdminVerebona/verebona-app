/**
 * Inscription pendant le pré-lancement — SIGNUP_MODE (src/lib/prelaunch.ts).
 *
 * Mode `prelaunch` : POST /api/users refuse (403 SIGNUP_CLOSED, message en
 * français) toute création de compte sans invitation valide, AVANT la moindre
 * écriture en base. Une invitation valide (compte partagé ou Premium Duo)
 * reste acceptée. Mode `full` (et variable absente) : inchangé.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const writes: string[] = [];
const insertedValues: Record<string, Record<string, unknown> | undefined> = {};
const resolveSignupInvitation = vi.fn();

vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  let nextId = 100;
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning', 'orderBy']) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return c;
  };
  const db = {
    select: () => chain([]),
    insert: (table: never) => {
      const name = getTableName(table);
      writes.push(`insert:${name}`);
      const c = chain([{ id: ++nextId, email: 'invite@exemple.fr', firstName: 'Anne', lastName: 'Martin', passwordHash: 'h' }]);
      c.values = (v: Record<string, unknown>) => { insertedValues[name] = v; return c; };
      return c;
    },
    update: (table: never) => { writes.push(`update:${getTableName(table)}`); return chain([]); },
    delete: (table: never) => { writes.push(`delete:${getTableName(table)}`); return chain([]); },
  };
  return { db };
});
vi.mock('@/lib/prelaunch-invitations', () => ({ resolveSignupInvitation }));
vi.mock('bcrypt', () => ({ default: { hash: async () => 'hash' } }));
vi.mock('@/lib/email/email-service', () => ({ emailService: { send: async () => undefined } }));
vi.mock('@/services/trial.service', () => ({ grantTrial: async () => ({ granted: true }) }));
vi.mock('@/services/referral-attribution.service', () => ({ recordSignupReferral: async () => null }));
vi.mock('@/services/legal', () => ({ getCurrentVersion: async () => ({ versionCode: 'CGVU-2026-01' }) }));
vi.mock('@/services/legal/legal-acceptances.service', () => ({ recordAcceptance: async () => undefined }));

const { POST } = await import('../route');
const { SIGNUP_CLOSED_CODE } = await import('@/lib/prelaunch');

const signup = (extra: Record<string, unknown> = {}) => new NextRequest('http://x/api/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'Invite@Exemple.fr',
    password: 'Motdepasse-solide-42!',
    firstName: 'Anne',
    lastName: 'Martin',
    acceptedTerms: true,
    termsVersion: 'CGVU-2026-01',
    ...extra,
  }),
});

const accountInvitation = {
  valid: true,
  kind: 'account',
  membership: { id: 7, accountId: 3, status: 'pending', invitedEmail: 'invite@exemple.fr' },
};

let previousMode: string | undefined;
beforeEach(() => {
  previousMode = process.env.SIGNUP_MODE;
  writes.length = 0;
  for (const k of Object.keys(insertedValues)) delete insertedValues[k];
  resolveSignupInvitation.mockReset();
});
afterEach(() => {
  if (previousMode === undefined) delete process.env.SIGNUP_MODE;
  else process.env.SIGNUP_MODE = previousMode;
});

describe('SIGNUP_MODE=prelaunch', () => {
  beforeEach(() => { process.env.SIGNUP_MODE = 'prelaunch'; });

  it('refuse une inscription sans invitation : 403 SIGNUP_CLOSED, message français, aucune écriture', async () => {
    const res = await POST(signup());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(SIGNUP_CLOSED_CODE);
    expect(body.error).toMatch(/ouvre bientôt/);
    expect(writes).toEqual([]);
    expect(resolveSignupInvitation).not.toHaveBeenCalled();
  });

  it('refuse aussi une inscription par parrainage sans invitation', async () => {
    const res = await POST(signup({ referralCode: 'ABC123' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(SIGNUP_CLOSED_CODE);
    expect(writes).toEqual([]);
  });

  it('refuse une invitation invalide ou expirée, sans écriture', async () => {
    resolveSignupInvitation.mockResolvedValue({ valid: false, code: 'INVITE_TOKEN_EXPIRED' });
    const res = await POST(signup({ inviteToken: 'tok-expire' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(SIGNUP_CLOSED_CODE);
    expect(body.invitationError).toBe('INVITE_TOKEN_EXPIRED');
    expect(resolveSignupInvitation).toHaveBeenCalledWith('tok-expire', 'invite@exemple.fr');
    expect(writes).toEqual([]);
  });

  it('accepte une invitation valide à un compte partagé et la consomme', async () => {
    resolveSignupInvitation.mockResolvedValue(accountInvitation);
    const res = await POST(signup({ inviteToken: 'tok-compte' }));
    expect(res.status).toBe(201);
    expect(writes).toContain('insert:users');
    expect(writes).toContain('update:account_memberships');
    expect(writes).not.toContain('insert:accounts');
    // Résolue une seule fois (garde + parcours).
    expect(resolveSignupInvitation).toHaveBeenCalledTimes(1);
  });

  it('accepte une invitation Premium Duo valide (compte créé, rattachement ensuite par /api/duo/join)', async () => {
    resolveSignupInvitation.mockResolvedValue({ valid: true, kind: 'duo', duoId: 9 });
    const res = await POST(signup({ inviteToken: 'tok-duo' }));
    expect(res.status).toBe(201);
    expect(writes).toContain('insert:users');
    expect(writes).toContain('insert:accounts');
    expect(writes).not.toContain('update:account_memberships');
  });

  // Destinataire d'une transmission de bien sans compte : le jeton de
  // transmission vaut invitation, sinon le bien ne peut jamais être reçu.
  it('accepte un jeton de transmission valide : compte ordinaire créé, jeton non consommé', async () => {
    resolveSignupInvitation.mockResolvedValue({ valid: true, kind: 'transmission', transmissionId: 4 });
    const res = await POST(signup({ transmissionToken: 'tok-transmission' }));
    expect(res.status).toBe(201);
    expect(resolveSignupInvitation).toHaveBeenCalledWith('tok-transmission', 'invite@exemple.fr');
    expect(writes).toContain('insert:users');
    expect(writes).toContain('insert:accounts');
    expect(writes).not.toContain('update:asset_transmissions');
  });

  it('refuse un jeton de transmission caduc, sans écriture', async () => {
    resolveSignupInvitation.mockResolvedValue({ valid: false, code: 'INVALID_INVITE_TOKEN' });
    const res = await POST(signup({ transmissionToken: 'tok-accepte' }));
    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('l’offre fournie par le client est ignorée (jamais PREMIUM_PRO sans paiement)', async () => {
    resolveSignupInvitation.mockResolvedValue({ valid: true, kind: 'transmission', transmissionId: 4 });
    const res = await POST(signup({ transmissionToken: 'tok', planType: 'PREMIUM_PRO' }));
    expect(res.status).toBe(201);
    expect(insertedValues.users?.planType).toBe('STANDARD');
    expect(insertedValues.accounts?.planType).toBe('STANDARD');
  });
});

describe('SIGNUP_MODE=full (ou absent) : inchangé', () => {
  it.each([['full'], ['open'], [undefined]])('mode %s : inscription libre acceptée', async (mode) => {
    if (mode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = mode;
    const res = await POST(signup());
    expect(res.status).toBe(201);
    expect(writes).toContain('insert:users');
    expect(writes).toContain('insert:accounts');
    expect(resolveSignupInvitation).not.toHaveBeenCalled();
  });

  it('une invitation invalide reste refusée en 400 avec son code d\'origine', async () => {
    process.env.SIGNUP_MODE = 'full';
    resolveSignupInvitation.mockResolvedValue({ valid: false, code: 'INVALID_INVITE_TOKEN' });
    const res = await POST(signup({ inviteToken: 'inconnu' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_INVITE_TOKEN');
    expect(writes.filter((w) => w.startsWith('insert'))).toEqual([]);
  });

  it('un jeton de transmission caduc ne bloque pas l’inscription ouverte', async () => {
    process.env.SIGNUP_MODE = 'full';
    const res = await POST(signup({ transmissionToken: 'tok-accepte' }));
    expect(res.status).toBe(201);
    expect(resolveSignupInvitation).not.toHaveBeenCalled();
  });

  it('une invitation valide rejoint le compte partagé comme avant', async () => {
    process.env.SIGNUP_MODE = 'full';
    resolveSignupInvitation.mockResolvedValue(accountInvitation);
    const res = await POST(signup({ inviteToken: 'tok-compte' }));
    expect(res.status).toBe(201);
    expect(writes).toContain('update:account_memberships');
  });
});
