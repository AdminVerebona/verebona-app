/**
 * Attribut « Bien mis en location » — CDC V2.0 §6.1, §6.2, RENT-01 à RENT-03.
 *
 * La règle testée en premier est celle qui ne se voit pas : le « Non » posé
 * par défaut n'est pas une réponse. La confondre avec une réponse protégerait
 * tout le parc dès la migration, et l'IA ne pourrait plus jamais renseigner
 * l'attribut — l'inverse exact de l'intention du §6.1.
 */
import { describe, it, expect } from 'vitest';
import {
  isRentalAttributeApplicable,
  toRentalState,
  RENTAL_FIELD_KEY,
} from '@/services/assets/rental-status.service';
import { decide } from '@/services/to-process/decision-engine';
import { findRule } from '@/services/to-process/rules-catalog';
import { getVisibleRubrics } from '@/lib/referential/v2';

const proposal = (value: boolean, confidence: number) => ({
  value,
  label: value ? 'Oui' : 'Non',
  confidence,
});

describe('applicabilité du champ (§6.1, RENT-01)', () => {
  it('RENT-01 — réservé aux biens immobiliers', () => {
    expect(isRentalAttributeApplicable('IMMOBILIER')).toBe(true);
    expect(isRentalAttributeApplicable('VEHICULE')).toBe(false);
    expect(isRentalAttributeApplicable('MATERIEL_PRO')).toBe(false);
    expect(isRentalAttributeApplicable(null)).toBe(false);
  });

  it('ne dépend pas du sous-type : un garage se loue aussi', () => {
    // La restriction porte sur la famille, jamais sur le sous-type.
    expect(isRentalAttributeApplicable('IMMOBILIER')).toBe(true);
  });
});

describe('trois états, pas deux (§6.1)', () => {
  it('RENT-01 — « Non » par défaut n’est pas une validation', () => {
    expect(toRentalState(false, false)).toBe('NON_RENSEIGNE');
  });

  it('« Non » répondu par l’utilisateur ferme la question', () => {
    expect(toRentalState(false, true)).toBe('NON');
  });

  it('« Oui » est toujours un état renseigné', () => {
    expect(toRentalState(true, true)).toBe('OUI');
    expect(toRentalState(true, false)).toBe('OUI');
  });
});

describe('règles IA sur l’attribut (§6.1, §11.3)', () => {
  const key = { targetType: 'ASSET' as const, key: RENTAL_FIELD_KEY };

  it('écrit automatiquement à ≥ 90 % quand rien n’a été répondu', () => {
    const verdict = decide({
      ...key,
      // Le « Non » système est présenté comme une absence : sans cela, le
      // moteur refuserait d'écrire sur un champ que personne n'a renseigné.
      currentValue: null,
      userValidated: false,
      proposals: [proposal(true, 0.95)],
    });
    expect(verdict.decision).toBe('APPLY');
    expect(verdict.valueToWrite).toBe(true);
  });

  it('n’écrit pas sous le seuil et propose un arbitrage', () => {
    const verdict = decide({
      ...key,
      currentValue: null,
      userValidated: false,
      proposals: [proposal(true, 0.7)],
    });
    expect(verdict.decision).toBe('ARBITRATE');
  });

  it('n’écrase jamais une réponse explicite, même à 100 %', () => {
    const verdict = decide({
      ...key,
      currentValue: false,
      userValidated: true,
      proposals: [proposal(true, 1)],
    });
    expect(verdict.decision).toBe('ARBITRATE');
    expect(verdict.valueToWrite).toBeUndefined();
  });

  it('ne crée jamais d’action « À compléter » : le champ n’est jamais vide', () => {
    const rule = findRule('ASSET', RENTAL_FIELD_KEY);
    expect(rule?.code).toBe('ASSET-RENTED');
    expect(rule?.completePriority).toBeNull();
    expect(rule?.allowNotApplicable).toBe(false);
  });
});

describe('effet sur la Rubrique « Gestion locative » (§6.2)', () => {
  const immo = { families: ['IMMOBILIER'] as const };

  it('RENT-02 — répondre « Oui » la rend visible, même à 0 document', () => {
    const codes = getVisibleRubrics({
      ...immo,
      hasRentedAsset: true,
      hasRentalDocuments: false,
    }).map((r) => r.code);
    expect(codes).toContain('RENTAL_MANAGEMENT');
  });

  it('RENT-03 — repasser à « Non » ne la masque pas si des documents existent', () => {
    const codes = getVisibleRubrics({
      ...immo,
      hasRentedAsset: false,
      hasRentalDocuments: true,
    }).map((r) => r.code);
    expect(codes).toContain('RENTAL_MANAGEMENT');
  });

  it('masquée quand il n’y a ni bien loué ni document locatif', () => {
    const codes = getVisibleRubrics({
      ...immo,
      hasRentedAsset: false,
      hasRentalDocuments: false,
    }).map((r) => r.code);
    expect(codes).not.toContain('RENTAL_MANAGEMENT');
  });
});
