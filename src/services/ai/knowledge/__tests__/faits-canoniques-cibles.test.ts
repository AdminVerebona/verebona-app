/**
 * Connaissance documentaire enrichie — CDC 15 PM-T1-PRE, T1-04, T4-06
 * (migration 0218). Faits canoniques ciblés, récurrence persistée et
 * restaurée, rattachement tardif sans rattachement arbitraire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  columnsReady: true,
}));

vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    if (sql.includes('information_schema.columns')) return [{ n: db.columnsReady ? (params[1] as string[]).length : 0 }];
    if (sql.includes('INSERT INTO document_extractions')) return [{ id: 77 }];
    return [];
  });
  return { db: {}, pgClient: { unsafe, begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<void>) => fn({ unsafe }) } };
});

import { buildKnowledgeFromSourceAnalysis, factsToExtractedFields, toFact, isMultiAssetResult } from '../document-knowledge';
import { persistDocumentKnowledge, fieldsForLinkedAsset, lateLinkAllowsReassignment } from '../document-knowledge.service';
import { projectedFactToExtractedField } from '../../source-analysis/steps/persist-evidence.step';
import { __resetCanonicalColumnsForTests } from '../../evidence/canonical-columns';
import type { ExtractedField, SourceAnalysisResult } from '../../source-analysis/types';
import type { ProjectedFact } from '../../source-analysis/master/t1-contract';

const projected = (over: Partial<ProjectedFact> = {}): ProjectedFact => ({
  canonicalKey: 'maintenanceDueDate', rawKey: 'Prochain entretien', label: null, subject: null, attribute: null,
  rawValue: '01/06/2025', value: '2025-06-01', valueType: 'date', canonicalUnit: null,
  target: { targetType: 'EQUIPMENT', targetEntityId: 7, targetEntityLabel: 'Chaudière', targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Entretien tous les 12 mois', page: 2 },
  semanticEvent: { type: 'maintenance', nature: 'DEADLINE' },
  recurrence: { frequency: 'monthly', interval: 12, excerpt: 'tous les 12 mois' },
  periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null, ...over,
});

const result = (fields: ExtractedField[]): SourceAnalysisResult => ({
  sourceGroup: { sourceIds: [55], leadSourceId: 55 },
  document: {},
  assetCandidates: [], roomCandidates: [], equipmentCandidates: [],
  extractedFields: fields, agendaCandidates: [], warnings: [],
  operationTrace: { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: [] },
});
const ctx = { accountId: 1, fileId: 55, analysisRunId: 9, assetIdAtAnalysis: null, sourceType: 'asset_file' as const };

beforeEach(() => {
  db.calls = []; db.columnsReady = true;
  __resetCanonicalColumnsForTests(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('toFact / buildKnowledgeFromSourceAnalysis — colonnes 0218', () => {
  it('fait historique : strictement aucune donnée nouvelle (rétrocompatibilité)', () => {
    const f = toFact({ fieldKey: 'chaudiere.puissance', value: '24 kW', confidence: 'certain', excerpt: '24 kW' });
    for (const k of ['canonicalKey', 'targetType', 'recurrence', 'projectionOrigin']) expect(f).not.toHaveProperty(k);
  });

  it('fait projeté : clé canonique, valeur brute, cible, événement et récurrence', () => {
    const k = buildKnowledgeFromSourceAnalysis(result([projectedFactToExtractedField(projected())]), ctx);
    expect(k.facts[0]).toMatchObject({
      factKey: 'maintenanceDueDate', canonicalKey: 'maintenanceDueDate', rawKey: 'Prochain entretien', rawValue: '01/06/2025',
      valueType: 'date', targetType: 'EQUIPMENT', targetEntityId: 7, targetEntityLabel: 'Chaudière', targetConfidence: 'certain',
      semanticEventType: 'maintenance', semanticEventNature: 'DEADLINE',
      recurrence: { frequency: 'monthly', interval: 12, excerpt: 'tous les 12 mois' }, projectionOrigin: 'MODEL_CANONICAL',
    });
  });

  it('fait sans cible vérifiée : conservé, cible NULL (U8)', () => {
    const k = buildKnowledgeFromSourceAnalysis(result([projectedFactToExtractedField(projected({
      target: { targetType: 'ASSET', targetEntityId: null, targetEntityLabel: 'Clio', targetConfidence: 'probable' },
    }))]), ctx);
    expect(k.facts).toHaveLength(1);
    expect(k.facts[0]).toMatchObject({ targetType: 'ASSET', targetEntityId: null, targetEntityLabel: 'Clio' });
  });
});

describe('factsToExtractedFields — reprojection tardive (T4-06)', () => {
  it('« tous les 12 mois » rattaché plus tard : récurrence et cible intactes', () => {
    const k = buildKnowledgeFromSourceAnalysis(result([projectedFactToExtractedField(projected())]), ctx);
    const [f] = factsToExtractedFields(k.facts);
    expect(f.recurrence).toEqual({ frequency: 'monthly', interval: 12, excerpt: 'tous les 12 mois' });
    expect(f.target).toEqual({ targetType: 'EQUIPMENT', targetEntityId: 7, targetEntityLabel: 'Chaudière', targetConfidence: 'certain' });
    expect(f).toMatchObject({ canonicalKey: 'maintenanceDueDate', semanticEvent: { type: 'maintenance', nature: 'DEADLINE' }, origin: 'MODEL_CANONICAL' });
  });

  it('fait historique relu : aucune donnée enrichie inventée', () => {
    const [f] = factsToExtractedFields([{ factKey: 'x', valueJson: 1, normalizedValue: '1', confidence: 'certain', excerpt: 'x', location: {} }]);
    for (const k of ['canonicalKey', 'target', 'recurrence', 'origin']) expect(f).not.toHaveProperty(k);
  });
});

describe('fieldsForLinkedAsset — rattachement explicite par l’utilisateur', () => {
  const asField = (over: Partial<ProjectedFact>) => projectedFactToExtractedField(projected(over));
  it('historique inchangé ; générique écarté ; ASSET sans id → bien rattaché ; cible vérifiée conservée ; équipement inconnu écarté', () => {
    const legacy: ExtractedField = { fieldKey: 'prixAchat', value: 1, confidence: 'certain', excerpt: '1' };
    const out = fieldsForLinkedAsset([
      legacy,
      asField({ canonicalKey: null, rawKey: 'chaudiere.puissance' }),
      asField({ canonicalKey: 'mileage', target: { targetType: 'ASSET', targetEntityId: null, targetEntityLabel: null, targetConfidence: 'probable' } }),
      asField({}),
      asField({ canonicalKey: 'serialNumber', target: { targetType: 'EQUIPMENT', targetEntityId: null, targetEntityLabel: 'Pompe', targetConfidence: 'probable' } }),
      asField({ canonicalKey: 'acquisitionDate', target: { targetType: 'DOCUMENT', targetEntityId: null, targetEntityLabel: null, targetConfidence: 'certain' } }),
    ], 42, { allowReassign: true });
    expect(out.map((f) => [f.fieldKey, f.target?.targetType ?? null, f.target?.targetEntityId ?? null])).toEqual([
      ['prixAchat', null, null],
      ['mileage', 'ASSET', 42],
      ['maintenanceDueDate', 'EQUIPMENT', 7],
    ]);
  });

  it('E2E-11 : un fait ciblant l’ANCIEN bien (A) n’est jamais projeté sur B ; un tiers garde sa cible ; les faits sans cible vont à B', () => {
    const cible = (id: number | null) => ({ targetType: 'ASSET' as const, targetEntityId: id, targetEntityLabel: null, targetConfidence: 'certain' as const });
    const versA = asField({ canonicalKey: 'mileage', target: cible(7) });
    const versB = asField({ canonicalKey: 'lastRevision', target: cible(42) });
    const tiers = asField({ canonicalKey: 'acquisitionDate', target: cible(9) });
    const sansCible = asField({ canonicalKey: 'maintenanceDueDate', target: cible(null) });
    const out = fieldsForLinkedAsset([versA, versB, tiers, sansCible], 42, { allowReassign: true, previousAssetId: 7 });
    expect(out.map((f) => [f.fieldKey, f.target?.targetEntityId])).toEqual([['lastRevision', 42], ['acquisitionDate', 9], ['maintenanceDueDate', 42]]);
    // Sans ancien bien connu : comportement antérieur (le fait ciblé reste sur sa cible).
    expect(fieldsForLinkedAsset([versA], 42, { allowReassign: false }).map((f) => f.target?.targetEntityId)).toEqual([7]);
    // L'ancien bien ne bloque pas l'attribution des faits sans cible ; un tiers, si.
    expect(lateLinkAllowsReassignment({ multiAsset: false, metadata: { assetCandidates: [{ entityId: 7 }] } }, [{ targetType: 'ASSET', targetEntityId: 7 }], 42, 7)).toBe(true);
    expect(lateLinkAllowsReassignment({ multiAsset: false, metadata: {} }, [{ targetType: 'ASSET', targetEntityId: 9 }], 42, 7)).toBe(false);
  });
});

describe('P-T1-04 — rattachement tardif sans fuite entre biens (T1-05)', () => {
  const sansId = projectedFactToExtractedField(projected({
    canonicalKey: 'mileage', target: { targetType: 'ASSET', targetEntityId: null, targetEntityLabel: 'Clio', targetConfidence: 'probable' },
  }));

  it('indicateur multi-biens : fourni par la branche maître seulement ; legacy = inconnu, aucune écriture', async () => {
    const r = result([sansId]);
    expect(buildKnowledgeFromSourceAnalysis(r, ctx).extraction.multiAsset).toBeUndefined();
    expect(buildKnowledgeFromSourceAnalysis({ ...r, warnings: [{ code: 'MULTI_ASSET_DOCUMENT', message: 'x' }] }, ctx).extraction.multiAsset).toBeUndefined();
    expect(buildKnowledgeFromSourceAnalysis(r, { ...ctx, multiAsset: false }).extraction.multiAsset).toBe(false);
    // Aide pour le pipeline maître : avertissement, candidats distincts, cibles distinctes.
    expect(isMultiAssetResult(r)).toBe(false);
    expect(isMultiAssetResult({ ...r, warnings: [{ code: 'MULTI_ASSET_DOCUMENT', message: 'x' }] })).toBe(true);
    expect(isMultiAssetResult({
      ...r, assetCandidates: [
        { entityId: null, rawLabel: 'Clio', confidence: 'probable', score: 1, reason: '', excerpt: '', verified: false },
        { entityId: null, rawLabel: 'Kangoo', confidence: 'probable', score: 1, reason: '', excerpt: '', verified: false },
      ],
    })).toBe(true);

    // Legacy (fait historique, indicateur absent) : ni contrôle de schéma ni UPDATE.
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(result([
      { fieldKey: 'chaudiere.puissance', value: '24 kW', confidence: 'certain', excerpt: '24 kW' },
    ]), ctx));
    expect(db.calls.some((c) => c.sql.includes('multi_asset') || c.sql.includes('information_schema'))).toBe(false);

    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(r, { ...ctx, multiAsset: true }));
    expect(db.calls.find((c) => c.sql.includes('SET multi_asset'))!.params).toEqual([77, true]);
  });

  it('document mono-bien : le fait ASSET sans identifiant va au bien rattaché', () => {
    expect(lateLinkAllowsReassignment({ multiAsset: false, metadata: {} }, [], 42)).toBe(true);
    const [f] = fieldsForLinkedAsset([sansId], 42, { allowReassign: true });
    expect(f.target).toMatchObject({ targetType: 'ASSET', targetEntityId: 42 });
  });

  it('document multi-biens ou mentionnant un autre bien : AUCUNE réattribution', () => {
    expect(lateLinkAllowsReassignment({ multiAsset: true, metadata: {} }, [], 42)).toBe(false);
    // Extraction antérieure à 0218 (indicateur inconnu) : relu dans metadata.
    expect(lateLinkAllowsReassignment({ multiAsset: null, metadata: { warnings: ['MULTI_ASSET_DOCUMENT'] } }, [], 42)).toBe(false);
    expect(lateLinkAllowsReassignment({ multiAsset: null, metadata: { assetCandidates: [{ entityId: null, rawLabel: 'Clio' }, { entityId: null, rawLabel: 'Kangoo' }] } }, [], 42)).toBe(false);
    // Un autre bien vérifié est mentionné, ou un fait vise un autre bien.
    expect(lateLinkAllowsReassignment({ multiAsset: false, metadata: { assetCandidates: [{ entityId: 7 }] } }, [], 42)).toBe(false);
    expect(lateLinkAllowsReassignment({ multiAsset: false, metadata: {} }, [{ targetType: 'ASSET', targetEntityId: 7 }], 42)).toBe(false);
    expect(fieldsForLinkedAsset([sansId], 42, { allowReassign: false })).toEqual([]);
  });
});

describe('persistDocumentKnowledge — écriture des colonnes 0218', () => {
  it('0218 appliquée : colonnes enrichies et récurrence en JSON', async () => {
    const k = buildKnowledgeFromSourceAnalysis(result([
      projectedFactToExtractedField(projected()),
      { fieldKey: 'chaudiere.puissance', value: '24 kW', confidence: 'certain', excerpt: '24 kW' },
    ]), ctx);
    await persistDocumentKnowledge(k);
    const facts = db.calls.filter((c) => c.sql.includes('INSERT INTO document_facts'));
    expect(facts).toHaveLength(2);
    expect(facts[0].sql).toMatch(/canonical_key, raw_key, raw_value/);
    expect(facts[0].params.slice(23)).toEqual([
      'maintenanceDueDate', 'Prochain entretien', '01/06/2025', 'date', null,
      'EQUIPMENT', 7, 'Chaudière', 'certain', 'maintenance', 'DEADLINE',
      JSON.stringify({ frequency: 'monthly', interval: 12, excerpt: 'tous les 12 mois' }), 'MODEL_CANONICAL', null,
    ]);
    // Le fait historique garde l'INSERT historique.
    expect(facts[1].sql).not.toMatch(/canonical_key/);
    expect(facts[1].params).toHaveLength(23);
  });

  it('0218 absente : le fait est conservé sur les colonnes historiques (jamais perdu), absence signalée', async () => {
    db.columnsReady = false;
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(result([projectedFactToExtractedField(projected())]), ctx));
    const facts = db.calls.filter((c) => c.sql.includes('INSERT INTO document_facts'));
    expect(facts).toHaveLength(1);
    expect(facts[0].sql).not.toMatch(/canonical_key/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/récurrence non persistée/));
  });
});
