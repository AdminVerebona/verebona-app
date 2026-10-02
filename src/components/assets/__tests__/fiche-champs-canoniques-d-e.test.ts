/**
 * CDC 15, décision D-E (lot 20) — champs canoniques du registre exposés sur
 * la fiche bien, avec les composants existants (`AssetDetailSection`).
 *
 * Pour chaque champ : défini dans la section de la famille où il a du sens
 * (onglet), lu par la route GET /details dans la même section (sinon le
 * formulaire ne le renverrait pas), et canonique pour cette famille — la
 * route PATCH /details/[section] l'écrit alors par la primitive canonique
 * avec l'origine USER, comme ses voisins (`canonicalWritesOf`).
 *
 * Lecture des sources (comme `registry-consistency`) : fins de ligne
 * normalisées pour Windows (CRLF).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getField, type AssetFamily } from '@/services/canonical/registry';

// Le service d'écriture importe la base : aucune requête n'est faite ici.
vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
const { canonicalWritesOf } = await import('@/services/asset-details-write.service');

const ROOT = resolve(__dirname, '../../../..');
const src = (...p: string[]) => readFileSync(resolve(ROOT, 'src', ...p), 'utf8').replace(/\r\n?/g, '\n');

const TAB = src('components', 'assets', 'AssetDetailsTab.tsx').split('const SECTION_LABELS')[0];
const ROUTE = src('app', 'api', 'assets', '[id]', 'details', 'route.ts');

/** Section de l'onglet → famille du registre. */
const FAMILLE: Record<string, AssetFamily> = {
  performance_technical: 'IMMOBILIER', physical_characteristics: 'IMMOBILIER', valuation: 'IMMOBILIER',
  vehicle_identification: 'VEHICULE', vehicle_technical: 'VEHICULE', vehicle_usage: 'VEHICULE', vehicle_insurance: 'VEHICULE',
  object_provenance: 'OBJECT', object_usage: 'OBJECT',
};

const ATTENDUS: Array<[section: string, key: string, type: 'date' | 'number' | 'text']> = [
  ['performance_technical', 'dpeExpiryDate', 'date'],
  ['performance_technical', 'dpeAdemeNumber', 'text'],
  ['performance_technical', 'energyConsumption', 'number'],
  ['performance_technical', 'lastRevision', 'date'],
  ['performance_technical', 'maintenanceDueDate', 'date'],
  ['vehicle_identification', 'registrationExpiry', 'date'],
  ['vehicle_technical', 'engineDisplacement', 'number'],
  ['vehicle_usage', 'lastRevision', 'date'],
  ['vehicle_usage', 'maintenanceDueDate', 'date'],
  ['vehicle_usage', 'contractNumber', 'text'],
  ['vehicle_usage', 'contractStartDate', 'date'],
  ['vehicle_usage', 'leaseDurationMonths', 'number'],
  ['vehicle_usage', 'leaseMonthlyPayment', 'number'],
  ['vehicle_usage', 'leaseResidualValue', 'number'],
  ['vehicle_insurance', 'lastInspectionDate', 'date'],
  ['object_provenance', 'warrantyStartDate', 'date'],
  ['object_usage', 'maintenanceDueDate', 'date'],
  // D-D (lot 20) : nouvelles clés du registre, saisissables.
  ['physical_characteristics', 'carrezArea', 'number'],
  ['physical_characteristics', 'listedArea', 'number'],
  ['physical_characteristics', 'parking', 'text'],
  ['valuation', 'listingPrice', 'number'],
];

function blocOnglet(section: string): string {
  const m = new RegExp(`\\n\\s+${section}: \\[([\\s\\S]*?)\\n\\s+\\],`).exec(TAB);
  expect(m, section).not.toBeNull();
  return m![1];
}

function blocRoute(section: string): string {
  const m = new RegExp(`sections\\.${section} = \\{([\\s\\S]*?)\\n\\s+\\};`).exec(ROUTE);
  expect(m, section).not.toBeNull();
  return m![1];
}

describe('D-E — champs canoniques affichés et modifiables sur la fiche', () => {
  it('les 13 champs + lastRevision hors objets sont tous exposés', () => {
    const cles = new Set(ATTENDUS.map(([, k]) => k));
    for (const k of ['maintenanceDueDate', 'lastInspectionDate', 'dpeExpiryDate', 'energyConsumption', 'dpeAdemeNumber', 'engineDisplacement',
      'leaseMonthlyPayment', 'leaseDurationMonths', 'leaseResidualValue', 'contractNumber', 'contractStartDate', 'warrantyStartDate', 'registrationExpiry', 'lastRevision']) {
      expect(cles.has(k), k).toBe(true);
    }
  });

  it.each(ATTENDUS)('%s · %s : onglet, route de lecture, registre', (section, key, type) => {
    const ligne = new RegExp(`\\{ key: '${key}', label: '[^\\n]*`).exec(blocOnglet(section))?.[0];
    expect(ligne, `${section}.${key} absent de l'onglet`).toBeDefined();
    if (type === 'text') expect(ligne).not.toMatch(/type: '/);
    else expect(ligne).toContain(`type: '${type}'`);
    expect(blocRoute(section)).toMatch(new RegExp(`\\b${key}: kc\\.${key} \\?\\? null,`));
    const def = getField(key);
    expect(def?.key, key).toBe(key);
    expect(def!.families).toContain(FAMILLE[section]);
    // Chemin PATCH /details/[section] : écriture canonique (origine USER).
    expect(canonicalWritesOf({ [key]: '2026-01-01' }, FAMILLE[section]).map((w) => w.key)).toEqual([key]);
  });

  it('unités et montants au format des champs voisins (libellé porteur de l’unité)', () => {
    expect(blocOnglet('performance_technical')).toContain("label: 'Consommation énergétique (kWh/m²/an)'");
    expect(blocOnglet('vehicle_technical')).toContain("label: 'Cylindrée (cm³)'");
    // `formatValue` formate en euros les nombres dont le libellé porte « € ».
    expect(blocOnglet('vehicle_usage')).toMatch(/key: 'leaseMonthlyPayment', label: '[^']*\(€\)'/);
    expect(blocOnglet('vehicle_usage')).toMatch(/key: 'leaseResidualValue', label: '[^']*\(€\)'/);
    expect(blocOnglet('vehicle_usage')).toContain("label: 'Durée du contrat (mois)'");
    expect(blocOnglet('physical_characteristics')).toContain("label: 'Surface Carrez (m²)'");
    expect(blocOnglet('valuation')).toContain("label: 'Prix annoncé (€)'");
  });

  it('contrat de véhicule : sans objet selon le statut de détention (schéma existant notApplicableWhen)', () => {
    const usage = blocOnglet('vehicle_usage');
    for (const k of ['contractNumber', 'contractStartDate', 'leaseDurationMonths', 'leaseMonthlyPayment', 'leaseResidualValue']) {
      expect(usage).toMatch(new RegExp(`key: '${k}'[^}]*notApplicableWhen: vehicleContractNa\\(`));
    }
  });
});
