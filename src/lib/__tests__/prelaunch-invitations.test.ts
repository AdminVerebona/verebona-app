/**
 * Invitations ouvrant la création de compte pendant le pré-lancement :
 * jeton de compte partagé (`account_memberships`) et jeton Premium Duo
 * (`duo_accounts.pending_invite_token`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: Record<string, unknown[]> = {};

vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const select = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from: (t: never) => { table = getTableName(t); return c; },
      where: () => c,
      limit: async () => rows[table] ?? [],
    };
    return c;
  };
  return { db: { select } };
});

const { resolveSignupInvitation } = await import('../prelaunch-invitations');

const NOW = new Date('2026-09-26T12:00:00Z');
const FUTURE = new Date('2026-10-01T00:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
});

describe('resolveSignupInvitation — compte partagé', () => {
  it('invitation en attente, bon email (casse ignorée), non expirée : valide', async () => {
    rows.account_memberships = [{ id: 1, status: 'pending', invitedEmail: 'Anne@Exemple.fr', inviteTokenExpiresAt: FUTURE }];
    const r = await resolveSignupInvitation('tok', 'anne@exemple.fr', NOW);
    expect(r).toMatchObject({ valid: true, kind: 'account' });
  });

  it('déjà acceptée, expirée ou pour un autre email : refusée', async () => {
    rows.account_memberships = [{ id: 1, status: 'active', invitedEmail: null, inviteTokenExpiresAt: null }];
    expect(await resolveSignupInvitation('tok', 'a@b.fr', NOW)).toEqual({ valid: false, code: 'INVALID_INVITE_TOKEN' });
    rows.account_memberships = [{ id: 1, status: 'pending', invitedEmail: null, inviteTokenExpiresAt: PAST }];
    expect(await resolveSignupInvitation('tok', 'a@b.fr', NOW)).toEqual({ valid: false, code: 'INVITE_TOKEN_EXPIRED' });
    rows.account_memberships = [{ id: 1, status: 'pending', invitedEmail: 'x@y.fr', inviteTokenExpiresAt: null }];
    expect(await resolveSignupInvitation('tok', 'a@b.fr', NOW)).toEqual({ valid: false, code: 'INVITE_EMAIL_MISMATCH' });
  });
});

describe('resolveSignupInvitation — Premium Duo', () => {
  it('Duo actif, invitation non expirée : valide', async () => {
    rows.duo_accounts = [{ id: 9, subscriptionStatus: 'ACTIVE', pendingInviteEmail: 'a@b.fr', pendingInviteTokenExpiresAt: FUTURE }];
    expect(await resolveSignupInvitation('duo', 'A@B.fr', NOW)).toEqual({ valid: true, kind: 'duo', duoId: 9 });
  });

  it('Duo inactif ou invitation expirée : refusée', async () => {
    rows.duo_accounts = [{ id: 9, subscriptionStatus: 'CANCELED', pendingInviteEmail: null, pendingInviteTokenExpiresAt: null }];
    expect((await resolveSignupInvitation('duo', 'a@b.fr', NOW)).valid).toBe(false);
    rows.duo_accounts = [{ id: 9, subscriptionStatus: 'ACTIVE', pendingInviteEmail: null, pendingInviteTokenExpiresAt: PAST }];
    expect(await resolveSignupInvitation('duo', 'a@b.fr', NOW)).toEqual({ valid: false, code: 'INVITE_TOKEN_EXPIRED' });
  });
});

it('jeton vide ou inconnu : refusé', async () => {
  expect(await resolveSignupInvitation('', 'a@b.fr', NOW)).toEqual({ valid: false, code: 'INVALID_INVITE_TOKEN' });
  expect(await resolveSignupInvitation('inconnu', 'a@b.fr', NOW)).toEqual({ valid: false, code: 'INVALID_INVITE_TOKEN' });
});

// Un destinataire de transmission sans compte doit pouvoir s'inscrire pendant
// le pré-lancement : sinon il ne peut jamais recevoir le bien.
describe('resolveSignupInvitation — transmission d’un bien', () => {
  it('transmission en attente, destinée à cet email : valide', async () => {
    rows.asset_transmissions = [{ id: 4, status: 'pending', recipientEmail: 'Paul@Exemple.fr' }];
    expect(await resolveSignupInvitation('tr', 'paul@exemple.fr', NOW))
      .toEqual({ valid: true, kind: 'transmission', transmissionId: 4 });
  });

  it('autre email : refusée (un lien transféré n’ouvre pas l’inscription)', async () => {
    rows.asset_transmissions = [{ id: 4, status: 'pending', recipientEmail: 'paul@exemple.fr' }];
    expect(await resolveSignupInvitation('tr', 'intrus@exemple.fr', NOW))
      .toEqual({ valid: false, code: 'INVITE_EMAIL_MISMATCH' });
  });

  it.each(['accepted', 'refused', 'cancelled'])('transmission %s : refusée', async (status) => {
    rows.asset_transmissions = [{ id: 4, status, recipientEmail: 'paul@exemple.fr' }];
    expect(await resolveSignupInvitation('tr', 'paul@exemple.fr', NOW))
      .toEqual({ valid: false, code: 'INVALID_INVITE_TOKEN' });
  });
});
