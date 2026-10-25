/**
 * Lot 89B — fiche d'un bien (onglet « Informations », desktop et mobile : même
 * composant) : chaque champ lu par l'écran doit être lu dans la section qui le
 * RENVOIE (`GET /api/assets/[id]/details`, `buildSections`).
 *
 *   L89B-DS01  « Valeur estimée » : renvoyée dans « Valorisation », plus dans « common » (affichée vide avant)
 *   L89B-DS02  générique, toutes familles : verdict du diagnostic global 88A (`apiUiMatch` + `propertyVerdict`)
 *              — aucun champ « renvoyé dans une section mais lu dans une autre », aucun champ lu mais jamais renvoyé
 *   L89B-DS03  une seule section porteuse par champ de valeur ; écriture de la section « valuation » acceptée
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSections } from '@/services/assets/details-sections';
import { CANONICAL_FIELDS } from '@/services/canonical/registry/fields';
import { apiUiMatch, propertyVerdict } from '@/services/admin/diagnostics-export/properties';
import {
  DETAILS_UI_COMMON_FIELDS, DETAILS_UI_SECTION_FIELDS, detailsUiFields, type DetailsUiFamily,
} from '@/lib/assets/details-ui-map';

const FAMILLES: DetailsUiFamily[] = ['IMMOBILIER', 'VEHICULE', 'OBJET'];

/** Toutes les clés connues de l'écran, remplies (valeur non vide distincte par clé). */
function ficheComplete(): Record<string, unknown> {
  const kc: Record<string, unknown> = {};
  const keys = new Set<string>([
    ...Object.values(DETAILS_UI_COMMON_FIELDS).flat().map((f) => f.key),
    ...Object.values(DETAILS_UI_SECTION_FIELDS).flat().map((f) => f.key),
    'estimatedValueCurrency', 'estimatedValueDate', 'estimatedValueMode', 'valuationLow', 'valuationHigh',
  ]);
  for (const k of keys) kc[k] = `v:${k}`;
  kc.estimatedValue = 400000;
  return kc;
}
const sectionsDe = (fam: DetailsUiFamily) =>
  JSON.parse(JSON.stringify(buildSections(fam, ficheComplete(), { name: 'Bien' }))) as Record<string, Record<string, unknown>>;

describe('L89B-DS01 — valeur estimée', () => {
  for (const fam of FAMILLES) {
    it(`${fam} : renvoyée dans « Valorisation » et lue par le champ « Valeur estimée (€) » de cette section`, () => {
      const s = sectionsDe(fam);
      expect(s.valuation.estimatedValue).toBe(400000);
      expect('estimatedValue' in s.common).toBe(false);
      const m = apiUiMatch(s, fam, 'estimatedValue');
      expect(m.section).toBe('valuation');
      expect(m.uiConsumed).toBe(true);
      expect(m.consumers.map((c) => [c.section, c.label])).toEqual([['valuation', 'Valeur estimée (€)']]);
    });
  }
});

describe('L89B-DS02 — générique : aucun écart section renvoyée / section lue (verdict 88A)', () => {
  for (const fam of FAMILLES) {
    it(`${fam} : chaque champ affiché reçoit sa valeur ; aucun « RENVOYE_NON_AFFICHE » par écart de section`, () => {
      const s = sectionsDe(fam);
      const champs = new Set<string>();
      for (const [section, data] of Object.entries(s)) {
        for (const f of detailsUiFields(fam, section)) champs.add(f.key);
        for (const k of Object.keys(data)) champs.add(k);
      }
      const ecarts: string[] = [];
      for (const champ of champs) {
        const m = apiUiMatch(s, fam, champ);
        if (!m.uiExpects) continue; // renvoyé mais non affiché par conception (ex. bornes de valorisation)
        const verdict = propertyVerdict({ persisted: 'x', apiStatus: 200, apiSent: m.apiSent, apiValue: m.apiValue, uiExpects: m.uiExpects, uiConsumed: m.uiConsumed });
        if (verdict === 'RENVOYE_NON_AFFICHE' || verdict === 'ATTENDU_PAR_ECRAN_NON_RENVOYE') {
          ecarts.push(`${champ} : ${verdict} (renvoyé dans ${m.section ?? '—'}, lu dans ${m.consumers.map((c) => c.section).join(', ')})`);
        }
      }
      expect(ecarts).toEqual([]);
      // Et, section par section : chaque champ défini pour une section renvoyée est bien présent dans SA donnée.
      for (const [section, data] of Object.entries(s)) {
        for (const f of detailsUiFields(fam, section)) expect(f.key in data, `${fam} › ${section} › ${f.key}`).toBe(true);
      }
    });
  }
});

describe('L89B-DS03 — une seule section porteuse', () => {
  for (const fam of FAMILLES) {
    it(`${fam} : valeur estimée et date de valorisation renvoyées par « Valorisation » seulement (registre canonique)`, () => {
      const s = sectionsDe(fam);
      for (const k of ['estimatedValue', 'valuationDate']) {
        const porteuses = Object.entries(s).filter(([, d]) => k in d).map(([n]) => n);
        expect(porteuses, `${fam} › ${k}`).toEqual(['valuation']);
        expect(CANONICAL_FIELDS.find((f) => f.key === k)?.section).toBe('valuation');
      }
      // Devise / date / mode de la valeur : section « common » du registre, inchangée (non affichés).
      expect(s.common).toMatchObject({ estimatedValueCurrency: 'v:estimatedValueCurrency', estimatedValueDate: 'v:estimatedValueDate', estimatedValueMode: 'v:estimatedValueMode' });
    });
  }
  it('fiche vide : valeur estimée nulle dans « Valorisation », devise EUR par défaut conservée', () => {
    const s = buildSections('IMMOBILIER', {}, { name: 'Maison' }) as Record<string, Record<string, unknown>>;
    expect(s.valuation).toMatchObject({ estimatedValue: null, valuationDate: null });
    expect(s.common.estimatedValueCurrency).toBe('EUR');
  });
  it('écriture : la section « valuation » porte la valeur estimée (validateur de champs), section applicable aux trois familles', () => {
    const validateur = readFileSync(resolve(__dirname, '..', '..', '..', 'lib', 'field-validator.ts'), 'utf8');
    expect(validateur).toMatch(/valuation:\s*\[[^\]]*'estimatedValue'/);
    const ecriture = readFileSync(resolve(__dirname, '..', '..', 'asset-details-write.service.ts'), 'utf8');
    for (const fam of ['IMMOBILIER', 'VEHICULE', 'OBJET']) expect(ecriture).toMatch(new RegExp(`const ${fam}_SECTIONS = \\[[^\\]]*'valuation'`));
  });
});
