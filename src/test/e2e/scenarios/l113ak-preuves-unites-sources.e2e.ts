/**
 * Lot 113AK (Trello #736) sur PostgreSQL 16 réel — « T1 / Preuves — Réparer
 * les liens vers unités sources et assainir les preuves orphelines ».
 * Aucun appel IA (aucun enregistrement de rejeu fourni : tout appel échouerait).
 *
 *  L113AK-E01  migration 1640 additive et rejouable
 *  L113AK-E02  persistance T1 : références validées DANS le document (cellule par sa ligne), référence absente
 *              retirée et journalisée — même identifiant présent dans un AUTRE document : jamais une correspondance
 *  L113AK-E03  cause démontrée : couche A en échec (point de sauvegarde) → aucun fait actif vers une unité absente
 *              ni vers les unités de l'analyse PRÉCÉDENTE ; journal SOURCE_LAYER_NOT_WRITTEN
 *  L113AK-E04  réanalyse / supersession : provenance valide, anciens faits = historique légitime (non signalés)
 *  L113AK-E05  reprise historique de la couche A : provenance déjà posée vérifiée, rétablie ou retirée, journalisée
 *  L113AK-E06  état « compte 10 » : rattrapage BO simuler (rien écrit) / appliquer (motif) / rejouer (aucun doublon) /
 *              restaurer ; aucune fausse correspondance interdocuments ; valeur des faits intacte ; biens archivés intacts
 *  L113AK-E07  suppression / fusion / transfert / détachement : preuve historique conservée, plus aucune preuve active
 *              indûment applicable ; journal suit le document au transfert
 *  L113AK-E08  auto-contrôle : COH-DOC-FACT-PROVENANCE (campagne réelle) répare sans ambiguïté, constate le reste avec
 *              motif ; export diagnostic : référence fait → unité vérifiée dans le même document
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import type { DocumentKnowledge, DocumentFactRecord } from '@/services/ai/knowledge/document-knowledge';
import type { ExtractedTable } from '@/services/ai/source-analysis/types';

process.env.DIAG_SYNC_HTTP = 'on';
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;

const TEXTE = 'Facture atelier n° FA-2026-118\n\nKilométrage relevé : 78 000 km au passage atelier\n\nProchaine révision conseillée en mars 2027';
const table = (lignes: Array<[string, string]>): ExtractedTable => ({
  index: 0, title: 'Prestations', pageStart: 1, pageEnd: 1, columns: [{ header: 'Libellé', path: ['Libellé'] }, { header: 'Montant', path: ['Montant'] }],
  rowCount: lignes.length, columnCount: 2, confidence: 'certain', uncertain: false, issues: [],
  cells: lignes.flatMap(([l, m], row) => [
    { row, column: 0, rowHeader: null, columnHeader: 'Libellé', columnPath: ['Libellé'], value: l, normalized: l, valueType: 'string', colspan: 1, rowspan: 1, page: 1, confidence: 'certain' as const },
    { row, column: 1, rowHeader: null, columnHeader: 'Montant', columnPath: ['Montant'], value: m, normalized: m, valueType: 'amount', colspan: 1, rowspan: 1, page: 1, confidence: 'certain' as const },
  ]),
});

scenario('L113AK', 'T1 / preuves : liens vers unités sources et preuves orphelines', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });

  const couche = async (accountId: number, fileId: number, tables: ExtractedTable[], texte = TEXTE) => {
    const { backfillLayer } = await import('@/services/ai/source-analysis/source-units/jobs');
    return backfillLayer({
      extraction: {
        id: 0, account_id: accountId, file_id: fileId, full_text: texte, title: 'Facture atelier', description: null, document_date: '2026-03-02',
        supplier_name: null, supplier_siret: null, amount_cents: null, document_type_code: 'FACTURE', rubric_code: null, visual_summary: null,
        visual_observations: [], structural_evidence: {},
      },
      tables, facts: [],
    }).layer;
  };
  const unitDe = (layer: Awaited<ReturnType<typeof couche>>, contient: string) => layer.units.find((u) => (u.kind === 'TEXT_BLOCK' || u.kind === 'LABEL_VALUE') && (u.text ?? '').includes(contient))!.sourceUnitId;
  const fait = (key: string, value: string, excerpt: string, ids: string[], over: Partial<DocumentFactRecord> = {}): DocumentFactRecord => ({
    factKey: key, subject: null, attribute: null, label: key, valueText: value, valueNumber: null, valueUnit: null, valueJson: value,
    normalizedValue: value, periodStart: null, periodEnd: null, confidence: 'certain', excerpt, location: { page: 1 },
    evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null, sourceUnitIds: ids, ...over,
  });
  const connaissance = (accountId: number, fileId: number, facts: DocumentFactRecord[], layer?: DocumentKnowledge['sourceLayer'], tables: ExtractedTable[] = []): DocumentKnowledge => ({
    extraction: {
      accountId, fileId, analysisRunId: null, assetIdAtAnalysis: null, engine: 'source_analysis', sourceType: 'asset_file', sourceVersion: null,
      title: 'Facture atelier', description: null, documentDate: '2026-03-02', supplierName: null, supplierSiret: null, amountCents: null, currency: 'EUR',
      fullText: TEXTE, visualSummary: null, visualObservations: [], documentTypeCode: 'FACTURE', rubricCode: null, hasExploitableContent: true,
      structuralEvidence: {}, metadata: {}, provider: 'gemini', model: 'e2e', promptVersion: 't1@e2e', operationTraceId: null,
    },
    facts, tables, ...(layer ? { sourceLayer: layer } : {}),
  });
  const persister = async (k: DocumentKnowledge) => (await import('@/services/ai/knowledge/document-knowledge.service')).persistDocumentKnowledgeDetailed(k);
  const faitsActifs = (fileId: number) => sql<Json[]>`SELECT id::float8 AS id, fact_key, value_text, source_unit_ids, provenance_status FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const journal = (fileId: number) => sql<Json[]>`SELECT fact_id::float8 AS fact_id, evidence_id, source_unit_id, status, cause, phase, run_id, detail, reverted_at
    FROM document_fact_provenance_events WHERE file_id = ${fileId} ORDER BY id`;
  const preuve = async (accountId: number, assetId: number, sourceId: number, key: string, over: { lifecycle?: string } = {}) => Number((await sql<{ id: number }[]>`
    INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, normalized_value, source_type, source_id, source_location, evidence_excerpt,
                                confidence, authority_score, status, lifecycle_status, fingerprint, target_type, target_entity_id)
    VALUES (${accountId}, ${assetId}, ${key}, ${key}, '"78000"'::jsonb, '78000', 'document', ${sourceId}, '{}'::jsonb, 'Kilométrage relevé : 78 000 km',
            'certain', 80, 'active', ${over.lifecycle ?? 'ACTIVE'}, ${`l113ak-${assetId}-${sourceId}-${key}-${Math.random()}`}, 'ASSET', ${assetId})
    RETURNING id`)[0].id);
  const lifecycle = async (id: number) => (await sql<{ l: string | null }[]>`SELECT lifecycle_status AS l FROM field_evidence WHERE id = ${id}`)[0]?.l ?? null;
  /** Données historiques (avant le lot 113AK) : gardes d'isolation contournées, comme l'état réel du compte 10. */
  const historique = async (f: (tx: typeof sql) => Promise<unknown>) => sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await f(tx as unknown as typeof sql);
  });

  it('L113AK-E01 — migration 1640 : additive, rejouable', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations', '1640_l113ak_provenance_unites_sources.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = {
        unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown>,
        reserve: async () => {
          const r = await sql.reserve();
          return { unsafe: (q: string, p?: never[]) => r.unsafe(q, p as never) as unknown as Promise<unknown>, release: () => r.release() };
        },
      };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally { cnx.release(); }
    const [n] = await sql<{ t: boolean; c: boolean }[]>`SELECT to_regclass('document_fact_provenance_events') IS NOT NULL AS t,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'document_facts' AND column_name = 'provenance_status') AS c`;
    expect(n).toEqual({ t: true, c: true });
  });

  it('L113AK-E02 — persistance : invariant compte + document + unité ; identifiant d’un autre document refusé', async () => {
    const c = await make.account({ plan: 'premium' });
    const autre = await make.assetFile(c);
    const doc = await make.assetFile(c);
    // L'AUTRE document a deux lignes de tableau ; celui-ci une seule : `…:row:2:cell:2` n'existe que là-bas.
    await persister(connaissance(c.id, autre.id, [], await couche(c.id, autre.id, [table([['Pneus', '320,00 €'], ['Vidange', '89,90 €']])])));
    const layer = await couche(c.id, doc.id, [table([['Vidange', '89,90 €']])]);
    const bloc = unitDe(layer, 'Kilométrage');
    const r = await persister(connaissance(c.id, doc.id, [
      fait('mileage', '78000', 'Kilométrage relevé : 78 000 km', [bloc]),
      fait('price', '89,90', 'Vidange | 89,90 €', ['page:1:table:1:row:1:cell:2']),
      fait('tyres', '320,00', 'Pneus | 320,00 €', ['page:1:table:1:row:2:cell:2']),
    ], layer));
    expect(r.sourceLayer).toBe('WRITTEN');
    const faits = await faitsActifs(doc.id);
    expect(faits.map((f) => [f.fact_key, f.source_unit_ids])).toEqual([
      ['mileage', [bloc]], ['price', ['page:1:table:1:row:1:cell:2']], ['tyres', null],
    ]);
    // Valeur du fait conservée : seule la référence invalide est retirée.
    expect(faits[2].value_text).toBe('320,00');
    expect(await journal(doc.id)).toEqual([expect.objectContaining({
      fact_id: faits[2].id, source_unit_id: 'page:1:table:1:row:2:cell:2', status: 'UNIT_MISSING', cause: 'UNIT_NOT_IN_WRITTEN_LAYER', phase: 'PERSISTENCE',
    })]);
    const { inspectFileProvenance } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    const st = (await inspectFileProvenance(sql, c.id, [doc.id])).get(doc.id)!;
    expect(st.facts.map((f) => f.state)).toEqual(['VALID', 'VALID']);
  });

  it('L113AK-E03 — couche A en échec : aucun fait actif vers une unité absente ou de l’analyse précédente', async () => {
    const c = await make.account({ plan: 'premium' });
    const doc = await make.assetFile(c);
    const v1 = await couche(c.id, doc.id, []);
    const ancien = unitDe(v1, 'Kilométrage');
    await persister(connaissance(c.id, doc.id, [fait('mileage', '78000', 'Kilométrage relevé : 78 000 km', [ancien])], v1));
    // Nouvelle analyse : la couche A échoue (unité invalide → point de sauvegarde annulé) ; les unités d'avant restent.
    const v2 = await couche(c.id, doc.id, [], `Avoir n° AV-2\n\n${TEXTE}`);
    const nouveau = unitDe(v2, 'Kilométrage');
    v2.units.push({ ...v2.units[0], sourceUnitId: 'page:1:bogus:1', kind: 'BOGUS' as never });
    const r = await persister(connaissance(c.id, doc.id, [fait('mileage', '78000', 'Kilométrage relevé : 78 000 km', [nouveau])], v2));
    expect(r.sourceLayer).toBe('FAILED');
    const faits = await faitsActifs(doc.id);
    expect(faits).toHaveLength(1);
    expect(faits[0].source_unit_ids).toBeNull();
    expect((await journal(doc.id)).filter((j) => j.cause === 'SOURCE_LAYER_NOT_WRITTEN')).toEqual([
      expect.objectContaining({ fact_id: faits[0].id, source_unit_id: nouveau, status: 'UNIT_MISSING', phase: 'PERSISTENCE' }),
    ]);
  });

  it('L113AK-E04 — réanalyse / supersession : provenance valide, anciens faits = historique légitime', async () => {
    const c = await make.account({ plan: 'premium' });
    const doc = await make.assetFile(c);
    const v1 = await couche(c.id, doc.id, [table([['Pneus', '320,00 €'], ['Vidange', '89,90 €']])]);
    await persister(connaissance(c.id, doc.id, [fait('tyres', '320,00', 'Pneus | 320,00 €', ['page:1:table:1:row:2:cell:2'])], v1));
    const v2 = await couche(c.id, doc.id, [table([['Pneus', '320,00 €']])]);
    await persister(connaissance(c.id, doc.id, [fait('tyres', '320,00', 'Pneus | 320,00 €', ['page:1:table:1:row:1:cell:2'])], v2));
    const [ancien] = await sql<Json[]>`SELECT status, source_unit_ids FROM document_facts WHERE file_id = ${doc.id} AND status <> 'active'`;
    expect(ancien).toEqual({ status: 'superseded', source_unit_ids: ['page:1:table:1:row:2:cell:2'] });
    const { inspectFileProvenance, runProvenanceCatchup } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    const st = (await inspectFileProvenance(sql, c.id, [doc.id])).get(doc.id)!;
    expect(st.facts.map((f) => f.state)).toEqual(['VALID']);
    const sim = await runProvenanceCatchup({ sql, apply: false, accountId: c.id });
    expect(sim.facts).toMatchObject({ broken: 0, historicalReferences: 1, valid: 1 });
  });

  it('L113AK-E05 — reprise historique de la couche A : provenance déjà posée vérifiée, rétablie ou retirée', async () => {
    const c = await make.account({ plan: 'premium' });
    const doc = await make.assetFile(c);
    const [ex] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars, title, fact_count)
      VALUES (${c.id}, ${doc.id}, ${TEXTE}, ${TEXTE.length}, 'Facture atelier', 2) RETURNING id`;
    // Faits d'une analyse dont la couche A n'a jamais été écrite : identifiants de cette analyse-là.
    const [a] = await sql<{ id: number }[]>`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, location, status, source_unit_ids)
      VALUES (${c.id}, ${doc.id}, ${ex.id}, 'mileage', 'Kilométrage', '78000', 'certain', 'Kilométrage relevé : 78 000 km', '{"page":1}', 'active', ${['page:2:block:9']}) RETURNING id`;
    const [b] = await sql<{ id: number }[]>`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, location, status, source_unit_ids)
      VALUES (${c.id}, ${doc.id}, ${ex.id}, 'ref', 'Référence', 'X-1', 'certain', 'texte disparu', '{}', 'active', ${['page:3:block:1']}) RETURNING id`;
    const { runSourceUnitsBackfill } = await import('@/services/ai/source-analysis/source-units/jobs');
    const r = await runSourceUnitsBackfill({ maxBatches: 50 });
    expect(r.failed).toBe(0);
    const faits = await faitsActifs(doc.id);
    const bloc = (await sql<{ id: string }[]>`SELECT source_unit_id AS id FROM document_source_units WHERE file_id = ${doc.id} AND content_text LIKE '%Kilométrage%'`)[0].id;
    expect(faits.map((f) => [f.id, f.source_unit_ids, f.provenance_status])).toEqual([[Number(a.id), [bloc], 'RELINKED'], [Number(b.id), null, 'NOT_RECONSTRUCTIBLE']]);
    expect((await journal(doc.id)).map((j) => [j.fact_id, j.status, j.phase])).toEqual([[Number(a.id), 'RELINKED', 'BACKFILL'], [Number(b.id), 'NOT_RECONSTRUCTIBLE', 'BACKFILL']]);
  });

  // ── État « compte 10 » ────────────────────────────────────────────────────
  const etat: Json = {};
  beforeAll(async () => {
    const c = await make.account({ plan: 'premium', name: 'Compte 10 L113AK' });
    const ailleurs = await make.account({ plan: 'premium' });
    const vivant = await make.asset(c, { name: 'Bien #31' });
    const archive = await make.asset(c, { name: 'Bien vendu' });
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${archive.id}`;
    const supprime = await make.asset(c, { name: 'Ancien bien #6' });
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${supprime.id}`;
    const parti = await make.asset(c, { name: 'Ancien bien #9' });
    const d347 = await make.assetFile(c, { assetId: vivant.id });
    const dTableau = await make.assetFile(c, { assetId: vivant.id });
    const dSupprime = await make.assetFile(c, { assetId: vivant.id });
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${dSupprime.id}`;
    const dAilleurs = await make.assetFile(c, { assetId: archive.id });
    // #347 : pas de tableau ; un autre document du compte en a un (même identifiant de cellule).
    const k347 = await couche(c.id, d347.id, []);
    await persister(connaissance(c.id, d347.id, [], k347));
    await persister(connaissance(c.id, dTableau.id, [], await couche(c.id, dTableau.id, [table([['Vidange', '89,90 €']])])));
    const [ex] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${d347.id}`;
    const insFait = (key: string, value: string, excerpt: string | null, ids: string[]) => sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, location, status, source_unit_ids, evidence_origin)
      VALUES (${c.id}, ${d347.id}, ${ex.id}, ${key}, ${key}, ${value}, 'certain', ${excerpt}, '{}', 'active', ${ids}, 'TEXT_EXTRACTION') RETURNING id`.then((r) => Number(r[0].id));
    etat.fait2386 = await insFait('price', '89,90', 'Montant : 89,90', ['page:1:table:1:row:1:cell:2']);
    etat.faitRelie = await insFait('mileage', '78000', 'Kilométrage relevé : 78 000 km', ['page:4:block:2']);
    etat.faitValide = await insFait('nextService', 'mars 2027', 'Prochaine révision conseillée en mars 2027', [unitDe(k347, 'Prochaine')]);
    etat.evSupprime = await preuve(c.id, supprime.id, d347.id, 'mileage');
    etat.evDocSupprime = await preuve(c.id, vivant.id, dSupprime.id, 'mileage');
    etat.evDocPurge = await preuve(c.id, vivant.id, 987_654, 'mileage');
    etat.evArchive = await preuve(c.id, archive.id, dAilleurs.id, 'mileage');
    etat.evValide = await preuve(c.id, vivant.id, d347.id, 'mileage');
    etat.evDeliee = await preuve(c.id, vivant.id, dAilleurs.id, 'mileage');
    await historique(async (tx) => {
      await tx`UPDATE assets SET account_id = ${ailleurs.id} WHERE id = ${parti.id}`;
      etat.evTransfere = Number((await tx<{ id: number }[]>`
        INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, evidence_excerpt, confidence, status, lifecycle_status, fingerprint)
        VALUES (${c.id}, ${parti.id}, 'mileage', '"1"'::jsonb, 'document', ${d347.id}, 'x', 'certain', 'active', 'ACTIVE', ${`l113ak-t-${Math.random()}`}) RETURNING id`)[0].id);
    });
    Object.assign(etat, { c, ailleurs, vivant, archive, d347, dTableau });
  });

  it('L113AK-E06 — rattrapage BO : simuler, appliquer, rejouer sans doublon, restaurer', async () => {
    const { c, d347 } = etat;
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const hooks = { log: () => {}, progress: () => {} };
    const run = (action: 'simulate' | 'apply' | 'restore', runId: string | null = null) =>
      executeBackfill(sql, { script: 'source-unit-provenance', action, step: null, runId, accountId: c.id, reason: action === 'simulate' ? null : 'recette 113AK' }, hooks);
    const avant = await faitsActifs(d347.id);

    const sim = (await run('simulate')).result as Json;
    expect(sim.facts).toMatchObject({ broken: 2, relinkable: 1, notReconstructible: 1, crossDocumentIds: 1, valid: 1 });
    expect(sim.evidence.byStatus).toEqual({ ASSET_DELETED: 1, ASSET_TRANSFERRED: 1, DOCUMENT_DELETED: 1, DOCUMENT_PURGED: 1, SOURCE_UNLINKED: 1 });
    expect(sim.evidence).toMatchObject({ withdrawable: 5, historicalArchived: 1 });
    expect(sim.samples).toContainEqual(expect.objectContaining({ accountId: c.id, fileId: d347.id, factId: etat.fait2386, unit: 'page:1:table:1:row:1:cell:2', status: 'NOT_RECONSTRUCTIBLE', cause: 'UNIT_MISSING_ID_IN_OTHER_DOCUMENT' }));
    expect(await faitsActifs(d347.id)).toEqual(avant);
    expect(await lifecycle(etat.evSupprime)).toBe('ACTIVE');
    expect(summarizeBackfill('source-unit-provenance', 'simulate', null, { result: sim }).headline).toMatch(/2 fait\(s\) à lien cassé/);

    const app = (await run('apply')).result as Json;
    expect(app.written).toEqual({ relinked: 1, notReconstructible: 1, evidenceWithdrawn: 5, events: 7 });
    const apres = new Map((await faitsActifs(d347.id)).map((f) => [f.id, f]));
    // Aucune fausse correspondance : la cellule d'un AUTRE document n'est jamais retenue ; valeur intacte.
    expect(apres.get(etat.fait2386)).toMatchObject({ source_unit_ids: null, provenance_status: 'NOT_RECONSTRUCTIBLE', value_text: '89,90' });
    expect(apres.get(etat.faitRelie)).toMatchObject({ provenance_status: 'RELINKED', value_text: '78000' });
    expect((apres.get(etat.faitRelie)!.source_unit_ids as string[])[0]).toMatch(/^page:1:(block|field):\d+$/);
    for (const id of [etat.evSupprime, etat.evDocSupprime, etat.evDocPurge, etat.evDeliee, etat.evTransfere]) expect(await lifecycle(id)).toBe('WITHDRAWN');
    for (const id of [etat.evArchive, etat.evValide]) expect(await lifecycle(id)).toBe('ACTIVE');
    // Historique conservé : aucune ligne supprimée.
    expect((await sql`SELECT id FROM field_evidence WHERE id = ANY(${[etat.evSupprime, etat.evDocPurge]}::int[])`).length).toBe(2);

    const rejeu = (await run('apply')).result as Json;
    expect(rejeu.written).toEqual({ relinked: 0, notReconstructible: 0, evidenceWithdrawn: 0, events: 0 });
    expect(rejeu.facts).toMatchObject({ broken: 0, alreadyNotReconstructible: 1 });

    const rest = (await run('restore', app.runId)).result as Json;
    expect(rest).toMatchObject({ facts: 2, evidence: 4, skipped: 1 }); // preuve du bien transféré : garde d'isolation, laissée retirée
    expect((await faitsActifs(d347.id)).find((f) => f.id === etat.fait2386)).toMatchObject({ source_unit_ids: ['page:1:table:1:row:1:cell:2'], provenance_status: null });
    expect(await lifecycle(etat.evSupprime)).not.toBe('WITHDRAWN');
    expect((await sql`SELECT id FROM document_fact_provenance_events WHERE run_id = ${app.runId}::uuid AND reverted_at IS NOT NULL`).length).toBe(6);
    // Nouvelle application (état final de la recette).
    const re = (await run('apply')).result as Json;
    expect(re.written).toMatchObject({ relinked: 1, notReconstructible: 1, evidenceWithdrawn: 4 });
  });

  it('L113AK-E07 — suppression, fusion, transfert, détachement : plus de preuve active indûment applicable', async () => {
    const c = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const bien = await make.asset(c);
    const autreBien = await make.asset(c);
    const garde = await make.assetFile(c, { assetId: bien.id });
    const fusionne = await make.assetFile(c, { assetId: bien.id });
    const ev = await preuve(c.id, bien.id, fusionne.id, 'mileage');
    // Fusion (« merge ») : document candidat en corbeille ET cycle de vie des preuves.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${fusionne.id}`;
    const { retireMergedDocumentEvidence } = await import('@/services/documents/document-fusion-lifecycle');
    await retireMergedDocumentEvidence({ accountId: c.id, userId: c.ownerUserId, fileId: fusionne.id, keptFileId: garde.id });
    expect(await lifecycle(ev)).toBe('WITHDRAWN');
    expect((await journal(fusionne.id)).map((j) => [j.status, j.phase])).toEqual([['DOCUMENT_MERGED', 'LIFECYCLE']]);
    // Détachement / déplacement par le cycle de vie existant : preuve sur l'ancien bien retirée.
    const deplace = await make.assetFile(c, { assetId: bien.id });
    const ev2 = await preuve(c.id, bien.id, deplace.id, 'mileage');
    await sql`UPDATE asset_files SET asset_id = ${autreBien.id} WHERE id = ${deplace.id}`;
    const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    await onDocumentAssetChanged({ accountId: c.id, userId: c.ownerUserId, fileId: deplace.id, fromAssetId: bien.id, toAssetId: autreBien.id });
    expect(await lifecycle(ev2)).toBe('WITHDRAWN');
    // Transfert du bien : ses documents, faits, preuves ET le journal de provenance suivent ; rien d'actif ne reste orphelin.
    await sql`INSERT INTO document_fact_provenance_events (account_id, file_id, subject, status, cause, phase) VALUES (${c.id}, ${garde.id}, 'FACT', 'RELINKED', 'e2e', 'CHECK')`;
    const ev3 = await preuve(c.id, bien.id, garde.id, 'mileage');
    const { db } = await import('@/db');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    await db.transaction(async (tx) => {
      await tx.execute((await import('drizzle-orm')).sql`UPDATE assets SET account_id = ${b.id} WHERE id = ${bien.id}`);
      await transferAssetDataInTx(tx, { assetId: bien.id, fromAccountId: c.id, toAccountId: b.id });
    });
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM document_fact_provenance_events WHERE file_id = ${garde.id}`).map((x) => x.a)).toEqual([b.id]);
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM field_evidence WHERE id = ${ev3}`)[0].a).toBe(b.id);
    const { runProvenanceCatchup } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    for (const a of [c.id, b.id]) expect((await runProvenanceCatchup({ sql, apply: false, accountId: a })).evidence.withdrawable).toBe(0);
    // Suppression du bien (route : suppression puis cycle de vie) : aucune preuve active ne cite ses documents.
    const autreDoc = await make.assetFile(c, { assetId: autreBien.id });
    const ev4 = await preuve(c.id, autreBien.id, autreDoc.id, 'mileage');
    const tiers = await make.asset(c);
    const ev5 = await preuve(c.id, tiers.id, autreDoc.id, 'mileage');
    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    const { onAssetDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    const del = await deleteAssetCompletely({ id: autreBien.id });
    await onAssetDeleted({ accountId: c.id, userId: c.ownerUserId, assetId: autreBien.id, fileIds: del.fileIds });
    expect(await lifecycle(ev4)).not.toBe('ACTIVE'); // emportée par la cascade du bien, ou retirée par le cycle de vie
    expect(await lifecycle(ev5)).toBe('WITHDRAWN');
    expect((await runProvenanceCatchup({ sql, apply: false, accountId: c.id })).evidence.withdrawable).toBe(0);
  });

  it('L113AK-E08 — auto-contrôle : contrôle de cohérence et export diagnostic', async () => {
    const c = await make.account({ plan: 'premium' });
    const bien = await make.asset(c);
    const autreBien = await make.asset(c);
    const doc = await make.assetFile(c, { assetId: bien.id });
    const cible = await make.assetFile(c, { assetId: bien.id });
    const layer = await couche(c.id, doc.id, [table([['Vidange', '89,90 €']])]);
    await persister(connaissance(c.id, doc.id, [], layer));
    await persister(connaissance(c.id, cible.id, [], await couche(c.id, cible.id, [table([['Pneus', '320,00 €'], ['Vidange', '89,90 €']])])));
    const [ex] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${doc.id}`;
    const ins = (ids: string[], excerpt: string) => sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, location, status, source_unit_ids)
      VALUES (${c.id}, ${doc.id}, ${ex.id}, 'k', 'k', 'v', 'certain', ${excerpt}, '{}', 'active', ${ids}) RETURNING id`.then((r) => Number(r[0].id));
    const casse = await ins(['page:1:table:1:row:2:cell:2'], 'introuvable ici');
    const cellule = await ins(['page:1:table:1:row:1:cell:2'], 'Vidange');
    const purge = await preuve(c.id, bien.id, 555_555, 'mileage');
    const deliee = await make.assetFile(c, { assetId: autreBien.id });
    const evDeliee = await preuve(c.id, bien.id, deliee.id, 'mileage');

    const r1 = await runCoherenceFor(sql, [c.id]);
    expect(r1.results['COH-DOC-FACT-PROVENANCE']).toMatchObject({ FINDING: 2 });
    // Document : lien cassé réparé (« non reconstituable ») → écart subsistant avec son motif.
    const p = await proofOf(sql, c.id, 'COH-DOC-FACT-PROVENANCE', doc.id);
    expect(p?.finding).toMatchObject({ anomaly: 'FACT_PROVENANCE_NOT_RECONSTRUCTIBLE' });
    expect(JSON.stringify(p?.finding)).toContain(String(casse));
    const faits = await faitsActifs(doc.id);
    expect(faits.find((f) => f.id === casse)).toMatchObject({ source_unit_ids: null, provenance_status: 'NOT_RECONSTRUCTIBLE' });
    expect(faits.find((f) => f.id === cellule)).toMatchObject({ source_unit_ids: ['page:1:table:1:row:1:cell:2'], provenance_status: null });
    // Document purgé : preuve retirée sans ambiguïté (REPAIRED) ; document seulement délié : constat, preuve intacte.
    expect(await lifecycle(purge)).toBe('WITHDRAWN');
    expect((await proofOf(sql, c.id, 'COH-DOC-FACT-PROVENANCE', 555_555))?.last_result).toBe('REPAIRED');
    expect(await proofOf(sql, c.id, 'COH-DOC-FACT-PROVENANCE', deliee.id)).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'EVIDENCE_SOURCE_UNLINKED' }) });
    expect(await lifecycle(evDeliee)).toBe('ACTIVE');
    const j = await sql<Json[]>`SELECT phase, status FROM document_fact_provenance_events WHERE account_id = ${c.id} ORDER BY id`;
    expect(j).toEqual([{ phase: 'CHECK', status: 'NOT_RECONSTRUCTIBLE' }, { phase: 'CHECK', status: 'DOCUMENT_PURGED' }]);
    // Second passage : rien de plus écrit (idempotent).
    await runCoherenceFor(sql, [c.id]);
    expect((await sql`SELECT id FROM document_fact_provenance_events WHERE account_id = ${c.id}`).length).toBe(2);

    // Export diagnostic : référence fait → unité vérifiée DANS le même document (la cellule de l'autre document n'est pas comptée).
    await sql`UPDATE document_facts SET source_unit_ids = ${['page:1:table:1:row:2:cell:2']} WHERE id = ${casse}`;
    const u = await make.user({ role: 'ADMIN' });
    Object.assign(session, { userId: u.id, role: 'ADMIN', email: u.email });
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const { NextRequest } = await import('next/server');
    const GET = (await import('@/app/api/admin/diagnostics/route')).GET as unknown as (r: unknown) => Promise<Response>;
    const res = await GET(new NextRequest(`http://app.test/api/admin/diagnostics?scope=account&id=${c.id}&period=all&format=zip`));
    expect(res.status).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const refs = JSON.parse(await z.file('controle/references.json')!.async('string')) as Json;
    const ref = (refs.references as Json[]).find((r) => r.from === 'document_facts' && r.column === 'source_unit_ids')!;
    expect(ref.absentes).toEqual([`${doc.id}|page:1:table:1:row:2`]);
    expect(ref.resolues).toBeGreaterThanOrEqual(1);
    const fichiers = Object.keys(z.files);
    expect(fichiers.some((f) => f.includes('document_fact_provenance_events'))).toBe(true);
  });
});
