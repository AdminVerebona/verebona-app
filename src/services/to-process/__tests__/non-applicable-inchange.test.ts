/**
 * Une action « Non applicable » ne réapparaît pas sans élément nouveau (§7.4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let lastResolved: Record<string, unknown> | null = null;
const inserts: Array<Record<string, unknown>> = [];
let queue: unknown[][] = [];
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
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        update: () => ({ set: () => ({ where: async () => {} }) }),
        insert: () => ({ values: (v: Record<string, unknown>) => { inserts.push(v); return { returning: async () => [{ id: 42 }] }; } }),
      }),
    },
  };
});
/** Réponses successives : action active, dernière résolue, cycle max. */
const prepare = (withCreate: boolean) => { queue.push([], lastResolved ? [lastResolved] : []); if (withCreate) queue.push([{ maxCycle: 1 }]); };

const { upsertAction, computeTriggerContextHash } = await import('../to-process-action.service');
const base = { accountId: 1, targetType: 'ASSET' as const, targetId: 3, fieldKey: 'registrationNumber', actionKind: 'COMPLETE' as const, ruleCode: 'DATA-REGISTRATION' };

beforeEach(() => { lastResolved = null; inserts.length = 0; queue = []; });

describe('empreinte des éléments déclencheurs', () => {
  it('stable : ni l’ordre, ni les libellés, ni la confiance ne la changent', () => {
    const a = computeTriggerContextHash({ ruleCode: 'R', actionKind: 'ARBITRATE', proposals: [{ value: 'A', evidenceIds: ['e2', 'e1'] }, { value: 'B' }] });
    const b = computeTriggerContextHash({ ruleCode: 'R', actionKind: 'ARBITRATE', proposals: [{ value: 'B', label: 'x', confidence: 0.2 } as never, { value: 'A', evidenceIds: ['e1', 'e2'], confidence: 0.9 } as never] });
    expect(a).toBe(b);
  });
  it('une nouvelle preuve, valeur ou échéance la change', () => {
    const h = (p: object) => computeTriggerContextHash({ ruleCode: 'R', actionKind: 'ARBITRATE', proposals: [{ value: 'A' }], ...p });
    expect(h({})).not.toBe(h({ proposals: [{ value: 'A', evidenceIds: ['e9'] }] }));
    expect(h({})).not.toBe(h({ dueDate: new Date('2027-01-01') }));
    expect(h({})).not.toBe(h({ triggerContext: { sourceVersion: 2 } }));
  });
});

describe('upsertAction après « Non applicable »', () => {
  it('mêmes données : SKIPPED NOT_APPLICABLE_UNCHANGED, rien d’écrit — à chaque relance', async () => {
    lastResolved = { id: 5, resolutionReason: 'NOT_APPLICABLE', triggerContextHash: computeTriggerContextHash({ ...base, proposals: [] }) };
    for (let i = 0; i < 3; i++) {
      prepare(false);
      expect(await upsertAction(base)).toMatchObject({ status: 'SKIPPED', code: 'NOT_APPLICABLE_UNCHANGED', actionId: 5 });
    }
    expect(inserts).toHaveLength(0);
  });

  it('ancienne action sans empreinte : recalculée depuis ce qu’elle a conservé', async () => {
    lastResolved = { id: 5, resolutionReason: 'NOT_APPLICABLE', triggerContextHash: null, ruleCode: base.ruleCode, actionKind: 'COMPLETE', proposalsJson: [], dueDate: null, triggerContext: null };
    prepare(false);
    expect((await upsertAction(base)).code).toBe('NOT_APPLICABLE_UNCHANGED');
  });

  it('élément nouveau : nouveau cycle, la décision précédente reste en base', async () => {
    lastResolved = { id: 5, resolutionReason: 'NOT_APPLICABLE', triggerContextHash: computeTriggerContextHash({ ...base, proposals: [] }) };
    prepare(true);
    const r = await upsertAction({ ...base, triggerContext: { sourceFileId: 12 } });
    expect(r.status).toBe('CREATED');
    expect(inserts[0]).toMatchObject({ cycleNumber: 2 });
    expect(inserts[0].triggerContextHash).toBeTypeOf('string');
  });

  it('un problème résolu autrement (valeur saisie) peut revenir normalement', async () => {
    lastResolved = { id: 5, resolutionReason: 'USER_COMPLETED', triggerContextHash: computeTriggerContextHash({ ...base, proposals: [] }) };
    prepare(true);
    expect((await upsertAction(base)).status).toBe('CREATED');
  });
});
