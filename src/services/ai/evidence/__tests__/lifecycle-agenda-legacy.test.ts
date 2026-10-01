/**
 * Relecture lot 17 — retrait agenda d'une source retirée : en
 * `AI_T4_EFFECTS=legacy`, sortie immédiate, AUCUNE requête.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const unsafe = vi.hoisted(() => vi.fn(async () => []));
const remove = vi.hoisted(() => vi.fn(async () => ({ removed: [] })));
vi.mock('@/db', () => ({ pgClient: { unsafe }, db: {} }));
vi.mock('@/services/agenda/agenda-write-primitive', () => ({ removeAgendaItemsFromSource: remove }));

const { retirerAgendaDeLaSource } = await import('../document-evidence-lifecycle');

describe('retrait agenda d’une source — commutateur AI_T4_EFFECTS', () => {
  const avant = process.env.AI_T4_EFFECTS;
  afterEach(() => { if (avant === undefined) delete process.env.AI_T4_EFFECTS; else process.env.AI_T4_EFFECTS = avant; unsafe.mockClear(); remove.mockClear(); });

  it('legacy : aucune requête, aucune primitive', async () => {
    process.env.AI_T4_EFFECTS = 'legacy';
    expect(await retirerAgendaDeLaSource({ accountId: 1, sourceFileId: 2, assetId: 3 })).toBeNull();
    expect(unsafe).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('enabled : sources partagées lues puis primitive appelée', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    await retirerAgendaDeLaSource({ accountId: 1, sourceFileId: 2, assetId: 3 });
    expect(unsafe).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ sourceFileId: 2, keepKeys: [], analysisComplete: true }));
  });
});
