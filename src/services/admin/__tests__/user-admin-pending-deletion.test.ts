/**
 * Suppression volontaire en cours : le BO ne peut ni désactiver ni réactiver
 * l'utilisateur — CDC Back-Office V1 GDP-008, REC-GDP-05.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/* ── Transaction simulée ──────────────────────────────────────────────── */

/** Résultats successifs des SELECT (verrou admins, cible, relecture). */
let selectResults: unknown[][] = [];
/** Lignes renvoyées par l'UPDATE … RETURNING (vide : WHERE non satisfait). */
let updateReturning: unknown[] = [];
const updateWheres: unknown[] = [];
const updateSets: unknown[] = [];

function selectChain() {
  const result = selectResults.shift() ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'for']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return chain;
}

const tx = {
  select: () => selectChain(),
  update: () => ({
    set: (values: unknown) => {
      updateSets.push(values);
      return {
        where: (cond: unknown) => {
          updateWheres.push(cond);
          return { returning: async () => updateReturning };
        },
      };
    },
  }),
};

vi.mock('@/db', () => ({
  db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
}));
const revokeUserSessionsNow = vi.fn(async () => new Date());
vi.mock('@/services/admin/account-status.service', () => ({
  revokeUserSessionsNow: (...a: unknown[]) => revokeUserSessionsNow(...(a as [])),
}));

const {
  reactivateUser,
  suspendUser,
  statusUpdateCondition,
  isStatusChangeBlockedByDeletion,
  UserAdminError,
  PENDING_DELETION_ADMIN_MESSAGE,
} = await import('@/services/admin/user-admin.service');

beforeEach(() => {
  selectResults = [];
  updateReturning = [];
  updateWheres.length = 0;
  updateSets.length = 0;
  revokeUserSessionsNow.mockClear();
});

async function expectPendingDeletion(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(UserAdminError);
  expect((err as InstanceType<typeof UserAdminError>).code).toBe('PENDING_DELETION');
  expect((err as Error).message).toBe(PENDING_DELETION_ADMIN_MESSAGE);
}

describe('règle pure', () => {
  it('seul PENDING_DELETION fige le statut', () => {
    expect(isStatusChangeBlockedByDeletion('PENDING_DELETION')).toBe(true);
    for (const s of ['ACTIVE', 'SUSPENDED', 'DELETED', null, undefined]) {
      expect(isStatusChangeBlockedByDeletion(s)).toBe(false);
    }
  });

  it('la condition de l’UPDATE exclut PENDING_DELETION (contrôle atomique)', () => {
    const q = new PgDialect().sqlToQuery(statusUpdateCondition(42));
    expect(q.sql).toMatch(/"users"\."id" = \$1 and "users"\."status" <> \$2/);
    expect(q.params).toEqual([42, 'PENDING_DELETION']);
  });
});

describe('reactivateUser', () => {
  it('refuse un utilisateur en suppression volontaire, sans écrire', async () => {
    selectResults = [[{ id: 7, role: 'USER', status: 'PENDING_DELETION' }]];
    await expectPendingDeletion(reactivateUser(7));
    expect(updateSets).toHaveLength(0);
  });

  it('refuse aussi une clôture validée entre la lecture et l’écriture (WHERE non satisfait)', async () => {
    selectResults = [
      [{ id: 7, role: 'USER', status: 'SUSPENDED' }],
      [{ status: 'PENDING_DELETION' }],
    ];
    updateReturning = [];
    await expectPendingDeletion(reactivateUser(7));
    expect(updateWheres).toHaveLength(1);
  });

  it('réactive un utilisateur désactivé', async () => {
    selectResults = [[{ id: 7, role: 'USER', status: 'SUSPENDED' }]];
    updateReturning = [{ id: 7 }];
    await expect(reactivateUser(7)).resolves.toEqual({ before: { status: 'SUSPENDED' }, after: { status: 'ACTIVE' } });
    expect(updateSets[0]).toMatchObject({ status: 'ACTIVE' });
    const q = new PgDialect().sqlToQuery(updateWheres[0] as ReturnType<typeof statusUpdateCondition>);
    expect(q.params).toContain('PENDING_DELETION');
  });
});

describe('suspendUser', () => {
  it('refuse un utilisateur en suppression volontaire et ne révoque rien', async () => {
    selectResults = [[], [{ id: 7, role: 'USER', status: 'PENDING_DELETION' }]];
    await expectPendingDeletion(suspendUser(7));
    expect(updateSets).toHaveLength(0);
    expect(revokeUserSessionsNow).not.toHaveBeenCalled();
  });

  it('course : WHERE non satisfait → PENDING_DELETION, sessions non révoquées', async () => {
    selectResults = [[], [{ id: 7, role: 'USER', status: 'ACTIVE' }], [{ status: 'PENDING_DELETION' }]];
    await expectPendingDeletion(suspendUser(7));
    expect(revokeUserSessionsNow).not.toHaveBeenCalled();
  });

  it('utilisateur disparu entre-temps → USER_NOT_FOUND', async () => {
    selectResults = [[], [{ id: 7, role: 'USER', status: 'ACTIVE' }], []];
    const err = await suspendUser(7).then(() => null, (e: unknown) => e);
    expect((err as InstanceType<typeof UserAdminError>).code).toBe('USER_NOT_FOUND');
  });

  it('désactive un utilisateur actif puis révoque ses sessions', async () => {
    selectResults = [[], [{ id: 7, role: 'USER', status: 'ACTIVE' }]];
    updateReturning = [{ id: 7 }];
    await expect(suspendUser(7)).resolves.toEqual({ before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' } });
    expect(revokeUserSessionsNow).toHaveBeenCalledWith(7, 'ADMIN_DEACTIVATE');
  });
});
