/**
 * Informations complémentaires — dictionnaire, validation, fusion, saisie.
 * CDC Exports V12 §4.1 (IC-GEN-005..009), §4.2.
 */
import { describe, it, expect } from 'vitest';
import {
  ADDITIONAL_INFO_FIELDS, SECTIONS_BY_FAMILY, applyPatch, emptyAdditionalInfos, fieldsFor, findField,
  formatCentsForInput, interpretFieldInput, parseEurosToCents, sanitizeSection, sectionsForCategory,
  toFieldInput, validateAdditionalInfosPatch,
} from '../additional-infos';

describe('dictionnaire (§4.2)', () => {
  it('contient les 18 champs du CDC avec leur type', () => {
    const cdc: Array<[string, string, string]> = [
      ['commercial', 'desiredSalePriceCents', 'money'],
      ['commercial', 'saleConditions', 'textarea'],
      ['commercial', 'availabilityDate', 'date'],
      ['commercial', 'availabilityComment', 'text'],
      ['commercial', 'contactInstructions', 'textarea'],
      ['commercial', 'includedAccessories', 'textarea'],
      ['rental', 'monthlyRentCents', 'money'],
      ['rental', 'monthlyChargesCents', 'money'],
      ['rental', 'depositCents', 'money'],
      ['rental', 'leaseType', 'enum'],
      ['rental', 'rentalAreaSqm', 'decimal'],
      ['rental', 'rentalConditions', 'textarea'],
      ['rental', 'contactInstructions', 'textarea'],
      ['insurance', 'insuranceObjective', 'enum'],
      ['insurance', 'valueToInsureCents', 'money'],
      ['insurance', 'desiredInsuredAmountCents', 'money'],
      ['insurance', 'coverageComment', 'textarea'],
      ['insurance', 'specialItems', 'textarea'],
    ];
    for (const [s, k, t] of cdc) expect(findField(s as never, k)?.type, `${s}.${k}`).toBe(t);
  });

  it('types de bail du CDC', () => {
    const values = findField('rental', 'leaseType')!.options!.map((o) => o.value).sort();
    expect(values).toEqual(['AUTRE', 'ETUDIANT', 'MEUBLE', 'MOBILITE', 'NON_MEUBLE', 'SAISONNIER']);
  });

  it('champs de la maquette validée : sinistre, énergie, protections', () => {
    for (const k of ['claimType', 'occurredOn', 'declaredOn', 'insurerClaimRef', 'circumstances', 'consequences', 'measures', 'exchangesSummary']) {
      expect(findField('claim', k), k).toBeDefined();
    }
    expect(findField('rental', 'energyCostMinCents')).toBeDefined();
    expect(findField('insurance', 'protections')).toBeDefined();
    expect(findField('insurance', 'occupancyDetails')).toBeDefined();
  });

  it('clés uniques par sous-rubrique, libellés en français', () => {
    const ids = ADDITIONAL_INFO_FIELDS.map((f) => `${f.section}.${f.key}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of ADDITIONAL_INFO_FIELDS) expect(f.label).toMatch(/^[A-ZÉÀ]/);
  });

  it('pas de location véhicule ni objet (§4.2)', () => {
    expect(SECTIONS_BY_FAMILY.IMMOBILIER).toContain('rental');
    expect(SECTIONS_BY_FAMILY.VEHICULE).not.toContain('rental');
    expect(sectionsForCategory('OBJECT')).toEqual(['commercial', 'insurance', 'claim', 'finance']);
    expect(sectionsForCategory('XYZ')).toEqual([]);
  });

  it('prix neuf de référence : véhicule et objet seulement', () => {
    expect(fieldsFor('commercial', 'IMMOBILIER').some((f) => f.key === 'newPriceCents')).toBe(false);
    expect(fieldsFor('commercial', 'VEHICULE').some((f) => f.key === 'newPriceCents')).toBe(true);
  });
});

describe('validateAdditionalInfosPatch', () => {
  it('accepte un correctif valide et normalise les textes', () => {
    const r = validateAdditionalInfosPatch({
      commercial: { desiredSalePriceCents: 390000, saleConditions: '  Paiement par virement  ', availabilityDate: '2026-10-15' },
      rental: { leaseType: 'NON_MEUBLE', rentalAreaSqm: 67.4 },
    }, 'IMMOBILIER');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.set.commercial).toEqual({ desiredSalePriceCents: 390000, saleConditions: 'Paiement par virement', availabilityDate: '2026-10-15' });
    expect(r.patch.set.rental).toEqual({ leaseType: 'NON_MEUBLE', rentalAreaSqm: 67.4 });
  });

  it('IC-GEN-008 : zéro est une valeur, pas un vide', () => {
    const r = validateAdditionalInfosPatch({ rental: { depositCents: 0 } }, 'IMMOBILIER');
    expect(r.ok && r.patch.set.rental).toEqual({ depositCents: 0 });
  });

  it('IC-GEN-009 : null ou vide retire le champ', () => {
    const r = validateAdditionalInfosPatch({ commercial: { saleConditions: '', desiredSalePriceCents: null } }, 'VEHICULE');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.unset.commercial?.sort()).toEqual(['desiredSalePriceCents', 'saleConditions']);
    expect(r.patch.set.commercial).toBeUndefined();
  });

  it.each([
    [{ commercial: { desiredSalePriceCents: 12.5 } }, 'commercial.desiredSalePriceCents', /centimes/],
    [{ commercial: { desiredSalePriceCents: -1 } }, 'commercial.desiredSalePriceCents', /négatif/],
    [{ commercial: { desiredSalePriceCents: '1000' } }, 'commercial.desiredSalePriceCents', /invalide/i],
    [{ commercial: { availabilityDate: '2026-02-30' } }, 'commercial.availabilityDate', /Date invalide/],
    [{ commercial: { availabilityDate: '15/10/2026' } }, 'commercial.availabilityDate', /Date invalide/],
    [{ rental: { leaseType: 'COLOCATION' } }, 'rental.leaseType', /non proposée/],
    [{ rental: { rentalAreaSqm: 12.345 } }, 'rental.rentalAreaSqm', /décimales/],
    [{ commercial: { salePitch: 'x'.repeat(201) } }, 'commercial.salePitch', /200/],
    [{ commercial: { foo: 1 } }, 'commercial.foo', /inconnu/],
    [{ divers: {} }, 'divers', /inconnue/],
  ])('refuse %j', (body, path, message) => {
    const r = validateAdditionalInfosPatch(body, 'IMMOBILIER');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.issues.find((i) => i.path === path);
    expect(issue, JSON.stringify(r.issues)).toBeDefined();
    expect(issue!.message).toMatch(message);
  });

  it('champ non applicable à la famille : écriture refusée, suppression admise', () => {
    const w = validateAdditionalInfosPatch({ rental: { monthlyRentCents: 90000 } }, 'VEHICULE');
    expect(w.ok).toBe(false);
    const w2 = validateAdditionalInfosPatch({ commercial: { newPriceCents: 1000 } }, 'IMMOBILIER');
    expect(w2.ok).toBe(false);
    const d = validateAdditionalInfosPatch({ rental: { monthlyRentCents: null } }, 'VEHICULE');
    expect(d.ok).toBe(true);
  });

  it('corps vide ou non objet : refusé', () => {
    expect(validateAdditionalInfosPatch({}, 'IMMOBILIER').ok).toBe(false);
    expect(validateAdditionalInfosPatch([], 'IMMOBILIER').ok).toBe(false);
    expect(validateAdditionalInfosPatch(null, 'IMMOBILIER').ok).toBe(false);
    expect(validateAdditionalInfosPatch({ commercial: 'x' }, 'IMMOBILIER').ok).toBe(false);
  });
});

describe('relecture et fusion', () => {
  it('sanitizeSection écarte clés inconnues et valeurs corrompues', () => {
    expect(sanitizeSection('rental', { monthlyRentCents: 115000, depositCents: 0, leaseType: 'X', foo: 'bar', monthlyChargesCents: '14000' }))
      .toEqual({ monthlyRentCents: 115000, depositCents: 0 });
    expect(sanitizeSection('claim', null)).toEqual({});
  });

  it('applyPatch : champ par champ, retraits appliqués', () => {
    const cur = { ...emptyAdditionalInfos(), commercial: { desiredSalePriceCents: 100, saleConditions: 'a' } };
    const next = applyPatch(cur, { set: { commercial: { saleConditions: 'b' }, claim: { claimType: 'VOL' } }, unset: { commercial: ['desiredSalePriceCents'] } });
    expect(next.commercial).toEqual({ saleConditions: 'b' });
    expect(next.claim).toEqual({ claimType: 'VOL' });
    expect(cur.commercial).toEqual({ desiredSalePriceCents: 100, saleConditions: 'a' });
  });
});

describe('saisie en euros (IC-GEN-006)', () => {
  it.each([
    ['1 250,50', 125050],
    ['1250.5', 125050],
    ['1 250 €', 125000],
    ['0', 0],
    ['', null],
    ['  ', null],
  ])('%j → %j', (input, cents) => {
    expect(parseEurosToCents(input)).toBe(cents);
  });

  it('saisie illisible → NaN', () => {
    expect(parseEurosToCents('12,345')).toBeNaN();
    expect(parseEurosToCents('abc')).toBeNaN();
    expect(parseEurosToCents('-5')).toBeNaN();
  });

  it('affichage français', () => {
    expect(formatCentsForInput(125050).replace(/\s/g, ' ')).toBe('1 250,50');
    expect(formatCentsForInput(120000).replace(/\s/g, ' ')).toBe('1 200');
    expect(formatCentsForInput(0)).toBe('0');
  });

  it('interpretFieldInput : set, clear, invalid', () => {
    const money = findField('rental', 'depositCents')!;
    expect(interpretFieldInput(money, '0')).toEqual({ kind: 'set', value: 0 });
    expect(interpretFieldInput(money, '')).toEqual({ kind: 'clear' });
    expect(interpretFieldInput(money, '12,3,4').kind).toBe('invalid');
    const area = findField('rental', 'rentalAreaSqm')!;
    expect(interpretFieldInput(area, '67,4')).toEqual({ kind: 'set', value: 67.4 });
    const year = findField('rental', 'energyCostReferenceYear')!;
    expect(interpretFieldInput(year, '2025')).toEqual({ kind: 'set', value: 2025 });
    expect(interpretFieldInput(year, '25').kind).toBe('invalid');
    const date = findField('claim', 'occurredOn')!;
    expect(interpretFieldInput(date, '2026-08-03')).toEqual({ kind: 'set', value: '2026-08-03' });
    const text = findField('claim', 'circumstances')!;
    expect(interpretFieldInput(text, '   ')).toEqual({ kind: 'clear' });
    expect(toFieldInput(money, 115000).replace(/\s/g, ' ')).toBe('1 150');
    expect(toFieldInput(area, 67.4)).toBe('67,4');
  });
});
