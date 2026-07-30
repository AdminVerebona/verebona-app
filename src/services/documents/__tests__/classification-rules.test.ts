/**
 * Règles de classement — CDC 5 §2.2, §2.3, §4.2, §4.3, §5.2.
 *
 * Les sept lignes du §4.3 sont testées une par une, ainsi que les
 * verrouillages du §5.2 : ce sont les règles qu'on découvre fausses six mois
 * plus tard, quand une correction manuelle a été écrasée par l'IA.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCompatibilityIndex,
  computeClassificationState,
  applyClassification,
  canAiRefineType,
  GENERIC_TYPE_CODE,
} from '@/services/documents/classification-rules';

/** Extrait fidèle du §3.4. */
const ASSOCIATIONS = [
  { typeCode: 'FACTURE', categoryCode: 'ACHAT_VALEUR' },
  { typeCode: 'FACTURE', categoryCode: 'ENTRETIEN_REPARATIONS' },
  { typeCode: 'FACTURE', categoryCode: 'TRAVAUX_TRANSFORMATIONS' },
  { typeCode: 'FACTURE', categoryCode: 'FISCALITE_CHARGES' },
  { typeCode: 'GARANTIE', categoryCode: 'GARANTIES_NOTICES' },
  { typeCode: 'DPE', categoryCode: 'CONFORMITE_CONTROLES' },
  { typeCode: 'TAXE_FONCIERE', categoryCode: 'FISCALITE_CHARGES' },
];

const ALL = [
  'ACHAT_VALEUR', 'CONTRATS_ASSURANCES', 'ENTRETIEN_REPARATIONS',
  'GARANTIES_NOTICES', 'CONFORMITE_CONTROLES', 'TRAVAUX_TRANSFORMATIONS',
  'FISCALITE_CHARGES', 'AUTRES_DOCUMENTS',
];

const index = buildCompatibilityIndex(ASSOCIATIONS, ALL);
/** Périmètre d'un véhicule : ni travaux, ni fiscalité (§3.2). */
const vehicleIndex = buildCompatibilityIndex(
  ASSOCIATIONS,
  ['ACHAT_VALEUR', 'CONTRATS_ASSURANCES', 'ENTRETIEN_REPARATIONS', 'GARANTIES_NOTICES', 'AUTRES_DOCUMENTS'],
);

describe('type générique AUTRE (§2.2, §6.2)', () => {
  it('est compatible avec toutes les catégories applicables', () => {
    for (const category of ALL) {
      expect(index.isCompatible(GENERIC_TYPE_CODE, category)).toBe(true);
    }
  });

  it('reste borné au périmètre des biens rattachés', () => {
    expect(vehicleIndex.isCompatible(GENERIC_TYPE_CODE, 'FISCALITE_CHARGES')).toBe(false);
  });

  it('n’est pas la même chose que la catégorie AUTRES_DOCUMENTS', () => {
    // §2.2 : « la catégorie Autres documents est distincte du type Autre ».
    expect(index.isCompatible('GARANTIE', 'AUTRES_DOCUMENTS')).toBe(false);
    expect(index.isCompatible(GENERIC_TYPE_CODE, 'GARANTIES_NOTICES')).toBe(true);
  });
});

describe('état de classification (§2.3)', () => {
  it('classe un couple compatible', () => {
    expect(computeClassificationState('ACHAT_VALEUR', 'FACTURE', index)).toBe('CLASSIFIED');
  });

  it('classe un type AUTRE dans une catégorie valide', () => {
    // Contrainte majeure du §1.3 : AUTRE est un type valide, pas un état.
    expect(computeClassificationState('AUTRES_DOCUMENTS', 'AUTRE', index)).toBe('CLASSIFIED');
  });

  it('ne classe pas sans catégorie', () => {
    expect(computeClassificationState(null, 'FACTURE', index)).toBe('TO_CLASSIFY');
  });

  it('ne classe pas sans type', () => {
    expect(computeClassificationState('ACHAT_VALEUR', null, index)).toBe('TO_CLASSIFY');
  });

  it('ne classe pas un couple incompatible', () => {
    expect(computeClassificationState('GARANTIES_NOTICES', 'DPE', index)).toBe('TO_CLASSIFY');
  });
});

describe('les sept situations du §4.3', () => {
  const base = { currentCategory: null, currentType: null, source: 'USER' as const };

  it('1 — attribue la catégorie quand le type n’en a qu’une', () => {
    const out = applyClassification({ ...base, nextType: 'GARANTIE' }, index);
    expect(out.category).toBe('GARANTIES_NOTICES');
    expect(out.state).toBe('CLASSIFIED');
    expect(out.changes.join(' ')).toContain('automatiquement');
  });

  it('2 — laisse à classer quand le type a plusieurs catégories', () => {
    const out = applyClassification({ ...base, nextType: 'FACTURE' }, index);
    expect(out.category).toBeNull();
    expect(out.state).toBe('TO_CLASSIFY');
  });

  it('3 — accepte une catégorie sans type', () => {
    const out = applyClassification({ ...base, nextCategory: 'ACHAT_VALEUR' }, index);
    expect(out.category).toBe('ACHAT_VALEUR');
    expect(out.type).toBeNull();
    expect(out.state).toBe('TO_CLASSIFY');
  });

  it('4 — accepte un type sans catégorie définitive', () => {
    const out = applyClassification({ ...base, nextType: 'FACTURE' }, index);
    expect(out.type).toBe('FACTURE');
    expect(out.state).toBe('TO_CLASSIFY');
  });

  it('5 — retire le type devenu incompatible après changement de catégorie', () => {
    const out = applyClassification(
      { currentCategory: 'CONFORMITE_CONTROLES', currentType: 'DPE',
        nextCategory: 'ACHAT_VALEUR', source: 'USER' },
      index,
    );
    expect(out.type).toBeNull();
    expect(out.state).toBe('TO_CLASSIFY');
    expect(out.changes.join(' ')).toContain('retiré');
  });

  it('6a — remplace la catégorie si le nouveau type n’en admet qu’une', () => {
    const out = applyClassification(
      { currentCategory: 'ACHAT_VALEUR', currentType: 'FACTURE',
        nextType: 'GARANTIE', source: 'USER' },
      index,
    );
    expect(out.category).toBe('GARANTIES_NOTICES');
    expect(out.state).toBe('CLASSIFIED');
  });

  it('6b — retire la catégorie si le nouveau type en admet plusieurs', () => {
    const multi = buildCompatibilityIndex(
      [...ASSOCIATIONS, { typeCode: 'DEVIS', categoryCode: 'ACHAT_VALEUR' },
        { typeCode: 'DEVIS', categoryCode: 'ENTRETIEN_REPARATIONS' }],
      ALL,
    );
    const out = applyClassification(
      { currentCategory: 'GARANTIES_NOTICES', currentType: 'GARANTIE',
        nextType: 'DEVIS', source: 'USER' },
      multi,
    );
    expect(out.category).toBeNull();
    expect(out.state).toBe('TO_CLASSIFY');
  });

  it('7 — AUTRE permet de sortir de « à classer » si la catégorie est valide', () => {
    const out = applyClassification(
      { currentCategory: 'AUTRES_DOCUMENTS', currentType: null,
        nextType: GENERIC_TYPE_CODE, source: 'USER' },
      index,
    );
    expect(out.state).toBe('CLASSIFIED');
  });
});

describe('verrouillages des corrections manuelles (§5.2)', () => {
  it('verrouille le champ modifié par l’utilisateur', () => {
    const out = applyClassification(
      { currentCategory: null, currentType: null, nextType: 'FACTURE', source: 'USER' },
      index,
    );
    expect(out.typeUserLocked).toBe(true);
    expect(out.categoryUserLocked).toBe(false);
  });

  it('empêche l’IA de changer une catégorie corrigée à la main', () => {
    const out = applyClassification(
      { currentCategory: 'ACHAT_VALEUR', currentType: 'FACTURE',
        nextCategory: 'FISCALITE_CHARGES', categoryUserLocked: true, source: 'AI' },
      index,
    );
    expect(out.category).toBe('ACHAT_VALEUR');
    expect(out.rejected.join(' ')).toContain('verrouillée');
  });

  it('empêche l’IA de changer un type corrigé à la main', () => {
    const out = applyClassification(
      { currentCategory: 'GARANTIES_NOTICES', currentType: 'GARANTIE',
        nextType: 'FACTURE', typeUserLocked: true, source: 'AI' },
      index,
    );
    expect(out.type).toBe('GARANTIE');
    expect(out.rejected.length).toBeGreaterThan(0);
  });

  it('autorise l’IA à préciser un type resté AUTRE', () => {
    // §5.2, exception : l'utilisateur qui a choisi « Autre » n'a pas exprimé
    // une préférence, il a constaté une absence.
    const out = applyClassification(
      { currentCategory: 'GARANTIES_NOTICES', currentType: GENERIC_TYPE_CODE,
        nextType: 'GARANTIE', typeUserLocked: true, source: 'AI' },
      index,
    );
    expect(out.type).toBe('GARANTIE');
    expect(out.rejected).toHaveLength(0);
  });

  it('laisse l’IA compléter le champ que l’utilisateur n’a pas renseigné', () => {
    // §5.2 : « si l'utilisateur ne renseigne qu'un champ, le champ manquant
    // peut toujours être complété par le traitement de cohérence ».
    const out = applyClassification(
      { currentCategory: null, currentType: 'FACTURE', typeUserLocked: true,
        nextCategory: 'ACHAT_VALEUR', source: 'AI' },
      index,
    );
    expect(out.category).toBe('ACHAT_VALEUR');
    expect(out.state).toBe('CLASSIFIED');
  });

  it('laisse l’utilisateur passer outre son propre verrouillage', () => {
    const out = applyClassification(
      { currentCategory: 'ACHAT_VALEUR', currentType: 'FACTURE',
        nextCategory: 'FISCALITE_CHARGES', categoryUserLocked: true, source: 'USER' },
      index,
    );
    expect(out.category).toBe('FISCALITE_CHARGES');
  });
});

describe('périmètre des biens rattachés (§4.4)', () => {
  it('retire une catégorie inapplicable au bien', () => {
    const out = applyClassification(
      { currentCategory: 'FISCALITE_CHARGES', currentType: null, source: 'AI' },
      vehicleIndex,
    );
    expect(out.category).toBeNull();
    expect(out.changes.join(' ')).toContain('inapplicable');
  });

  it('conserve une catégorie commune à tous les biens', () => {
    const out = applyClassification(
      { currentCategory: 'ENTRETIEN_REPARATIONS', currentType: 'FACTURE', source: 'AI' },
      vehicleIndex,
    );
    expect(out.category).toBe('ENTRETIEN_REPARATIONS');
    expect(out.state).toBe('CLASSIFIED');
  });
});

describe('affinage d’un type générique (§4.2, §5.2)', () => {
  it('autorise le remplacement d’AUTRE par un type précis', () => {
    expect(canAiRefineType(GENERIC_TYPE_CODE, true, 'GARANTIE')).toBe(true);
  });

  it('refuse de remplacer un type précis verrouillé', () => {
    expect(canAiRefineType('GARANTIE', true, 'FACTURE')).toBe(false);
  });

  it('refuse de régresser vers AUTRE', () => {
    expect(canAiRefineType('GARANTIE', false, GENERIC_TYPE_CODE)).toBe(false);
  });

  it('autorise tout changement sur un type non verrouillé', () => {
    expect(canAiRefineType('FACTURE', false, 'DEVIS')).toBe(true);
  });
});
