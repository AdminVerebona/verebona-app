/**
 * Reprise mécanique du classement — CDC 5 §4.3 règle 1, §7.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE REPRISE SE DÉFAIT MAL
 *
 * Elle touche des milliers de lignes d'un coup. Une règle trop permissive
 * classerait à tort des documents que personne ne reviendrait vérifier — et
 * l'utilisateur découvrirait ses factures rangées au hasard.
 *
 * D'où une règle volontairement stricte : en cas de doute, on ne classe pas.
 * « À classer » est un état honnête ; une mauvaise catégorie ne l'est pas.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { buildCompatibilityIndex } from '@/services/documents/classification-rules';
import { decideCategory } from '@/services/documents/reclassify.service';

/** Extrait du référentiel réel (§3.4). */
const ASSOCIATIONS = [
  { typeCode: 'GARANTIE', categoryCode: 'GARANTIES_NOTICES' },
  { typeCode: 'DPE', categoryCode: 'CONFORMITE_CONTROLES' },
  { typeCode: 'TAXE_FONCIERE', categoryCode: 'FISCALITE_CHARGES' },
  // FACTURE en admet quatre : c'est le cas ambigu type.
  { typeCode: 'FACTURE', categoryCode: 'ACHAT_VALEUR' },
  { typeCode: 'FACTURE', categoryCode: 'ENTRETIEN_REPARATIONS' },
  { typeCode: 'FACTURE', categoryCode: 'TRAVAUX_TRANSFORMATIONS' },
  { typeCode: 'FACTURE', categoryCode: 'FISCALITE_CHARGES' },
];

const TOUTES = [
  'ACHAT_VALEUR', 'ENTRETIEN_REPARATIONS', 'TRAVAUX_TRANSFORMATIONS',
  'FISCALITE_CHARGES', 'GARANTIES_NOTICES', 'CONFORMITE_CONTROLES', 'AUTRES_DOCUMENTS',
];

const complet = buildCompatibilityIndex(ASSOCIATIONS, TOUTES);
/** Périmètre d'un véhicule : ni travaux, ni fiscalité (§3.2). */
const vehicule = buildCompatibilityIndex(
  ASSOCIATIONS,
  ['ACHAT_VALEUR', 'ENTRETIEN_REPARATIONS', 'GARANTIES_NOTICES', 'CONFORMITE_CONTROLES', 'AUTRES_DOCUMENTS'],
);

describe('types sans ambiguïté — classés', () => {
  it('attribue la catégorie unique d’une garantie', () => {
    expect(decideCategory('GARANTIE', complet, complet))
      .toEqual({ decision: 'classify', categoryCode: 'GARANTIES_NOTICES' });
  });

  it('attribue la catégorie unique d’un DPE', () => {
    expect(decideCategory('DPE', complet, complet))
      .toEqual({ decision: 'classify', categoryCode: 'CONFORMITE_CONTROLES' });
  });
});

describe('types ambigus — laissés à classer', () => {
  it('ne tranche pas une facture', () => {
    // Quatre catégories possibles : classer au hasard serait pire que de
    // laisser l'utilisateur décider.
    const v = decideCategory('FACTURE', complet, complet);
    expect(v.decision).toBe('ambiguous');
    expect(v).toMatchObject({ reason: expect.stringContaining('4') });
  });

  it('ne tranche jamais sur le type générique', () => {
    // `AUTRE` est compatible avec TOUTES les catégories (§6.2) : il ne peut
    // par construction jamais désigner une catégorie unique.
    expect(decideCategory('AUTRE', complet, complet).decision).toBe('ambiguous');
  });
});

describe('cas écartés', () => {
  it('écarte un document sans type', () => {
    expect(decideCategory(null, complet, complet))
      .toEqual({ decision: 'skip', reason: 'no_type' });
  });

  it('écarte un type inconnu du référentiel', () => {
    expect(decideCategory('TYPE_INVENTE', complet, complet))
      .toEqual({ decision: 'skip', reason: 'no_type' });
  });

  it('distingue « inapplicable » de « inconnu »', () => {
    // TAXE_FONCIERE n'a qu'une catégorie — FISCALITE_CHARGES —, mais elle ne
    // s'applique pas aux véhicules. Ce n'est pas un référentiel incomplet,
    // c'est un rattachement à revoir : les deux cas appellent des actions
    // différentes et ne doivent pas être confondus.
    expect(decideCategory('TAXE_FONCIERE', vehicule, complet))
      .toEqual({ decision: 'skip', reason: 'not_applicable' });
  });
});

describe('restriction par famille de bien (§4.4)', () => {
  it('classe encore ce qui reste applicable', () => {
    expect(decideCategory('GARANTIE', vehicule, complet))
      .toEqual({ decision: 'classify', categoryCode: 'GARANTIES_NOTICES' });
  });

  it('réduit l’ambiguïté sans la faire disparaître', () => {
    // FACTURE passe de quatre catégories à deux sur un véhicule — encore
    // ambigu, donc toujours pas classé.
    expect(decideCategory('FACTURE', vehicule, complet).decision).toBe('ambiguous');
  });
});

describe('propriété générale', () => {
  it('ne classe jamais dans une catégorie inapplicable', () => {
    // La garantie qu'une reprise ne peut pas produire d'incohérence : toute
    // catégorie attribuée appartient au périmètre des biens rattachés.
    for (const type of ['GARANTIE', 'DPE', 'TAXE_FONCIERE', 'FACTURE', 'AUTRE', 'INCONNU']) {
      const v = decideCategory(type, vehicule, complet);
      if (v.decision === 'classify') {
        expect(vehicule.categoriesForAssets()).toContain(v.categoryCode);
      }
    }
  });
});
