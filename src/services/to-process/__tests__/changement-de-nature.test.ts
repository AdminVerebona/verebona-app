/**
 * Un problème qui change de forme (COMPLETE ↔ ARBITRATE) garde UNE seule
 * action active : l'ancienne est fermée (OBSOLETE) dans la même transaction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let queue: unknown[][] = [];
const txOps: Array<{ kind: string; values: Record<string, unknown> }> = [];
vi.mock('@/db', () => {
  const chain = () => {
    const rows = queue.shift() ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) c[m] = () => c;
    c.limit = async () => rows;
    c.then = (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r);
    return c;
  };
  return {
    db: {
      select: () => chain(),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { txOps.push({ kind: 'update', values }); } }) }),
        insert: () => ({ values: (values: Record<string, unknown>) => { txOps.push({ kind: 'insert', values }); return { returning: async () => [{ id: 50 }], then: (r: (v: unknown) => unknown) => Promise.resolve().then(r) }; } }),
      }),
    },
  };
});
const { upsertAction } = await import('../to-process-action.service');
const base = { accountId: 1, targetType: 'DOCUMENT' as const, targetId: 9, fieldKey: 'rubricCode', ruleCode: 'DOC-RUB' };
const active = (id: number, actionKind: string) => ({ id, actionKind, targetType: 'DOCUMENT', targetId: 9, fieldKey: 'rubricCode', relationKey: null, priority: 'DO_NEXT', dueDate: null });

beforeEach(() => { queue = []; txOps.length = 0; });

describe('changement de nature', () => {
  it('COMPLETE → ARBITRATE : COMPLETE fermée OBSOLETE, tracée, ARBITRATE créée', async () => {
    queue.push([active(4, 'COMPLETE')], [], [{ maxCycle: 1 }]);
    const r = await upsertAction({ ...base, actionKind: 'ARBITRATE', proposals: [{ value: 'LOGEMENT', label: 'Logement', confidence: 0.5 }] });
    expect(r).toMatchObject({ status: 'CREATED', replacedActionId: 4 });
    expect(txOps[0]).toMatchObject({ kind: 'update', values: { resolutionReason: 'OBSOLETE' } });
    expect(txOps[1]).toMatchObject({ kind: 'insert', values: { event: 'OBSOLETE', actionId: 4, details: { from: 'COMPLETE', to: 'ARBITRATE' } } });
    expect(txOps[2]).toMatchObject({ kind: 'insert', values: { actionKind: 'ARBITRATE' } });
  });

  it('ARBITRATE → COMPLETE : même principe', async () => {
    queue.push([active(5, 'ARBITRATE')], [], [{ maxCycle: 1 }]);
    const r = await upsertAction({ ...base, actionKind: 'COMPLETE' });
    expect(r.replacedActionId).toBe(5);
  });

  it('même nature : mise à jour, aucune fermeture', async () => {
    queue.push([active(6, 'COMPLETE')]);
    expect((await upsertAction({ ...base, actionKind: 'COMPLETE' })).status).toBe('UPDATED');
    expect(txOps).toEqual([]);
  });

  it('l’unicité en base porte sur le problème, plus sur la nature', () => {
    const m = readFileSync(join(process.cwd(), 'src/db/migrations/0147_to_process_single_active_per_problem.sql'), 'utf8');
    const idx = m.slice(m.indexOf('CREATE UNIQUE INDEX'));
    expect(idx).not.toContain('action_kind');
    expect(m).toContain('DROP INDEX IF EXISTS to_process_actions_active_unique_idx');
  });
});
