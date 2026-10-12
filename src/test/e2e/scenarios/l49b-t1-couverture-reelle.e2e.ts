/**
 * Lot 49B sur base réelle — ticket « T1 — Garantir la couverture réelle des
 * documents et corriger les pertes résiduelles d'extraction » : TC01, TC06,
 * TC07, TC08, TC09, TC11 (TC12 : `l34f-t1-extraction-exhaustive.e2e.ts`,
 * reprise historique ; tous les TC en unitaire : `t1x-completude.test.ts`).
 *
 * Point d'entrée de production (`analyzeFileSources`), passerelle RÉELLE,
 * sorties modèle rejouées ; reprise planifiée `runCompletenessRetry` (tâche
 * interne `t1-completeness-retry`). Vérifie l'état final EN BASE : couche A
 * (`repair_state`), couverture (`source_verification`, `verification`,
 * dernière reprise), originaux conservés (`document_unresolved_facts`),
 * faits sans doublon, BO (Exécutions IA › Complétude T1).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
/** PDF original servi à la vérification de couverture (aucune lecture S3 réelle). */
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
const sortie = (p: { transcription?: string; facts?: Fait[]; document?: Record<string, unknown> }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: p.document ?? {
    title: { value: 'Relevé de compteurs 2026', confidence: 'certain', evidence: { excerpt: 'Relevé de compteurs 2026', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: [],
  facts: p.facts ?? [],
  hasExploitableContent: true,
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput =>
  ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
const REPARATION = (output: unknown, over: Partial<RecordedOutput> = {}) => T1(output, { promptIncludes: '[page:1:field:', ...over });
const SUFFIXES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett'];
const THEMES = ['', 'chaudiere', 'radiateur', 'thermostat', 'ventilation', 'plomberie', 'electricite', 'toiture', 'isolation', 'fenetre', 'charpente'];
const textePage = (n: number) => SUFFIXES.map((x) => `${THEMES[n]}${x}`).join(' ');

scenario('L49B-T1', 'T1 — couverture réelle de la source, pertes de normalisation, réparations reprises', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  afterEach(() => {
    pdf.bytes = null;
    for (const k of ['T1_REPAIR_MAX_CALLS', 'T1_COMPLETENESS_MAX_RETRIES']) delete process.env[k];
  });

  const fichier = async (compte: Compte) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`releve-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const analyser = async (compte: Compte, fileId: number, records: RecordedOutput[]) => {
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l49b-t1' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const appelsT1 = (replay: { calls: Array<{ operationCode?: string; attachments: unknown[]; prompt: string }> }) =>
    replay.calls.filter((c) => c.operationCode === 't1_analyze_document');
  const couverture = async (fileId: number) => (await sql<Array<Record<string, unknown> & { verification: Record<string, unknown> | null }>>`
    SELECT quality_state, anomalies, retry_attempts, next_retry_at, source_verification, verification, last_retry_at, last_retry_result, origin
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const etats = async (fileId: number) => (await sql<{ id: string; status: string; repair_state: string | null; attempts: number }[]>`
    SELECT source_unit_id AS id, coverage_status AS status, repair_state, repair_attempts AS attempts
      FROM document_source_units WHERE file_id = ${fileId} AND kind = 'LABEL_VALUE' ORDER BY ordinal`);
  const faits = async (fileId: number) => sql<{ raw_value: string | null }[]>`
    SELECT raw_value FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const echeance = (fileId: number) => sql`UPDATE document_extraction_coverage SET next_retry_at = now() - interval '1 minute' WHERE file_id = ${fileId}`;
  const reprise = async () => {
    const { runCompletenessRetry } = await import('@/services/ai/source-analysis/source-units/jobs');
    return runCompletenessRetry();
  };
  const pdfReel = async (pages: string[]) => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const t of pages) doc.addPage([600, 800]).drawText(t, { x: 30, y: 760, size: 9, font });
    return doc.save();
  };

  it('migration 0329 : idempotente (deux passes), colonnes de vérification et d’état de réparation', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const texte = await readFile(join(process.cwd(), 'src/db/migrations', '0329_t1_source_verification.sql'), 'utf-8');
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const cols = await sql<{ c: string }[]>`
      SELECT table_name || '.' || column_name AS c FROM information_schema.columns
       WHERE (table_name = 'document_source_units' AND column_name = 'repair_state')
          OR (table_name = 'document_extraction_coverage' AND column_name IN ('source_verification', 'verification', 'last_retry_at', 'last_retry_result'))
       ORDER BY 1`;
    expect(cols.map((x) => x.c)).toEqual([
      'document_extraction_coverage.last_retry_at', 'document_extraction_coverage.last_retry_result',
      'document_extraction_coverage.source_verification', 'document_extraction_coverage.verification', 'document_source_units.repair_state',
    ]);
  });

  it('TC01 — omission silencieuse : PDF de 10 pages, réponse limitée aux pages 1 à 7 → pages 8 à 10 reprises (lot ciblé) ; vérification persistée ; jamais COMPLETE prématurément', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel(Array.from({ length: 10 }, (_, k) => textePage(k + 1)));
    const replay = await analyser(compte, f.id, [
      T1(sortie({ transcription: [8, 9, 10].map(textePage).join('\n\n') }), { promptIncludes: 'extrait de 3 page(s)' }),
      T1(sortie({ transcription: [1, 2, 3, 4, 5, 6, 7].map(textePage).join('\n\n') })),
    ]);
    expect(appelsT1(replay)).toHaveLength(2);
    expect((appelsT1(replay)[1].attachments[0] as { displayName?: string }).displayName).toContain('pages 8 à 10');
    const c = await couverture(f.id);
    expect(c).toMatchObject({ source_verification: 'VERIFIED' });
    expect(c.quality_state).not.toBe('COMPLETE');
    expect(c.verification).toMatchObject({ pagesExpected: 10, pagesVerified: 10, pagesMissing: [], pagesReread: [8, 9, 10] });
    const [e] = await sql<{ t: string }[]>`SELECT full_text AS t FROM document_extractions WHERE file_id = ${f.id}`;
    expect(e.t).toContain(textePage(10));
  });

  it('TC06 / TC07 — valeur réduite par le contrat ou retirée par la normalisation : original INTÉGRAL récupérable en base, avec son motif ; BO : originaux = réductions', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const long = `Libellé ${'très '.repeat(80)}long`;
    await analyser(compte, f.id, [T1(sortie({
      transcription: 'Relevé de compteurs 2026\nRéférence : REF-1',
      facts: [fait('Référence : REF-1', 'REF-1', { label: long })],
      document: {
        title: { value: 'Relevé de compteurs 2026', confidence: 'certain', evidence: { excerpt: 'Relevé de compteurs 2026', page: 1 } },
        documentDate: { value: 'courant du trimestre prochain', confidence: 'probable', evidence: {} },
      },
    }))]);
    const rec = await sql<{ reason: string; status: string; raw_key: string; raw_value: string; detail: string; source_unit_ids: string[] }[]>`
      SELECT reason, status, raw_key, raw_value, detail, source_unit_ids FROM document_unresolved_facts
       WHERE file_id = ${f.id} AND reason IN ('VALUE_TRUNCATED', 'VALUE_NOT_NORMALIZABLE') ORDER BY reason`;
    expect(rec).toEqual([
      expect.objectContaining({ reason: 'VALUE_NOT_NORMALIZABLE', status: 'UNRESOLVED', raw_key: 'document.documentDate', detail: expect.stringContaining('retirée') }),
      expect.objectContaining({ reason: 'VALUE_TRUNCATED', status: 'RETAINED', raw_key: 'facts[0].label', raw_value: long, source_unit_ids: ['page:1:field:1'] }),
    ]);
    const c = await couverture(f.id);
    expect(c.verification).toMatchObject({ truncations: 1, originalsPreserved: 1, normalisationLosses: 0 });
    expect(c.anomalies).not.toContain('NORMALISATION_LOSS');
  });

  it('TC08 — budget épuisé : unités hors budget persistées (PENDING), reprise automatique (continuation sans consommer de tentative) ; BO : réparation en attente', async () => {
    process.env.T1_REPAIR_MAX_CALLS = '1';
    pdf.bytes = await pdfReel(['']);
    const compte = await make.account();
    const f = await fichier(compte);
    const lignes = Array.from({ length: 130 }, (_, i) => `Compteur ${i + 1} : CPT-${10_000 + i}`);
    await analyser(compte, f.id, [
      REPARATION(sortie({ facts: [] }), { repeat: true }),
      T1(sortie({ transcription: ['Relevé de compteurs 2026', ...lignes].join('\n') })),
    ]);
    const u1 = await etats(f.id);
    expect(u1.filter((u) => u.repair_state === 'PENDING')).toHaveLength(10);
    expect(u1.filter((u) => u.repair_state === 'PENDING').every((u) => u.attempts === 0 && u.status === 'UNRESOLVED')).toBe(true);
    const c1 = await couverture(f.id);
    expect(c1).toMatchObject({ quality_state: 'INCOMPLETE_RETRYABLE', retry_attempts: 0 });
    expect(c1.next_retry_at).not.toBeNull();
    expect(c1.anomalies).toEqual(expect.arrayContaining(['REPAIR_PENDING']));
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const bo = await getT1CompletenessOverview({ days: 1, anomaly: 'REPAIR_PENDING' });
    expect(bo.rows.find((x) => x.fileId === f.id)).toMatchObject({ sourceVerification: 'VERIFIED', verification: expect.objectContaining({ pendingRepairUnits: 10 }) });

    // Reprise planifiée : la suite (dont les 10 unités en attente) est examinée, sans tentative consommée.
    process.env.T1_REPAIR_MAX_CALLS = '2';
    await echeance(f.id);
    const replay = await rejouer([REPARATION(sortie({ facts: [fait('Compteur 130 : CPT-10129', 'CPT-10129')] }), { repeat: true })]);
    const r = await reprise();
    expect(r.repaired).toBe(1);
    expect(appelsT1(replay).every((c) => c.attachments.length === 0)).toBe(true);
    const u2 = await etats(f.id);
    expect(u2.filter((u) => u.repair_state === 'PENDING')).toEqual([]);
    expect(u2.find((u) => u.id === 'page:1:field:130')).toMatchObject({ status: 'COVERED', repair_state: 'SUCCEEDED' });
    const c2 = await couverture(f.id);
    expect(c2).toMatchObject({ quality_state: 'COMPLETE_WITH_UNRESOLVED', retry_attempts: 0, next_retry_at: null, last_retry_result: 'REPAIRED_1' });
    expect(c2.last_retry_at).not.toBeNull();
    expect((await faits(f.id)).map((x) => x.raw_value)).toEqual(['CPT-10129']);
  });

  it('TC09 — réparation infructueuse : arrêt au plafond de tentatives, sans boucle ; INCOMPLETE_FINAL et anomalie en Supervision', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    const panne = { error: { message: 'délai dépassé', code: 'TIMEOUT', recoverable: true }, repeat: true } as Partial<RecordedOutput>;
    await analyser(compte, f.id, [
      REPARATION(null, panne),
      T1(sortie({ transcription: 'Relevé de compteurs 2026\nRéférence : REF-1\nN° de série : SN-4242', facts: [fait('Référence : REF-1', 'REF-1')] })),
    ]);
    expect(await couverture(f.id)).toMatchObject({ quality_state: 'INCOMPLETE_RETRYABLE' });
    const replay = await rejouer([REPARATION(null, panne)]);
    for (let n = 0; n < 5; n++) {
      await sql`UPDATE document_extraction_coverage SET next_retry_at = now() - interval '1 minute' WHERE file_id = ${f.id} AND next_retry_at IS NOT NULL`;
      await reprise();
    }
    const c = await couverture(f.id);
    expect(c).toMatchObject({ quality_state: 'INCOMPLETE_FINAL', retry_attempts: 2, next_retry_at: null });
    // Deux reprises au plus (la passerelle peut réessayer chaque appel) ; l'unité a atteint le plafond.
    const [u] = (await etats(f.id)).filter((x) => x.id === 'page:1:field:2');
    expect(u).toMatchObject({ status: 'FAILED', attempts: 3, repair_state: 'EXHAUSTED' });
    const n = appelsT1(replay).length;
    await reprise();
    expect(appelsT1(replay).length).toBe(n);
    const [a] = await sql<{ status: string }[]>`SELECT status FROM admin_anomalies WHERE fingerprint = ${`ai:t1-completeness:${f.id}`}`;
    expect(a.status).toBe('open');
  });

  it('TC11 — redémarrage / concurrence : document réservé par un bail (une seule exécution) ; reprise rejouée après interruption sans doublon de faits', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    await analyser(compte, f.id, [
      REPARATION(null, { error: { message: 'délai dépassé', code: 'TIMEOUT', recoverable: true }, repeat: true }),
      T1(sortie({ transcription: 'Relevé de compteurs 2026\nRéférence : REF-1\nN° de série : SN-4242', facts: [fait('Référence : REF-1', 'REF-1')] })),
    ]);
    await echeance(f.id);
    await rejouer([REPARATION(sortie({ facts: [fait('N° de série : SN-4242', 'SN-4242')] }), { repeat: true })]);
    // Deux exécutions concurrentes : le document n'est traité qu'une fois.
    const [r1, r2] = await Promise.all([reprise(), reprise()]);
    expect(r1.examined + r2.examined).toBe(1);
    expect((await faits(f.id)).map((x) => x.raw_value)).toEqual(['REF-1', 'SN-4242']);
    // Worker interrompu APRÈS l'écriture des faits, AVANT celle de la couche A : la reprise est rejouée.
    await sql`UPDATE document_source_units SET coverage_status = 'FAILED', coverage_reason = 'repair_failed:retryable', repair_state = 'ATTEMPTED_FAILED'
               WHERE file_id = ${f.id} AND source_unit_id = 'page:1:field:2'`;
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 0 WHERE file_id = ${f.id}`;
    await echeance(f.id);
    await reprise();
    // Aucun doublon : le fait déjà écrit n'est pas réinséré.
    expect((await faits(f.id)).map((x) => x.raw_value)).toEqual(['REF-1', 'SN-4242']);
    // Bail d'un worker arrêté : le document reste réservé jusqu'à l'échéance, puis est repris.
    await sql`UPDATE document_extraction_coverage SET next_retry_at = now() + interval '30 minutes' WHERE file_id = ${f.id}`;
    expect((await reprise()).examined).toBe(0);
  });
});
