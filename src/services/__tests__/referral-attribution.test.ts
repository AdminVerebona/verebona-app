/**
 * Attribution du parrainage — règles pures, testées sans base.
 *
 * `normalizeReferralCode` et `canAttribute` concentrent toutes les décisions
 * du CDC parrainage §4.7 : ce sont elles qui déterminent si un code est
 * retenu. Les isoler du SQL est ce qui rend ces règles vérifiables.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeReferralCode,
  canAttribute,
} from '@/services/referral-attribution.service';

describe('normalizeReferralCode', () => {
  it('met en majuscules et retire les espaces de bordure', () => {
    expect(normalizeReferralCode('  abc123 ')).toBe('ABC123');
  });

  it('accepte un code déjà normalisé sans le modifier', () => {
    expect(normalizeReferralCode('ABC123')).toBe('ABC123');
  });

  it('retire les caractères non alphanumériques', () => {
    // Le code est réinjecté dans une URL et dans des métadonnées Stripe :
    // rien d'autre que [A-Z0-9] ne doit passer.
    expect(normalizeReferralCode('ab-c 12/3')).toBe('ABC123');
  });

  it('rejette une tentative d’injection', () => {
    expect(normalizeReferralCode('<script>')).toBe('SCRIPT');
    expect(normalizeReferralCode('<>')).toBeNull();
  });

  it('rejette une chaîne vide ou uniquement composée de séparateurs', () => {
    expect(normalizeReferralCode('')).toBeNull();
    expect(normalizeReferralCode('   ')).toBeNull();
    expect(normalizeReferralCode('---')).toBeNull();
  });

  it('rejette un code trop long', () => {
    // Aligné sur /api/referral/validate : 20 caractères.
    expect(normalizeReferralCode('A'.repeat(20))).toBe('A'.repeat(20));
    expect(normalizeReferralCode('A'.repeat(21))).toBeNull();
  });

  it('rejette toute valeur qui n’est pas une chaîne', () => {
    expect(normalizeReferralCode(undefined)).toBeNull();
    expect(normalizeReferralCode(null)).toBeNull();
    expect(normalizeReferralCode(42)).toBeNull();
    expect(normalizeReferralCode({ code: 'ABC' })).toBeNull();
  });
});

describe('canAttribute', () => {
  const activeLink = { id: 7, accountId: 100, isActive: true };

  it('retient un lien actif pour un autre compte', () => {
    expect(canAttribute(activeLink, 200)).toEqual({
      linkId: 7,
      referrerAccountId: 100,
    });
  });

  it('rejette un lien désactivé', () => {
    // CDC §4.7 : « qu'il n'est pas expiré ou désactivé ».
    expect(canAttribute({ ...activeLink, isActive: false }, 200)).toBeNull();
  });

  it('rejette l’auto-parrainage', () => {
    // CDC §4.7 : « que le parrain ne se parraine pas lui-même ».
    expect(canAttribute(activeLink, 100)).toBeNull();
  });

  it('rejette un code inconnu', () => {
    expect(canAttribute(undefined, 200)).toBeNull();
    expect(canAttribute(null, 200)).toBeNull();
  });

  it('retient le lien lorsque le compte parrainé n’est pas encore connu', () => {
    // Cas d'une invitation Duo : aucun compte n'est créé pour l'inscrit.
    // Le contrôle d'auto-parrainage ne peut pas s'appliquer, et ne doit pas
    // faire échouer l'attribution pour autant.
    expect(canAttribute(activeLink, null)).toEqual({
      linkId: 7,
      referrerAccountId: 100,
    });
  });
});
