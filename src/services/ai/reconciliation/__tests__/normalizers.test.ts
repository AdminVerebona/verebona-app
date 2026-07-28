/**
 * Tests de normalisation — première étape du §4.2.8.
 *
 * Enjeu : éviter les faux conflits. Un arbitrage inutile décrédibilise la page
 * « À traiter » aussi sûrement qu'une erreur silencieuse décrédibilise la fiche.
 */
import { describe, it, expect } from 'vitest';
import { normalize, areEquivalent, normalizeDate, normalizeMoney, normalizePlate } from '../decision/normalizers';

describe('dates', () => {
  it('ramène les formats français et ISO à une même valeur', () => {
    expect(normalizeDate('14/03/2026')).toBe('2026-03-14');
    expect(normalizeDate('14-03-2026')).toBe('2026-03-14');
    expect(normalizeDate('2026-03-14')).toBe('2026-03-14');
  });

  it('rejette une date impossible plutôt que de la corriger', () => {
    expect(normalizeDate('32/13/2026')).toBeNull();
    expect(normalizeDate('bientôt')).toBeNull();
  });
});

describe('montants', () => {
  it('ramène toutes les écritures d\'un même montant en centimes', () => {
    expect(normalizeMoney('1 234,56 €')).toBe('123456');
    expect(normalizeMoney('1234.56')).toBe('123456');
    expect(normalizeMoney('1.234,56')).toBe('123456');
  });

  it('rejette un montant illisible', () => {
    expect(normalizeMoney('environ mille euros')).toBeNull();
  });
});

describe('plaques', () => {
  it('uniformise la ponctuation', () => {
    expect(normalizePlate('ab123cd')).toBe('AB-123-CD');
    expect(normalizePlate('AB-123-CD')).toBe('AB-123-CD');
    expect(normalizePlate('AB 123 CD')).toBe('AB-123-CD');
  });
});

describe('équivalences — absence de faux conflit', () => {
  it.each([
    ['livingArea', '78,40', '78.4'],
    ['acquisitionPrice', '120 000 €', '120000'],
    ['contractEndDate', '01/01/2027', '2027-01-01'],
    ['registrationNumber', 'ab-123-cd', 'AB 123 CD'],
    ['city', 'Saint-Étienne', 'saint-etienne'],
    ['vin', 'vf1-234567', 'VF1234567'],
  ])('%s : « %s » et « %s » sont la même valeur', (field, a, b) => {
    expect(areEquivalent(field, a, b)).toBe(true);
  });

  it.each([
    ['livingArea', '78', '79'],
    ['acquisitionPrice', '120000', '115000'],
    ['contractEndDate', '01/01/2027', '01/02/2027'],
  ])('%s : « %s » et « %s » sont bien différentes', (field, a, b) => {
    expect(areEquivalent(field, a, b)).toBe(false);
  });

  it('deux valeurs vides ne sont pas « équivalentes » : elles sont absentes', () => {
    expect(areEquivalent('notes', '', null)).toBe(false);
  });

  it('traite les mentions d\'absence comme une valeur vide', () => {
    expect(normalize('notes', 'N/A')).toBeNull();
    expect(normalize('notes', 'néant')).toBeNull();
    expect(normalize('notes', '  ')).toBeNull();
  });
});
