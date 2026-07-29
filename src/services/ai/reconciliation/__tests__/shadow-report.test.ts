/**
 * CDC §10.2 — mesure des écarts du mode observation, et §4.2.6 — invariant des
 * champs critiques.
 *
 * Le second bloc de tests existe à cause d'un défaut réel : `CRITICAL_FIELDS`
 * comptait six clés, `CRITICAL_ALLOWED_TYPES` seulement trois, et
 * `isAuthorizedForCriticalField` refuse par défaut. Le code postal, la ville et
 * le complément d'adresse ne pouvaient donc jamais être corrigés
 * automatiquement — silencieusement, sans que rien n'échoue. L'invariant est
 * désormais tenu par un test plutôt que par l'attention du relecteur.
 */
import { describe, it, expect } from 'vitest';
import { summarizeShadowDecisions, type ShadowDecisionRow } from '../shadow-report.service';
import { CRITICAL_FIELDS } from '../decision/critical-fields';
import { isAuthorizedForCriticalField, getAuthorityMatrix } from '../decision/authority-matrix';

function row(over: Partial<ShadowDecisionRow> = {}): ShadowDecisionRow {
  return {
    fieldKey: 'livingArea',
    action: 'apply',
    reasonCode: 'BETTER_AUTHORITY',
    confidence: 'certain',
    deterministic: true,
    assetId: 1,
    ...over,
  };
}

describe('agrégation du mode observation', () => {
  it('classe les six actions du moteur en trois familles lisibles', () => {
    const s = summarizeShadowDecisions([
      row({ action: 'apply' }),
      row({ action: 'update' }),
      row({ action: 'create_conflict' }),
      row({ action: 'request_ai_review' }),
      row({ action: 'keep' }),
      row({ action: 'ignore' }),
    ]);

    expect(s.wouldWrite).toBe(2);
    expect(s.wouldAsk).toBe(2);
    expect(s.wouldKeep).toBe(2);
    expect(s.decisionCount).toBe(6);
  });

  it('compte les biens distincts, pas les décisions', () => {
    const s = summarizeShadowDecisions([
      row({ assetId: 1 }), row({ assetId: 1 }), row({ assetId: 2 }),
    ]);
    expect(s.assetCount).toBe(2);
    expect(s.decisionCount).toBe(3);
  });

  it('mesure les sollicitations par bien — le chiffre de la question 6', () => {
    const s = summarizeShadowDecisions([
      row({ assetId: 1, action: 'create_conflict' }),
      row({ assetId: 1, action: 'request_ai_review' }),
      row({ assetId: 2, action: 'keep' }),
    ]);
    expect(s.asksPerAsset).toBe(1); // 2 sollicitations / 2 biens
  });

  it('mesure la part de décisions prises sans appel modèle (§4.2.8)', () => {
    const s = summarizeShadowDecisions([
      row({ deterministic: true }), row({ deterministic: true }),
      row({ deterministic: true }), row({ deterministic: false }),
    ]);
    expect(s.deterministicRate).toBe(0.75);
  });

  it('isole les écritures automatiques sur champ critique', () => {
    const s = summarizeShadowDecisions([
      row({ fieldKey: 'city', action: 'update' }),
      row({ fieldKey: 'livingArea', action: 'update' }),
      row({ fieldKey: 'city', action: 'keep' }),
    ]);
    expect(s.criticalWouldWrite).toBe(1);
  });

  it('trie le détail par champ le plus sollicitant', () => {
    const s = summarizeShadowDecisions([
      row({ fieldKey: 'calme', action: 'keep' }),
      row({ fieldKey: 'bruyant', action: 'create_conflict' }),
      row({ fieldKey: 'bruyant', action: 'request_ai_review' }),
    ]);
    expect(s.byField[0].fieldKey).toBe('bruyant');
    expect(s.byField[0].wouldAsk).toBe(2);
  });

  it('traduit le motif dominant en langage lisible', () => {
    const s = summarizeShadowDecisions([
      row({ reasonCode: 'CRITICAL_FIELD_INSUFFICIENT_PROOF', action: 'create_conflict' }),
    ]);
    expect(s.byField[0].topReason).toContain('Champ critique');
  });

  it('ne divise pas par zéro sur une fenêtre vide', () => {
    const s = summarizeShadowDecisions([]);
    expect(s).toMatchObject({ decisionCount: 0, assetCount: 0, asksPerAsset: 0, deterministicRate: 1 });
    expect(s.byField).toEqual([]);
  });
});

describe('invariant des champs critiques (§4.2.6)', () => {
  it('tout champ critique dispose d\'une liste de types autorisés', () => {
    const { criticalAllowedTypes } = getAuthorityMatrix();
    const sansListe = [...CRITICAL_FIELDS].filter((f) => !criticalAllowedTypes[f]);

    // Sans cette liste, le champ ne peut JAMAIS être écrit automatiquement :
    // `isAuthorizedForCriticalField` refuse par défaut. Un oubli ici ne casse
    // rien visiblement — il envoie simplement tout en arbitrage, pour toujours.
    expect(sansListe, `champs critiques sans type autorisé : ${sansListe.join(', ')}`).toEqual([]);
  });

  it('les quatre clés d\'adresse partagent la même autorité', () => {
    for (const key of ['address1', 'address2', 'postalCode', 'city']) {
      expect(isAuthorizedForCriticalField(key, 'ACTE_AUTHENTIQUE'), key).toBe(true);
      expect(isAuthorizedForCriticalField(key, 'FACTURE'), key).toBe(false);
    }
  });

  it('un type de document non listé reste refusé', () => {
    expect(isAuthorizedForCriticalField('registrationNumber', 'FACTURE')).toBe(false);
    expect(isAuthorizedForCriticalField('registrationNumber', 'CARTE_GRISE')).toBe(true);
  });

  it('un champ non critique n\'est pas concerné par cette porte', () => {
    expect(CRITICAL_FIELDS.has('insurancePremium')).toBe(false);
  });
});
