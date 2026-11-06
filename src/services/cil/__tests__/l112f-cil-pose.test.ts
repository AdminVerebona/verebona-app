/**
 * Lot 112F — facture / attestation de travaux RÉALISÉS → B5 « posé » (date de
 * pose, performances prouvées) et B6 (équipement posé), rattachés à
 * l'Opération d'intervention prouvée (même identité que B7) ; déclenchement
 * du contrôle COH-CIL-DOCUMENT-PROJECTION par les écritures d'Opérations.
 *
 * L112F-U-INST     décision par Opération (union, ambigu, contradiction) ; faits d'une facture reconnus ; devis jamais posé.
 * L112F-U-STATE    état commun : « posé le … », date de pose manquante → partiel, contradiction → à confirmer, USER protégée.
 * L112F-U-TRIGGER  contrôle v3 déclenché par BUSINESS_OPERATION_CHANGED (relayé par le bus existant), sans nouvelle file.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const { recognizeCilFact } = await import('@/lib/cil/cil-fact-vocabulary');
const { evaluateCilState } = await import('@/services/cil/state/evaluate');
const { decideInstalled } = await import('@/services/cil/projection/document-projection');
const { cilDocumentProjectionCheck } = await import('@/services/coherence/registry/checks/cil-document-projection');
const { BUSINESS_OPERATION_CHANGED } = await import('@/services/coherence/events');
import type { CilFactInput } from '@/lib/cil/cil-fact-vocabulary';
import type { CilMaterialInput, CilStateInput } from '@/services/cil/state/evaluate';

const fact = (o: Partial<CilFactInput>): CilFactInput => ({
  id: 1, fileId: 10, factKey: 'k', subject: null, attribute: null, label: null, valueText: null, valueNumber: null, valueUnit: null,
  normalizedValue: null, confidence: 'certain', targetType: 'ASSET', targetEntityId: null, semanticEventNature: null, ...o,
});
const base = (o: Partial<CilStateInput> = {}): CilStateInput => ({
  asset: { id: 1, address: '1 rue A', postalCode: '69001', city: 'Lyon', subtype: 'Maison' },
  fields: {}, fieldSources: {}, profile: null, resolutions: [], documents: [], materials: [], equipments: [], works: [], journal: [],
  now: '2026-11-06T10:00:00Z', ...o,
});
const doc = (id: number, title: string, code: string, date = '2024-10-02') => ({ id, title, date, documentType: null, documentTypeCode: code, retainedFunctionCode: null, cilRubricCodes: null, planState: null });
const mat = (o: Partial<CilMaterialInput>): CilMaterialInput => ({
  id: 1, category: 'toiture', materialNature: 'Laine soufflée', brand: null, reference: null, thermalResistanceR: 7, lambda: null, thicknessMm: 300, surfaceSqm: null,
  origin: 'DOCUMENT', installationState: 'installe', sourceFileId: 40, documentId: 40, installedAt: '2024-10-02', operationId: 7, ...o,
});
const itemOf = (s: ReturnType<typeof evaluateCilState>, id: string) => s.blocks.flatMap((b) => b.items).find((i) => i.id === id)!;
const vals = (entries: Array<[string, Array<string | number>]>) => new Map(entries.map(([k, list]) => [k, list.map((value, i) => ({ value, factId: i + 1 }))]));

describe('L112F-U-INST — décision de pose par Opération', () => {
  it('faits d’une facture de travaux reconnus (poste, performances, équipement posé)', () => {
    expect(recognizeCilFact(fact({ subject: 'Isolation des combles perdus', attribute: 'Isolant', valueText: 'Laine soufflée' }))).toEqual({ kind: 'material', post: 'toiture', attribute: 'materialNature', value: 'Laine soufflée' });
    expect(recognizeCilFact(fact({ subject: 'Combles perdus', attribute: 'Épaisseur', valueNumber: 30, valueUnit: 'cm' }))).toMatchObject({ attribute: 'thicknessMm', value: 300 });
    expect(recognizeCilFact(fact({ subject: 'Pompe à chaleur air/eau', attribute: 'Marque', valueText: 'Atlantic' }))).toEqual({ kind: 'system', usage: 'chauffage', attribute: 'brand', value: 'Atlantic' });
    // Une ligne de devis / un projet n'est jamais une pose.
    expect(recognizeCilFact(fact({ subject: 'Combles perdus', attribute: 'Isolant', label: 'Devis', valueText: 'Laine soufflée' }))).toMatchObject({ kind: 'recommendation' });
  });
  it('facture + attestation concordantes : union des attributs, pièces citées', () => {
    const d = decideInstalled(new Map([[40, vals([['materialNature', ['Laine soufflée']], ['thermalResistanceR', [7]]])], [41, vals([['thicknessMm', [300]], ['thermalResistanceR', [7.02]]])]]));
    expect(d).toMatchObject({ status: 'OK', picked: { materialNature: 'Laine soufflée', thermalResistanceR: 7, thicknessMm: 300 }, fileIds: [40, 41] });
  });
  it('pièces divergentes → CONFLICT ; deux valeurs dans une pièce → AMBIGUOUS ; aucune → null', () => {
    expect(decideInstalled(new Map([[40, vals([['thermalResistanceR', [7]]])], [41, vals([['thermalResistanceR', [5]]])]]))).toEqual({ status: 'CONFLICT', fileIds: [40, 41] });
    expect(decideInstalled(new Map([[40, vals([['materialNature', ['Laine de verre', 'Ouate']]])]]))).toEqual({ status: 'AMBIGUOUS', fileIds: [40] });
    expect(decideInstalled(new Map())).toBeNull();
  });
});

describe('L112F-U-STATE — état commun B5 / B6', () => {
  const facture = doc(40, 'Facture isolation', 'WORKS_INVOICE');
  it('matériau posé : renseigné, « posé le … », source = facture ; avant le constat d’un diagnostic', () => {
    const s = evaluateCilState(base({ documents: [facture, doc(50, 'DPE', 'DPE', '2020-01-01')], materials: [
      mat({ id: 2, materialNature: 'Laine de verre', thermalResistanceR: 2, thicknessMm: 80, installationState: 'constate', sourceFileId: 50, documentId: 50, installedAt: null, operationId: null }),
      mat({}),
    ] }));
    const it = itemOf(s, 'B5.toiture');
    expect(it.status).toBe('renseigne');
    expect(it.values[0]).toMatchObject({ label: 'Laine soufflée (posé le 2 octobre 2024)', source: { kind: 'document', fileId: 40 } });
    expect(it.values[1].label).toContain('(décrit par un diagnostic)');
  });
  it('attestation sans date : partiel, seule la date de pose manque', () => {
    const it = itemOf(evaluateCilState(base({ documents: [facture], materials: [mat({ installedAt: null })] })), 'B5.toiture');
    expect(it).toMatchObject({ status: 'partiel', missing: ['Toiture / combles : date de pose'] });
    expect(it.values[0].label).toContain('date de pose à compléter');
  });
  it('justificatifs contradictoires : à confirmer (avec ou sans valeur déjà prouvée)', () => {
    const journal = [{ projectionKey: 'cil:inst:7:toiture', status: 'CONFLICT', reason: 'PROOF_DOCUMENTS_DIFFER', sourceFileIds: [40, 41], targetId: null }];
    expect(itemOf(evaluateCilState(base({ documents: [facture], journal })), 'B5.toiture').status).toBe('a_confirmer');
    expect(itemOf(evaluateCilState(base({ documents: [facture], journal, materials: [mat({})] })), 'B5.toiture').status).toBe('a_confirmer');
  });
  it('saisie USER divergente conservée, signalée', () => {
    const s = evaluateCilState(base({ materials: [mat({ origin: 'USER', installationState: null, installedAt: null, operationId: null, sourceFileId: null, documentId: null, materialNature: 'Ouate' })],
      journal: [{ projectionKey: 'cil:inst:7:toiture', status: 'PROTECTED', reason: 'USER_VALUE_DIFFERS', sourceFileIds: [40], targetId: 1 }] }));
    expect(itemOf(s, 'B5.toiture').reason).toMatch(/votre saisie est conservée/);
  });
  it('équipement posé : « posé le … », source = facture ; sans date → partiel ; remplacement non prouvé → à confirmer', () => {
    const pac = { id: 9, name: 'Pompe à chaleur air/eau', type: 'Pompe à chaleur air/eau', category: 'chauffage', energyUsage: null, brand: 'Atlantic', model: 'Alfea', energyType: 'Électricité',
      evacuationMode: null, heatNetworkDeliveryStation: null, powerKw: 8, fieldOrigins: { energy_type: 'WORKS', installed_at: 'WORKS' }, installedAt: '2024-10-02', installationOperationId: 7 };
    const ok = [{ projectionKey: 'cil:insteq:7:chauffage', status: 'WRITTEN', reason: 'CREATED_FROM_WORKS', sourceFileIds: [40], targetId: 9 }];
    const s = itemOf(evaluateCilState(base({ documents: [facture], equipments: [pac], journal: ok })), 'B6.chauffage');
    expect(s).toMatchObject({ status: 'renseigne', values: [{ label: 'Pompe à chaleur air/eau', source: { kind: 'document', fileId: 40 } }] });
    expect(s.values[0].value).toContain('posé le 2 octobre 2024');
    expect(itemOf(evaluateCilState(base({ documents: [facture], equipments: [{ ...pac, installedAt: null }], journal: ok })), 'B6.chauffage'))
      .toMatchObject({ status: 'partiel', missing: ['Date de pose : Pompe à chaleur air/eau'] });
    const doute = [{ projectionKey: 'cil:insteq:7:chauffage', status: 'AMBIGUOUS', reason: 'EXISTING_EQUIPMENT_FOR_USAGE', sourceFileIds: [40], targetId: null }];
    const chaudiere = { ...pac, id: 3, name: 'Chaudière gaz', type: 'Chaudière gaz', brand: null, model: null, energyType: 'Gaz', fieldOrigins: {}, installedAt: null, installationOperationId: null };
    const a = itemOf(evaluateCilState(base({ documents: [facture], equipments: [chaudiere], journal: doute })), 'B6.chauffage');
    expect(a.status).toBe('a_confirmer');
    expect(a.reason).toMatch(/remplace/);
  });
});

describe('L112F-U-TRIGGER — déclenchement depuis la consolidation des Opérations', () => {
  it('contrôle v3, déclenché par BUSINESS_OPERATION_CHANGED (bus des Opérations relayé, après commit)', () => {
    expect(cilDocumentProjectionCheck.version).toBe(3);
    expect(cilDocumentProjectionCheck.triggers).toContain(BUSINESS_OPERATION_CHANGED);
    expect(cilDocumentProjectionCheck.sources).toContain('business_operation_asset_links');
    expect(cilDocumentProjectionCheck.forbiddenRepairs.join(' ')).toMatch(/posé.*devis/);
  });
  it('aucune nouvelle file ni cron : la projection ne s’abonne à rien, le relais existant suffit', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/cil/projection/document-projection.ts'), 'utf8');
    expect(src).not.toMatch(/subscribeBusinessOperationEvents|registerT3JobKind|enqueue|setInterval|cron/i);
    const relais = readFileSync(join(process.cwd(), 'src/services/coherence/events.ts'), 'utf8');
    expect(relais).toMatch(/subscribeBusinessOperationEvents\('coherence-targeted'/);
    // Aucune écriture energy_works par la projection (décision PO du 06/11).
    expect(src).not.toMatch(/(INSERT INTO|UPDATE)\s+energy_works/i);
  });
});
