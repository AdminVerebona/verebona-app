/**
 * Résolution directe d'un arbitrage : valeur, validation, résolution et trace
 * dans la MÊME transaction (CDC V2 §13.5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Op = { client: 'tx' | 'db'; kind: 'update' | 'insert'; values?: Record<string, unknown> };
const ops: Op[] = [];
let action: Record<string, unknown> | null = null;

function client(name: 'tx' | 'db') {
  const selectChain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'for']) selectChain[m] = () => selectChain;
  selectChain.limit = async () => (action ? [action] : []);
  return {
    select: () => selectChain,
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { ops.push({ client: name, kind: 'update', values }); } }) }),
    insert: () => ({ values: async (values: Record<string, unknown>) => { ops.push({ client: name, kind: 'insert', values }); } }),
  };
}
const tx = client('tx');
vi.mock('@/db', () => ({
  db: {
    ...client('db'),
    // Transaction simulée : si le callback lève, les opérations « tx » sont annulées.
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      const mark = ops.length;
      try { return await fn(tx); } catch (e) { ops.splice(mark); throw e; }
    },
  },
}));

const { resolveArbitration } = await import('../resolve-action.service');

beforeEach(() => {
  ops.length = 0;
  action = { id: 7, publicId: 'p', accountId: 1, targetType: 'DOCUMENT', targetId: 3, fieldKey: 'rubricCode', ruleCode: 'R', cycleNumber: 1, resolvedAt: null };
});

describe('résolution atomique', () => {
  it('toutes les écritures passent par la transaction, trace comprise', async () => {
    const r = await resolveArbitration(1, 'p', 'RENTAL_MANAGEMENT', { userId: 9 });
    expect(r.ok).toBe(true);
    expect(ops.every((o) => o.client === 'tx')).toBe(true);
    expect(ops.map((o) => o.kind)).toEqual(['update', 'update', 'insert']);
    expect(ops[0].values).toMatchObject({ rubricCode: 'RENTAL_MANAGEMENT', rubricOrigin: 'USER' });
    expect(ops[1].values).toMatchObject({ resolutionReason: 'USER_ARBITRATED' });
    expect(ops[2].values).toMatchObject({ event: 'RESOLVED_ARBITRATION', actorUserId: 9, newValue: 'RENTAL_MANAGEMENT' });
  });

  it('erreur après l’écriture du champ : rollback complet, rien de partiel', async () => {
    await expect(resolveArbitration(1, 'p', 'RENTAL_MANAGEMENT', { onAfterFieldWrite: () => { throw new Error('panne'); } })).rejects.toThrow('panne');
    expect(ops).toEqual([]);
  });

  it('action déjà résolue (relue dans la transaction) : aucune écriture', async () => {
    action!.resolvedAt = new Date();
    expect(await resolveArbitration(1, 'p', 'RENTAL_MANAGEMENT')).toMatchObject({ ok: false, error: 'ALREADY_RESOLVED' });
    expect(ops).toEqual([]);
  });
});
