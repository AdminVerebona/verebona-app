/**
 * Normalisation des valeurs de réconciliation — CDC 15 T1-03, D-09, D-16.
 *
 * Recette du CDC : « Montant 749 EUR doit rester 749 EUR dans la fiche et
 * 74900 cents dans les champs explicitement en cents. »
 *
 * Règle de la revue : comportement historique IDENTIQUE, à la seule
 * exception du « ×100 » retiré — vérifié par un test de parité contre
 * l'ancienne version (fixture `normalizers-legacy.ts`) sur toutes les clés et
 * alias du registre. Aucun test existant ne figeait le ×100.
 */
import { describe, it, expect, vi } from 'vitest';

// Clé `money_cents` synthétique : le registre n'en déclare pas encore.
vi.mock('@/services/canonical/registry/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/canonical/registry/registry')>();
  const fake = {
    key: 'fakeDepositCents', label: 'Dépôt (centimes)', families: ['IMMOBILIER'], valueType: 'money_cents', unit: 'cents',
    aliases: [], assistantReadable: false, assistantWritable: false,
  };
  return { ...actual, getField: (k: string) => (k === 'fakeDepositCents' ? fake : actual.getField(k)) };
});

import { normalize, normalizeMoney, areEquivalent } from '../decision/normalizers';
import { legacyNormalize, legacyIsMoneyBranch } from './fixtures/normalizers-legacy';
import { CANONICAL_FIELDS } from '@/services/canonical/registry';

describe('normalize — montants sans ×100 (T1-03)', () => {
  it('749 € reste 749 dans la fiche', () => {
    expect(normalize('acquisitionPrice', 749)).toBe('749');
    expect(normalize('acquisitionPrice', '749 €')).toBe('749');
    expect(normalize('insurancePremium', '1 250,50 €')).toBe('1250.5');
  });

  it('un champ en centimes garde 74900', () => {
    expect(normalize('fakeDepositCents', 74900)).toBe('74900');
    expect(normalize('amountCents', 74900)).toBe('74900'); // hors registre — auparavant 7490000
  });

  it('conversion uniquement sur unité source DÉCLARÉE différente de celle de la clé du registre', () => {
    expect(normalize('acquisitionPrice', 74900, { sourceUnit: 'cents' })).toBe('749');
    expect(normalize('fakeDepositCents', 749, { sourceUnit: 'EUR' })).toBe('74900');
    expect(normalize('acquisitionPrice', 749, { sourceUnit: 'EUR' })).toBe('749');
    // Clé hors registre : jamais de conversion, même déclarée.
    expect(normalize('amountCents', 74900, { sourceUnit: 'EUR' })).toBe('74900');
    // Erreur d'unité probable (centimes non entiers) : non normalisable.
    expect(normalize('acquisitionPrice', '749,5', { sourceUnit: 'cents' })).toBeNull();
    expect(areEquivalent('acquisitionPrice', 749, '749,00 €')).toBe(true);
  });

  it('normalizeMoney : lu tel quel', () => {
    expect(normalizeMoney('749')).toBe('749');
    expect(normalizeMoney('1.250,50 €')).toBe('1250.5');
    expect(normalizeMoney('environ mille')).toBeNull();
  });
});

describe('parité avec la version historique (seul le ×100 diffère)', () => {
  const ECHANTILLONS: unknown[] = [
    749, '749', '749,00 €', '1 250,50 €', '12.500', '12,5', '78 m2 habitables', 'environ 200', '2021-03-12',
    '03/02/2024', '31/13/2024', 'ab 123 cd', 'WVW ZZZ-1K', 'Oui', '  MAÏF  Assurances ', 'n/a', '', 0, -3.5, true,
  ];
  const cles = [...new Set(CANONICAL_FIELDS.flatMap((d) => [d.key, ...d.aliases]))];

  it(`${cles.length} clés et alias × ${ECHANTILLONS.length} valeurs`, () => {
    const ecarts: string[] = [];
    for (const k of cles) {
      for (const v of ECHANTILLONS) {
        const avant = legacyNormalize(k, v);
        const apres = normalize(k, v);
        const ok = legacyIsMoneyBranch(k)
          ? (avant === null && apres === null) || (avant !== null && apres !== null && Math.round(Number(apres) * 100) === Number(avant))
          : avant === apres;
        if (!ok) ecarts.push(`${k}(${JSON.stringify(v)}) : ${avant} → ${apres}`);
      }
    }
    expect(ecarts).toEqual([]);
  });

  it('les clés citées par la revue gardent leur aiguillage historique', () => {
    for (const k of ['valuationLow', 'valuationHigh', 'leaseMonthlyPayment', 'levels', 'energyConsumption', 'ptac',
      'seats', 'engineDisplacement', 'leaseDurationMonths', 'lastRevision', 'nextInspection', 'roomCount']) {
      for (const v of ['12.500', '78 m2 habitables', 'environ 200', '12,5', '2021-03-12']) {
        expect(normalize(k, v), `${k}(${v})`).toBe(legacyNormalize(k, v));
      }
    }
  });
});
