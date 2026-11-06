/**
 * Lot 111U — CIL : vocabulaire des faits T1 (L111U-U-VOCAB), formule
 * d'avancement (L111U-U-PROGRESS), état commun (L111U-U-STATE) et
 * dérivation de la préparation (L111U-U-READINESS). Fonctions pures.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const { recognizeCilFact } = await import('@/lib/cil/cil-fact-vocabulary');
const { cilProgress, aggregateCilStatus, CIL_CATALOG, cilItemNotApplicableAllowed } = await import('@/lib/cil/cil-catalog');
const { evaluateCilState } = await import('@/services/cil/state/evaluate');
const { readinessFromCilInput } = await import('@/services/exports/cil-preparation.service');
import type { CilFactInput } from '@/lib/cil/cil-fact-vocabulary';
import type { CilStateInput } from '@/services/cil/state/evaluate';

const fact = (o: Partial<CilFactInput>): CilFactInput => ({
  id: 1, fileId: 10, factKey: 'k', subject: null, attribute: null, label: null, valueText: null, valueNumber: null, valueUnit: null,
  normalizedValue: null, confidence: 'certain', targetType: 'ASSET', targetEntityId: null, semanticEventNature: null, ...o,
});

describe('L111U-U-VOCAB — reconnaissance déterministe des faits persistés', () => {
  it('murs : épaisseur en cm convertie en mm, R, nature', () => {
    expect(recognizeCilFact(fact({ subject: 'Murs extérieurs', attribute: 'Épaisseur d’isolant', valueNumber: 10, valueUnit: 'cm' })))
      .toEqual({ kind: 'material', post: 'murs_exterieurs', attribute: 'thicknessMm', value: 100 });
    expect(recognizeCilFact(fact({ subject: 'Isolation des combles', attribute: 'Résistance thermique', valueNumber: 7, valueUnit: 'm².K/W' })))
      .toEqual({ kind: 'material', post: 'toiture', attribute: 'thermalResistanceR', value: 7 });
    expect(recognizeCilFact(fact({ subject: 'Plancher bas', attribute: 'Isolant', valueText: 'Polystyrène expansé' })))
      .toEqual({ kind: 'material', post: 'planchers_bas', attribute: 'materialNature', value: 'Polystyrène expansé' });
    expect(recognizeCilFact(fact({ subject: 'Plancher haut', attribute: 'Isolant', valueText: 'Laine soufflée' }))).toMatchObject({ post: 'toiture' });
    expect(recognizeCilFact(fact({ subject: 'Menuiseries', attribute: 'Type de vitrage', valueText: 'Double vitrage 4/16/4' }))).toMatchObject({ post: 'parois_vitrees', attribute: 'materialNature' });
  });

  it('clé brute sans sujet (« murs epaisseur ») et clé anglaise', () => {
    expect(recognizeCilFact(fact({ rawKey: 'murs_epaisseur', factKey: 'murs_epaisseur', valueNumber: 120, valueUnit: 'mm' }))).toMatchObject({ post: 'murs_exterieurs', attribute: 'thicknessMm', value: 120 });
    expect(recognizeCilFact(fact({ factKey: 'roofInsulationThickness', valueNumber: 30, valueUnit: 'cm' }))).toMatchObject({ post: 'toiture', attribute: 'thicknessMm', value: 300 });
  });

  it('systèmes : type, énergie, puissance (W → kW) ; heatingType canonique', () => {
    expect(recognizeCilFact(fact({ subject: 'Chauffage', attribute: 'Énergie', valueText: 'Gaz naturel' }))).toEqual({ kind: 'system', usage: 'chauffage', attribute: 'energy', value: 'Gaz naturel' });
    expect(recognizeCilFact(fact({ subject: 'Eau chaude sanitaire', attribute: 'Puissance', valueNumber: 2200, valueUnit: 'W' }))).toEqual({ kind: 'system', usage: 'ecs', attribute: 'powerKw', value: 2.2 });
    expect(recognizeCilFact(fact({ subject: 'Ventilation', attribute: 'Type', valueText: 'VMC simple flux hygroréglable' }))).toMatchObject({ usage: 'ventilation', attribute: 'type' });
    expect(recognizeCilFact(fact({ canonicalKey: 'heatingType', normalizedValue: 'Chaudière gaz à condensation' }))).toMatchObject({ usage: 'chauffage', attribute: 'type' });
    // Autre clé canonique : moteur T3 du registre, pas ce module.
    expect(recognizeCilFact(fact({ canonicalKey: 'dpeClass', subject: 'Chauffage', normalizedValue: 'D' }))).toBeNull();
  });

  it('recommandation / scénario / échéance : jamais une donnée constatée', () => {
    expect(recognizeCilFact(fact({ subject: 'Combles', attribute: 'Isolation recommandée', valueText: 'Laine soufflée 30 cm' }))).toEqual({ kind: 'recommendation', topic: 'toiture' });
    expect(recognizeCilFact(fact({ subject: 'Chauffage', attribute: 'Type', label: 'Scénario 2 — après travaux', valueText: 'PAC air/eau' }))).toMatchObject({ kind: 'recommendation' });
    expect(recognizeCilFact(fact({ subject: 'Murs', attribute: 'Isolant', valueText: 'ITE', semanticEventNature: 'DEADLINE' }))).toMatchObject({ kind: 'recommendation' });
    // « gaine » n'est pas le marqueur « gain ».
    expect(recognizeCilFact(fact({ subject: 'Ventilation', attribute: 'Type', label: 'Gaine isolée', valueText: 'VMC' }))).toMatchObject({ kind: 'system' });
  });

  it('cibles pièce / document / fournisseur et sujets hors vocabulaire : ignorés', () => {
    expect(recognizeCilFact(fact({ subject: 'Murs', attribute: 'Isolant', valueText: 'Laine', targetType: 'ROOM' }))).toBeNull();
    expect(recognizeCilFact(fact({ subject: 'Diagnostiqueur', attribute: 'Nom', valueText: 'X' }))).toBeNull();
    expect(recognizeCilFact(fact({ subject: 'Murs', attribute: 'Couleur' , valueText: 'blanc' }))).toBeNull();
  });
});

describe('L111U-U-PROGRESS — formule d’avancement', () => {
  it('N/A et « à confirmer » non comptés hors dénominateur ; partiel = ½', () => {
    expect(cilProgress([
      { status: 'renseigne', counted: true }, { status: 'partiel', counted: true }, { status: 'manquant', counted: true },
      { status: 'non_applicable', counted: false }, { status: 'a_confirmer', counted: false },
    ])).toMatchObject({ done: 1.5, applicable: 3, percentage: 50, nonApplicable: 1, aConfirmer: 1 });
    expect(cilProgress([])).toMatchObject({ percentage: 100, applicable: 0 });
  });
  it('agrégat de bloc', () => {
    expect(aggregateCilStatus(['renseigne', 'non_applicable'])).toBe('renseigne');
    expect(aggregateCilStatus(['non_applicable', 'non_applicable'])).toBe('non_applicable');
    expect(aggregateCilStatus(['manquant', 'a_confirmer'])).toBe('manquant');
    expect(aggregateCilStatus(['renseigne', 'manquant'])).toBe('partiel');
  });
  it('catalogue : identifiants uniques ; B1 et le DPE jamais déclarables non applicables', () => {
    expect(new Set(CIL_CATALOG.map((c) => c.id)).size).toBe(CIL_CATALOG.length);
    expect(cilItemNotApplicableAllowed('B8.dpeDocument')).toBe(false);
    expect(cilItemNotApplicableAllowed('B1.address')).toBe(false);
    expect(cilItemNotApplicableAllowed('B4.gaz')).toBe(true);
  });
});

const base = (o: Partial<CilStateInput> = {}): CilStateInput => ({
  asset: { id: 1, address: '1 rue A', postalCode: '69001', city: 'Lyon', subtype: 'Appartement' },
  fields: {}, fieldSources: {}, profile: null, resolutions: [], documents: [], materials: [], equipments: [], works: [], journal: [],
  now: '2026-11-05T10:00:00Z', ...o,
});
const dpe = { id: 50, title: 'DPE 2025', date: '2025-03-12', documentType: 'DIAGNOSTIC', documentTypeCode: 'DPE', retainedFunctionCode: null, cilRubricCodes: null, planState: null };
const itemOf = (s: ReturnType<typeof evaluateCilState>, id: string) => s.blocks.flatMap((b) => b.items).find((i) => i.id === id)!;

describe('L111U-U-STATE — état commun', () => {
  it('DPE seul (V2 documentTypeCode) : ligne DPE renseignée, le reste reste à compléter ; jamais « complet »', () => {
    const s = evaluateCilState(base({ documents: [dpe], fields: { dpeClass: { value: 'D', origin: 'RECONCILIATION' } }, fieldSources: { dpeClass: { fileId: 50, page: 1 } } }));
    expect(itemOf(s, 'B8.dpeDocument').status).toBe('renseigne');
    expect(itemOf(s, 'B8.dpeClass')).toMatchObject({ status: 'renseigne', values: [{ value: 'D', source: { kind: 'document', fileId: 50, page: 1 } }] });
    expect(itemOf(s, 'B8.gesClass').status).toBe('manquant');
    expect(itemOf(s, 'B5.toiture').status).toBe('manquant');
    expect(s.regulatory.percentage).toBeLessThan(100);
    expect(s.documents.map((d) => d.id)).toEqual([50]);
  });

  it('gaz : jamais « non applicable » déduit d’un chauffage électrique ; présence connue → attendu', () => {
    const elec = evaluateCilState(base({ fields: { mainEnergy: { value: 'Électricité', origin: 'USER' }, heatingType: { value: 'Convecteurs électriques', origin: 'USER' } } }));
    expect(itemOf(elec, 'B4.gaz')).toMatchObject({ status: 'a_confirmer', counted: false, notApplicable: null });
    const gaz = evaluateCilState(base({ equipments: [{ id: 3, name: 'Chaudière', type: 'Chaudière', category: null, energyUsage: null, energyType: 'gaz naturel', evacuationMode: null, heatNetworkDeliveryStation: null, brand: null, model: null, powerKw: null, fieldOrigins: {} }] }));
    expect(itemOf(gaz, 'B4.gaz')).toMatchObject({ status: 'manquant', counted: true });
    const decl = evaluateCilState(base({ resolutions: [{ blockId: 'B4.gaz', resolution: 'not_applicable', justification: 'Pas de gaz' }] }));
    expect(itemOf(decl, 'B4.gaz')).toMatchObject({ status: 'non_applicable', counted: false, notApplicable: { by: 'user', justification: 'Pas de gaz' } });
  });

  it('B6 : aucun équipement non énergétique (téléviseur) ; partiel si l’énergie manque', () => {
    const tv = { id: 4, name: 'TV salon', type: 'Téléviseur', category: null, energyUsage: null, energyType: null, evacuationMode: null, heatNetworkDeliveryStation: null, brand: null, model: null, powerKw: null, fieldOrigins: {} };
    const pac = { ...tv, id: 5, name: 'PAC', type: 'Pompe à chaleur air/eau' };
    const s = evaluateCilState(base({ equipments: [tv, pac] }));
    expect(s.energyEquipmentIds).toEqual([5]);
    expect(itemOf(s, 'B6.chauffage')).toMatchObject({ status: 'partiel', missing: ['Énergie utilisée : PAC'] });
    expect(itemOf(s, 'B6.refroidissement')).toMatchObject({ status: 'a_confirmer', counted: false });
  });

  it('B5 : matériau DOCUMENT avec source ouvrable ; conflit journalisé → à confirmer', () => {
    const s = evaluateCilState(base({
      documents: [dpe],
      materials: [{ id: 9, category: 'murs_exterieurs', materialNature: 'Laine de verre', brand: null, reference: null, thermalResistanceR: 2.5, lambda: null, thicknessMm: 100, surfaceSqm: null, origin: 'DOCUMENT', installationState: 'constate', sourceFileId: 50, documentId: 50 }],
      journal: [{ projectionKey: 'cil:mat:toiture', status: 'CONFLICT', reason: 'SAME_DATE_SOURCES_DIFFER', sourceFileIds: [50], targetId: null }],
    }));
    expect(itemOf(s, 'B5.murs_exterieurs')).toMatchObject({ status: 'renseigne', values: [{ source: { kind: 'document', fileId: 50 } }] });
    expect(itemOf(s, 'B5.murs_exterieurs').values[0].label).toMatch(/décrit par un diagnostic/);
    expect(itemOf(s, 'B5.toiture').status).toBe('a_confirmer');
  });

  it('B7 : une recommandation n’est pas un travail réalisé ; RE2020 non applicable par règle hors construction', () => {
    const s = evaluateCilState(base({
      profile: { triggerType: 'volontaire', triggerDate: null },
      journal: [{ projectionKey: 'cil:rec:50', status: 'RECOMMENDATION_ONLY', reason: 'NOT_REALIZED_WORKS', sourceFileIds: [50], targetId: null }],
    }));
    expect(itemOf(s, 'B7.works')).toMatchObject({ status: 'a_confirmer', values: [], counted: false });
    expect(itemOf(s, 'B7.works').reason).toMatch(/ne sont pas des travaux réalisés/);
    expect(s.recommendations).toEqual({ count: 1, sourceFileIds: [50] });
    expect(itemOf(s, 'B8.re2020')).toMatchObject({ status: 'non_applicable', notApplicable: { by: 'rule' } });
  });

  it('deux DPE : le plus récent fait foi, signalé', () => {
    const s = evaluateCilState(base({ documents: [dpe, { ...dpe, id: 51, title: 'DPE 2019', date: '2019-01-01' }] }));
    expect(itemOf(s, 'B8.dpeDocument').values.map((v) => v.value)).toEqual(['DPE 2025', 'DPE 2019']);
    expect(s.blocks.find((b) => b.id === 'B8')!.notice).toMatch(/2 DPE/);
  });
});

describe('L111U-U-READINESS — préparation dérivée du même état', () => {
  it('B8 complet par le DPE V2 ; N/A hors numérateur ; détail granulaire porté', () => {
    const r = readinessFromCilInput(base({ documents: [dpe], resolutions: [{ blockId: 'B4', resolution: 'not_applicable', justification: null }] }));
    expect(r.blocks.find((b) => b.id === 'B8')!.status).toBe('complete');
    expect(r.blocks.find((b) => b.id === 'B8')!.cilStatus).toBe('partiel');
    expect(r.blocks.find((b) => b.id === 'B8')!.cilMissing).toEqual(expect.arrayContaining(['Classe énergie']));
    expect(r.blocks.find((b) => b.id === 'B4')!.status).toBe('not_applicable');
    // 8 blocs, 1 non applicable : complets = B1, B8, B9 → 3 / 7.
    expect(r.completion).toMatchObject({ applicableBlocks: 7, percentage: 43 });
    expect(r.globalStatus).toBe('action_required'); // B3 sans plan reste bloquant (règle produit)
    expect(r.state?.version).toBe('cil-state-v1');
  });
  it('B6 : règle 75A conservée (déclaration neutralisée par un équipement énergétique)', () => {
    const pac = { id: 5, name: 'PAC', type: 'Pompe à chaleur', category: null, energyUsage: null, energyType: 'électricité', evacuationMode: null, heatNetworkDeliveryStation: null, brand: null, model: null, powerKw: null, fieldOrigins: {} };
    const r = readinessFromCilInput(base({ equipments: [pac], resolutions: [{ blockId: 'B6', resolution: 'not_applicable', justification: 'x' }] }));
    expect(r.blocks.find((b) => b.id === 'B6')).toMatchObject({ status: 'complete', neutralizedResolution: 'not_applicable' });
    expect(r.energyEquipmentIds).toEqual([5]);
  });
});
