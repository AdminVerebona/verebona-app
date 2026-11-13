/**
 * Lot 113AK (Trello #736) — provenance fait → unité source et preuves
 * orphelines : fonctions pures, déclarations, rapport du rattrapage BO.
 * (Sans base : la CI unitaire n'a pas de PostgreSQL.)
 *
 *  L113AK-U01  invariant : compte + document + unité ; cellule = sa ligne ; jamais l'identifiant seul
 *  L113AK-U02  qualification d'un fait : historique, hors périmètre, version remplacée, couche en attente, cassé
 *  L113AK-U03  rattachement depuis la preuve CONSERVÉE (extrait, cellule) — jamais par la valeur nue
 *  L113AK-U04  contradiction : constat, jamais réécrite ; correction « non reconstituable » sans perte de valeur
 *  L113AK-U05  preuves : supprimé / purgé / transféré / fusionné / délié / archivé (historique légitime)
 *  L113AK-U06  contrôle COH-DOC-FACT-PROVENANCE : verdicts, anomalies, réparation automatique bornée
 *  L113AK-U07  déclarations : migration additive, couverture du diagnostic, recette, transfert, registre, rattrapage BO
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  factCorrection, partitionUnitRefs, qualifyEvidence, qualifyFact, relinkFromStored, resolveUnitRef,
  type FactDocumentContext, type StoredFactView, type StoredUnitView,
} from '../provenance-integrity';
import { verifierProvenanceHistorique } from '../jobs';

const ROOT = join(__dirname, '../../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const unites: StoredUnitView[] = [
  { sourceUnitId: 'page:1:table:1', kind: 'TABLE', page: 1, ordinal: 0, text: 'Entretien', payload: { tableIndex: 0 } },
  { sourceUnitId: 'page:1:table:1:row:1', kind: 'TABLE_ROW', page: 1, ordinal: 1, text: 'Vidange moteur | 89,90 €', payload: { cells: [{ value: 'Vidange moteur' }, { value: '89,90 €' }] } },
  { sourceUnitId: 'page:1:block:1', kind: 'TEXT_BLOCK', page: 1, ordinal: 2, text: 'Kilométrage relevé : 78 000 km au passage atelier' },
  { sourceUnitId: 'page:2:block:1', kind: 'TEXT_BLOCK', page: 2, ordinal: 3, text: 'Prochaine révision conseillée en mars 2027' },
];
const doc = (o: Partial<FactDocumentContext> = {}): FactDocumentContext => ({ exists: true, accountId: 10, deleted: false, currentExtractionId: 5, hasCoverage: true, ...o });
const fait = (o: Partial<StoredFactView> = {}): StoredFactView => ({
  id: 2386, accountId: 10, fileId: 347, extractionId: 5, status: 'active', sourceUnitIds: ['page:1:block:1'],
  excerpt: 'Kilométrage relevé : 78 000 km', location: { page: 1 }, evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null, ...o,
});

describe('L113AK-U01 — invariant documentaire', () => {
  it('unité du même document, cellule par sa ligne, identifiant seul jamais suffisant', () => {
    const ids = new Set(unites.map((u) => u.sourceUnitId));
    expect(resolveUnitRef('page:1:block:1', ids)).toBe('VALID');
    expect(resolveUnitRef('page:1:table:1:row:1:cell:2', ids)).toBe('VALID_CELL');
    expect(resolveUnitRef('page:1:table:1:row:2:cell:2', ids)).toBe('UNIT_MISSING');
    expect(resolveUnitRef('page:1:table:1:cell:2', ids)).toBe('UNIT_MISSING');
    expect(partitionUnitRefs(['page:1:block:1', 'page:9:block:9', 'page:1:block:1', ''], ids)).toEqual({ valid: ['page:1:block:1'], invalid: ['page:9:block:9'] });
  });

  it('identifiant de cellule répété dans un AUTRE document : aucune fausse correspondance', () => {
    // Document #347 sans tableau ; l'identifiant existe ailleurs dans le compte.
    const sansTableau = unites.filter((u) => !u.sourceUnitId.includes('table'));
    const q = qualifyFact(fait({ sourceUnitIds: ['page:1:table:1:row:1:cell:2'], excerpt: null, location: {} }), doc(), sansTableau, () => true);
    expect(q.state).toBe('BROKEN');
    expect(q.cause).toBe('UNIT_MISSING_ID_IN_OTHER_DOCUMENT');
    expect(q.refs).toEqual([{ ref: 'page:1:table:1:row:1:cell:2', status: 'UNIT_MISSING', elsewhere: true }]);
    expect(q.relinked).toBeNull();
    expect(factCorrection(q)).toEqual({ sourceUnitIds: null, provenanceStatus: 'NOT_RECONSTRUCTIBLE', eventStatus: 'NOT_RECONSTRUCTIBLE' });
  });
});

describe('L113AK-U02 — qualification d’un fait', () => {
  it('historique, hors périmètre, autre compte, version remplacée, couche en attente, valide', () => {
    const casse = { sourceUnitIds: ['page:7:block:7'] };
    expect(qualifyFact(fait({ ...casse, status: 'superseded' }), doc(), unites).state).toBe('HISTORICAL');
    expect(qualifyFact(fait(casse), doc({ deleted: true }), unites).state).toBe('OUT_OF_SCOPE');
    expect(qualifyFact(fait(casse), doc({ exists: false }), unites).state).toBe('OUT_OF_SCOPE');
    expect(qualifyFact(fait(casse), doc({ accountId: 11 }), unites)).toMatchObject({ state: 'SOURCE_UNLINKED', cause: 'DOCUMENT_IN_OTHER_ACCOUNT' });
    expect(qualifyFact(fait({ ...casse, extractionId: 4 }), doc(), unites).state).toBe('SUPERSEDED_VERSION');
    expect(qualifyFact(fait(casse), doc({ hasCoverage: false }), [])).toMatchObject({ state: 'LAYER_PENDING', cause: 'SOURCE_LAYER_NOT_BUILT' });
    expect(qualifyFact(fait(casse), doc(), [])).toMatchObject({ state: 'BROKEN', cause: 'SOURCE_LAYER_EMPTY' });
    expect(qualifyFact(fait(), doc(), unites).state).toBe('VALID');
    expect(qualifyFact(fait({ sourceUnitIds: ['page:1:table:1:row:1:cell:2'], excerpt: 'Vidange moteur' }), doc(), unites).state).toBe('VALID');
    expect(qualifyFact(fait({ sourceUnitIds: [], provenanceStatus: 'NOT_RECONSTRUCTIBLE' }), doc(), unites).state).toBe('NOT_RECONSTRUCTIBLE');
  });
});

describe('L113AK-U03 — provenance rétablie depuis la preuve conservée', () => {
  it('extrait conservé → unité du même document ; cellule conservée → adresse dérivée', () => {
    const q = qualifyFact(fait({ sourceUnitIds: ['page:3:block:12'] }), doc(), unites);
    expect(q).toMatchObject({ state: 'BROKEN', cause: 'UNIT_MISSING', relinked: ['page:1:block:1'] });
    expect(factCorrection(q)).toEqual({ sourceUnitIds: ['page:1:block:1'], provenanceStatus: 'RELINKED', eventStatus: 'RELINKED' });
    const cell = relinkFromStored({ excerpt: null, location: { table: { tableIndex: 0, row: 0, column: 1 } }, evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null }, unites);
    expect(cell).toEqual(['page:1:table:1:row:1:cell:2']);
  });

  it('valeur nue jamais utilisée comme preuve ; références valides conservées', () => {
    expect(relinkFromStored({ excerpt: null, location: {}, evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null }, unites)).toEqual([]);
    const q = qualifyFact(fait({ sourceUnitIds: ['page:2:block:1', 'page:9:block:1'], excerpt: 'texte introuvable dans ce document' }), doc(), unites);
    expect(factCorrection(q)).toEqual({ sourceUnitIds: ['page:2:block:1'], provenanceStatus: 'NOT_RECONSTRUCTIBLE', eventStatus: 'NOT_RECONSTRUCTIBLE' });
  });

  it('reprise historique de la couche A : provenance déjà posée vérifiée, rétablie ou retirée', () => {
    const base = { confidence: 'certain' as const, visual_evidence: null, value_text: '78000', normalized_value: '78000', label: 'Kilométrage', attribute: null, fact_key: 'mileage', evidence_origin: 'TEXT_EXTRACTION' };
    const r = verifierProvenanceHistorique([
      { ...base, id: 1, excerpt: 'Kilométrage relevé : 78 000 km', location: { page: 1 }, source_unit_ids: ['page:1:block:3'] },
      { ...base, id: 2, excerpt: 'autre chose', location: {}, source_unit_ids: ['page:4:block:1'] },
      { ...base, id: 3, excerpt: 'Kilométrage', location: {}, source_unit_ids: ['page:1:block:1'] },
      { ...base, id: 4, excerpt: 'x', location: {}, source_unit_ids: null },
    ], unites);
    expect(r).toEqual([
      { id: 1, before: ['page:1:block:3'], after: ['page:1:block:1'], invalid: ['page:1:block:3'], status: 'RELINKED' },
      { id: 2, before: ['page:4:block:1'], after: null, invalid: ['page:4:block:1'], status: 'NOT_RECONSTRUCTIBLE' },
    ]);
  });
});

describe('L113AK-U04 — contradiction', () => {
  it('unité présente sans l’extrait, extrait retrouvé ailleurs : constat, aucune correction', () => {
    const q = qualifyFact(fait({ sourceUnitIds: ['page:2:block:1'] }), doc(), unites);
    expect(q.state).toBe('BROKEN');
    expect(q.cause).toBe('UNIT_DOES_NOT_CONTAIN_EXCERPT');
    expect(q.refs[0].status).toBe('CONTRADICTION');
    expect(factCorrection(q)).toBeNull();
  });
});

describe('L113AK-U05 — preuves par champ', () => {
  const ev = (asset: Parameters<typeof qualifyEvidence>[0]['asset'], document: Parameters<typeof qualifyEvidence>[0]['document']) =>
    qualifyEvidence({ id: 1, accountId: 10, assetId: 6, sourceId: 53, asset, document });
  const vivant = { accountId: 10, deleted: false, status: 'EN_SERVICE' };
  const lie = { accountId: 10, deleted: false, merged: false, linkedToAsset: true };
  it('qualification sans ambiguïté', () => {
    expect(ev(null, lie)).toEqual({ status: 'ASSET_DELETED', withdraw: true });
    expect(ev({ ...vivant, deleted: true }, lie)).toEqual({ status: 'ASSET_DELETED', withdraw: true });
    expect(ev({ ...vivant, accountId: 22 }, lie)).toEqual({ status: 'ASSET_TRANSFERRED', withdraw: true });
    expect(ev(vivant, null)).toEqual({ status: 'DOCUMENT_PURGED', withdraw: true });
    expect(ev(vivant, { ...lie, accountId: 22 })).toEqual({ status: 'DOCUMENT_TRANSFERRED', withdraw: true });
    expect(ev(vivant, { ...lie, deleted: true })).toEqual({ status: 'DOCUMENT_DELETED', withdraw: true });
    expect(ev(vivant, { ...lie, deleted: true, merged: true })).toEqual({ status: 'DOCUMENT_MERGED', withdraw: true });
    expect(ev(vivant, { ...lie, linkedToAsset: false })).toEqual({ status: 'SOURCE_UNLINKED', withdraw: true });
    expect(ev({ ...vivant, status: 'TRANSMIS' }, lie)).toEqual({ status: 'HISTORICAL_ARCHIVED', withdraw: false });
    expect(ev(vivant, lie)).toEqual({ status: 'VALID', withdraw: false });
  });
});

describe('L113AK-U06 — contrôle COH-DOC-FACT-PROVENANCE', () => {
  it('verdicts : réparable (fait, preuve sans ambiguïté), constats, cohérent', async () => {
    const { inspectionOfProvenance } = await import('@/services/coherence/registry/checks/fact-provenance');
    const AUTO = new Set(['ASSET_DELETED', 'DOCUMENT_PURGED']);
    const st = (facts: ReturnType<typeof qualifyFact>[], evidence: Array<{ status: string; withdraw: boolean }> = []) => ({
      accountId: 10, fileId: 347, doc: doc(), facts,
      evidence: evidence.map((e, i) => ({ evidenceId: 100 + i, accountId: 10, assetId: 6, fileId: 347, fieldKey: 'mileage', lifecycleBefore: null, ...e })) as never,
    });
    const casse = qualifyFact(fait({ sourceUnitIds: ['page:3:block:12'] }), doc(), unites);
    expect(inspectionOfProvenance(st([casse]), AUTO)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACT_PROVENANCE_BROKEN', faultyLink: 'PERSISTENCE' });
    expect(inspectionOfProvenance(st([], [{ status: 'DOCUMENT_PURGED', withdraw: true }]), AUTO)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'EVIDENCE_ORPHANED' });
    expect(inspectionOfProvenance(st([], [{ status: 'SOURCE_UNLINKED', withdraw: true }]), AUTO)).toMatchObject({ verdict: 'FINDING', anomaly: 'EVIDENCE_SOURCE_UNLINKED' });
    const contra = qualifyFact(fait({ sourceUnitIds: ['page:2:block:1'] }), doc(), unites);
    expect(inspectionOfProvenance(st([contra]), AUTO)).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_PROVENANCE_CONTRADICTION' });
    const nr = qualifyFact(fait({ sourceUnitIds: [], provenanceStatus: 'NOT_RECONSTRUCTIBLE' }), doc(), unites);
    const i = inspectionOfProvenance(st([nr]), AUTO);
    expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_PROVENANCE_NOT_RECONSTRUCTIBLE' });
    expect(i.detail).toMatchObject({ accountId: 10, fileId: 347, facts: { notReconstructible: 1 } });
    expect(inspectionOfProvenance(st([qualifyFact(fait(), doc(), unites)], [{ status: 'HISTORICAL_ARCHIVED', withdraw: false }]), AUTO)).toMatchObject({ verdict: 'CONSISTENT' });
    // Même entrée → même empreinte (anti-boucle).
    expect(inspectionOfProvenance(st([casse]), AUTO).inputHash).toBe(inspectionOfProvenance(st([casse]), AUTO).inputHash);
  });

  it('registre : en fin de liste, réparations sans IA, contrat déclaré', async () => {
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    // Lot 113AQ : COH-OPS-ATTRIBUTE-CONFLICTS ajouté ensuite, en fin de registre.
    expect(ids.slice(ids.indexOf('COH-DOC-FACT-PROVENANCE'))).toEqual(['COH-DOC-FACT-PROVENANCE', 'COH-OPS-ATTRIBUTE-CONFLICTS']);
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-DOC-FACT-PROVENANCE')!;
    expect(c).toMatchObject({ status: 'ACTIVE', objectType: 'document', version: 1 });
    expect(c.forbiddenRepairs.join(' ')).toMatch(/autre document/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/IA/);
    const { UNAMBIGUOUS_EVIDENCE_WITHDRAWALS } = await import('../provenance-repair');
    expect(UNAMBIGUOUS_EVIDENCE_WITHDRAWALS.has('SOURCE_UNLINKED')).toBe(false);
  });
});

describe('L113AK-U07 — déclarations', () => {
  it('migration 1640 additive et idempotente', () => {
    const m = read('src/db/migrations/1640_l113ak_provenance_unites_sources.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS document_fact_provenance_events/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS provenance_status/);
    expect(m).not.toMatch(/DROP\s+(TABLE|COLUMN)\s+(?!IF)/i);
    expect(m).not.toMatch(/^\s*(DELETE|UPDATE|TRUNCATE)\b/im);
  });

  it('table déclarée : diagnostic, recette, transfert de bien ; référence fait → unité qualifiée par le document', async () => {
    const { DIAG_TABLE_COVERAGE, DIAG_LOGICAL_REFERENCES } = await import('@/services/admin/diagnostics-export/coverage');
    const { RECETTE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { FILE_SCOPED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    expect(DIAG_TABLE_COVERAGE.document_fact_provenance_events).toBeTruthy();
    expect(RECETTE_TABLES.document_fact_provenance_events).toBeTruthy();
    expect(FILE_SCOPED_TABLES).toContainEqual(['document_fact_provenance_events', 'file_id']);
    const ref = DIAG_LOGICAL_REFERENCES.find((r) => r.from === 'document_facts' && r.column === 'source_unit_ids')!;
    expect(ref).toMatchObject({ scope: { column: 'file_id', toColumn: 'file_id', cellToRow: true }, when: `t.status = 'active'` });
  });

  it('rattrapage BO n° 21 : simuler / appliquer (motif) / restaurer ; rapport par statut', async () => {
    const { backfillDefinition, validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    expect(backfillDefinition('source-unit-provenance')).toMatchObject({ order: 21, actions: ['simulate', 'apply', 'restore'], accountFilter: true });
    expect(validateBackfillRequest({ script: 'source-unit-provenance', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const rapport = {
      mode: 'simulate', runId: null, disabled: null, accounts: 1, documents: 15,
      facts: { examined: 120, valid: 40, historicalReferences: 8, outOfScope: 0, layerPending: 0, broken: 80, relinkable: 30, notReconstructible: 50,
        alreadyNotReconstructible: 0, contradictions: 0, supersededVersion: 0, sourceUnlinked: 0, crossDocumentIds: 12 },
      evidence: { examined: 30, valid: 12, historicalArchived: 0, byStatus: { ASSET_DELETED: 18 }, withdrawable: 18 },
      written: { relinked: 0, notReconstructible: 0, evidenceWithdrawn: 0, events: 0 }, assetsToReconcile: [],
      samples: [{ accountId: 10, fileId: 347, factId: 2386, unit: 'page:1:table:1:row:1:cell:2', status: 'NOT_RECONSTRUCTIBLE', cause: 'UNIT_MISSING_ID_IN_OTHER_DOCUMENT' }],
      more: false,
    };
    const s = summarizeBackfill('source-unit-provenance', 'simulate', null, { result: rapport });
    expect(s.headline).toMatch(/80 fait\(s\) à lien cassé \(30 rétabli\(s\), 50 non reconstituable\(s\)\), 18 preuve\(s\)/);
    expect(s.conflicts.samples[0]).toMatch(/compte 10 · document 347 · fait 2386 · unité page:1:table:1:row:1:cell:2 — provenance non reconstituable/);
    expect(s.restorable).toBe(false);
    const r = summarizeBackfill('source-unit-provenance', 'restore', null, { result: { runId: 'x', facts: 2, evidence: 1, skipped: 0 } });
    expect(r.headline).toMatch(/2 fait\(s\) et 1 preuve\(s\)/);
  });

  it('causes corrigées visibles dans le code', () => {
    const k = read('src/services/ai/knowledge/document-knowledge.service.ts');
    expect(k).toMatch(/partitionUnitRefs\(f\.sourceUnitIds, unites\)/);
    expect(k).toMatch(/cause: 'SOURCE_LAYER_NOT_WRITTEN'/);
    expect(read('src/app/api/documents/[id]/fusion/route.ts').match(/retireMergedDocumentEvidence\(/g)).toHaveLength(2);
    expect(read('src/lib/cleanup-job.ts')).toMatch(/UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN'/);
    expect(read('src/services/ai/source-analysis/source-units/jobs.ts')).toMatch(/verifierProvenanceHistorique\(facts, b\.layer\.units\)/);
  });
});
