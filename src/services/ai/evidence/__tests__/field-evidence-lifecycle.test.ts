/**
 * Preuves canoniques, ciblées, et leur cycle de vie — CDC 15 T1-04, T3-03,
 * §14.4 (migration 0219). Base simulée : chaque requête SQL est capturée.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const db = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  columnsReady: true,
  nextId: 100,
  selectRows: [] as Array<Record<string, unknown>>,
  supersedeRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    if (sql.includes('information_schema.columns')) {
      const cols = (params[1] as string[]) ?? [];
      return [{ n: db.columnsReady ? cols.length : 0 }];
    }
    if (sql.includes('INSERT INTO field_evidence')) return [{ id: db.nextId++ }];
    if (sql.includes('WITH remplacement') || sql.includes('WITH retenue') || sql.startsWith('UPDATE field_evidence SET lifecycle')) return db.supersedeRows;
    if (sql.includes('FROM field_evidence')) return db.selectRows;
    return [];
  });
  return {
    db: {},
    pgClient: {
      unsafe,
      begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => {
        db.calls.push({ sql: 'BEGIN', params: [] });
        const r = await fn({ unsafe });
        db.calls.push({ sql: 'COMMIT', params: [] });
        return r;
      },
    },
  };
});

import {
  recordEvidence, getActiveEvidence, supersedePriorSourceEvidence, evidenceFingerprint, EvidenceSchemaNotReadyError,
  evidenceReadFilter, withdrawEvidence, linkReplacements, listRetiredEvidenceValues, listActiveEvidenceAssets,
  supersedeFieldEvidenceExcept,
} from '../field-evidence.service';
import { __resetCanonicalColumnsForTests } from '../canonical-columns';
import type { FieldEvidenceInput } from '../evidence.types';

const base: FieldEvidenceInput = {
  accountId: 1, assetId: 10, fieldKey: 'acquisitionPrice', value: 749, normalizedValue: '749',
  sourceType: 'document', sourceId: 55, location: { page: 1 }, excerpt: 'Total 749,00 €',
  confidence: 'certain', authorityScore: 60,
};

beforeEach(() => {
  db.calls = []; db.columnsReady = true; db.nextId = 100; db.selectRows = []; db.supersedeRows = [];
  __resetCanonicalColumnsForTests(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('empreinte', () => {
  it('preuve historique : empreinte strictement identique à celle d’avant le lot 12', () => {
    const attendue = createHash('sha256').update(JSON.stringify({
      a: 1, as: 10, f: 'acquisitionPrice', st: 'document', si: 55, sv: null, loc: { page: 1 }, nv: '749',
    })).digest('hex');
    expect(evidenceFingerprint(base)).toBe(attendue);
  });

  it('cible et analyse distinguent deux preuves (T1-04, §14.4)', () => {
    const eq1 = evidenceFingerprint({ ...base, target: { type: 'EQUIPMENT', entityId: 7, label: null, confidence: 'certain' } });
    const eq2 = evidenceFingerprint({ ...base, target: { type: 'EQUIPMENT', entityId: 8, label: null, confidence: 'certain' } });
    const run1 = evidenceFingerprint({ ...base, analysisRunId: 1 });
    const run2 = evidenceFingerprint({ ...base, analysisRunId: 2 });
    expect(new Set([evidenceFingerprint(base), eq1, eq2, run1, run2]).size).toBe(5);
  });
});

describe('recordEvidence', () => {
  it('sans contrat enrichi : INSERT historique, aucune colonne 0219 écrite ; réactivation du cycle de vie au conflit (lot 13)', async () => {
    await recordEvidence(base);
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO field_evidence'))!;
    expect(ins.sql).not.toMatch(/canonical_key/);
    expect(ins.params).toHaveLength(21);
    expect(ins.sql).toMatch(/lifecycle_status = 'ACTIVE', superseded_at = NULL/);
    expect(ins.sql.slice(ins.sql.indexOf('ON CONFLICT'))).not.toMatch(/\bstatus = /);
  });

  it('sans contrat enrichi, 0219 absente : INSERT historique strict', async () => {
    db.columnsReady = false;
    await recordEvidence(base);
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO field_evidence'))!;
    expect(ins.sql).not.toMatch(/lifecycle_status|canonical_key/);
  });

  it('contrat enrichi, 0219 appliquée : colonnes cible/clé/récurrence écrites, réactivation du cycle de vie SEUL au conflit', async () => {
    await recordEvidence({
      ...base, canonicalKey: 'acquisitionPrice', canonicalUnit: 'EUR', rawValue: '749,00 €',
      target: { type: 'EQUIPMENT', entityId: 7, label: 'Chaudière', confidence: 'probable' },
      semanticEvent: { type: 'purchase', nature: 'HISTORICAL' },
      recurrence: { frequency: 'yearly', interval: 1 },
      projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: 'PURCHASE_RECEIPT_ACQUISITION', analysisRunId: 9,
    });
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO field_evidence'))!;
    expect(insert.sql).toMatch(/canonical_key, canonical_unit, raw_value/);
    expect(insert.sql).toMatch(/lifecycle_status = 'ACTIVE'/);
    // Revue 2c : jamais de retour à status='active' d'une preuve écartée par T3.
    expect(insert.sql.slice(insert.sql.indexOf('ON CONFLICT'))).not.toMatch(/\bstatus\s*=/);
    expect(insert.params.slice(21)).toEqual([
      'acquisitionPrice', 'EUR', '749,00 €', 'EQUIPMENT', 7, 'Chaudière', 'probable', 'purchase', 'HISTORICAL',
      JSON.stringify({ frequency: 'yearly', interval: 1 }), 'DETERMINISTIC_RULE', 'PURCHASE_RECEIPT_ACQUISITION', 9,
    ]);
  });

  it('0219 absente : repli historique pour une preuve du bien ; refus pour un équipement (sinon fuite vers le parent)', async () => {
    db.columnsReady = false;
    await recordEvidence({ ...base, canonicalKey: 'acquisitionPrice', target: { type: 'ASSET', entityId: 10, label: null, confidence: 'certain' } });
    expect(db.calls.at(-1)!.sql).not.toMatch(/canonical_key/);
    await expect(recordEvidence({ ...base, target: { type: 'EQUIPMENT', entityId: 7, label: null, confidence: 'certain' } }))
      .rejects.toBeInstanceOf(EvidenceSchemaNotReadyError);
  });
});

describe('getActiveEvidence — lecteurs filtrés', () => {
  it('0219 appliquée : ACTIVE seulement, et preuves du bien seulement par défaut', async () => {
    db.selectRows = [{
      id: 3, accountId: 1, assetId: 10, fieldKey: 'acquisitionPrice', valueJson: 749, normalizedValue: '749',
      sourceType: 'document', sourceId: 55, sourceVersion: null, sourceLocation: { page: 1 }, evidenceExcerpt: 'x',
      evidenceOrigin: null, visualEvidence: null, documentType: 'FACTURE', documentDate: '2024-01-02T00:00:00Z',
      provider: 'gemini', model: 'm', promptVersion: 'p', confidence: 'certain', authorityScore: 60,
      operationTraceId: null, status: 'active', extractedAt: '2024-01-03T00:00:00Z', lifecycleStatus: null,
    }];
    const [e] = await getActiveEvidence(1, 10, 'acquisitionPrice');
    const sel = db.calls.find((c) => c.sql.includes('FROM field_evidence'))!;
    expect(sel.sql).toMatch(/lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE'/);
    expect(sel.sql).toMatch(/target_type IS NULL OR \(target_type = 'ASSET' AND \(target_entity_id IS NULL OR target_entity_id = asset_id\)\)/);
    expect(sel.sql).not.toMatch(/SELECT \*/);
    expect(e).toMatchObject({ id: 3, value: 749, excerpt: 'x', location: { page: 1 }, evidenceOrigin: 'TEXT_EXTRACTION', lifecycleStatus: 'ACTIVE' });
    expect(e.documentDate).toBeInstanceOf(Date);
  });

  it('cible équipement demandée explicitement', async () => {
    await getActiveEvidence(1, 10, 'serialNumber', { target: { type: 'EQUIPMENT', entityId: 7 } });
    const sel = db.calls.find((c) => c.sql.includes('FROM field_evidence'))!;
    expect(sel.sql).toMatch(/target_type = \$4 AND target_entity_id = \$5/);
    expect(sel.params).toEqual([1, 10, 'serialNumber', 'EQUIPMENT', 7]);
  });

  it('0219 absente : requête historique valide (aucune colonne nouvelle citée)', async () => {
    db.columnsReady = false;
    await getActiveEvidence(1, 10, 'acquisitionPrice');
    const sel = db.calls.find((c) => c.sql.includes('FROM field_evidence'))!;
    expect(sel.sql).not.toMatch(/lifecycle_status|target_type/);
    expect(await getActiveEvidence(1, 10, 'serialNumber', { target: { type: 'EQUIPMENT', entityId: 7 } })).toEqual([]);
  });
});

describe('evidenceReadFilter — lecteurs hors service', () => {
  it('0219 appliquée : cycle de vie ACTIVE ; niveau bien : cible ASSET ou nulle', async () => {
    expect(await evidenceReadFilter()).toBe(` AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`);
    // Lot 13 (objectif 5) : un fait ciblé sur un AUTRE bien n'est jamais une preuve de ce bien.
    expect(await evidenceReadFilter({ alias: 'fe', assetLevel: true }))
      .toBe(` AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE')`
        + ` AND (fe.target_type IS NULL OR (fe.target_type = 'ASSET' AND (fe.target_entity_id IS NULL OR fe.target_entity_id = fe.asset_id)))`);
  });
  it('0219 absente : aucun fragment (requête historique valide)', async () => {
    db.columnsReady = false;
    expect(await evidenceReadFilter({ assetLevel: true })).toBe('');
  });
});

describe('supersedePriorSourceEvidence (§14.4)', () => {
  it('avec analyse : verrou consultatif (compte, source) dans la transaction, analyses antérieures seulement, status intact', async () => {
    db.supersedeRows = [{ id: 1, assetId: 10, newId: 100 }, { id: 2, assetId: 11, newId: null }];
    const r = await supersedePriorSourceEvidence({ accountId: 1, sourceType: 'document', sourceId: 55, analysisRunId: 9, keepIds: [100], complete: true });
    const i = db.calls.findIndex((c) => c.sql === 'BEGIN');
    expect(db.calls[i + 1]).toEqual({ sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)', params: [1, 55] });
    const q = db.calls[i + 2];
    expect(db.calls[i + 3].sql).toBe('COMMIT');
    expect(q.sql).not.toMatch(/DELETE/i);
    expect(q.sql).not.toMatch(/\bstatus\s*=/); // seul lifecycle_status change
    expect(q.sql).toMatch(/SET lifecycle_status = 'SUPERSEDED', superseded_at = now\(\), superseded_by_evidence_id = rp\.new_id/);
    expect(q.sql).toMatch(/GREATEST\(\$4::int, \(SELECT max\(x\.analysis_run_id\)/);
    expect(q.sql).toMatch(/o\.analysis_run_id IS NULL OR o\.analysis_run_id < r\.run/);
    // Analyse courante périmée (une plus récente a écrit) : ses preuves cèdent, même incomplète.
    expect(q.sql).toMatch(/\$5::boolean OR rp\.run > \$4::int OR rp\.new_id IS NOT NULL/);
    expect(q.params).toEqual([1, 'document', 55, 9, true, [100]]);
    // Même run réutilisé (réanalyse dédupliquée) : preuves non reproduites remplacées,
    // remplaçante cherchée parmi les preuves écrites maintenant.
    expect(q.sql).toMatch(/r\.run = \$4::int AND o\.analysis_run_id = \$4::int AND NOT \(o\.id = ANY\(\$6::int\[\]\)\)/);
    expect(q.sql).toMatch(/r\.run <> \$4::int OR n\.id = ANY\(\$6::int\[\]\)/);
    expect(q.sql).toMatch(/n\.id <> o\.id/);
    expect(r).toEqual({ superseded: 2, linked: 1, assetIds: [10, 11] });
  });

  it('sans analyse : repli sur les preuves écrites, jamais une preuve d’analyse datée', async () => {
    await supersedePriorSourceEvidence({ accountId: 1, sourceType: 'document', sourceId: 55, analysisRunId: null, keepIds: [100], complete: false });
    const q = db.calls.find((c) => c.sql.includes('WITH remplacement'))!;
    expect(q.sql).toMatch(/o\.analysis_run_id IS NULL/);
    expect(q.sql).toMatch(/NOT \(o\.id = ANY\(\$4::int\[\]\)\)/);
    expect(q.params).toEqual([1, 'document', 55, [100], false]);
  });

  it('0219 absente : aucune modification (la trace ne pourrait pas être conservée)', async () => {
    db.columnsReady = false;
    const r = await supersedePriorSourceEvidence({ accountId: 1, sourceType: 'document', sourceId: 55, analysisRunId: 3, keepIds: [], complete: true });
    expect(r).toEqual({ superseded: 0, linked: 0, assetIds: [] });
    expect(db.calls.some((c) => c.sql === 'BEGIN' || c.sql.includes('UPDATE'))).toBe(false);
  });
});

describe('withdrawEvidence (T3-03, lot 13)', () => {
  beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });

  it('enabled : UPDATE lifecycle WITHDRAWN + date, jamais status ni DELETE ; filtres source / bien / champs', async () => {
    db.supersedeRows = [{ id: 4, assetId: 10 }, { id: 5, assetId: 10 }];
    const r = await withdrawEvidence({ accountId: 1, sourceIds: [55], assetId: 10, fieldKeys: ['mileage'], reason: 'DOCUMENT_MOVED', mode: 'enabled' });
    const q = db.calls.at(-1)!;
    expect(q.sql).toMatch(/^UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN', superseded_at = now\(\)/);
    expect(q.sql).not.toMatch(/DELETE|\bstatus = /);
    expect(q.sql).toMatch(/lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE'/);
    // Relecture lot 13 : jamais les preuves d'un lien web (autre espace d'identifiants).
    // R4 : un lien web est une ligne asset_files — même espace d'identifiants.
    expect(q.sql).toMatch(/source_type IN \('document', 'web_link'\) AND source_id = ANY/);
    expect(q.sql).not.toMatch(/'agenda'|'equipment'|'supplier'|'user_input'/);
    expect(q.params).toEqual([1, [55], 10, ['mileage']]);
    expect(r).toEqual({ evidenceIds: [4, 5], assetIds: [10], dryRun: false });
  });

  it('shadow : SELECT seulement ; revalidation : SUPERSEDED ; 0219 absente : rien', async () => {
    await withdrawEvidence({ accountId: 1, sourceIds: [55], reason: 'DOCUMENT_DELETED', mode: 'shadow' });
    expect(db.calls.at(-1)!.sql).toMatch(/^SELECT id, asset_id/);
    await withdrawEvidence({ accountId: 1, sourceIds: [55], reason: 'FACT_REVALIDATED', mode: 'enabled', lifecycle: 'SUPERSEDED' });
    expect(db.calls.at(-1)!.sql).toMatch(/SET lifecycle_status = 'SUPERSEDED'/);
    db.calls = []; db.columnsReady = false; __resetCanonicalColumnsForTests(null);
    expect(await withdrawEvidence({ accountId: 1, sourceIds: [55], reason: 'DOCUMENT_DELETED', mode: 'enabled' }))
      .toEqual({ evidenceIds: [], assetIds: [], dryRun: true });
    expect(db.calls.some((c) => /UPDATE|SELECT id/.test(c.sql))).toBe(false);
  });

  it('ni source ni bien : rien', async () => {
    expect((await withdrawEvidence({ accountId: 1, sourceIds: [], reason: 'DOCUMENT_DELETED', mode: 'enabled' })).evidenceIds).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it('linkReplacements et listFieldsWithRetiredEvidence : requêtes bornées au compte et au bien', async () => {
    await linkReplacements(1, [4]);
    expect(db.calls.at(-1)!.sql).toMatch(/SET superseded_by_evidence_id/);
    expect(db.calls.at(-1)!.params).toEqual([1, [4]]);
    await listRetiredEvidenceValues(1, 10);
    expect(db.calls.at(-1)!.sql).toMatch(/lifecycle_status IN \('WITHDRAWN', 'SUPERSEDED'\)/);
    expect(db.calls.at(-1)!.sql).toMatch(/target_entity_id = asset_id/);
  });
});

describe('relecture lot 13', () => {
  beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });

  it('listActiveEvidenceAssets (R4) : documents ET liens web (asset_files.id), aucun autre type de source', async () => {
    await listActiveEvidenceAssets(1, 55);
    const q = db.calls.at(-1)!;
    expect(q.sql).toMatch(/source_type IN \('document', 'web_link'\) AND source_id = \$2/);
    expect(q.sql).not.toMatch(/'agenda'|'equipment'|'supplier'|'user_input'/);
  });

  it('supersedeFieldEvidenceExcept (R4) : documents ET liens web', async () => {
    db.selectRows = [];
    await supersedeFieldEvidenceExcept({ accountId: 1, sourceId: 55, assetId: 10, fieldKeys: ['acquisitionDate'], keepValue: 'x', mode: 'shadow' });
    expect(db.calls.at(-1)!.sql).toMatch(/source_type IN \('document', 'web_link'\) AND source_id = \$2 AND asset_id = \$3/);
  });

  it('supersedeFieldEvidenceExcept : remplace seulement s’il existe une remplaçante de la valeur revalidée', async () => {
    db.selectRows = [{ id: 8, fieldKey: 'acquisitionDate', value: '2024-03-04' }, { id: 7, fieldKey: 'acquisitionDate', value: '2024-01-02' }];
    const r = await supersedeFieldEvidenceExcept({ accountId: 1, sourceId: 55, assetId: 10, fieldKeys: ['acquisitionDate'], keepValue: '04/03/2024', mode: 'enabled' });
    expect(r.replacementId).toBe(8);
    const upd = db.calls.at(-1)!;
    expect(upd.sql).toMatch(/SET lifecycle_status = 'SUPERSEDED', superseded_at = now\(\), superseded_by_evidence_id = \$3/);
    expect(upd.params).toEqual([1, [7], 8]);

    db.calls = [];
    db.selectRows = [{ id: 7, fieldKey: 'acquisitionDate', value: '2024-01-02' }];
    expect(await supersedeFieldEvidenceExcept({ accountId: 1, sourceId: 55, assetId: 10, fieldKeys: ['acquisitionDate'], keepValue: '2024-03-04', mode: 'enabled' }))
      .toEqual({ superseded: 0, replacementId: null });
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });
});
