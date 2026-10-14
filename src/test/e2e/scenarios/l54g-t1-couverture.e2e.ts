/**
 * Lot 54G sur base réelle (PG16) — ticket « T1 : finaliser la couverture
 * réelle des documents et supprimer les pertes résiduelles d'extraction » :
 * TC13 à TC19, TC05 (cycle complet NEEDS_SOURCE → relecture du fichier) et
 * BO › Exécutions IA (diagnostics agrégés). Unitaires : `t1x-completude.test.ts`.
 *
 * Point d'entrée de production (`analyzeFileSources`), passerelle RÉELLE,
 * sorties modèle rejouées (aucun appel réseau) ; reprise planifiée
 * `runCompletenessRetry` (tâche interne `t1-completeness-retry`). Vérifie
 * l'état final EN BASE.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** PDF original servi à la vérification et à la relecture (aucune lecture S3 réelle). */
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
const sortie = (p: { transcription?: string; facts?: Fait[]; observations?: unknown[]; tables?: unknown[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Relevé de compteurs 2026', confidence: 'certain', evidence: { excerpt: 'Relevé de compteurs 2026', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  ...(p.observations ? { visual: { observations: p.observations } } : {}),
  tables: p.tables ?? [],
  facts: p.facts ?? [],
  hasExploitableContent: true,
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput =>
  ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
/** Relecture du FICHIER (reprise NEEDS_SOURCE) : SOURCES « relecture ciblée ». */
const RELECTURE = (output: unknown, over: Partial<RecordedOutput> = {}) => T1(output, { promptIncludes: 'relecture ciblée', ...over });
const SUFFIXES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett'];
const THEMES = ['', 'chaudiere', 'radiateur', 'thermostat', 'ventilation', 'plomberie'];
const textePage = (n: number) => SUFFIXES.map((x) => `${THEMES[n]}${x}`).join(' ');
const PAGE_1 = `Releve de compteurs ${textePage(1)}`;
const OBS = 'Trace d’humidité au plafond';

scenario('L54G-T1', 'T1 — couverture réelle : pages citées, relecture NEEDS_SOURCE, champs prunés, tableaux, BO', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  afterEach(() => {
    pdf.bytes = null;
    delete process.env.T1_COMPLETENESS_MAX_RETRIES;
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
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l54g-t1' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const appelsT1 = (replay: { calls: Array<{ operationCode?: string; attachments: unknown[]; prompt: string }> }) =>
    replay.calls.filter((c) => c.operationCode === 't1_analyze_document');
  const relectures = (replay: Parameters<typeof appelsT1>[0]) => appelsT1(replay).filter((c) => c.prompt.includes('relecture ciblée'));
  const couverture = async (fileId: number) => (await sql<Array<Record<string, unknown> & { verification: Record<string, unknown> | null; anomalies: string[] }>>`
    SELECT quality_state, anomalies, retry_attempts, next_retry_at, source_verification, verification, last_retry_result
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const unite = async (fileId: number, kind: string) => (await sql<{ id: string; status: string; reason: string | null; repair_state: string | null; attempts: number; payload: Record<string, unknown> }[]>`
    SELECT source_unit_id AS id, coverage_status AS status, coverage_reason AS reason, repair_state, repair_attempts AS attempts, payload
      FROM document_source_units WHERE file_id = ${fileId} AND kind = ${kind} ORDER BY ordinal`);
  const echeance = (fileId: number) => sql`UPDATE document_extraction_coverage SET next_retry_at = now() - interval '1 minute' WHERE file_id = ${fileId}`;
  const reprise = async () => {
    const { runCompletenessRetry } = await import('@/services/ai/source-analysis/source-units/jobs');
    return runCompletenessRetry();
  };
  const pdfReel = async (pages: Array<string | null>, scannees: number[] = []) => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const png = scannees.length
      ? await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
      : null;
    pages.forEach((t, i) => {
      const page = doc.addPage([600, 800]);
      if (scannees.includes(i + 1)) page.drawImage(png!, { x: 0, y: 0, width: 600, height: 800 });
      else if (t) page.drawText(t, { x: 30, y: 760, size: 9, font });
    });
    return doc.save();
  };
  const premiere = (confidence: 'conflictual' | 'certain' = 'conflictual') => T1(sortie({
    transcription: `${PAGE_1}\nRéférence : REF-1`, facts: [fait('Référence : REF-1', 'REF-1')],
    observations: [{ description: OBS, confidence, page: 1 }],
  }));

  it('TC13 — page citée par un seul fait mais omise de la transcription : MANQUANTE, reprise ciblée de cette seule page, puis VERIFIED', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([PAGE_1, textePage(2)]);
    const replay = await analyser(compte, f.id, [
      T1(sortie({ transcription: textePage(2) }), { promptIncludes: 'extrait de 1 page(s)' }),
      T1(sortie({
        transcription: `${PAGE_1}\nRéférence : radiateuralpha`,
        facts: [fait('Référence : radiateuralpha', 'radiateuralpha', { evidence: { excerpt: 'Référence : radiateuralpha', page: 2 } })],
      })),
    ]);
    expect(appelsT1(replay)).toHaveLength(2);
    expect((appelsT1(replay)[1].attachments[0] as { displayName?: string }).displayName).toContain('pages 2 à 2');
    const c = await couverture(f.id);
    expect(c).toMatchObject({ source_verification: 'VERIFIED' });
    expect(c.verification).toMatchObject({ pagesExpected: 2, pagesVerified: 2, pagesReread: [2], pagesMissing: [] });
  });

  it('TC14 — PDF scanné, observation et fait visuel page 1 : page citée non vérifiée, VERIFICATION_INCOMPLETE persisté, jamais COMPLETE', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([null, null], [1, 2]);
    await analyser(compte, f.id, [T1(sortie({
      transcription: 'Relevé de compteurs 2026',
      observations: [{ description: 'Fissure en façade', confidence: 'certain', page: 1 }],
    }))]);
    const c = await couverture(f.id);
    expect(c).toMatchObject({ quality_state: 'VERIFICATION_INCOMPLETE', source_verification: 'PARTIAL' });
    expect(c.verification).toMatchObject({ pagesVerified: 0, pagesUnverified: [1, 2], pagesCitedUnverified: [1], pagesScanned: [1, 2] });
    expect(c.anomalies).toEqual(expect.arrayContaining(['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED']));
  });

  it('TC05 / TC15 — NEEDS_SOURCE résolu : reprise programmée → relecture du FICHIER (page concernée) → SUCCEEDED, couverture recalculée, faits sans doublon', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([`${PAGE_1} Reference REF-1`]);
    const r1 = await analyser(compte, f.id, [premiere()]);
    expect(relectures(r1)).toHaveLength(0);
    const [o1] = await unite(f.id, 'VISUAL_OBSERVATION');
    expect(o1).toMatchObject({ status: 'UNCERTAIN', repair_state: 'NEEDS_SOURCE', attempts: 0 });
    const c1 = await couverture(f.id);
    expect(c1).toMatchObject({ quality_state: 'COMPLETE_WITH_UNRESOLVED', retry_attempts: 0 });
    // Une vraie reprise est programmée (plus d'état NEEDS_SOURCE jamais consommé).
    expect(c1.next_retry_at).not.toBeNull();
    expect(c1.verification).toMatchObject({ needsSourceUnits: 1 });

    await echeance(f.id);
    const replay = await rejouer([RELECTURE(sortie({
      observations: [{ description: `${OBS} de la cuisine`, confidence: 'certain', page: 1 }],
      facts: [fait('', 'humidité au plafond', {
        provenance: 'VISUAL_ANALYSIS', rawKey: 'etat.humidite', evidence: { page: 1 }, visualEvidence: { description: OBS, page: 1 },
      })],
    }))]);
    const r = await reprise();
    expect(r).toMatchObject({ examined: 1, failed: 0 });
    expect(relectures(replay)).toHaveLength(1);
    // Fichier ORIGINAL relu (pièce jointe : la page concernée), jamais le texte déjà extrait.
    expect((relectures(replay)[0].attachments[0] as { displayName?: string; mimeType?: string })).toMatchObject({
      mimeType: 'application/pdf', displayName: expect.stringContaining('pages 1 à 1'),
    });
    const [o2] = await unite(f.id, 'VISUAL_OBSERVATION');
    expect(o2).toMatchObject({ status: 'COVERED', reason: 'observation_verified', repair_state: 'SUCCEEDED', attempts: 1 });
    const c2 = await couverture(f.id);
    expect(c2).toMatchObject({ retry_attempts: 1, next_retry_at: null, last_retry_result: 'SOURCE_REREAD_RESOLVED_1' });
    expect(c2.verification).toMatchObject({ needsSourceUnits: 0, sourceRereads: 1, sourceRereadResolved: 1, sourceRereadsFailed: 0 });
    // Fait visuel prouvé ajouté une seule fois, sans écraser les faits existants.
    const faits = await sql<{ raw_value: string | null }[]>`SELECT raw_value FROM document_facts WHERE file_id = ${f.id} AND status = 'active' ORDER BY id`;
    // (l'observation elle-même est déjà persistée comme fait visuel `visual.*` à la 1re analyse, sans valeur brute).
    expect(faits.map((x) => x.raw_value).filter((v) => v !== null)).toEqual(['REF-1', 'humidité au plafond']);
    // Rien de plus à relire : aucune nouvelle relecture.
    await echeance(f.id);
    await reprise();
    expect(relectures(replay)).toHaveLength(1);
  });

  it('TC16 — NEEDS_SOURCE non résolu : UNCERTAIN maintenu, relectures bornées (2), EXHAUSTED, jamais COMPLETE, aucune boucle', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([`${PAGE_1} Reference REF-1`]);
    await analyser(compte, f.id, [premiere()]);
    const replay = await rejouer([RELECTURE(sortie({ observations: [{ description: OBS, confidence: 'conflictual', page: 1 }] }), { repeat: true })]);
    for (let n = 0; n < 5; n++) {
      await sql`UPDATE document_extraction_coverage SET next_retry_at = now() - interval '1 minute' WHERE file_id = ${f.id} AND next_retry_at IS NOT NULL`;
      await reprise();
    }
    expect(relectures(replay)).toHaveLength(2);
    const [o] = await unite(f.id, 'VISUAL_OBSERVATION');
    expect(o).toMatchObject({ status: 'UNCERTAIN', repair_state: 'EXHAUSTED', attempts: 2 });
    const c = await couverture(f.id);
    expect(c).toMatchObject({ quality_state: 'COMPLETE_WITH_UNRESOLVED', retry_attempts: 2, next_retry_at: null });
    expect(String(c.last_retry_result)).toMatch(/^SOURCE_REREAD_PARTIAL_0_OF_1/);
    expect(c.verification).toMatchObject({ needsSourceUnits: 0, needsSourceExhausted: 1, sourceRereads: 2, sourceRereadsFailed: 2 });
    expect(c.anomalies).toContain('REPAIR_EXHAUSTED');
  });

  it('isolation intercomptes : fichier passé sous un autre compte → jamais relu pour ce compte (aucun appel IA), relecture en échec tracée, incertitude maintenue', async () => {
    const compte = await make.account();
    const autre = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([`${PAGE_1} Reference REF-1`]);
    await analyser(compte, f.id, [premiere()]);
    await sql`UPDATE asset_files SET account_id = ${autre.id} WHERE id = ${f.id}`;
    await echeance(f.id);
    const replay = await rejouer([RELECTURE(sortie({ observations: [{ description: OBS, confidence: 'certain', page: 1 }] }), { repeat: true })]);
    await reprise();
    expect(relectures(replay)).toHaveLength(0);
    const [o] = await unite(f.id, 'VISUAL_OBSERVATION');
    expect(o).toMatchObject({ status: 'UNCERTAIN', repair_state: 'NEEDS_SOURCE', attempts: 1 });
    expect(await couverture(f.id)).toMatchObject({ last_retry_result: 'SOURCE_REREAD_FAILED', retry_attempts: 1 });
  });

  it('TC17 — champ rejeté par la validation de la passerelle : FIELD_PRUNED en base avec valeur originale, motif, unité ; NORMALISATION_LOSS = 0', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([`${PAGE_1} Reference REF-1`]);
    const region = { x1: 'gauche', y1: 0.1, x2: 0.5, y2: 0.6 };
    await analyser(compte, f.id, [T1(sortie({
      transcription: `${PAGE_1}\nRéférence : REF-1`, facts: [fait('Référence : REF-1', 'REF-1')],
      observations: [{ description: 'Fissure en façade', confidence: 'certain', page: 1, region }],
    }), { repeat: true })]);
    const rec = await sql<{ reason: string; status: string; raw_key: string; raw_value: string; source_unit_ids: string[]; original_payload: Record<string, unknown>; detail: string }[]>`
      SELECT reason, status, raw_key, raw_value, source_unit_ids, original_payload, detail FROM document_unresolved_facts
       WHERE file_id = ${f.id} AND reason = 'FIELD_PRUNED'`;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ status: 'UNRESOLVED', raw_key: 'visual.observations[0].region', raw_value: JSON.stringify(region), detail: expect.stringContaining('retiré par la validation') });
    expect(rec[0].source_unit_ids).toHaveLength(1);
    expect(rec[0].original_payload).toMatchObject({ originalValue: region, preserved: true, container: { value: expect.objectContaining({ description: 'Fissure en façade' }) } });
    const c = await couverture(f.id);
    expect(c.verification).toMatchObject({ normalisationLosses: 0, prunedFields: 1, prunedOriginalsPreserved: 1 });
    expect(c.anomalies).not.toContain('NORMALISATION_LOSS');
  });

  it('TC18 / TC19 — tableau incertain : une ligne non confirmée → TABLE UNCERTAIN (jamais COMPLETE) ; reprise confirmant la ligne → TABLE COVERED / table_verified', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([`${PAGE_1} Reference REF-1`]);
    const tableau = {
      title: 'Pièces', pageStart: 1, uncertain: true, uncertaintyNote: 'colonnes ambiguës',
      columns: [{ header: 'Réf' }, { header: 'Prix' }],
      rows: [{ cells: [{ column: 0, value: 'KIT-778' }, { column: 1, value: '24,90 €' }] }, { cells: [{ column: 0, value: 'JOINT-12' }, { column: 1, value: '3,50 €' }] }],
    };
    await analyser(compte, f.id, [
      T1(sortie({ facts: [fait('KIT-778', 'KIT-778'), fait('24,90 €', '24,90 €'), fait('JOINT-12', 'JOINT-12')] }), { promptIncludes: '[page:1:table:1:row:' }),
      T1(sortie({ transcription: `${PAGE_1}\nRéférence : REF-1`, facts: [fait('Référence : REF-1', 'REF-1')], tables: [tableau] })),
    ]);
    // TC19 : une ligne reste incertaine → le tableau aussi ; jamais COMPLETE.
    expect((await unite(f.id, 'TABLE_ROW')).map((u) => u.status)).toEqual(['COVERED', 'UNCERTAIN']);
    expect((await unite(f.id, 'TABLE'))[0]).toMatchObject({ status: 'UNCERTAIN', reason: 'table_uncertain' });
    const c1 = await couverture(f.id);
    expect(c1.quality_state).not.toBe('COMPLETE');
    expect(c1.verification).toMatchObject({ tablesUncertain: 1, tablesResolved: 0 });
    // TC18 : reprise ciblée qui confirme la ligne restante → parent recalculé depuis ses lignes.
    await echeance(f.id);
    await rejouer([T1(sortie({ facts: [fait('JOINT-12', 'JOINT-12'), fait('3,50 €', '3,50 €')] }), { promptIncludes: '[page:1:table:1:row:', repeat: true })]);
    await reprise();
    expect((await unite(f.id, 'TABLE_ROW')).map((u) => [u.status, u.reason])).toEqual([['COVERED', 'table_verified'], ['COVERED', 'table_verified']]);
    const [t] = await unite(f.id, 'TABLE');
    expect(t).toMatchObject({ status: 'COVERED', reason: 'table_verified' });
    expect(t.payload.uncertain).toBe(true);
    expect((await couverture(f.id)).verification).toMatchObject({ tablesUncertain: 0, tablesResolved: 1 });
  });

  it('BO › Exécutions IA : diagnostics T1 agrégés (pages, relectures, champs retirés, tableaux) — compteurs seulement', async () => {
    const compte = await make.account();
    const f = await fichier(compte);
    pdf.bytes = await pdfReel([null, null], [1, 2]);
    await analyser(compte, f.id, [T1(sortie({
      transcription: 'Relevé de compteurs 2026',
      observations: [{ description: OBS, confidence: 'conflictual', page: 1, region: { x1: 'gauche', y1: 0, x2: 1, y2: 1 } }],
    }), { repeat: true })]);
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const bo = await getT1CompletenessOverview({ days: 1 });
    expect(bo.totals).toBeDefined();
    expect(bo.totals!.documents).toBeGreaterThanOrEqual(1);
    expect(bo.totals!.needsSourceUnits).toBeGreaterThanOrEqual(1);
    expect(bo.totals!.pagesCitedUnverified).toBeGreaterThanOrEqual(1);
    expect(bo.totals!.prunedFields).toBeGreaterThanOrEqual(1);
    const row = bo.rows.find((x) => x.fileId === f.id)!;
    expect(row.verification).toMatchObject({ needsSourceUnits: 1, pagesCitedUnverified: [1], prunedOriginalsPreserved: 1 });
    // Aucun contenu du document dans les diagnostics.
    expect(JSON.stringify(row.verification)).not.toContain('humidité');
  });
});
