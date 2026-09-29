/**
 * Persistance des faits ciblés — CDC 15 T1-01, T1-04, T1-05, U8, DOD-01, §14.4.
 *
 * Recettes : « facture multi-véhicules et facture chaudière : chaque fait doit
 * rester sur sa cible » ; « un document comportant deux véhicules doit
 * alimenter deux biens sans fuite croisée » ; « aucun alias libre n'entre dans
 * field_evidence ». Base simulée : chaque requête SQL est capturée.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  columnsReady: true,
  nextId: 1000,
  failFieldKey: null as string | null,
  // Entités du compte 1 : biens 10 et 11 ; équipement 7 (bien 10) ; pièce 3 (bien 11).
  assets: new Set([10, 11]),
  equipments: new Map([[7, 10]]),
  rooms: new Map([[3, 11]]),
}));

vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
      db.calls.push({ sql, params });
      if (sql.includes('information_schema.columns')) {
        return [{ n: db.columnsReady ? (params[1] as string[]).length : 0 }];
      }
      if (sql.includes('FROM assets') && !sql.includes('JOIN')) {
        return (params[1] as number[]).filter((id) => params[0] === 1 && db.assets.has(id)).map((id) => ({ entityId: id, assetId: id }));
      }
      if (sql.includes('FROM equipments')) {
        return (params[1] as number[]).filter((id) => params[0] === 1 && db.equipments.has(id)).map((id) => ({ entityId: id, assetId: db.equipments.get(id) }));
      }
      if (sql.includes('FROM rooms')) {
        return (params[1] as number[]).filter((id) => params[0] === 1 && db.rooms.has(id)).map((id) => ({ entityId: id, assetId: db.rooms.get(id) }));
      }
      if (sql.includes('INSERT INTO field_evidence')) {
        if (db.failFieldKey && params[2] === db.failFieldKey) throw new Error('panne simulée');
        return [{ id: db.nextId++ }];
      }
      if (sql.includes('WITH remplacement') || sql.includes('WITH retenue')) return [{ id: 1, assetId: 12, newId: null }];
      return [];
  });
  return { db: {}, pgClient: { unsafe, begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe }) } };
});

import { persistProjectedFacts, persistEvidence, projectedFactToExtractedField } from '../steps/persist-evidence.step';
import { __resetCanonicalColumnsForTests } from '../../evidence/canonical-columns';
import type { ProjectedFact, PersistedFactTarget } from '../master/t1-contract';
import type { SourceInput, AiOperationTrace } from '../types';

const input: SourceInput = { sourceType: 'file', sourceIds: [55], accountId: 1, userId: 2, mimeTypes: [], displayNames: [], sourceVersion: 3 };
const trace: AiOperationTrace = {
  traceIds: ['00000000-0000-0000-0000-000000000001'], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['gemini-x'],
};
const target = (targetType: PersistedFactTarget['targetType'], targetEntityId: number | null): PersistedFactTarget =>
  ({ targetType, targetEntityId, targetEntityLabel: null, targetConfidence: 'certain' });

const fact = (over: Partial<ProjectedFact>): ProjectedFact => ({
  canonicalKey: 'mileage', rawKey: 'Kilométrage', label: null, subject: null, attribute: null,
  rawValue: '78 000 km', value: 78000, valueType: 'number', canonicalUnit: 'km',
  target: target('ASSET', 10), provenance: 'TEXT_EXTRACTION', confidence: 'certain',
  evidence: { excerpt: 'Kilométrage : 78 000 km', page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null,
  origin: 'MODEL_CANONICAL', ruleCode: null, ...over,
});

const inserts = () => db.calls.filter((c) => c.sql.includes('INSERT INTO field_evidence'));
/** Colonnes clés d'un INSERT enrichi : asset_id ($2), field_key ($3), target_type ($25), target_entity_id ($26). */
const cible = (c: { params: unknown[] }) => ({ assetId: c.params[1], key: c.params[2], type: c.params[24], entityId: c.params[25] });

beforeEach(() => {
  db.calls = []; db.columnsReady = true; db.nextId = 1000; db.failFieldKey = null;
  __resetCanonicalColumnsForTests(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('persistProjectedFacts — chaque fait sur SA cible (T1-04, T1-05)', () => {
  it('document à deux véhicules : deux biens, aucune fuite croisée', async () => {
    const r = await persistProjectedFacts({
      input, leadSourceId: 55, trace, analysisRunId: 9, documentType: 'FACTURE',
      facts: [
        fact({ value: 78000, target: target('ASSET', 10) }),
        fact({ value: 12000, rawValue: '12 000 km', target: target('ASSET', 11) }),
      ],
    });
    expect(inserts().map(cible)).toEqual([
      { assetId: 10, key: 'mileage', type: 'ASSET', entityId: 10 },
      { assetId: 11, key: 'mileage', type: 'ASSET', entityId: 11 },
    ]);
    expect(r.evidenceIds.get('mileage@ASSET:10')).toBe(1000);
    expect(r.evidenceIds.get('mileage@ASSET:11')).toBe(1001);
    expect(r.skipped).toEqual([]);
  });

  it('facture chaudière : le fait d’équipement porte l’équipement ET le bien porteur retrouvé en base', async () => {
    await persistProjectedFacts({
      input, leadSourceId: 55, trace,
      facts: [fact({ canonicalKey: 'serialNumber', value: 'SN-1', valueType: 'string', canonicalUnit: null, target: target('EQUIPMENT', 7) })],
    });
    expect(inserts().map(cible)).toEqual([{ assetId: 10, key: 'serialNumber', type: 'EQUIPMENT', entityId: 7 }]);
  });

  it('pièce : bien porteur de la pièce', async () => {
    await persistProjectedFacts({ input, leadSourceId: 55, trace, facts: [fact({ canonicalKey: 'livingArea', target: target('ROOM', 3) })] });
    expect(inserts().map(cible)).toEqual([{ assetId: 11, key: 'livingArea', type: 'ROOM', entityId: 3 }]);
  });

  it('zéro perte silencieuse : les faits non projetés sont rendus avec leur motif, jamais rattachés arbitrairement', async () => {
    const generic = fact({ canonicalKey: null, rawKey: 'chaudiere.puissance' });
    const unattached = fact({ target: target('ASSET', null) });
    const otherAccount = fact({ target: target('ASSET', 999) });
    const docLevel = fact({ canonicalKey: 'acquisitionDate', target: target('DOCUMENT', null) });
    const unknownKey = fact({ canonicalKey: 'cleInventee' });
    const noProof = fact({ evidence: {} });
    const r = await persistProjectedFacts({ input, leadSourceId: 55, trace, facts: [generic, unattached, otherAccount, docLevel, unknownKey, noProof] });
    expect(inserts()).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      'GENERIC_KNOWLEDGE', 'UNATTACHED', 'NON_ENTITY_TARGET', 'UNKNOWN_CANONICAL_KEY', 'NO_EVIDENCE', 'TARGET_NOT_FOUND',
    ]);
    expect(r.skipped.find((s) => s.reason === 'TARGET_NOT_FOUND')!.fact).toBe(otherAccount);
  });

  it('règle déterministe sans extrait propre : écrite, origine et règle tracées', async () => {
    await persistProjectedFacts({
      input, leadSourceId: 55, trace,
      facts: [fact({ canonicalKey: 'acquisitionPrice', value: 749, rawValue: 74900, canonicalUnit: 'EUR', evidence: {}, origin: 'DETERMINISTIC_RULE', ruleCode: 'PURCHASE_RECEIPT_ACQUISITION' })],
    });
    const [ins] = inserts();
    expect(ins.params[3]).toBe('749'); // value_json : euros, jamais ×100
    expect(ins.params[4]).toBe('749');
    expect(ins.params[23]).toBe('74900'); // raw_value conservée
    expect(ins.params.slice(31, 33)).toEqual(['DETERMINISTIC_RULE', 'PURCHASE_RECEIPT_ACQUISITION']);
  });

  it('observation visuelle : aucune citation fabriquée', async () => {
    await persistProjectedFacts({
      input, leadSourceId: 55, trace,
      facts: [fact({ provenance: 'VISUAL_ANALYSIS', evidence: { excerpt: 'ne doit pas passer' }, visualEvidence: { description: 'compteur 78 000' } })],
    });
    const [ins] = inserts();
    expect(ins.params[9]).toBeNull();
    expect(ins.params[19]).toBe('VISUAL_ANALYSIS');
    expect(JSON.parse(ins.params[20] as string)).toEqual({ description: 'compteur 78 000', fileId: 55 });
  });

  it('récurrence et événement persistés (PM-T1-PRE)', async () => {
    await persistProjectedFacts({
      input, leadSourceId: 55, trace,
      facts: [fact({ canonicalKey: 'maintenanceDueDate', value: '2025-06-01', semanticEvent: { type: 'maintenance', nature: 'DEADLINE' }, recurrence: { frequency: 'yearly', interval: 1 } })],
    });
    const [ins] = inserts();
    expect(ins.params.slice(28, 31)).toEqual(['maintenance', 'DEADLINE', JSON.stringify({ frequency: 'yearly', interval: 1 })]);
  });
});

describe('persistProjectedFacts — cycle de vie (§14.4)', () => {
  it('supersede des preuves antérieures de la source, nouvelles preuves épargnées ; biens remplacés à réconcilier', async () => {
    const r = await persistProjectedFacts({ input, leadSourceId: 55, trace, analysisRunId: 9, facts: [fact({})] });
    const sup = db.calls.find((c) => c.sql.includes('WITH retenue'))!;
    expect(sup.params).toEqual([1, 'document', 55, 9, true, [1000]]);
    expect(r.superseded).toEqual({ count: 1, linked: 0 });
    expect(r.affectedAssetIds.sort()).toEqual([10, 12]);
  });

  it('écriture partielle : supersede limité aux preuves ayant une remplaçante', async () => {
    db.failFieldKey = 'serialNumber';
    const r = await persistProjectedFacts({
      input, leadSourceId: 55, trace,
      facts: [fact({}), fact({ canonicalKey: 'serialNumber', value: 'SN', target: target('EQUIPMENT', 7) })],
    });
    expect(db.calls.find((c) => c.sql.includes('WITH remplacement'))!.params).toEqual([1, 'document', 55, [1000], false]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['WRITE_FAILED']);
  });

  it('0219 absente : preuve du bien en repli historique, équipement NON écrit (sinon lu comme preuve du parent), aucun supersede', async () => {
    db.columnsReady = false;
    const r = await persistProjectedFacts({
      input, leadSourceId: 55, trace,
      facts: [fact({}), fact({ canonicalKey: 'serialNumber', value: 'SN', target: target('EQUIPMENT', 7) })],
    });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].sql).not.toMatch(/canonical_key/);
    expect(r.skipped.map((s) => s.reason)).toEqual(['SCHEMA_NOT_READY']);
    expect(db.calls.some((c) => /WITH (remplacement|retenue)/.test(c.sql))).toBe(false);
  });
});

describe('persistEvidence — mode « étapes » historique', () => {
  it('champs sans cible : tous sur le bien du pipeline, INSERT historique, pas de supersede', async () => {
    const m = await persistEvidence({
      input, leadSourceId: 55, assetId: 10, trace,
      fields: [
        { fieldKey: 'prixAchat', value: '749', confidence: 'certain', excerpt: '749 €' },
        { fieldKey: 'chaudiere.puissance', value: '24 kW', confidence: 'probable', excerpt: '24 kW' },
      ],
    });
    expect(m.size).toBe(2);
    expect(inserts().every((c) => c.params[1] === 10 && !/canonical_key/.test(c.sql))).toBe(true);
    expect(db.calls.some((c) => /WITH (remplacement|retenue)|FROM equipments/.test(c.sql))).toBe(false);
    // Lot 13 (T3-03) : une preuve retirée puis reproduite redevient active (cycle de vie seul).
    expect(inserts()[0].sql).toMatch(/lifecycle_status = 'ACTIVE'/);
    expect(inserts()[0].sql).not.toMatch(/\bstatus = /);
  });

  it('champ enrichi de cible vérifiée : écrit sur SA cible, pas sur le bien du pipeline', async () => {
    await persistEvidence({
      input, leadSourceId: 55, assetId: 11, trace,
      fields: [
        { fieldKey: 'serialNumber', value: 'SN', confidence: 'certain', excerpt: 'SN', canonicalKey: 'serialNumber', target: target('EQUIPMENT', 7) },
        { fieldKey: 'mileage', value: 1, confidence: 'certain', excerpt: '1 km', canonicalKey: 'mileage', target: target('EQUIPMENT', 404) },
      ],
    });
    expect(inserts().map(cible)).toEqual([{ assetId: 10, key: 'serialNumber', type: 'EQUIPMENT', entityId: 7 }]);
  });
});

describe('persistEvidence — remplacement à la réanalyse (mode « étapes », lot 13)', () => {
  const champs = [{ fieldKey: 'mileage', value: 1, confidence: 'certain' as const, excerpt: '1 km' }];
  it('enabled : preuves antérieures de la source remplacées sous verrou (sans analyse datée, preuves écrites épargnées)', async () => {
    const onResult = vi.fn();
    await persistEvidence({ input, leadSourceId: 55, assetId: 10, trace, fields: champs, supersede: { mode: 'enabled', onResult } });
    const sup = db.calls.find((c) => c.sql.includes('WITH remplacement'))!;
    expect(sup.sql).toMatch(/o\.analysis_run_id IS NULL/);
    expect(sup.params).toEqual([1, 'document', 55, [1000], true]);
    expect(onResult).toHaveBeenCalledWith({ superseded: 1, linked: 0, assetIds: [12] });
  });

  it('écriture en échec : remplacement partiel (seulement ce qui a une remplaçante)', async () => {
    db.failFieldKey = 'mileage';
    await persistEvidence({ input, leadSourceId: 55, assetId: 10, trace, fields: champs, supersede: { mode: 'enabled' } });
    expect(db.calls.find((c) => c.sql.includes('WITH remplacement'))!.params).toEqual([1, 'document', 55, [], false]);
  });

  it('shadow : lecture seule, rien n’est remplacé ; absent : rien', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await persistEvidence({ input, leadSourceId: 55, assetId: 10, trace, fields: champs, supersede: { mode: 'shadow' } });
    expect(db.calls.some((c) => /WITH (remplacement|retenue)|^\s*UPDATE field_evidence/.test(c.sql))).toBe(false);
    expect(db.calls.some((c) => /SELECT id, asset_id AS "assetId" FROM field_evidence/.test(c.sql))).toBe(true);
    db.calls = [];
    await persistEvidence({ input, leadSourceId: 55, assetId: 10, trace, fields: champs });
    expect(db.calls.some((c) => /WITH (remplacement|retenue)|SELECT id, asset_id/.test(c.sql))).toBe(false);
  });

  it('pipeline, chemin étapes : option activée selon T3_NEGATIVE_RECONCILIATION (enabled / shadow), jamais en legacy', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(`${process.cwd()}/src/services/ai/source-analysis/pipeline.ts`, 'utf8');
    expect(src).toMatch(/const negMode = t3NegativeMode\(\);/);
    expect(src).toMatch(/supersede: negMode === 'legacy' \? undefined : \{ mode: negMode/);
  });
});

describe('projectedFactToExtractedField', () => {
  it('conserve cible, clé, unité, événement et récurrence', () => {
    const f = projectedFactToExtractedField(fact({ recurrence: { frequency: 'monthly' }, semanticEvent: { type: 'maintenance', nature: 'DEADLINE' }, target: target('EQUIPMENT', 7) }));
    expect(f).toMatchObject({
      fieldKey: 'mileage', value: 78000, normalizedValue: '78000', excerpt: 'Kilométrage : 78 000 km', page: 1,
      canonicalKey: 'mileage', rawKey: 'Kilométrage', rawValue: '78 000 km', canonicalUnit: 'km', unit: 'km',
      target: target('EQUIPMENT', 7), recurrence: { frequency: 'monthly' }, origin: 'MODEL_CANONICAL',
    });
    expect(projectedFactToExtractedField(fact({ canonicalKey: null, rawKey: null, subject: 'Chaudière', attribute: 'puissance' })).fieldKey)
      .toBe('Chaudière.puissance');
  });
});
