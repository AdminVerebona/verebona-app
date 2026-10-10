/**
 * Lot 34F sur base réelle — ticket « T1 — Garantir une extraction
 * exhaustive, persistée et réexploitable ». Cas obligatoires T1X-01 à
 * T1X-08, sorties modèle simulées par le rejeu (`replay-gateway`) derrière la
 * passerelle RÉELLE, point d'entrée de production (`analyzeFileSources`).
 *
 * Vérifie l'ÉTAT FINAL en base : `document_source_units` (couche A),
 * `document_extraction_coverage` (rapport, somme = total, état de qualité),
 * `document_unresolved_facts` (rien n'est supprimé), `document_facts.
 * source_unit_ids` (provenance), reprise des documents historiques sans
 * réanalyse, reprise ciblée des documents INCOMPLETE_RETRYABLE, anomalies.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** PDF servi au découpage par pages : jamais de lecture S3 réelle. */
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null, fetched: 0 }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => { pdf.fetched++; return pdf.bytes; },
}));

type Compte = { id: number; ownerUserId: number };
type Fait = Record<string, unknown>;

const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[]; tables?: unknown[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Relevé de compteurs 2026', confidence: 'certain', evidence: { excerpt: 'Relevé de compteurs 2026', page: 1 } },
    documentDate: { value: '2026-03-02', confidence: 'certain', evidence: { excerpt: 'Relevé de compteurs 2026', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: p.tables ?? [],
  facts: p.facts ?? [],
  hasExploitableContent: true,
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput =>
  ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
/** Passe de réparation ciblée : son prompt porte l'identifiant des unités. */
const REPARATION = (output: unknown, over: Partial<RecordedOutput> = {}) => T1(output, { promptIncludes: '[page:1:field:', ...over });

scenario('L34F', 'T1 — extraction exhaustive, persistée et réexploitable (T1X-01 à T1X-08)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const fichier = async (compte: Compte, assetId: number | null = null) => {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`releve-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  /** Analyse par le point d'entrée de production. Les enregistrements CIBLÉS (réparation, lots) viennent AVANT la sortie principale. */
  const analyser = async (compte: Compte, fileId: number, records: RecordedOutput[]) => {
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l34f' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const appelsT1 = (replay: { calls: Array<{ operationCode?: string; attachments: unknown[]; prompt: string }> }) =>
    replay.calls.filter((c) => c.operationCode === 't1_analyze_document');
  const couverture = async (fileId: number) => (await sql<Array<Record<string, unknown>>>`
    SELECT total_units, covered_units, non_informational_units, unresolved_units, uncertain_units, failed_units, facts_count,
           dropped_facts_count, truncated_sections_count, batched_sections_count, chunk_count, repair_pass_count,
           coverage_ratio::float8 AS coverage_ratio, quality_state, anomalies, origin, retry_attempts, next_retry_at
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const unites = async (fileId: number) => sql<Array<{ source_unit_id: string; kind: string; page: number | null; content_text: string | null; coverage_status: string; coverage_reason: string | null; value_text: string | null }>>`
    SELECT source_unit_id, kind, page, content_text, coverage_status, coverage_reason, value_text
      FROM document_source_units WHERE file_id = ${fileId} ORDER BY ordinal`;
  const faits = async (fileId: number) => sql<Array<{ raw_value: string | null; value_text: string | null; source_unit_ids: string[] | null }>>`
    SELECT raw_value, value_text, source_unit_ids FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const sommeOk = (c: Record<string, unknown>) => Number(c.total_units) === ['covered_units', 'non_informational_units', 'unresolved_units', 'uncertain_units', 'failed_units']
    .reduce((s, k) => s + Number(c[k]), 0);

  it('migrations 0295 à 0297 : idempotentes (deux passes), contrainte « somme = total »', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const f of ['0295_document_source_units.sql', '0296_document_unresolved_facts.sql', '0297_document_facts_source_units.sql']) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const compte = await make.account();
    const f = await fichier(compte);
    await expect(sql`INSERT INTO document_extraction_coverage (file_id, account_id, total_units, covered_units, quality_state)
                     VALUES (${f.id}, ${compte.id}, 3, 1, 'COMPLETE')`).rejects.toThrow(/document_extraction_coverage_sum_chk/);
  });

  // ══ T1X-01 ═════════════════════════════════════════════════════════════
  it('T1X-01 — document simple (20 informations) : 20 conservées, couverture complète, aucune reprise', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const lignes = Array.from({ length: 20 }, (_, i) => `Référence ${i + 1} : REF-${1000 + i}`);
    const replay = await analyser(compte, f.id, [T1(sortie({
      transcription: ['Relevé de compteurs 2026', ...lignes].join('\n'),
      facts: lignes.map((l, i) => fait(l, `REF-${1000 + i}`)),
    }))]);
    expect(appelsT1(replay)).toHaveLength(1);
    const c = await couverture(f.id);
    expect(c).toMatchObject({ quality_state: 'COMPLETE', coverage_ratio: 1, repair_pass_count: 0, facts_count: 20, anomalies: [], origin: 'ANALYSIS' });
    expect(sommeOk(c)).toBe(true);
    const fs = await faits(f.id);
    expect(fs).toHaveLength(20);
    expect(fs[0].source_unit_ids).toEqual(['page:1:field:1']);
    expect((await unites(f.id)).filter((u) => u.kind === 'LABEL_VALUE').every((u) => u.coverage_status === 'COVERED')).toBe(true);
    // Compatibilité : document analysé normalement (état, extraction, titre).
    const [af] = await sql<{ analysis_state: string }[]>`SELECT analysis_state FROM asset_files WHERE id = ${f.id}`;
    expect(af.analysis_state).toBe('ANALYZED');
  });

  // ══ T1X-02 ═════════════════════════════════════════════════════════════
  it('T1X-02 — plus de 300 faits : 320 persistés, aucune perte, aucune troncature définitive', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const lignes = Array.from({ length: 320 }, (_, i) => `Compteur ${i + 1} : CPT-${10_000 + i}`);
    await analyser(compte, f.id, [T1(sortie({ transcription: lignes.join('\n'), facts: lignes.map((l, i) => fait(l, `CPT-${10_000 + i}`)) }))]);
    const fs = await faits(f.id);
    expect(fs).toHaveLength(320);
    expect(fs[319].source_unit_ids).toEqual(['page:1:field:320']);
    const [e] = await sql<{ fact_count: number; warnings: string[] }[]>`
      SELECT fact_count, metadata->'warnings' AS warnings FROM document_extractions WHERE file_id = ${f.id}`;
    expect(e.fact_count).toBe(320);
    expect(e.warnings).not.toContain('FACTS_TRUNCATED');
    expect(await couverture(f.id)).toMatchObject({ truncated_sections_count: 0, facts_count: 320, quality_state: 'COMPLETE' });
  });

  // ══ T1X-03 ═════════════════════════════════════════════════════════════
  it('T1X-03 — document très long : transcription > 200 000 caractères intégralement conservée et découpée', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const texte = Array.from({ length: 5_500 }, (_, i) => `Paragraphe ${i} du règlement intérieur, rédigé sans aucune valeur chiffrée utile.`).join('\n');
    expect(texte.length).toBeGreaterThan(200_000);
    await analyser(compte, f.id, [T1(sortie({ transcription: texte }))]);
    const [e] = await sql<{ n: number }[]>`SELECT full_text_chars AS n FROM document_extractions WHERE file_id = ${f.id}`;
    expect(e.n).toBe(texte.length);
    const blocs = (await unites(f.id)).filter((u) => u.kind === 'TEXT_BLOCK');
    expect(blocs.map((u) => u.content_text).join('\n')).toBe(texte);
    expect(await couverture(f.id)).toMatchObject({ truncated_sections_count: 0 });
  });

  it('T1X-03 — long PDF à sortie saturée : plusieurs lots de pages, fusion, 100 % des pages lues', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage();
    pdf.bytes = await doc.save();
    process.env.T1_CHUNK_PAGES = '1';
    try {
      const compte = await make.account();
      const f = await fichier(compte);
      const lot = (p: number) => T1(sortie({
        transcription: `Article ${p} : ART-00${p}`,
        facts: [fait(`Article ${p} : ART-00${p}`, `ART-00${p}`)],
      }), { promptIncludes: 'extrait de 1 page(s)' });
      const replay = await analyser(compte, f.id, [
        lot(2), lot(3), lot(4),
        T1(sortie({ transcription: 'Relevé de compteurs 2026\n--- page 2 ---\nArticle 2 : ART-002', facts: [fait('Article 2 : ART-002', 'ART-002', { evidence: { excerpt: 'Article 2 : ART-002', page: 2 } })] }), { outputTokens: 31_000 }),
      ]);
      expect(pdf.fetched).toBeGreaterThanOrEqual(1);
      // Passe principale + pages 2, 3, 4.
      expect(appelsT1(replay)).toHaveLength(4);
      expect(appelsT1(replay).slice(1).every((c) => (c.attachments[0] as { data?: string })?.data)).toBe(true);
      expect(await couverture(f.id)).toMatchObject({ chunk_count: 3, quality_state: 'COMPLETE', truncated_sections_count: 0 });
      const fs = await faits(f.id);
      expect(fs.map((x) => x.raw_value).sort()).toEqual(['ART-002', 'ART-003', 'ART-004']);
      expect(fs.find((x) => x.raw_value === 'ART-004')?.source_unit_ids).toEqual(['page:4:field:1']);
      const [e] = await sql<{ t: string }[]>`SELECT full_text AS t FROM document_extractions WHERE file_id = ${f.id}`;
      expect(e.t).toContain('Article 4 : ART-004');
    } finally {
      delete process.env.T1_CHUNK_PAGES;
      pdf.bytes = null;
    }
  });

  // ══ T1X-04 ═════════════════════════════════════════════════════════════
  it('T1X-04 — fait invalide : pas perdu → document_unresolved_facts (charge complète), unité conservée UNRESOLVED', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    await analyser(compte, f.id, [
      REPARATION(sortie({ facts: [] })),
      T1(sortie({
        transcription: 'Relevé de compteurs 2026\nPuissance souscrite : 9 kVA',
        facts: [fait('Puissance souscrite : 9 kVA', '9 kVA', { target: { type: 'BATIMENT' } })],
      })),
    ]);
    const [u] = await sql<Array<{ reason: string; status: string; source_unit_ids: string[]; raw_value: string; original_payload: { target: unknown } }>>`
      SELECT reason, status, source_unit_ids, raw_value, original_payload FROM document_unresolved_facts WHERE file_id = ${f.id} AND reason = 'INVALID_SCHEMA'`;
    expect(u).toMatchObject({ status: 'UNRESOLVED', source_unit_ids: ['page:1:field:1'], raw_value: '9 kVA' });
    expect(u.original_payload.target).toEqual({ type: 'BATIMENT' });
    expect((await unites(f.id)).find((x) => x.source_unit_id === 'page:1:field:1'))
      .toMatchObject({ coverage_status: 'UNRESOLVED', coverage_reason: 'fact_dropped', content_text: 'Puissance souscrite : 9 kVA' });
    const c = await couverture(f.id);
    expect(c).toMatchObject({ dropped_facts_count: 1, quality_state: 'COMPLETE_WITH_UNRESOLVED' });
    expect(c.anomalies).toContain('FACT_INVALID_DROPPED');
  });

  // ══ T1X-05 ═════════════════════════════════════════════════════════════
  it('T1X-05 — information non interprétée : source conservée, UNRESOLVED, aucune perte ; clé inconnue tracée (RETAINED)', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    await analyser(compte, f.id, [
      REPARATION(sortie({ facts: [] })),
      T1(sortie({
        transcription: 'Relevé de compteurs 2026\nIndice bidule : 42 XQ7\nCode chantier : ZK-4471',
        facts: [fait('Indice bidule : 42 XQ7', '42 XQ7', { canonicalKey: 'cleTotalementInconnue' })],
      })),
    ]);
    expect((await unites(f.id)).find((x) => x.source_unit_id === 'page:1:field:2'))
      .toMatchObject({ coverage_status: 'UNRESOLVED', content_text: 'Code chantier : ZK-4471', value_text: 'ZK-4471' });
    const [r] = await sql<{ status: string; canonical_key: string }[]>`
      SELECT status, canonical_key FROM document_unresolved_facts WHERE file_id = ${f.id} AND reason = 'UNKNOWN_CANONICAL_KEY'`;
    expect(r).toEqual({ status: 'RETAINED', canonical_key: 'cleTotalementInconnue' });
    expect((await faits(f.id)).map((x) => x.raw_value)).toEqual(['42 XQ7']);
  });

  // ══ T1X-06 ═════════════════════════════════════════════════════════════
  it('T1X-06 — oubli au 1er passage : couverture → réparation ciblée (unité seule, sans fichier) → extraction complémentaire', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const replay = await analyser(compte, f.id, [
      REPARATION(sortie({ facts: [fait('N° de série : SN-778899', 'SN-778899')] })),
      T1(sortie({
        transcription: 'Relevé de compteurs 2026\nRéférence : REF-1\nN° de série : SN-778899',
        facts: [fait('Référence : REF-1', 'REF-1')],
      })),
    ]);
    const appels = appelsT1(replay);
    expect(appels).toHaveLength(2);
    expect(appels[1].attachments).toEqual([]);
    expect(appels[1].prompt).toContain('[page:1:field:2]');
    expect(appels[1].prompt).not.toContain('REF-1');
    const fs = await faits(f.id);
    expect(fs.map((x) => x.raw_value)).toEqual(['REF-1', 'SN-778899']);
    expect(fs[1].source_unit_ids).toEqual(['page:1:field:2']);
    expect(await couverture(f.id)).toMatchObject({ repair_pass_count: 1, quality_state: 'COMPLETE' });
  });

  // ══ T1X-07 ═════════════════════════════════════════════════════════════
  it('T1X-07 — tableau volumineux (1 200 lignes) : toutes les lignes et cellules conservées', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const rows = Array.from({ length: 1_200 }, (_, r) => ({ cells: [{ column: 0, value: `L${r}` }, { column: 1, value: `${r},00 €` }] }));
    await analyser(compte, f.id, [T1(sortie({
      transcription: 'Relevé de compteurs 2026',
      tables: [{ title: 'Relevés', pageStart: 2, columns: [{ header: 'Ligne' }, { header: 'Montant' }], rows }],
    }))]);
    const [t] = await sql<{ rows: number; cells: number }[]>`
      SELECT t.row_count AS rows, (SELECT count(*)::int FROM document_table_cells c WHERE c.table_id = t.id) AS cells
        FROM document_tables t WHERE t.file_id = ${f.id} AND t.status = 'active'`;
    expect(t).toEqual({ rows: 1_200, cells: 2_400 });
    const lignes = (await unites(f.id)).filter((u) => u.kind === 'TABLE_ROW');
    expect(lignes).toHaveLength(1_200);
    expect(lignes[1_199]).toMatchObject({ source_unit_id: 'page:2:table:1:row:1200', coverage_status: 'COVERED' });
  });

  // ══ T1X-08 ═════════════════════════════════════════════════════════════
  it('T1X-08 — information non comprise, bien créé plus tard : exploitable depuis la base, sans relire le fichier', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const replay = await analyser(compte, f.id, [
      T1(sortie({ facts: [] }), { promptIncludes: '[page:1:field:' }),
      T1(sortie({ transcription: 'Relevé de compteurs 2026\nLieu d’intervention : 12 rue Victor Hugo, 69003 Lyon' })),
    ]);
    const avant = appelsT1(replay).length;
    const fetches = pdf.fetched;
    // J+30 : la maison est créée.
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison Victor Hugo' });
    const { searchDocumentSourceUnits, loadDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units');
    const hits = await searchDocumentSourceUnits(compte.id, ['12', 'rue', 'Victor', 'Hugo']);
    expect(hits).toEqual([expect.objectContaining({
      fileId: f.id, sourceUnitId: 'page:1:field:1', page: 1, coverageStatus: 'UNRESOLVED', value: '12 rue Victor Hugo, 69003 Lyon',
    })]);
    const ouvertes = await loadDocumentSourceUnits(f.id, { accountId: compte.id, statuses: ['UNRESOLVED'], withFacts: true });
    expect(ouvertes.map((u) => u.sourceUnitId)).toContain('page:1:field:1');
    // Un autre compte ne voit rien.
    const autre = await make.account();
    expect(await searchDocumentSourceUnits(autre.id, ['Victor', 'Hugo'])).toEqual([]);
    expect(await loadDocumentSourceUnits(f.id, { accountId: autre.id })).toEqual([]);
    // Aucun appel IA, aucune lecture du fichier.
    expect(appelsT1(replay)).toHaveLength(avant);
    expect(pdf.fetched).toBe(fetches);
    expect(maison.id).toBeGreaterThan(0);
  });

  // ══ Migration sans réanalyse ═══════════════════════════════════════════
  it('documents historiques : couche A reconstruite par la tâche planifiée, sans réanalyse ni appel IA ; provenance des faits existants', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const replay = await analyser(compte, f.id, [T1(sortie({
      transcription: 'Relevé de compteurs 2026\nRéférence : REF-HIST',
      facts: [fait('Référence : REF-HIST', 'REF-HIST')],
    }))]);
    // État « avant le lot 34F » : ni couche A, ni provenance.
    await sql`DELETE FROM document_source_units WHERE file_id = ${f.id}`;
    await sql`DELETE FROM document_extraction_coverage WHERE file_id = ${f.id}`;
    await sql`UPDATE document_facts SET source_unit_ids = NULL WHERE file_id = ${f.id}`;
    const n = appelsT1(replay).length;
    const { runSourceUnitsBackfill } = await import('@/services/ai/source-analysis/source-units/jobs');
    let r = await runSourceUnitsBackfill({ env: { T1_BACKFILL_BATCH: '1000' } });
    while (r.more) r = await runSourceUnitsBackfill({ env: { T1_BACKFILL_BATCH: '1000' } });
    expect(r.failed).toBe(0);
    expect(await couverture(f.id)).toMatchObject({ origin: 'BACKFILL', quality_state: 'COMPLETE' });
    expect((await faits(f.id))[0].source_unit_ids).toEqual(['page:1:field:1']);
    expect(appelsT1(replay)).toHaveLength(n);
    // Idempotente : un second passage ne reprend pas le document.
    const again = await runSourceUnitsBackfill({ env: { T1_BACKFILL_BATCH: '1000' } });
    expect(again.processed).toBe(0);
  });

  // ══ Reprise ciblée (INCOMPLETE_RETRYABLE) ══════════════════════════════
  it('réparation en échec transitoire → INCOMPLETE_RETRYABLE → reprise ciblée planifiée (unités seules) → faits ajoutés', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    await analyser(compte, f.id, [
      REPARATION(null, { error: { message: 'délai dépassé', code: 'TIMEOUT', recoverable: true }, repeat: true }),
      T1(sortie({
        transcription: 'Relevé de compteurs 2026\nRéférence : REF-1\nN° de série : SN-4242',
        facts: [fait('Référence : REF-1', 'REF-1')],
      })),
    ]);
    const c1 = await couverture(f.id);
    expect(c1).toMatchObject({ quality_state: 'INCOMPLETE_RETRYABLE', failed_units: 1 });
    expect(c1.next_retry_at).not.toBeNull();
    expect(c1.anomalies).toEqual(expect.arrayContaining(['SOURCE_UNIT_FAILED', 'COVERAGE_INCOMPLETE']));
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const bo = await getT1CompletenessOverview({ days: 1 });
    expect(bo.rows.find((x) => x.fileId === f.id)).toMatchObject({ qualityState: 'INCOMPLETE_RETRYABLE', failedUnits: 1 });
    expect(bo.byAnomaly.SOURCE_UNIT_FAILED).toBeGreaterThanOrEqual(1);

    await sql`UPDATE document_extraction_coverage SET next_retry_at = now() - interval '1 minute' WHERE file_id = ${f.id}`;
    const replay = await rejouer([REPARATION(sortie({ facts: [fait('N° de série : SN-4242', 'SN-4242')] }))]);
    const { runCompletenessRetry } = await import('@/services/ai/source-analysis/source-units/jobs');
    const r = await runCompletenessRetry();
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    expect(appelsT1(replay).every((c) => c.attachments.length === 0)).toBe(true);
    const c2 = await couverture(f.id);
    expect(c2).toMatchObject({ quality_state: 'COMPLETE', origin: 'RETRY', retry_attempts: 1, failed_units: 0, next_retry_at: null });
    expect(sommeOk(c2)).toBe(true);
    const fs = await faits(f.id);
    expect(fs.map((x) => x.raw_value)).toEqual(['REF-1', 'SN-4242']);
    expect(fs[1].source_unit_ids).toEqual(['page:1:field:2']);
  });

  it('INCOMPLETE_FINAL (fin de document illisible) : anomalie fonctionnelle en Supervision, résolue à l’analyse complète suivante', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    await sql`UPDATE asset_files SET mime_type = 'image/jpeg' WHERE id = ${f.id}`;
    await analyser(compte, f.id, [T1(sortie({ transcription: 'Ligne : B-0001', facts: [fait('Ligne : B-0001', 'B-0001')] }), { outputTokens: 31_000 })]);
    expect(await couverture(f.id)).toMatchObject({ quality_state: 'INCOMPLETE_FINAL', truncated_sections_count: 1 });
    const [a] = await sql<{ status: string; domain: string }[]>`
      SELECT status, domain FROM admin_anomalies WHERE fingerprint = ${`ai:t1-completeness:${f.id}`}`;
    expect(a).toEqual({ status: 'open', domain: 'ai' });
    await analyser(compte, f.id, [T1(sortie({ transcription: 'Ligne : B-0002', facts: [fait('Ligne : B-0002', 'B-0002')] }))]);
    const [b] = await sql<{ status: string }[]>`SELECT status FROM admin_anomalies WHERE fingerprint = ${`ai:t1-completeness:${f.id}`}`;
    expect(b.status).toBe('resolved');
  });

  it('compatibilité : une nouvelle analyse remplace la couche A (aucun doublon), anciens faits « superseded », identifiants stables', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const out = sortie({ transcription: 'Relevé de compteurs 2026\nRéférence : REF-9', facts: [fait('Référence : REF-9', 'REF-9')] });
    await analyser(compte, f.id, [T1(out)]);
    const u1 = (await unites(f.id)).map((u) => u.source_unit_id);
    await analyser(compte, f.id, [T1(out)]);
    expect((await unites(f.id)).map((u) => u.source_unit_id)).toEqual(u1);
    const [n] = await sql<{ actifs: number; remplaces: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'active')::int AS actifs, count(*) FILTER (WHERE status = 'superseded')::int AS remplaces
        FROM document_facts WHERE file_id = ${f.id}`;
    expect(n.actifs).toBe(1);
    expect(n.remplaces).toBeGreaterThanOrEqual(1);
  });
});
