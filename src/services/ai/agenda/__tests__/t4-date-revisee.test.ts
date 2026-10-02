/**
 * Décision PO D-M (lot 20) : la date TRANCHÉE par T4 (branche
 * TEMPORAL_AMBIGUITY, T4 master + AI_T4_EFFECTS=enabled) déclenche la
 * révision de la preuve du champ d'origine — jamais hors de ce mode, jamais
 * quand la date n'a pas changé, jamais bloquante.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ choix: 1 as number | null }));
vi.mock('../../config/config-resolver', async (orig) => ({
  ...(await orig<typeof import('../../config/config-resolver')>()),
  getPromptArchitecture: async () => 'master',
}));
vi.mock('../master/temporal-ambiguity', async (orig) => ({
  ...(await orig<typeof import('../master/temporal-ambiguity')>()),
  resolveTemporalAmbiguityMaster: vi.fn(async (_c: unknown, candidats: Array<{ candidateId: number; date: string; interpretation: string }>) =>
    ({ chosen: h.choix === null ? null : candidats[h.choix], warning: null })),
}));

const { processAgendaCandidates, __resetTemporalCacheForTests } = await import('../agenda-intelligence.service');

const cand = {
  title: 'Contrôle technique', date: '2027-03-04', confidence: 'certain' as const, excerpt: 'Prochain contrôle avant le 03/04/2027',
  originFieldKey: 'nextInspection', documentType: 'CONTROLE_TECHNIQUE', nature: 'DEADLINE', businessType: 'inspection',
  sources: [{ fileId: 40, role: 'SOURCE', evidenceId: 70 }],
};
const run = (t4Effects: 'legacy' | 'shadow' | 'enabled', reviseDate: ReturnType<typeof vi.fn>, c: Record<string, unknown> = cand) => processAgendaCandidates({
  accountId: 1, userId: 2, assetId: 3, sourceFileId: 40, candidates: [c] as never, existing: [], today: '2026-10-02', t4Effects,
  reviseDate: reviseDate as never,
});

beforeEach(() => {
  __resetTemporalCacheForTests();
  h.choix = 1;
});

describe('D-M — date tranchée par T4', () => {
  it('enabled + master, date changée : révision demandée (champ, date lue, date retenue, preuve du candidat)', async () => {
    const reviseDate = vi.fn(async () => ({}));
    const [d] = await run('enabled', reviseDate);
    expect(d.date).toBe('2027-04-03');
    expect(reviseDate).toHaveBeenCalledWith({
      accountId: 1, userId: 2, sourceFileId: 40, fieldKey: 'nextInspection', extractedDate: '2027-03-04', chosenDate: '2027-04-03', evidenceId: 70,
    });
  });

  it('date retenue identique, abstention (proposition) ou hors enabled : aucune révision', async () => {
    const reviseDate = vi.fn(async () => ({}));
    h.choix = 0;
    await run('enabled', reviseDate);
    __resetTemporalCacheForTests();
    h.choix = null;
    const [p] = await run('enabled', reviseDate);
    expect(p).toMatchObject({ action: 'propose', reasonCode: 'TEMPORAL_AMBIGUITY' });
    __resetTemporalCacheForTests();
    h.choix = 1;
    await run('shadow', reviseDate);
    await run('legacy', reviseDate);
    expect(reviseDate).not.toHaveBeenCalled();
  });

  it('sans champ d’origine (événement sans champ de bien) : aucune révision', async () => {
    const reviseDate = vi.fn(async () => ({}));
    await run('enabled', reviseDate, { ...cand, originFieldKey: undefined });
    expect(reviseDate).not.toHaveBeenCalled();
  });

  it('jamais bloquant : une erreur de révision n’empêche pas la décision agenda', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reviseDate = vi.fn(async () => { throw new Error('boom'); });
    const [d] = await run('enabled', reviseDate);
    expect(d).toMatchObject({ date: '2027-04-03' });
    expect(d.action).not.toBe('propose');
  });
});
