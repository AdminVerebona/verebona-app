/**
 * Lot 114A (Trello #753, CDC T2 §6.3, §12.6, D02, tests U16-U17-U21) —
 * CLARIFICATIONS SUCCESSIVES SANS PLAFOND MÉTIER.
 *
 *   K01  trois ambiguïtés réelles : trois questions, chaque décision conservée ;
 *   K02  un nouveau choix n'efface pas les décisions précédentes ;
 *   K03  la même question (mêmes candidats) n'est jamais reposée : boucle détectée ;
 *   K04  une clarification créée pendant une reprise hérite des décisions.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { inputDeReprise } = await import('../../clarification.service');
const { carryResolved, clarificationSignature, isClarificationCycle } = await import('../../clarification-builder');
type State = import('../../../types/machine').ClarificationState;

const base = { accountId: 1, userId: 2, planType: 'STANDARD', locale: 'fr-FR' } as never;
const etat = (o: Partial<State>): State => ({
  clarificationId: 'c1', conversationId: 3, accountId: 1, userId: 2, originalMessageId: 'm1',
  originalMessage: 'Quand se termine le contrat de la chaudière de ma maison ?', originalIntent: 'ACCOUNT_DATA_QUESTION' as never,
  candidateType: 'asset', ambiguity: { kind: 'asset', field: 'assetId', reason: 'TARGET_AMBIGUOUS' },
  candidates: [{ id: 'asset_42', label: 'Maison Lyon', entityId: 42 }, { id: 'asset_87', label: 'Maison Annecy', entityId: 87 }] as never,
  question: 'De quelle maison parlez-vous ?', expiresAt: '2099-01-01T00:00:00Z', attemptCount: 0, chainDepth: 1, status: 'PENDING', ...o,
});

describe('L114A-K01 / K02 — trois clarifications, décisions cumulées', () => {
  it('bien, puis équipement, puis document : rien n’est perdu en route', () => {
    // 1re question : le bien.
    const e1 = etat({});
    const r1 = inputDeReprise(base, e1, e1.candidates[0]);
    expect(r1.resume).toMatchObject({ assetId: 42, chainDepth: 1, decisions: { assetId: 42 } });

    // 2e question (créée pendant la reprise) : l'équipement.
    const e2 = carryResolved(etat({
      clarificationId: 'c2', chainDepth: 2, candidateType: 'equipment', ambiguity: { kind: 'equipment', field: 'entityId', reason: 'ENTITY_HOMONYM' },
      candidates: [{ id: 'eq_5', label: 'Chaudière gaz', entityId: 5, assetId: 42 }, { id: 'eq_6', label: 'Chaudière fioul', entityId: 6, assetId: 42 }] as never,
    }), r1.resume);
    expect(isClarificationCycle(e2, r1.resume)).toBe(false);
    const r2 = inputDeReprise(base, e2, e2.candidates[0]);
    expect(r2.resume?.decisions).toMatchObject({ assetId: 42, entity: { type: 'equipment', id: 5, assetId: 42 } });

    // 3e question : le document — au-delà de l'ancien plafond de deux.
    const e3 = carryResolved(etat({
      clarificationId: 'c3', chainDepth: 3, candidateType: 'document', ambiguity: undefined,
      candidates: [{ id: 'doc_9', label: 'Contrat 2024', entityId: 9 }, { id: 'doc_10', label: 'Contrat 2025', entityId: 10 }] as never,
    }), r2.resume);
    expect(isClarificationCycle(e3, r2.resume)).toBe(false);
    const r3 = inputDeReprise(base, e3, e3.candidates[1]);
    expect(r3.resume).toMatchObject({
      documentId: 10, entity: { type: 'equipment', id: 5, assetId: 42 },
      decisions: { assetId: 42, documentId: 10, entity: { type: 'equipment', id: 5 } },
    });
    expect(r3.resume?.asked).toHaveLength(3);
    // La demande rejouée reste la demande initiale, jamais une concaténation.
    expect(r3.message).toBe(e1.originalMessage);
  });
});

describe('L114A-K03 — boucle sans progression', () => {
  it('la même question avec les mêmes candidats est reconnue, quel que soit leur ordre', () => {
    const e1 = etat({});
    const r1 = inputDeReprise(base, e1, e1.candidates[0]);
    const encore = etat({ clarificationId: 'c9', candidates: [...e1.candidates].reverse() });
    expect(clarificationSignature(encore)).toBe(clarificationSignature(e1));
    expect(isClarificationCycle(encore, r1.resume)).toBe(true);
  });

  it('des candidats différents sur la même dimension : progression, pas une boucle', () => {
    const e1 = etat({});
    const r1 = inputDeReprise(base, e1, e1.candidates[0]);
    const autre = etat({ candidates: [{ id: 'asset_42', label: 'Maison Lyon', entityId: 42 }, { id: 'asset_99', label: 'Studio', entityId: 99 }] as never });
    expect(isClarificationCycle(autre, r1.resume)).toBe(false);
  });
});

describe('L114A-K04 — héritage à la création', () => {
  it('sans reprise : état inchangé', () => {
    const e = etat({});
    expect(carryResolved(e, undefined)).toBe(e);
    expect(e.resolvedContext).toBeUndefined();
  });
});
