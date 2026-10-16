/**
 * Lot 61A sur base réelle (PG16) — ticket « [P1] T1 — Corriger le blocage
 * Gemini et garantir extraction exhaustive, structuration et persistance BDD ».
 *
 * Point d'entrée de production (file T1 et `analyzeFileSources`), passerelle
 * RÉELLE, sorties modèle rejouées (aucun réseau), PDF réel lu par pdf.js.
 *
 *   T1-GEM-09 : incident fileId=98 rejoué — nom NFD, erreur ByteString à
 *               `request_build` : UN appel (aucun repli), REQUEST_BUILD_FAILED,
 *               extract brut enregistré et consultable, structuration en échec
 *               explicite ; relance BO (« Relancer » du job) SANS nouvel
 *               upload ni ré-extraction → analyse complète.
 *   T1-GEM-10 : échec de persistance (base de connaissance) → jamais de faux
 *               succès : document en échec transitoire, phase persistance
 *               FAILED, extract brut conservé, données déclarées tracées.
 *   T1-GEM-11 : réanalyses → aucun doublon (faits, extract brut), extract réutilisé.
 *   T1-GEM-12 : BO — extract intégral consultable depuis le rapport, phases séparées.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { sortieT1, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** PDF original servi par le « stockage » (aucune lecture S3 réelle). */
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null, fetched: 0 }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => { pdf.fetched++; return pdf.bytes; },
}));

/** Nom du document 98 : accents en forme DÉCOMPOSÉE (NFD), comme en préproduction. */
const NOM_98 = 'Facture électricité septembre 2026 – résidence principale.pdf'.normalize('NFD');
const BYTESTRING = 'Cannot convert argument to a ByteString because the character at index 46 has a value of 768 which is greater than 255.';
const PAGES = [
  ['FACTURE FA-2026-0098 du 14/09/2026', 'Fournisseur EDF SA', 'Consommation 4512 kWh'],
  ['ANNEXE conditions particulieres', 'Echeance 30/09/2026', 'Total TTC 974,59 EUR'],
];

type Raw = {
  id: number; file_id: number; extraction_status: string; method: string; page_count: number | null; pages_with_text: number;
  full_text: string | null; full_text_chars: number; extracted_at: Date; reuse_count: number; structuring_status: string | null;
  structuring_error_code: string | null; persistence_status: string | null; persistence_error: string | null; source_ref: string | null;
};
type Rapport = { id: number; status: string; steps: Array<{ step: string; status: string; detail?: Record<string, unknown> }>; sources: Record<string, unknown> };

scenario('L61A', 'T1 : blocage Gemini (Unicode NFD), extract brut persistant, phases séparées, aucun faux succès', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  // Suite e2e complète (un seul processus) : un fichier antérieur charge
  // drizzle-kit, qui ajoute `Array.prototype.random` (énumérable) ; pdf.js
  // refuse alors de lire tout PDF. Pollution propre aux tests (drizzle-kit
  // n'est jamais chargé par l'application) : retirée le temps de ce fichier.
  const pollution = Object.getOwnPropertyDescriptor(Array.prototype, 'random');
  beforeAll(() => { if (pollution) delete (Array.prototype as unknown as Record<string, unknown>).random; });
  afterAll(() => { if (pollution) Object.defineProperty(Array.prototype, 'random', pollution); });
  beforeAll(async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const lignes of PAGES) {
      const page = doc.addPage([595, 842]);
      lignes.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font }));
    }
    pdf.bytes = await doc.save();
    await ecarterLesAutresJobsT1();
  });
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });
  afterEach(async () => { await sql.unsafe('DROP TRIGGER IF EXISTS e2e_l61a_facts ON document_facts'); });

  const transcription = PAGES.map((l, i) => `--- page ${i + 1} ---\n${l.join('\n')}`);
  const sortie = () => sortieT1({
    title: 'FACTURE FA-2026-0098 du 14/09/2026', date: '2026-09-14', documentTypeCode: 'INVOICE', assets: [],
    facts: [
      { canonicalKey: null, rawKey: 'consommation', value: '4512 kWh', valueType: 'string', excerpt: 'Consommation 4512 kWh', assetId: null },
      { canonicalKey: null, rawKey: 'total_ttc', value: '974,59 EUR', valueType: 'string', excerpt: 'Total TTC 974,59 EUR', assetId: null },
    ],
    texte: transcription,
  });
  const T1_OK = () => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie(), repeat: true });
  const T1_BYTESTRING = { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: null, error: { name: 'TypeError' as const, message: BYTESTRING, stage: 'request_build' } };

  const fichier98 = async () => {
    const compte = await make.account({ plan: 'premium' });
    const f = await make.assetFile(compte);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${NOM_98}, analysis_state = NULL WHERE id = ${f.id}`;
    return { compte, f };
  };
  const raw = async (fileId: number) => (await sql<Raw[]>`SELECT * FROM document_raw_extracts WHERE file_id = ${fileId}`);
  const etat = async (id: number) => (await sql<{ analysis_state: string | null; analysis_fail_reason: string | null; original_filename: string; s3_key: string }[]>`
    SELECT analysis_state, analysis_fail_reason, original_filename, s3_key FROM asset_files WHERE id = ${id}`)[0];
  const rapports = (fileId: number) => sql<Rapport[]>`SELECT id, status, steps, sources FROM ai_execution_reports WHERE treatment = 'T1' AND file_id = ${fileId} ORDER BY id`;
  const jobDe = async (id: number) => (await sql<{ id: number; status: string; attempts: number }[]>`
    SELECT id, status, attempts FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];
  /** Appels d'ANALYSE T1 (hors passes de réparation ciblée du lot 34F). */
  const appelsT1 = (calls: Array<{ operationCode?: string; callKind?: string }>) =>
    calls.filter((c) => c.operationCode === 't1_analyze_document' && c.callKind !== 'repair');
  const faitsActifs = async (fileId: number) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id = ${fileId} AND status = 'active'`)[0].n);

  it('migration 0435 : idempotente (deux passes), contraintes de statut', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const fichier of ['0435_t1_raw_extract.sql', '0435_t1_raw_extract_idx_1.sql']) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', fichier), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${fichier} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const { compte, f } = await fichier98();
    await expect(sql`INSERT INTO document_raw_extracts (account_id, file_id, method, extraction_status) VALUES (${compte.id}, ${f.id}, 'PDF_TEXT_LAYER', 'PRESQUE')`)
      .rejects.toThrow(/document_raw_extracts_extraction_chk/);
  });

  it('T1-GEM-09 — document 98 (nom NFD, ByteString à request_build) : un seul appel, REQUEST_BUILD_FAILED, extract conservé ; relance BO sans nouvel upload ni ré-extraction', async () => {
    await ecarterLesAutresJobsT1();
    const { compte, f } = await fichier98();
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const { MAX_ATTEMPTS } = await import('@/services/ai/queue/queue-policy');
    registerSourceAnalysisHandler();

    // Deux erreurs enregistrées : si un repli avait lieu, il consommerait la seconde.
    const replay = await rejouer([T1_BYTESTRING, { ...T1_BYTESTRING }]);
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    const job = await jobDe(f.id);
    await sql`UPDATE ai_job_queue SET attempts = ${MAX_ATTEMPTS - 1} WHERE id = ${job.id}`;
    expect(await runOne('T1')).toBe(true);

    // Aucun repli : un seul appel modèle, erreur classée REQUEST_BUILD_FAILED (jamais PROVIDER_UNAVAILABLE).
    expect(appelsT1(replay.calls)).toHaveLength(1);
    const traces = await sql<{ error_code: string | null; model_rank: string | null }[]>`
      SELECT error_code, model_rank FROM ai_usage_event WHERE account_id = ${compte.id} AND operation_code = 't1_analyze_document' ORDER BY id`;
    expect(traces).toEqual([{ error_code: 'REQUEST_BUILD_FAILED', model_rank: 'primary' }]);
    // Échec définitif après reprise : job clos, résultat MÉTIER en échec (lot 33D).
    const clos = (await sql<{ status: string; business_result: string | null }[]>`SELECT status, business_result FROM ai_job_queue WHERE id = ${job.id}`)[0];
    expect(clos).toEqual({ status: 'DONE', business_result: 'FAILED' });
    const e1 = await etat(f.id);
    expect(e1.analysis_state).toBe('ANALYSIS_FAILED');
    // Message utilisateur générique (défaut interne), nom d'origine intact en base (NFD).
    expect(e1.analysis_fail_reason).toMatch(/erreur technique interne/);
    expect(e1.original_filename).toBe(NOM_98);

    // Extract brut enregistré AVANT le modèle, intégral, conservé malgré l'échec.
    const [r1] = await raw(f.id);
    expect(r1).toMatchObject({ extraction_status: 'COMPLETE', method: 'PDF_TEXT_LAYER', page_count: 2, pages_with_text: 2,
      structuring_status: 'FAILED', structuring_error_code: 'REQUEST_BUILD_FAILED', persistence_status: null, reuse_count: 0 });
    for (const l of PAGES.flat()) expect(r1.full_text).toContain(l);
    const [rap1] = await rapports(f.id);
    expect(rap1.status).toBe('FAILED');
    const ph1 = rap1.sources.phases as Record<string, { state: string; detail: Record<string, unknown> }>;
    expect(ph1.extraction.state).toBe('SUCCEEDED');
    expect(ph1.structuring).toMatchObject({ state: 'FAILED', detail: { code: 'REQUEST_BUILD_FAILED', recoverable: false, stage: 'request_build' } });
    expect(String(ph1.structuring.detail.error)).toMatch(/ByteString/);
    expect(ph1.persistence.state).toBe('NOT_RUN');

    // ── Relance BO (« Relancer » du job, lot 61 : aussi un job T1 clos en échec MÉTIER) : même fichier, aucun upload ──
    const s3Avant = e1.s3_key;
    const { retryFailedJob } = await import('@/services/ai/queue/job-queue.repository');
    expect(await retryFailedJob(job.id)).toBe(true);
    const replay2 = await rejouer([T1_OK()]);
    expect(await runOne('T1')).toBe(true);
    // Master appelé (plus, éventuellement, la réparation ciblée des unités non couvertes, lot 34F).
    expect(appelsT1(replay2.calls).length).toBeGreaterThanOrEqual(1);

    const e2 = await etat(f.id);
    expect(e2.analysis_state).not.toBe('ANALYSIS_FAILED');
    expect(e2.s3_key).toBe(s3Avant);
    expect(e2.original_filename).toBe(NOM_98);
    const [r2] = await raw(f.id);
    // Réutilisé : même ligne, même date d'extraction, compteur de réutilisation.
    expect(r2).toMatchObject({ id: r1.id, reuse_count: 1, structuring_status: 'SUCCEEDED', persistence_status: 'SUCCEEDED' });
    expect(new Date(r2.extracted_at).getTime()).toBe(new Date(r1.extracted_at).getTime());
    expect(await faitsActifs(f.id)).toBeGreaterThanOrEqual(2);
    const rap2 = (await rapports(f.id)).at(-1)!;
    const ph2 = rap2.sources.phases as Record<string, { state: string; detail: { files?: Array<{ reused: boolean }> } }>;
    expect([ph2.extraction.state, ph2.structuring.state, ph2.persistence.state]).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(ph2.extraction.detail.files?.[0].reused).toBe(true);
  });

  it('T1-GEM-10 — échec de persistance (base de connaissance) : aucun faux succès, extract conservé, données déclarées tracées', async () => {
    await ecarterLesAutresJobsT1();
    const { compte, f } = await fichier98();
    await sql.unsafe(`CREATE OR REPLACE FUNCTION e2e_l61a_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'e2e : écriture refusée (%)', TG_TABLE_NAME; END $$`);
    await sql.unsafe(`CREATE TRIGGER e2e_l61a_facts BEFORE INSERT ON document_facts FOR EACH ROW WHEN (NEW.file_id = ${f.id}) EXECUTE FUNCTION e2e_l61a_fail()`);
    await rejouer([T1_OK()]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l61a' });
    expect(r).toMatchObject({ analysedCount: 0, failedSourceIds: [f.id] });

    // Jamais « analysé » : la source repart en file durable (UPLOADED, « en file d'attente »).
    const e = await etat(f.id);
    expect(e.analysis_state).toBe('UPLOADED');
    const [x] = await raw(f.id);
    expect(x).toMatchObject({ extraction_status: 'COMPLETE', structuring_status: 'SUCCEEDED', persistence_status: 'FAILED' });
    expect(x.persistence_error).toMatch(/KNOWLEDGE/);
    expect(x.full_text).toContain('Total TTC 974,59 EUR');
    expect(await faitsActifs(f.id)).toBe(0);
    const [rap] = await rapports(f.id);
    expect(rap.status).toBe('PARTIAL');
    expect((rap.sources.phases as Record<string, { state: string }>).persistence.state).toBe('FAILED');
    const declares = await sql<{ write_result: string; reason_code: string | null }[]>`
      SELECT e.write_result, e.reason_code FROM ai_execution_report_entries e WHERE e.report_id = ${rap.id} AND e.section = 'DECLARED' AND e.table_name = 'document_facts'`;
    expect(declares.length).toBeGreaterThanOrEqual(2);
    expect(declares.every((d) => d.write_result === 'NOT_PERSISTED' && d.reason_code === 'KNOWLEDGE_TRANSACTION_FAILED')).toBe(true);
    // Remis en file durable (reprise automatique), jamais « analysé ».
    expect((await jobDe(f.id))?.status).toBe('PENDING');
  });

  it('T1-GEM-11 — réanalyses : aucun doublon de faits ni d’extract, extract réutilisé', async () => {
    const { compte, f } = await fichier98();
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    for (let i = 0; i < 3; i++) {
      await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${f.id}`;
      await rejouer([T1_OK()]);
      const r = await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l61a' });
      expect(r?.failedSourceIds).toEqual([]);
    }
    const lignes = await raw(f.id);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ reuse_count: 2, persistence_status: 'SUCCEEDED' });
    expect(await faitsActifs(f.id)).toBe(2);
  });

  it('T1-GEM-12 — BO : extract intégral consultable depuis le rapport (relecture par empreinte), phases séparées', async () => {
    const { compte, f } = await fichier98();
    await rejouer([T1_OK()]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l61a' });
    const [rap] = await rapports(f.id);
    const repo = await import('@/services/ai/execution-report/repository');
    const resume = await repo.getExecutionReport(rap.id);
    const { entries } = await repo.readReportEntries(resume!, { section: 'RAW_EXTRACT', limit: 100 });
    const texte = entries.find((e) => e.columnPath === 'full_text')!;
    expect(texte).toMatchObject({ tableName: 'document_raw_extracts', writeResult: 'WRITTEN' });
    const contenu = texte.ref ? await repo.resolveRef(compte.id, texte) : { state: 'TRACED', content: texte.value };
    expect(contenu.state).toBe('TRACED');
    for (const l of PAGES.flat()) expect(String((contenu as { content: unknown }).content)).toContain(l);
    expect(entries.find((e) => e.columnPath === 'page_count')?.value).toBe(2);
    // Un autre compte ne relit rien.
    const autre = await make.account();
    if (texte.ref) expect((await repo.resolveRef(autre.id, texte)).state).toBe('NOT_TRACED');
  });
});
