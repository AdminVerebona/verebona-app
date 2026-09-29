/**
 * Normalisation, conversions monétaires exactes, miroirs, résolution d'alias
 * et DTO pour prompts.
 */
import { describe, expect, it } from 'vitest';
import {
  catalogForPrompts,
  centsToEur,
  eurToCents,
  normalizeValue,
  resolveAlias,
  resolveAliasDetailed,
  toAssetFamily,
  toMirrorPatch,
  toMirrorValue,
} from '..';

const val = (key: string, raw: unknown, sourceUnit?: string) => {
  const r = normalizeValue(key, raw, sourceUnit ? { sourceUnit } : undefined);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
const refus = (key: string, raw: unknown, sourceUnit?: string) =>
  normalizeValue(key, raw, sourceUnit ? { sourceUnit } : undefined).ok === false;

describe('montants — euros ↔ centimes exacts (D-09, T1-03)', () => {
  it('aller-retour exact sur tous les centimes de 0 à 200 000, et au-delà par échantillon', () => {
    const faux: number[] = [];
    for (let c = 0; c <= 200_000; c++) if (eurToCents(centsToEur(c)) !== c) faux.push(c);
    for (let c = 200_001; c < 10_000_000_000; c = Math.floor(c * 1.37) + 7) if (eurToCents(centsToEur(c)) !== c) faux.push(c);
    expect(faux).toEqual([]);
  });

  it('pièges flottants classiques', () => {
    expect(eurToCents(0.29)).toBe(29);
    expect(eurToCents(1.15)).toBe(115);
    expect(eurToCents(10834.85)).toBe(1083485);
    expect(eurToCents(4.35)).toBe(435);
    expect(() => eurToCents(1.005)).toThrow();
    expect(() => centsToEur(1.5)).toThrow();
  });

  it('recette T1-03 : 749 € reste 749 dans la fiche et 74 900 centimes dans le miroir', () => {
    expect(val('acquisitionPrice', 749)).toBe(749);
    expect(val('acquisitionPrice', '749 €')).toBe(749);
    expect(toMirrorValue('acquisitionPrice', 749)).toEqual({ purchase_price_cents: 74900 });
    expect(toMirrorPatch('acquisitionPrice', 749)).toEqual({ purchasePriceCents: 74900 });
  });

  it('aucune multiplication déduite du nom ou de l’ordre de grandeur', () => {
    expect(val('insurancePremium', '580,40 €')).toBe(580.4);
    expect(val('estimatedValue', 12)).toBe(12);
    expect(val('acquisitionPrice', 245000)).toBe(245000);
  });

  it('conversion seulement sur unité déclarée ou écrite', () => {
    expect(val('acquisitionPrice', 74900, 'cents')).toBe(749);
    expect(val('acquisitionPrice', '45 k€')).toBe(45000);
    expect(val('acquisitionPrice', '12 500,50 €')).toBe(12500.5);
    expect(val('acquisitionPrice', '€ 1 228')).toBe(1228);
    expect(refus('acquisitionPrice', 749.5, 'cents')).toBe(true);
    expect(refus('acquisitionPrice', '749 €', 'cents')).toBe(true);
    expect(refus('acquisitionPrice', 12.345)).toBe(true);
    expect(refus('acquisitionPrice', -5)).toBe(true);
  });

  it('séparateur ambigu refusé plutôt que deviné', () => {
    expect(refus('acquisitionPrice', '12.500')).toBe(true);
    expect(val('acquisitionPrice', '12.500,00')).toBe(12500);
    expect(val('acquisitionPrice', '1,234,567.89')).toBe(1234567.89);
  });

  it('alias en centimes : l’unité voyage avec la résolution', () => {
    const r = resolveAliasDetailed('purchasePriceCents');
    expect(r).toEqual({ key: 'acquisitionPrice', canonical: false, sourceUnit: 'cents' });
    expect(val(r!.key, 74900, r!.sourceUnit)).toBe(749);
    expect(resolveAliasDetailed('estimatedValueCents')?.sourceUnit).toBe('cents');
  });
});

describe('dates', () => {
  it('formes admises → AAAA-MM-JJ', () => {
    expect(val('acquisitionDate', '2021-05-25')).toBe('2021-05-25');
    expect(val('acquisitionDate', '2021-05-25T10:00:00.000Z')).toBe('2021-05-25');
    expect(val('acquisitionDate', '25/05/2021')).toBe('2021-05-25');
    expect(val('acquisitionDate', '5.6.2021')).toBe('2021-06-05');
    expect(val('acquisitionDate', new Date(Date.UTC(2024, 1, 29)))).toBe('2024-02-29');
  });

  it('dates impossibles ou ambiguës refusées', () => {
    expect(refus('acquisitionDate', '31/02/2024')).toBe(true);
    expect(refus('acquisitionDate', '2023-02-29')).toBe(true);
    expect(refus('acquisitionDate', '05/2021')).toBe(true);
    expect(refus('acquisitionDate', 'demain')).toBe(true);
  });

  it('miroir date', () => {
    expect(toMirrorValue('acquisitionDate', '25/05/2021')).toEqual({ purchase_date: '2021-05-25' });
    expect(toMirrorValue('warrantyEndDate', null)).toEqual({ warranty_end_date: null });
  });
});

describe('autres types', () => {
  it('vide → null (effacement)', () => {
    expect(val('insurer', '')).toBeNull();
    expect(val('insurer', 'N/A')).toBeNull();
    expect(val('mileage', null)).toBeNull();
    expect(toMirrorValue('acquisitionPrice', null)).toEqual({ purchase_price_cents: null });
  });

  it('nombres et unités', () => {
    expect(val('mileage', '84 260 km')).toBe(84260);
    expect(val('mileage', 100, 'miles')).toBe(161);
    expect(val('livingArea', '78,4 m²')).toBe(78.4);
    expect(val('landArea', '1,2 ha')).toBe(12000);
    expect(refus('livingArea', 78, 'km')).toBe(true);
    expect(refus('roomCount', 3.5)).toBe(true);
    expect(refus('constructionYear', 3024)).toBe(true);
    expect(toMirrorValue('mileage', '84 260 km')).toEqual({ mileage_or_hours: 84260 });
  });

  it('enums par code ou libellé', () => {
    expect(val('dpeClass', 'd')).toBe('D');
    expect(val('fuelType', 'Électrique')).toBe('ELECTRIQUE');
    expect(val('occupancyUsage', 'Mis en location')).toBe('LOCATIF');
    expect(refus('dpeClass', 'H')).toBe(true);
  });

  it('booléens et identifiants', () => {
    expect(val('isInsured', 'oui')).toBe(true);
    expect(val('isInsured', 'false')).toBe(false);
    expect(val('registrationNumber', 'gk 482 rt')).toBe('GK-482-RT');
    expect(val('postalCode', '14 123')).toBe('14123');
    expect(toMirrorValue('registrationNumber', 'gk482rt')).toEqual({ registration_number: 'GK-482-RT' });
  });

  it('clé non canonique ou sans miroir', () => {
    expect(refus('purchaseDate', '2021-05-25')).toBe(true);
    expect(toMirrorValue('insurer', 'MAIF')).toEqual({});
    expect(() => toMirrorValue('acquisitionPrice', 'beaucoup')).toThrow();
  });
});

describe('résolution d’alias', () => {
  it('insensible à la casse, aux accents et aux séparateurs', () => {
    expect(resolveAlias('purchase_date')).toBe('acquisitionDate');
    expect(resolveAlias('DATE_ACHAT')).toBe('acquisitionDate');
    expect(resolveAlias('kilométrage')).toBe('mileage');
  });

  it('famille : alias ambigu levé par la famille, canonique prioritaire', () => {
    expect(resolveAlias('loyerMensuel')).toBeUndefined();
    expect(resolveAlias('loyerMensuel', 'IMMOBILIER')).toBe('monthlyRent');
    expect(resolveAlias('loyerMensuel', 'VEHICULE')).toBe('leaseMonthlyPayment');
    expect(resolveAlias('marque', 'VEHICULE')).toBe('make');
    expect(resolveAlias('marque', 'OBJECT')).toBe('brand');
    expect(resolveAlias('generalCondition')).toBe('generalCondition');
    expect(resolveAlias('generalCondition', 'OBJECT')).toBe('condition');
    expect(resolveAlias('nextInspection', 'OBJECT')).toBeUndefined();
  });

  it('origines et clés exclues jamais résolues', () => {
    expect(resolveAlias('acquisitionDate_origin')).toBeUndefined();
    expect(resolveAlias('acquisitionDate__origin')).toBeUndefined();
    expect(resolveAlias('amountCents')).toBeUndefined();
    expect(resolveAlias('coherenceAlerts')).toBeUndefined();
  });

  it('familles historiques', () => {
    expect(toAssetFamily('OBJET')).toBe('OBJECT');
    expect(toAssetFamily('MATERIEL_PRO')).toBe('OBJECT');
    expect(toAssetFamily('VEHICULE')).toBe('VEHICULE');
    expect(toAssetFamily('???')).toBeUndefined();
  });
});

describe('catalogForPrompts (R6)', () => {
  it('DTO sérialisable sans perte', () => {
    const dto = catalogForPrompts({});
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
    expect(dto.family).toBeNull();
    expect(dto.fields.length).toBeGreaterThan(80);
  });

  it('filtré par famille', () => {
    const v = catalogForPrompts({ family: 'VEHICULE' });
    const keys = v.fields.map((x) => x.key);
    expect(keys).toContain('nextInspection');
    expect(keys).not.toContain('dpeDate');
    expect(v.events.map((e) => e.businessType)).not.toContain('dpe');
    expect(v.documents.map((d) => d.code)).not.toContain('DPE');
    expect(v.fields.find((x) => x.key === 'acquisitionPrice')).toMatchObject({ valueType: 'money_eur', unit: 'EUR' });
  });
});
