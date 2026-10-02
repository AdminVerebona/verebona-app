/**
 * CDC 15, décision D-N (lot 20) — champs d'équipement dans les PDF V12.
 *
 *  · les champs renseignés de la fiche canonique d'un équipement (puissance,
 *    entretien, garantie, et tout champ ajouté au registre : COP, fluide…)
 *    s'impriment dans le tableau d'équipement EXISTANT (CIL, bloc B6), sous
 *    le nom, au format français (dates, nombres + unité) ;
 *  · jamais de montant ni de doublon des colonnes (marque, modèle) ;
 *  · le numéro de série n'apparaît QUE dans les dossiers CIL et assurance,
 *    masqué comme dans le design ;
 *  · toute valeur saisie est échappée (aucune balise injectée).
 */
import { describe, it, expect } from 'vitest';
import { mapDossierData } from '../data/mappers';
import { buildDefaultChoices, planSelection } from '../data/choices';
import { renderDossierHtml } from '../templates';
import { equipmentFieldValue, equipmentSpecs, energyConsumptionLabel, serialNumberAllowed } from '../data/mappers/common';
import type { ExportSource, SourceEquipment, SourceEquipmentField } from '../data/source';
import type { CilData } from '../types';
import { getField } from '@/services/canonical/registry';
import type { DossierCode } from '@/services/exports/catalog';
import { makeSource, TODAY } from './fixtures/sources';

const META = { reference: 'VBN-TEST-000002', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: null, templateLabel: 'test · v1.0', zipName: null, label: 'Test' };

const champ = (key: string, label: string, value: unknown): SourceEquipmentField => ({ key, label, value, origin: 'USER', evidence: null });

function chaudiere(fields: SourceEquipmentField[]): SourceEquipment {
  return { id: 7, name: 'Chaudière gaz', type: 'CHAUFFAGE', category: 'chauffage', brand: 'Viessmann', model: 'Vitodens 100', energyType: 'GAZ', fields };
}

const CHAMPS = [
  champ('serialNumber', 'Numéro de série', 'VTD100-2023-0004871'),
  champ('powerKw', 'Puissance réelle', 24.5),
  champ('lastRevision', 'Dernier entretien', '2025-10-12'),
  champ('maintenanceDueDate', 'Prochain entretien', '2026-10-12'),
  champ('warrantyEndDate', 'Fin de garantie', '2028-03-01'),
  champ('acquisitionPrice', 'Prix d’achat', 3890),
  champ('brand', 'Marque', 'Viessmann'),
  // Clé hors registre : lue comme texte (aucun format inventé).
  champ('noteTechniqueLibre', 'Note technique', 'R32'),
];

function cilSource(equipments: SourceEquipment[], over: Partial<ExportSource> = {}): ExportSource {
  return makeSource('IMMOBILIER', 'CIL', {
    equipments,
    cil: {
      readiness: { globalStatus: 'ready', completion: { resolvedBlocks: 1, applicableBlocks: 8, totalBlocks: 8, percentage: 12 }, blockingBlocks: [],
        blocks: ['B1', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].map((id) => ({ id, label: id, status: id === 'B6' ? 'complete' as const : 'unknown' as const, blocking: false, missingItems: [] })) },
      profile: null, materials: [], works: [], resolutions: [],
    },
    ...over,
  });
}

function render(code: DossierCode, source: ExportSource) {
  const plan = planSelection(code, source, buildDefaultChoices(code, source, { today: TODAY }), TODAY);
  const data = mapDossierData(code, { source, plan, resolved: null, meta: META, today: TODAY });
  const html = renderDossierHtml(code, data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
  const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
  return { data, html, text };
}

describe('D-N — champs de la fiche équipement dans le tableau B6 du CIL', () => {
  it('caractéristiques sous le nom, ordre du registre, formats français', () => {
    const { data, text } = render('CIL', cilSource([chaudiere(CHAMPS)]));
    const row = (data as CilData).cil.equipments![0];
    expect(row.equipment).toBe('Chaudière gaz');
    expect(row.model).toBe('Viessmann · Vitodens 100');
    expect(row.specs).toBe([
      'Énergie : Gaz',
      'Dernier entretien : 12/10/2025',
      'Prochain entretien : 12/10/2026',
      'Fin de garantie : 01/03/2028',
      'Puissance réelle : 24,5 kW',
      'Numéro de série : VTD100-2023-•••871',
      'Note technique : R32',
    ].join(' · '));
    expect(text).toContain('Puissance réelle : 24,5 kW');
    expect(text).toContain('Note technique : R32');
  });

  it('jamais de montant, de doublon marque / modèle, ni de numéro de série en clair', () => {
    const { text, data } = render('CIL', cilSource([chaudiere(CHAMPS)]));
    const specs = (data as CilData).cil.equipments![0].specs!;
    expect(specs).not.toMatch(/Prix|3 890|3890|€/);
    expect(specs).not.toContain('Marque');
    expect(text).not.toContain('VTD100-2023-0004871');
    expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
  });

  it('équipement sans fiche canonique ni énergie : cellule inchangée (nom seul)', () => {
    const { data, html } = render('CIL', cilSource([{ ...chaudiere([]), energyType: null }]));
    expect((data as CilData).cil.equipments![0].specs).toBeNull();
    expect(html).not.toContain('<span class="cell-t">Chaudière gaz</span>');
    expect(html).toContain('Chaudière gaz');
  });

  it('valeurs saisies échappées (nom, libellé, valeur)', () => {
    const piege = '<img src=x onerror=alert(1)>';
    const { html } = render('CIL', cilSource([{ ...chaudiere([champ('noteTechniqueLibre', `Note ${piege}`, `R32 ${piege}`)]), name: `PAC ${piege}` }]));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('D-N — numéro de série seulement dans les dossiers CIL et assurance', () => {
  it('règle par dossier', () => {
    for (const code of ['CIL', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE'] as const) expect(serialNumberAllowed({ exportType: code })).toBe(true);
    for (const code of ['DOSSIER_COMPLET', 'VENTE', 'LOCATION'] as const) expect(serialNumberAllowed({ exportType: code })).toBe(false);
  });

  it('caractéristiques d’équipement hors CIL / assurance : sans numéro de série', () => {
    const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { equipments: [chaudiere(CHAMPS)] });
    const specs = equipmentSpecs(src, src.equipments[0])!;
    expect(specs).toContain('Puissance réelle : 24,5 kW');
    expect(specs).not.toContain('Numéro de série');
  });

  it('objet : ligne « Numéro de série » retirée du dossier complet et de la vente, gardée en assurance', () => {
    for (const code of ['DOSSIER_COMPLET', 'VENTE'] as const) {
      const { text } = render(code, makeSource('OBJET', code));
      expect(text, code).not.toContain('Numéro de série');
      expect(text, code).not.toContain('FW-SS58');
    }
    expect(render('ASSURANCE_SOUSCRIPTION', makeSource('OBJET', 'ASSURANCE_SOUSCRIPTION')).text).toContain('FW-SS58-H-25•••318');
  });
});

describe('Formats des champs (registre)', () => {
  it('date, nombre + unité, montant écarté, valeur structurée écartée', () => {
    expect(equipmentFieldValue('lastRevision', '2025-10-12')).toBe('12/10/2025');
    expect(equipmentFieldValue('engineDisplacement', 1598)).toBe('1\u00a0598 cm³');
    expect(equipmentFieldValue('energyConsumption', 142)).toBe('142 kWh/m²/an');
    expect(equipmentFieldValue('acquisitionPrice', 1200)).toBeNull();
    expect(equipmentFieldValue('powerKw', { v: 1 })).toBeNull();
    expect(equipmentFieldValue('powerKw', '')).toBeNull();
  });

  // Champs d'équipement ajoutés au registre au lot 20 (COP, fluide, compteur
  // horaire) : formatés dès qu'ils y figurent, sans code propre à chacun.
  it.skipIf(!getField('cop') || !getField('hourMeter') || !getField('refrigerant'))('COP, compteur horaire, fluide frigorigène (registre)', () => {
    expect(equipmentFieldValue('cop', 4.2)).toBe('4,2');
    expect(equipmentFieldValue('hourMeter', 1250)).toBe('1\u00a0250 h');
    expect(equipmentFieldValue('refrigerant', 'R32')).toBe('R32');
  });

  it('CIL : consommation au format du design et fin de validité du DPE (clé canonique)', () => {
    const base = cilSource([]);
    const src = { ...base, asset: { ...base.asset, characteristics: { ...base.asset.characteristics, energyConsumption: 142, dpeExpiryDate: '2034-03-11' } } };
    expect(energyConsumptionLabel(src)).toBe('142 kWh/m²/an');
    const { data, text } = render('CIL', src);
    expect((data as CilData).cil.energy?.validUntil).toBe('2034-03-11');
    expect(text).toContain('142 kWh/m²/an');
    expect(text).toContain('11/03/2034');
  });
});
