/**
 * CDC §12 critère n°4 — le départage des liaisons passe par la gateway.
 *
 * L'exigence testée ici n'est pas « le modèle répond bien » : c'est que
 * l'indisponibilité du modèle, sous toutes ses formes, dégrade vers le
 * déterministe seul sans jamais interrompre le rattachement. C'était le
 * comportement de l'existant, et le perdre en migrant aurait été une
 * régression invisible — les deux appels d'origine étaient explicitement
 * documentés « non-blocking ».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execute = vi.fn();
vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: (...a: unknown[]) => execute(...a) } }));

const { reconcileLinks, retainAbove, ReconcileLinksOutput, LINK_SCORE_THRESHOLDS } =
  await import('../link-reconciler');

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('appel via la gateway', () => {
  it('déclare l\'usage et l\'opération du référentiel', async () => {
    execute.mockResolvedValue({ data: { documents: [], agendaItems: [], suppliers: [], matches: [] } });
    await reconcileLinks({ accountId: 3, variables: { SUBJECT_CONTEXT: 'x' }, sourceIds: [9] });

    expect(execute.mock.calls[0][0]).toMatchObject({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: 'reconcile_links',
      accountId: 3,
      sourceIds: [9],
    });
  });

  it('transmet un schéma de sortie — jamais de JSON brut persisté (§5.3)', async () => {
    execute.mockResolvedValue({ data: { documents: [], agendaItems: [], suppliers: [], matches: [] } });
    await reconcileLinks({ accountId: 3, variables: {} });

    expect(execute.mock.calls[0][0].outputSchema).toBeDefined();
  });

  it('rend le résultat validé', async () => {
    execute.mockResolvedValue({
      data: { documents: [{ id: 1, score: 0.9, reason: 'même fournisseur' }], agendaItems: [], suppliers: [], matches: [] },
    });
    const res = await reconcileLinks({ accountId: 3, variables: {} });
    expect(res.documents[0].id).toBe(1);
  });
});

describe('dégradation vers le déterministe', () => {
  it('ne lève pas quand la gateway échoue', async () => {
    execute.mockRejectedValue(new Error('fournisseur indisponible'));
    await expect(reconcileLinks({ accountId: 3, variables: {} }))
      .resolves.toEqual({ documents: [], agendaItems: [], suppliers: [], matches: [] });
  });

  it('journalise la cause pour distinguer prompt absent et panne', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    execute.mockRejectedValue(new Error('prompt introuvable'));
    await reconcileLinks({ accountId: 3, variables: {} });

    expect(warn.mock.calls[0][0]).toContain('déterministe seul');
  });
});

describe('schéma de sortie', () => {
  it('tolère les sections absentes', () => {
    const parsed = ReconcileLinksOutput.parse({ matches: [{ id: 4, score: 0.7 }] });
    expect(parsed.documents).toEqual([]);
    expect(parsed.matches[0].reason).toBe('');
  });

  it('refuse un identifiant ou un score invalide', () => {
    expect(ReconcileLinksOutput.safeParse({ matches: [{ id: -1, score: 0.5 }] }).success).toBe(false);
    expect(ReconcileLinksOutput.safeParse({ matches: [{ id: 1, score: 1.4 }] }).success).toBe(false);
  });
});

describe('seuils de rétention', () => {
  it('conserve les seuils de l\'existant', () => {
    expect(LINK_SCORE_THRESHOLDS.equipmentToObjects).toBe(0.4);
    expect(LINK_SCORE_THRESHOLDS.documentToEquipment).toBe(0.5);
  });

  it('filtre et classe du meilleur score au moins bon', () => {
    const kept = retainAbove(
      [{ id: 1, score: 0.5, reason: '' }, { id: 2, score: 0.9, reason: '' }, { id: 3, score: 0.2, reason: '' }],
      0.4,
    );
    expect(kept.map(m => m.id)).toEqual([2, 1]);
  });
});
