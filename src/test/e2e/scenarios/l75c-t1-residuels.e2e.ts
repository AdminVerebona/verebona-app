/**
 * Lot 75C sur base réelle (PG16) — ticket « [P1] T1 — Corriger les écarts
 * résiduels d'extraction exhaustive et de persistance métier ».
 *
 * Point d'entrée de production (`analyzeFileSources`), passerelle RÉELLE,
 * sorties modèle rejouées (aucun réseau), PDF réels lus par pdf.js. Les
 * pannes d'écriture sont provoquées par des déclencheurs PostgreSQL posés
 * sur le seul fichier du scénario (retirés après chaque test).
 *
 *   T1-FIX-01 : extract brut non enregistrable → aucun faux succès, reprise
 *               (sans nouvel appel Gemini) qui l'enregistre.
 *   T1-FIX-02 : PDF mixte texte / scan → page scannée transcrite par la
 *               lecture du modèle PERSISTÉE par page (provenance distincte),
 *               extract original intact, aucun appel IA supplémentaire.
 *   T1-FIX-03 : extract tronqué + page scannée illisible → lacunes visibles,
 *               complétude jamais « complète », rapport jamais « réussi ».
 *   T1-FIX-04 : échec `recordEvidence` → persistance non réussie ; reprise
 *               sans Gemini et sans doublon de preuve active.
 *   T1-FIX-05 : échec de la couche source (unités, couverture) → faits
 *               conservés, persistance non réussie, réparation par reprise.
 *   T1-FIX-06 : faits certains d'un ÉQUIPEMENT : sa fiche alimentée dès T1
 *               (sans attendre T3), jamais le bien parent ; valeur USER
 *               protégée.
 *   T1-FIX-07 : run dédupliqué avec écritures manquantes (propositions,
 *               métadonnées) → réparées sans nouvel appel Gemini.
 *   T1-FIX-08 : fichier remplacé au même emplacement → extract réextrait.
 *   T1-FIX-09 : échec Gemini → traces (trace, modèle, code, étape, job)
 *               rattachées au rapport T1 et retrouvables depuis le BO.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { fiche, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** Fichier original servi par le « stockage » (aucune lecture S3 réelle). */
const stockage = vi.hoisted(() => ({ bytes: null as Uint8Array | null, fetched: 0 }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => { stockage.fetched++; return stockage.bytes; },
}));

// PNG 1×1 : page « scannée » (image seule, aucune couche texte).
const PNG_1PX = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const BYTESTRING = 'Cannot convert argument to a ByteString because the character at index 46 has a value of 768 which is greater than 255.';

type Page = string[] | 'SCAN';
async function pdf(pages: Page[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(PNG_1PX);
  for (const p of pages) {
    const page = doc.addPage([595, 842]);
    if (p === 'SCAN') page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    else p.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font }));
  }
  return doc.save();
}

type Rapport = {
  id: number; status: string; trace_ids: string[]; job_id: number | null; job_attempt: number | null;
  steps: Array<{ step: string; status: string; error?: string | null; detail?: Record<string, unknown> }>; sources: Record<string, unknown>;
};
type Phases = Record<'extraction' | 'structuring' | 'persistence', { state: string; detail: Record<string, unknown> }>;

scenario('L75C', 'T1 : écarts résiduels d’extraction exhaustive et de persistance métier', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  // Pollution propre à la suite complète (drizzle-kit, `Array.prototype.random`) : voir l61a.
  const pollution = Object.getOwnPropertyDescriptor(Array.prototype, 'random');
  beforeAll(() => { if (pollution) delete (Array.prototype as unknown as Record<string, unknown>).random; });
  afterAll(() => { if (pollution) Object.defineProperty(Array.prototype, 'random', pollution); });
  beforeAll(async () => { await ecarterLesAutresJobsT1(); });
  /** Documents du scénario : retirés à la fin (aucune reprise programmée ne doit déborder sur les autres fichiers de la suite). */
  const mesFichiers: number[] = [];
  afterAll(async () => {
    if (mesFichiers.length) {
      await sql`UPDATE document_extraction_coverage SET next_retry_at = NULL WHERE file_id = ANY(${mesFichiers})`;
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE status = 'PENDING' AND target_type = 'asset_file' AND target_id = ANY(${mesFichiers.map(String)})`.catch(() => undefined);
      await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ANY(${mesFichiers})`;
    }
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });
  const PANNES = ['document_raw_extracts', 'field_evidence', 'document_source_units', 'document_facts'];
  afterEach(async () => {
    for (const t of PANNES) await sql.unsafe(`DROP TRIGGER IF EXISTS e2e_l75c_panne ON ${t}`);
    delete process.env.T1_RAW_EXTRACT_MAX_PAGES;
  });
  /** Écriture refusée sur `table` pour le seul fichier `fileId` (colonne `col`). */
  const panne = async (table: string, col: string, fileId: number) => {
    await sql.unsafe(`CREATE OR REPLACE FUNCTION e2e_l75c_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'e2e : écriture refusée (%)', TG_TABLE_NAME; END $$`);
    await sql.unsafe(`CREATE TRIGGER e2e_l75c_panne BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW.${col} = ${fileId}) EXECUTE FUNCTION e2e_l75c_fail()`);
  };
  const reparer = (table: string) => sql.unsafe(`DROP TRIGGER IF EXISTS e2e_l75c_panne ON ${table}`);

  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };
  const T1 = (output: Record<string, unknown>): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, repeat: true });
  /** Appels du modèle T1 (analyse, réparation ciblée du lot 34F comprise). */
  const appelsT1 = <C extends { operationCode?: string; callKind?: string }>(calls: C[]): C[] =>
    calls.filter((c) => c.operationCode === 't1_analyze_document' && c.callKind !== 'repair');
  /** Appels d'analyse PRINCIPALE (hors réparation ciblée des unités, dont le prompt cite `[page:…]`). */
  const analysesPrincipales = (calls: Array<{ operationCode?: string; callKind?: string; prompt?: string }>) =>
    appelsT1(calls).filter((c) => !String(c.prompt ?? '').includes('[page:'));

  const fichier = async (c: AccountRow, assetId: number | null, bytes: Uint8Array) => {
    stockage.bytes = bytes;
    const f = await make.assetFile(c, { assetId });
    mesFichiers.push(f.id);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, mime_type = 'application/pdf',
                analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const analyser = async (c: AccountRow, fileId: number) => {
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    return analyzeFileSources([fileId], c.id, { userId: c.ownerUserId, billable: false, origin: 'e2e/l75c' });
  };
  const etat = async (id: number) => (await sql<{ analysis_state: string | null; document_type: string | null }[]>`
    SELECT analysis_state, document_type FROM asset_files WHERE id = ${id}`)[0];
  const raw = async (fileId: number) => (await sql<Array<Record<string, unknown>>>`SELECT * FROM document_raw_extracts WHERE file_id = ${fileId}`)[0];
  const rapports = (fileId: number) => sql<Rapport[]>`
    SELECT id, status, trace_ids, job_id, job_attempt, steps, sources FROM ai_execution_reports WHERE treatment = 'T1' AND file_id = ${fileId} ORDER BY id`;
  const dernierRapport = async (fileId: number) => (await rapports(fileId)).at(-1)!;
  const phases = (r: Rapport) => r.sources.phases as Phases;
  const lignes = (reportId: number, section: string) => sql<Array<{ write_result: string; reason_code: string | null; field_key: string | null; entity_type: string | null; entity_id: number | null; value: unknown; links: Record<string, unknown> | null }>>`
    SELECT write_result, reason_code, field_key, entity_type, entity_id, value, links FROM ai_execution_report_entries WHERE report_id = ${reportId} AND section = ${section} ORDER BY seq`;
  const run = async (fileId: number) => sql<Array<{ id: number; writes_status: string | null; has_snapshot: boolean }>>`
    SELECT id, writes_status, master_snapshot IS NOT NULL AS has_snapshot FROM document_analysis_runs WHERE asset_file_id = ${fileId} ORDER BY id`;
  const preuvesActives = async (fileId: number, key: string) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM field_evidence WHERE source_id = ${fileId} AND field_key = ${key}
       AND status = 'active' AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE'`)[0].n);
  const faitsActifs = async (fileId: number) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id = ${fileId} AND status = 'active'`)[0].n);

  // ── Document de garage (véhicule, kilométrage) ────────────────────────────
  const GARAGE = [['FACTURE ENTRETIEN FE-2026-0075', 'Garage Martin', 'Kilometrage : 78 000 km', 'Total TTC 300,00 EUR']];
  const garage = (assetId: number) => sortieT1({
    title: 'FACTURE ENTRETIEN FE-2026-0075', date: '2026-09-03', documentTypeCode: 'MAINTENANCE_INVOICE', supplier: 'Garage Martin',
    assets: [{ id: assetId, label: 'Clio' }],
    facts: [{ canonicalKey: 'mileage', value: 78000, valueType: 'number', unit: 'km', excerpt: 'Kilometrage : 78 000 km', assetId }] as FaitT1[],
    texte: ['--- page 1 ---', ...GARAGE[0]],
  });
  const vehicule = async (c: AccountRow) => make.asset(c, { category: 'VEHICULE', name: 'Clio' });

  it('migration 0545 : idempotente (deux passes), contraintes de statut', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const texte = await readFile(join(process.cwd(), 'src/db/migrations', '0545_l75c_t1_residuels.sql'), 'utf-8');
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const c = await make.account();
    const f = await make.assetFile(c);
    await expect(sql`INSERT INTO document_raw_extracts (account_id, file_id, method, extraction_status, ocr_status) VALUES (${c.id}, ${f.id}, 'NONE', 'OCR_REQUIRED', 'PRESQUE')`)
      .rejects.toThrow(/document_raw_extracts_ocr_chk/);
  });

  it('T1-FIX-01 — extract brut non enregistrable : aucun faux succès ; reprise sans Gemini qui l’enregistre', async () => {
    const c = await make.account();
    const clio = await vehicule(c);
    const f = await fichier(c, clio.id, await pdf(GARAGE));
    await panne('document_raw_extracts', 'file_id', f.id);
    const r1 = await rejouer([T1(garage(clio.id))]);
    const out = await analyser(c, f.id);
    expect(out).toMatchObject({ analysedCount: 0, failedSourceIds: [f.id] });
    expect(analysesPrincipales(r1.calls)).toHaveLength(1);
    expect((await etat(f.id)).analysis_state).not.toBe('ANALYZED');
    expect(await raw(f.id)).toBeUndefined();
    const rap = await dernierRapport(f.id);
    expect(rap.status).not.toBe('SUCCESS');
    expect(rap.steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'RAW_EXTRACT', status: 'FAILED' })]));
    expect(phases(rap).extraction.state).toBe('FAILED');
    expect(phases(rap).persistence.state).toBe('FAILED');
    // Données obtenues conservées : faits et run écrits, sortie structurée gardée pour la reprise.
    expect(await faitsActifs(f.id)).toBeGreaterThan(0);
    expect(await run(f.id)).toEqual([expect.objectContaining({ writes_status: 'FAILED', has_snapshot: true })]);

    // ── Reprise : aucune sortie modèle disponible → la moindre sollicitation de Gemini échouerait ──
    await reparer('document_raw_extracts');
    const r2 = await rejouer([]);
    const out2 = await analyser(c, f.id);
    expect(out2?.failedSourceIds).toEqual([]);
    expect(appelsT1(r2.calls)).toHaveLength(0);
    expect((await etat(f.id)).analysis_state).toBe('ANALYZED');
    expect(await raw(f.id)).toMatchObject({ extraction_status: 'COMPLETE', persistence_status: 'SUCCEEDED', structuring_status: 'SUCCEEDED' });
    const rap2 = await dernierRapport(f.id);
    expect([phases(rap2).extraction.state, phases(rap2).structuring.state, phases(rap2).persistence.state]).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(phases(rap2).structuring.detail).toMatchObject({ replayedFromRunId: expect.any(Number) });
    expect(await run(f.id)).toEqual([expect.objectContaining({ writes_status: 'SUCCEEDED', has_snapshot: false })]);
  });

  it('T1-FIX-02 — PDF mixte texte / scan : page scannée transcrite et persistée par page, provenance distincte, extract original intact, aucun appel IA de plus', async () => {
    const c = await make.account();
    const f = await fichier(c, null, await pdf([['FACTURE FA-2026-0201', 'Fournisseur EDF SA', 'Total TTC 120,00 EUR'], 'SCAN']));
    const sortie = sortieT1({
      title: 'FACTURE FA-2026-0201', date: '2026-09-14', documentTypeCode: 'INVOICE', assets: [],
      facts: [{ canonicalKey: null, rawKey: 'index_compteur', value: '4512 kWh', valueType: 'string', excerpt: 'Index releve 4512 kWh', assetId: null }],
      texte: ['--- page 1 ---', 'FACTURE FA-2026-0201', 'Fournisseur EDF SA', 'Total TTC 120,00 EUR',
        '--- page 2 ---', 'Releve compteur n° 778899', 'Index releve 4512 kWh'],
    });
    const rep = await rejouer([T1(sortie)]);
    const out = await analyser(c, f.id);
    expect(out?.failedSourceIds).toEqual([]);
    // Une seule lecture du document par le modèle : la transcription OCR n'ajoute aucun appel.
    expect(analysesPrincipales(rep.calls)).toHaveLength(1);
    const x = await raw(f.id);
    // Extract ORIGINAL inchangé : couche texte seule, page 2 toujours signalée sans texte.
    expect(x).toMatchObject({ method: 'PDF_TEXT_LAYER', extraction_status: 'PARTIAL_OCR_REQUIRED', pages_without_text: [2] });
    expect(String(x.full_text)).not.toContain('778899');
    // Transcription de la page scannée : persistée À PART, par page, provenance distincte.
    expect(x).toMatchObject({ ocr_status: 'COMPLETE', ocr_pages_recognized: [2], ocr_pages_unreadable: [] });
    const pages = x.ocr_pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 2, status: 'RECOGNIZED', provenance: 'MODEL_TRANSCRIPTION' });
    expect(String(pages[0].text)).toContain('Releve compteur n° 778899');
    expect(pages[0].sourceUnitIds).toEqual(expect.arrayContaining(['page:2:block:1']));
    // Couverture : toutes les pages lues (couche texte ou transcription) → extraction réussie.
    const rap = await dernierRapport(f.id);
    expect(phases(rap).extraction.state).toBe('SUCCEEDED');
    expect(phases(rap).extraction.detail).toMatchObject({ files: [expect.objectContaining({ ocr: expect.objectContaining({ recognized: [2], unreadable: [] }) })] });
    const ocr = await lignes(rap.id, 'OCR_PAGE');
    expect(ocr).toEqual([expect.objectContaining({ write_result: 'WRITTEN', reason_code: 'MODEL_TRANSCRIPTION' })]);
  });

  it('T1-FIX-03 — extract tronqué et page scannée illisible : lacunes visibles, complétude et rapport jamais « complets »', async () => {
    process.env.T1_RAW_EXTRACT_MAX_PAGES = '2';
    const c = await make.account();
    const f = await fichier(c, null, await pdf([['ATTESTATION AT-2026-03', 'Emetteur Mairie'], 'SCAN', ['ANNEXE finale', 'Signature du maire']]));
    const sortie = sortieT1({
      title: 'ATTESTATION AT-2026-03', date: '2026-09-01', documentTypeCode: 'INVOICE', assets: [],
      facts: [{ canonicalKey: null, rawKey: 'emetteur', value: 'Mairie', valueType: 'string', excerpt: 'Emetteur Mairie', assetId: null }],
      // Page 2 (scan) : rien n'a pu être lu.
      texte: ['--- page 1 ---', 'ATTESTATION AT-2026-03', 'Emetteur Mairie', '--- page 3 ---', 'ANNEXE finale', 'Signature du maire'],
    });
    await rejouer([T1(sortie)]);
    await analyser(c, f.id);
    const x = await raw(f.id);
    expect(x).toMatchObject({ extraction_status: 'TRUNCATED', truncated: true, pages_without_text: [2], ocr_status: 'NONE', ocr_pages_unreadable: [2] });
    expect(String(x.truncation_reason)).toMatch(/pages 3 à 3 non extraites/);
    const rap = await dernierRapport(f.id);
    expect(rap.status).not.toBe('SUCCESS');
    expect(phases(rap).extraction.state).toBe('PARTIAL');
    expect(phases(rap).extraction.detail).toMatchObject({ gaps: expect.arrayContaining([expect.stringMatching(/tronqué/), expect.stringMatching(/page 2/)]) });
    const ocr = await lignes(rap.id, 'OCR_PAGE');
    expect(ocr).toEqual([expect.objectContaining({ write_result: 'NOT_EXAMINED', reason_code: 'OCR_PAGE_UNREADABLE' })]);
    // État de complétude existant : jamais COMPLETE.
    const [cov] = await sql<{ quality_state: string }[]>`SELECT quality_state FROM document_extraction_coverage WHERE file_id = ${f.id}`;
    expect(cov.quality_state).not.toBe('COMPLETE');
  });

  it('T1-FIX-04 — échec recordEvidence : persistance non réussie ; reprise sans Gemini, sans doublon de preuve active, attribut alimenté', async () => {
    const c = await make.account();
    const clio = await vehicule(c);
    const f = await fichier(c, clio.id, await pdf(GARAGE));
    await panne('field_evidence', 'source_id', f.id);
    await rejouer([T1(garage(clio.id))]);
    const out = await analyser(c, f.id);
    expect(out).toMatchObject({ analysedCount: 0, failedSourceIds: [f.id] });
    expect((await etat(f.id)).analysis_state).not.toBe('ANALYZED');
    const rap = await dernierRapport(f.id);
    expect(rap.steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'EVIDENCE', status: 'FAILED' })]));
    expect(phases(rap).persistence.state).toBe('FAILED');
    expect((await raw(f.id))?.persistence_status).toBe('FAILED');
    const proj = await lignes(rap.id, 'PROJECTION');
    expect(proj).toEqual(expect.arrayContaining([expect.objectContaining({ field_key: 'mileage', write_result: 'FAILED', reason_code: 'WRITE_FAILED' })]));

    await reparer('field_evidence');
    const rep = await rejouer([]);
    expect((await analyser(c, f.id))?.failedSourceIds).toEqual([]);
    expect(appelsT1(rep.calls)).toHaveLength(0);
    expect(await preuvesActives(f.id, 'mileage')).toBe(1);
    expect((await etat(f.id)).analysis_state).toBe('ANALYZED');
    // Attribut métier écrit par T1 lui-même (aucune file T3 drainée).
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 78000 });
    const attr = await lignes((await dernierRapport(f.id)).id, 'ATTRIBUTE');
    expect(attr).toEqual(expect.arrayContaining([expect.objectContaining({ field_key: 'mileage', entity_type: 'ASSET', entity_id: clio.id, write_result: 'WRITTEN' })]));
    // Nouvelle analyse complète du même document : toujours une seule preuve active, attribut inchangé.
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${f.id}`;
    await rejouer([T1(garage(clio.id))]);
    expect((await analyser(c, f.id))?.failedSourceIds).toEqual([]);
    expect(await preuvesActives(f.id, 'mileage')).toBe(1);
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 78000 });
  });

  it('T1-FIX-05 — échec de la couche source : faits conservés, persistance non réussie, couverture signalée ; réparation par reprise', async () => {
    const c = await make.account();
    const clio = await vehicule(c);
    const f = await fichier(c, clio.id, await pdf(GARAGE));
    await panne('document_source_units', 'file_id', f.id);
    await rejouer([T1(garage(clio.id))]);
    const out = await analyser(c, f.id);
    expect(out?.failedSourceIds).toEqual([f.id]);
    expect(await faitsActifs(f.id)).toBeGreaterThan(0);
    expect((await sql`SELECT 1 FROM document_source_units WHERE file_id = ${f.id}`)).toHaveLength(0);
    const rap = await dernierRapport(f.id);
    expect(rap.steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'SOURCE_LAYER', status: 'FAILED' })]));
    expect(phases(rap).persistence.state).toBe('FAILED');
    expect((await etat(f.id)).analysis_state).not.toBe('ANALYZED');

    await reparer('document_source_units');
    const rep = await rejouer([]);
    expect((await analyser(c, f.id))?.failedSourceIds).toEqual([]);
    expect(appelsT1(rep.calls)).toHaveLength(0);
    expect((await sql`SELECT 1 FROM document_source_units WHERE file_id = ${f.id}`).length).toBeGreaterThan(0);
    expect((await sql`SELECT 1 FROM document_extraction_coverage WHERE file_id = ${f.id}`)).toHaveLength(1);
    expect(phases(await dernierRapport(f.id)).persistence.state).toBe('SUCCEEDED');
  });

  it('T1-FIX-06 — faits certains d’un équipement : sa fiche alimentée dès T1, jamais le bien parent ; valeur USER protégée', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await make.asset(c, { category: 'IMMOBILIER', name: `Maison ${c.id}` });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${m.id}`;
    // Prix d'achat saisi à l'écran (colonne sans origine tracée = USER).
    const [{ id: robot }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents) VALUES (${m.id}, 'Robot aspirateur', '{}'::jsonb, 45000) RETURNING id`;
    const f = await fichier(c, m.id, await pdf([['Facture Robot aspirateur', 'Date d achat : 10/03/2025', 'Robot aspirateur 499,00 EUR']]));
    const fait = (k: string, v: string | number, ex: string): FaitT1 => ({
      canonicalKey: k, value: v, excerpt: ex, assetId: null, targetType: 'EQUIPMENT', equipmentId: robot,
      valueType: k === 'acquisitionPrice' ? 'money_eur' : 'date',
    });
    await rejouer([T1(sortieT1({
      title: 'Facture Robot aspirateur', date: '2025-03-10', documentTypeCode: 'ACQUISITION_INVOICE', canonicalType: 'FACTURE',
      amountCents: 49_900, assets: [{ id: m.id, label: 'Maison' }], equipments: [{ id: robot, label: 'Robot aspirateur' }],
      facts: [fait('acquisitionDate', '2025-03-10', 'Date d achat : 10/03/2025'), fait('acquisitionPrice', 499, 'Robot aspirateur 499,00 EUR')],
    })), T3_ABSTENTION]);
    expect((await analyser(c, f.id))?.failedSourceIds).toEqual([]);
    // AUCUNE file drainée : T1 a écrit lui-même la valeur fiable sur l'équipement.
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    const eq = (await getCanonicalEntityState({ type: 'EQUIPMENT', id: robot }, c.id))!.fields;
    expect(eq.acquisitionDate).toMatchObject({ value: '2025-03-10' });
    expect(eq.acquisitionPrice).toMatchObject({ value: 450, origin: 'USER' });
    // Bien parent jamais alimenté par une valeur de l'équipement (lot 71A).
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    const bien = (await getCanonicalAssetState(m.id, c.id))!.fields;
    expect(bien.acquisitionDate).toBeUndefined();
    expect(bien.acquisitionPrice).toBeUndefined();
    const attr = await lignes((await dernierRapport(f.id)).id, 'ATTRIBUTE');
    expect(attr).toEqual(expect.arrayContaining([
      expect.objectContaining({ field_key: 'acquisitionDate', entity_type: 'EQUIPMENT', entity_id: robot, write_result: 'WRITTEN' }),
      expect.objectContaining({ field_key: 'acquisitionPrice', entity_type: 'EQUIPMENT', entity_id: robot, write_result: 'NOT_WRITTEN' }),
    ]));
    expect(attr.some((a) => a.entity_type === 'ASSET')).toBe(false);
  });

  it('T1-FIX-07 — run dédupliqué avec écritures manquantes : propositions et métadonnées réparées sans nouvel appel Gemini', async () => {
    const c = await make.account();
    const clio = await vehicule(c);
    const f = await fichier(c, clio.id, await pdf(GARAGE));
    await panne('document_facts', 'file_id', f.id);
    await rejouer([T1(garage(clio.id))]);
    expect((await analyser(c, f.id))?.failedSourceIds).toEqual([f.id]);
    const [r1] = await run(f.id);
    // Écritures du run perdues (run historique incomplet) : propositions et métadonnées.
    await sql`DELETE FROM document_analysis_proposals WHERE run_id = ${r1.id}`;
    await sql`UPDATE asset_files SET document_type = NULL WHERE id = ${f.id}`;

    await reparer('document_facts');
    const rep = await rejouer([]);
    expect((await analyser(c, f.id))?.failedSourceIds).toEqual([]);
    expect(appelsT1(rep.calls)).toHaveLength(0);
    const runs = await run(f.id);
    expect(runs).toEqual([expect.objectContaining({ id: r1.id, writes_status: 'SUCCEEDED', has_snapshot: false })]);
    const props = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_proposals WHERE run_id = ${r1.id}`;
    expect(props[0].n).toBeGreaterThan(0);
    expect((await etat(f.id)).document_type).not.toBeNull();
    expect((await etat(f.id)).analysis_state).toBe('ANALYZED');
    expect(await faitsActifs(f.id)).toBe(1);
    const rap = await dernierRapport(f.id);
    expect(rap.sources).toMatchObject({ deduplicatedRun: true });
    expect(rap.steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'ANALYSIS_RUN', status: 'OK', detail: expect.objectContaining({ repaired: expect.arrayContaining(['PROPOSALS', 'METADATA']) }) })]));
  });

  it('T1-FIX-08 — fichier remplacé au même emplacement : extract invalidé et réextrait', async () => {
    const c = await make.account();
    const f = await fichier(c, null, await pdf([['CONTRAT VERSION A', 'Prime 100 EUR']]));
    const sortie = (v: string) => sortieT1({ title: `CONTRAT VERSION ${v}`, date: '2026-01-01', documentTypeCode: 'INVOICE', assets: [], facts: [], texte: [`Prime 100 EUR`] });
    await rejouer([T1(sortie('A'))]);
    await analyser(c, f.id);
    const a = await raw(f.id);
    expect(String(a.full_text)).toContain('VERSION A');
    // Même objet de stockage, contenu remplacé.
    stockage.bytes = await pdf([['CONTRAT VERSION B', 'Prime 100 EUR']]);
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${f.id}`;
    await rejouer([T1(sortie('B'))]);
    await analyser(c, f.id);
    const b = await raw(f.id);
    expect(b.source_ref).toBe(a.source_ref);
    expect(String(b.full_text)).toContain('VERSION B');
    expect(String(b.full_text)).not.toContain('VERSION A');
    expect(b.source_sha256).not.toBe(a.source_sha256);
    expect(b.reuse_count).toBe(0);
  });

  it('T1-FIX-09 — échec Gemini : trace, modèle, code et étape rattachés au rapport T1, retrouvable depuis le BO', async () => {
    const c = await make.account();
    const f = await fichier(c, null, await pdf(GARAGE));
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: null,
      error: { name: 'TypeError', message: BYTESTRING, stage: 'request_build' } }]);
    const out = await analyser(c, f.id);
    expect(out?.failedSourceIds).toEqual([f.id]);
    const traces = await sql<{ trace_id: string; model: string; error_code: string }[]>`
      SELECT metadata->>'traceId' AS trace_id, model, error_code FROM ai_usage_event
       WHERE account_id = ${c.id} AND operation_code = 't1_analyze_document' ORDER BY id`;
    expect(traces.length).toBeGreaterThan(0);
    const rap = await dernierRapport(f.id);
    expect(rap.status).toBe('FAILED');
    expect(rap.trace_ids).toEqual(expect.arrayContaining(traces.map((t) => t.trace_id)));
    expect(phases(rap).structuring.state).toBe('FAILED');
    expect(phases(rap).structuring.detail).toMatchObject({
      code: 'REQUEST_BUILD_FAILED', stage: 'request_build',
      attempts: expect.arrayContaining([expect.objectContaining({ traceId: traces[0].trace_id, model: traces[0].model, errorCode: 'REQUEST_BUILD_FAILED' })]),
    });
    // BO › Exécutions IA : la trace retrouve le rapport du document.
    const { reportsForExecution } = await import('@/services/ai/execution-report/repository');
    const lies = await reportsForExecution({ accountId: c.id, jobId: null, traceId: traces[0].trace_id, fileId: f.id });
    expect(lies.map((x) => Number(x.id))).toContain(Number(rap.id));
  });
});
