/**
 * Relecture lot 17 — retrait agenda d'une source retirée. Lot 16b-2 :
 * AI_T4_EFFECTS retiré, le retrait est toujours actif (sources partagées
 * détachées, puis primitive), quelle que soit la variable encore posée.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const unsafe = vi.hoisted(() => vi.fn(async () => []));
const remove = vi.hoisted(() => vi.fn(async () => ({ removed: [] })));
vi.mock('@/db', () => ({ pgClient: { unsafe }, db: {} }));
vi.mock('@/services/agenda/agenda-write-primitive', () => ({ removeAgendaItemsFromSource: remove }));

const { retirerAgendaDeLaSource } = await import('../document-evidence-lifecycle');

describe('retrait agenda d’une source — toujours actif', () => {
  afterEach(() => { vi.unstubAllEnvs(); unsafe.mockClear(); remove.mockClear(); });

  it('sources partagées lues puis primitive appelée', async () => {
    await retirerAgendaDeLaSource({ accountId: 1, sourceFileId: 2, assetId: 3 });
    expect(unsafe).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ sourceFileId: 2, keepKeys: [], analysisComplete: true }));
  });
  it('variable retirée encore posée (AI_T4_EFFECTS=legacy) : sans effet', async () => {
    vi.stubEnv('AI_T4_EFFECTS', 'legacy');
    await retirerAgendaDeLaSource({ accountId: 1, sourceFileId: 2, assetId: 3 });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
