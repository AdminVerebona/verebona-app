/**
 * Lot 54A — réexamen réel des « À traiter » ouverts : règles pures
 * (Candidate Builder élément LINK-ELT, mode d'évaluation, contrat de
 * périmètre « passage global du compte »).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as elementLink from '../document-element-link';
import { matchDocumentToEquipments, type EquipmentProfile } from '@/services/equipment/document-equipment-matching';
import { classifyEvaluation, EVALUATION_MODES } from '../open-actions.service';

const eq = (id: number, name: string, over: Partial<EquipmentProfile> = {}): EquipmentProfile => ({
  id, name, assetId: 1, assetName: null, type: null, category: null, brand: null, model: null, serialNumber: null, room: null, features: [], ...over,
});
const doc = (title: string, sourceTexts: string[] = []) => ({
  fileId: 1, title, typeCode: null, description: null, supplier: null, documentDate: null, amountCents: null,
  assetIds: [1], assetNames: [''], facts: [], sourceTexts,
});

// Lot 75G (écart C) : le Candidate Builder élément est remplacé par les règles
// communes (`document-equipment-matching`) ; mêmes cas, règles unifiées.
describe('T3-OPEN-E02 / RDE-C — LINK-ELT : règles communes', () => {
  it('plus de moteur parallèle : le module n’exporte plus le Candidate Builder ni la décision par type', () => {
    expect(Object.keys(elementLink)).toEqual(['resolveDocumentElementLink']);
  });
  it('n° de série lu dans les données persistées (unité source) → équipement unique', () => {
    const r = matchDocumentToEquipments(doc('Facture', ['N° série : PAC 778899']), [eq(1, 'Chaudière'), eq(2, 'Pompe à chaleur', { serialNumber: 'PAC-778899' })]);
    expect(r.links.map((l) => [l.equipmentId, l.method])).toEqual([[2, 'SERIAL_NUMBER']]);
  });
  it('nom dans le titre → rattaché ; deux équipements désignés distinctement → deux liens (document multi-équipements)', () => {
    expect(matchDocumentToEquipments(doc('Entretien Vitodens 200'), [eq(1, 'Vitodens 200'), eq(2, 'Radiateur')]).links.map((l) => l.equipmentId)).toEqual([1]);
    expect(matchDocumentToEquipments(doc('Radiateur salon et radiateur chambre'), [eq(1, 'Radiateur salon'), eq(2, 'Radiateur chambre')]).links.map((l) => l.equipmentId)).toEqual([1, 2]);
  });
  it('type seul dans le titre : jamais candidat (ancienne règle TYPE_MATCH supprimée)', () => {
    expect(matchDocumentToEquipments(doc('Facture chaudière murale'), [eq(1, 'Appareil cuisine', { type: 'chaudière murale' })]).status).toBe('NONE');
  });
  it('aucune correspondance → aucun candidat (la carte reste ouverte)', () => {
    expect(matchDocumentToEquipments(doc('Assurance habitation'), [eq(1, 'Tondeuse')]).status).toBe('NONE');
  });
});

describe('T3-OPEN-E04 — examined ≠ resolutionAttempted', () => {
  it('modes définis ; un constat n’est jamais une résolution', () => {
    expect(EVALUATION_MODES).toEqual(['FULL_REEVALUATION', 'DETERMINISTIC_REEVALUATION', 'AI_REEVALUATION', 'OBSOLESCENCE_ONLY', 'NOT_T3', 'SUPERSEDED', 'ERROR']);
    const base = { actionId: 1, ruleCode: 'X', targetType: 'ASSET', targetId: 1, previousResolution: null, resolver: 'T3_ASSET', candidateCount: null, deterministicAttempted: false, aiCalled: false, newResolution: null };
    expect(classifyEvaluation({ ...base, actionEffect: 'STILL_OPEN' })).toEqual({ evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
    expect(classifyEvaluation({ ...base, actionEffect: 'SKIPPED_NOT_T3' })).toEqual({ evaluationMode: 'NOT_T3', resolutionAttempted: false });
    expect(classifyEvaluation({ ...base, actionEffect: 'STILL_OPEN', aiCalled: true })).toEqual({ evaluationMode: 'AI_REEVALUATION', resolutionAttempted: true });
  });
});

describe('T3-OPEN-E05 — contrat : seul le passage GLOBAL du compte réexamine tous les « À traiter »', () => {
  it('la phase n’est appelée que par reconcileAccount (aucun sous-job spécialisé)', () => {
    const racine = join(process.cwd(), 'src/services/ai/reconciliation');
    const compte = readFileSync(join(racine, 'account-reconciliation.service.ts'), 'utf-8');
    expect(compte).toMatch(/reconcileOpenToProcessActions\(accountId/);
    for (const f of ['t3-queue.ts', 'document-asset/queue.ts', 'entity-reconciliation.ts']) {
      expect(readFileSync(join(racine, f), 'utf-8'), f).not.toMatch(/reconcileOpenToProcessActions\(/);
    }
  });
});
