/**
 * Carte #806 §9 (lot 116C, seconde partie) — la carte d'ASSOCIATION entre deux
 * opérations devenue sans objet est fermée par le balayage horaire, par le
 * service et la prémisse DÉJÀ déclarés (aucune règle dupliquée).
 *
 *   L116CB-U01  règles fermées par le passage : les trois questions qu'il pose ET `OPERATION-RELATION`
 *   L116CB-U02  chacune déclare sa prémisse et le MÊME service de fermeture (`closeCardsNoLongerUseful`)
 *   L116CB-U03  les règles POSÉES par le passage n'ont pas changé (il ne pose toujours pas la carte d'association)
 *   L116CB-U04  §8.5 : la carte d'association n'a aucune exception déclarée — deux propositions au plus, plus l'état actuel
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

const balayage = await import('../reference-event-sweep');
const { contractOf } = await import('../publishability');
const modele = await import('../action-model');
const { OPERATION_RELATION_RULE, operationRelationProposals } = await import('../operation-relation-cards');

describe('L116CB-U — fermeture des cartes d’association périmées (#806 §9)', () => {
  it('L116CB-U01 — le passage ferme aussi la carte d’association', () => {
    expect(balayage.STALE_CLOSURE_RULES).toEqual(['AGENDA-LINK', 'REFERENCE-EVENT-MERGE', 'REFERENCE-EVENT-FACT', 'OPERATION-RELATION']);
    expect(balayage.STALE_CLOSURE_RULES).toContain(OPERATION_RELATION_RULE);
    expect(new Set(balayage.STALE_CLOSURE_RULES).size).toBe(balayage.STALE_CLOSURE_RULES.length);
  });

  it('L116CB-U02 — une prémisse déclarée et un seul service de fermeture par règle', () => {
    for (const code of balayage.STALE_CLOSURE_RULES) {
      const c = contractOf(code);
      expect(c, code).toBeDefined();
      expect(c!.cleanup, code).toMatchObject({ service: 'closeCardsNoLongerUseful' });
      expect(typeof c!.noLongerUseful, code).toBe('function');
      // La prémisse est bornée au compte de la carte (alias fourni), jamais une valeur libre.
      expect(c!.noLongerUseful!('a'), code).toContain('a.account_id');
    }
    expect(contractOf(OPERATION_RELATION_RULE)!.reason).toBe('ASSOCIATION_ALREADY_SETTLED');
  });

  it('L116CB-U03 — les règles posées par le passage sont inchangées', () => {
    expect(balayage.SWEEP_RULES).toEqual(['AGENDA-LINK', 'REFERENCE-EVENT-MERGE', 'REFERENCE-EVENT-FACT']);
  });

  it('L116CB-U04 — §8.5 : deux réponses, dont l’état actuel ; aucune exception déclarée pour cette carte', () => {
    expect(modele.DISPLAYED_PROPOSALS_MAX).toBe(2);
    expect(modele.DISPLAYED_PROPOSALS_MAX_BY_RULE[OPERATION_RELATION_RULE]).toBeUndefined();
    const affichees = modele.selectDisplayedProposals(operationRelationProposals([12]), OPERATION_RELATION_RULE);
    expect(affichees.map((p) => p.value)).toEqual(['ASSOCIATE', 'KEEP_SEPARATE']);
    expect(affichees.filter((p) => p.isCurrentValue)).toHaveLength(1);
    // Aucune des deux réponses n'est mise en avant (question neutre).
    expect(affichees.find((p) => p.value === 'ASSOCIATE')!.emphasis).toBe('neutral');
  });
});
