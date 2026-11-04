/**
 * Lot 108K — correctifs de conformité du lot 91D (ticket #581 bis), sur
 * PostgreSQL 16 réel. Analyses T1 par le point d'entrée de PRODUCTION
 * (`analyzeFileSources`, passerelle réelle, sorties modèle rejouées),
 * campagnes de l'orchestrateur unique, diagnostic BO (lot 107G). Version BO
 * du prompt T1 posée par le test (texte livré + bloc du guide du PO, jamais
 * modifié).
 *
 *   L108K-E2E-01  §A : « non pertinent » rendu par T1 → décision INVALIDE
 *                 (REASON_GENERIC), omission conservée, réexamen ciblé, puis
 *                 exclusion étayée → justifiée ; décision VALIDE d'avant le
 *                 correctif au motif générique → rejugée, plus aucune
 *                 justification (aucune ligne réécrite) ; 120 € dont 34 € :
 *                 composante justifiée, aucune seconde dépense ;
 *   L108K-E2E-02  §B : deux 120 € sur deux lignes : l'un structuré, l'autre
 *                 SIGNALÉ ; total répété au même contexte : aucun constat ;
 *   L108K-E2E-03  §C : contrat porté + tableau absent → constat tracé
 *                 (provenance), faits et transcription intacts ; omission +
 *                 réexamen sans tableau → absence persistante qualifiée,
 *                 aucun second appel ; `[]` cohérent → cohérent ; ancien
 *                 prompt → non évalué, comportement d'avant ;
 *   L108K-E2E-04  §D : 70 unités en constat, 1 lot par passage → progression
 *                 par lots (60 puis 10), jamais « revu » avant la fin, puis
 *                 constat qualifié ; aucune relance supplémentaire ;
 *   L108K-E2E-05  §E : identifiant en texte libre et en champ de formulaire
 *                 détecté avec preuve (unité), aucun faux positif ;
 *   L108K-E2E-06  §3 : diagnostic BO (ia/t1-decisions-valeurs.json / .txt) :
 *                 marqueur du prompt effectif, interrupteur, concordance,
 *                 compteurs, bilan par document et par unité, rattrapage
 *                 simulé ; rattrapage BO 18 simulé puis appliqué.
 *
 * Campagnes BORNÉES aux comptes créés ici ; assertions sur ces comptes seuls.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';
import { RECETTE_TODAY } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => pdf.bytes,
}));

type Json = Record<string, any>;
type Fait = Record<string, unknown>;
const CHECK = 'COH-DOC-EXTRACT-CHAIN';
const RACINE = process.cwd();
const T1_LIVRE = readFileSync(join(RACINE, 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
const GUIDE = readFileSync(join(RACINE, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
const ANCRE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';
const T1_AVEC_CONTRAT = (() => {
  const m = /<!-- l89c:bloc id="t1-value-decisions-v1"[^>]*-->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc T1 absent du guide');
  return T1_LIVRE.replace(ANCRE, `${m[1]}\n\n${ANCRE}`);
})();

const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const decision = (value: string, kind: string, excerpt: string, d: string, reason: string, over: Fait = {}): Fait => ({
  value, kind, decision: d, reason, sourceUnitId: null, evidence: { excerpt, page: 1 }, relatedFactIndexes: [], relatedCandidateKeys: [], confidence: 'certain', ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[]; valueDecisions?: unknown }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Facture entretien', confidence: 'certain', evidence: { excerpt: 'Facture entretien', page: 1 } },
    documentDate: { value: '2026-03-12', confidence: 'certain', evidence: { excerpt: 'Date : 12/03/2026', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: [], facts: p.facts ?? [], hasExploitableContent: true,
  ...(p.valueDecisions !== undefined ? { valueDecisions: p.valueDecisions } : {}),
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
const REEXAMEN = (output: unknown, over: Partial<RecordedOutput> = {}) => T1(output, { promptIncludes: 'réexamen des valeurs significatives', ...over });

const L_DATE = 'Date : 12/03/2026';
const L_TOTAL = 'Total TTC : 120,00 € dont frais de dossier 34,00 €';
const L_CAPITAL = 'Paiement à réception. SARL au capital de 10 000 €';

scenario('L108K', 'Conformité du lot 91D : justifications, occurrences, sorties T1, pagination, identifiants, diagnostic', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let pageUnique: Uint8Array;
  beforeAll(async () => {
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage();
    pageUnique = await d.save();
  });
  beforeEach(async () => {
    pdf.bytes = pageUnique;
    await contrat(true);
  });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    delete process.env.COHERENCE_DECISION_REVIEW_BATCHES_MAX;
  });

  async function contrat(porte: boolean) {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: porte ? 108192 : 108191, treatment: 'T1', versionNumber: porte ? 10892 : 10891, content: porte ? T1_AVEC_CONTRAT : T1_LIVRE }]);
    (await import('@/services/ai/source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests();
  }
  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`facture-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/l108k' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const appelsT1 = () => replay.calls.filter((c) => c.operationCode === 't1_analyze_document').length;
  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: scope });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: RECETTE_TODAY });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  /** Contrôle direct (lecture seule, détail complet) : ce que verra le diagnostic BO. */
  const inspecter = async (accountId: number, fileId: number) => {
    const { inspectExtractChain } = await import('@/services/coherence/registry/checks/extract-chain');
    return (await inspectExtractChain({ sql: sql as never, now: new Date() }, accountId, [fileId], { fullDetail: true })).get(fileId)!;
  };
  const preuve = async (accountId: number, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding, requested_at, request_reason FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number, fileId: number) => sql<Json[]>`
    SELECT service, outcome, recheck_verdict, anomaly, result, ai_calls FROM coherence_repairs
     WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${fileId} ORDER BY id`;
  const decisions = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, origin, source_unit_id, value_kind, normalized_value, decision, reason, validity, invalid_reason, status
      FROM document_value_decisions WHERE file_id = ${fileId} ORDER BY id`;
  const unitesDe = (fileId: number) => sql<Json[]>`SELECT source_unit_id, kind, coalesce(content_text, label || ' : ' || value_text) AS t FROM document_source_units WHERE file_id = ${fileId} ORDER BY ordinal`;
  const omises = (i: Json) => ((i.detail?.allOmissions ?? []) as Json[]).flatMap((o) => (o.values as Json[]).map((x) => `${o.unit}:${x.kind}:${x.value}:${x.decision?.state ?? '-'}`)).sort();

  // ══ L108K-E2E-01 ═══════════════════════════════════════════════════════════

  it('L108K-E2E-01 — §A : motif générique jamais une justification (analyse, réexamen, décisions d’avant) ; 120 € dont 34 € sans seconde dépense', async () => {
    const c = await make.account();
    const f = await fichier(c);
    const transcription = `Facture entretien\n${L_DATE}\n${L_TOTAL}\n\n${L_CAPITAL}`;
    await analyser(c, f, [T1(sortie({
      transcription, facts: [fait(L_DATE, '2026-03-12'), fait(L_TOTAL, '120.00'), fait('Paiement à réception', 'à réception')],
      valueDecisions: [
        decision('34,00 €', 'AMOUNT', L_TOTAL, 'COMPONENT_OR_CONTEXT', 'Frais de dossier déjà inclus dans le total TTC de 120,00 € : pas une seconde dépense.', { normalizedValue: '3400', relatedFactIndexes: [1] }),
        decision('10 000 €', 'AMOUNT', 'SARL au capital de 10 000 €', 'NOT_RETAINED', 'Non pertinent.'),
      ],
    }))]);
    expect((await decisions(f)).map((d) => [d.normalized_value, d.validity, d.invalid_reason])).toEqual([['3400', 'VALID', null], ['1000000', 'INVALID', 'REASON_GENERIC']]);
    // L'omission du capital reste ; T1 est réexaminé sur CETTE unité seulement et donne un motif étayé.
    await rejouer([REEXAMEN(sortie({ facts: [], valueDecisions: [
      decision('10 000 €', 'AMOUNT', 'SARL au capital de 10 000 €', 'NOT_RETAINED', 'Capital social du prestataire : mention légale sans rapport avec la prestation facturée.'),
    ] }))]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(1);
    expect(replay.calls.find((x) => x.operationCode === 't1_analyze_document')!.prompt).toContain('SARL au capital');
    expect((await decisions(f)).filter((d) => d.status === 'ACTIVE').map((d) => [d.normalized_value, d.validity])).toEqual([['3400', 'VALID'], ['1000000', 'VALID']]);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'REPAIRED' });
    // 34 € : composante du total, jamais une seconde dépense.
    expect(await sql`SELECT 1 FROM business_operation_financial_components WHERE account_id = ${c.id}`).toHaveLength(0);

    // Décision VALIDE d'avant le correctif au motif générique : rejugée à la lecture, plus aucune justification.
    await sql`UPDATE document_value_decisions SET reason = 'Information secondaire.' WHERE file_id = ${f} AND status = 'ACTIVE' AND normalized_value = '1000000'`;
    const i = await inspecter(c.id, f);
    expect(omises(i)).toEqual([expect.stringMatching(/:AMOUNT:1000000:INVALID$/)]);
    expect(JSON.stringify(i.detail!.allOmissions)).toContain('REASON_GENERIC');
    expect((await decisions(f)).find((d) => d.normalized_value === '1000000' && d.status === 'ACTIVE')).toMatchObject({ validity: 'VALID' });
    // Rattrapage : la preuve cohérente contrôlée avant les règles 108K est redemandée une fois.
    await sql`UPDATE coherence_object_proofs SET last_result = 'CONSISTENT', last_completed_at = '2026-10-26T10:00:00Z' WHERE account_id = ${c.id} AND check_id = ${CHECK} AND object_id = ${f}`;
    const orch = await import('@/services/coherence/orchestrator');
    expect((await orch.requestCatchupChecks({ apply: false, accountId: c.id, sql, checkIds: [CHECK] })).items).toEqual([expect.objectContaining({ objectId: f })]);
  });

  // ══ L108K-E2E-02 ═══════════════════════════════════════════════════════════

  it('L108K-E2E-02 — §B : deux 120 € distincts → l’omission du second reste ; même total répété → aucun doublon', async () => {
    await contrat(false);
    const c = await make.account();
    const f = await fichier(c);
    const L1 = 'Remplacement filtre : 120,00 €';
    const L2 = 'Main-d’œuvre pose : 120,00 €';
    await analyser(c, f, [T1(sortie({ transcription: `Facture entretien\n${L_DATE}\n${L1}\n${L2}`, facts: [fait(L_DATE, '2026-03-12'), fait(L1, '120.00'), fait(L2, 'pose')] }))]);
    const u2 = (await unitesDe(f)).find((u) => String(u.t).includes('pose'))!.source_unit_id;
    const i = await inspecter(c.id, f);
    expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT', detail: expect.objectContaining({ omissionTotals: expect.objectContaining({ reconciliation: 'OCCURRENCE', units: 1 }) }) });
    expect(omises(i)).toEqual([`${u2}:AMOUNT:12000:-`]);

    const g = await fichier(c);
    const LT = 'Total TTC : 120,00 €';
    await analyser(c, g, [T1(sortie({ transcription: `Facture entretien\n${L_DATE}\n${LT}\nConditions générales applicables.\n--- page 2 ---\n${LT}`, facts: [fait(L_DATE, '2026-03-12'), fait(LT, '120.00')] }))]);
    expect((await inspecter(c.id, g)).verdict).toBe('CONSISTENT');
  });

  // ══ L108K-E2E-03 ═══════════════════════════════════════════════════════════

  it('L108K-E2E-03 — §C : tableau absent avec contrat → constat tracé ; `[]` cohérent valide ; ancien prompt compatible', async () => {
    const c = await make.account();
    const base = `Facture entretien\n${L_DATE}\nTotal TTC : 120,00 €`;
    const faits = () => [fait(L_DATE, '2026-03-12'), fait('Total TTC : 120,00 €', '120.00')];
    const meta = async (fileId: number) => (await sql<Json[]>`SELECT metadata->'valueDecisionsOutput' AS o FROM document_extractions WHERE file_id = ${fileId}`)[0].o;

    // Contrat porté, réponse SANS le tableau : faits et transcription écrits, constat de non-conformité tracé.
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: base, facts: faits() }))]);
    expect(await meta(f)).toMatchObject({ status: 'ABSENT', conforming: false, contract: 'CARRIED', versionsMatch: true, passes: [expect.objectContaining({ origin: 'PASS_1', status: 'ABSENT' })] });
    expect((await sql`SELECT 1 FROM document_facts WHERE file_id = ${f} AND status = 'active'`).length).toBe(2);
    expect(await decisions(f)).toEqual([]);
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    const run = (await sql<{ r: number }[]>`SELECT analysis_run_id::int AS r FROM document_extractions WHERE file_id = ${f}`)[0].r;
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'T1_VALUE_DECISIONS_OUTPUT_MISSING',
      observed: expect.objectContaining({ status: 'ABSENT', analysisRunId: run }), detail: expect.objectContaining({ qualification: 'OUTPUT_NONCONFORMITY' }) }) });

    // `valueDecisions: []` cohérent (tout est structuré) : conforme, cohérent.
    const g = await fichier(c);
    await analyser(c, g, [T1(sortie({ transcription: base, facts: faits(), valueDecisions: [] }))]);
    expect(await meta(g)).toMatchObject({ status: 'EMPTY', conforming: true });

    // Omission + réexamen qui omet ENCORE le tableau : absence persistante qualifiée, aucune décision inventée, aucun second appel.
    const h = await fichier(c);
    await analyser(c, h, [T1(sortie({ transcription: `${base}\n\n${L_CAPITAL}`, facts: [...faits(), fait('Paiement à réception', 'à réception')] }))]);
    await rejouer([REEXAMEN(sortie({ facts: [] }))]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(1);
    expect(await reparations(c.id, h)).toEqual([expect.objectContaining({ service: 'reviewDocumentValueDecisions', result: expect.objectContaining({ outcome: 'NO_DECISION' }) })]);
    expect(await decisions(h)).toEqual([]);
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    const p = await preuve(c.id, h);
    expect(p.finding.detail.diagnostics.map((d: Json) => d.anomaly)).toEqual(expect.arrayContaining(['FACT_OMITTED_COVERED_UNIT', 'T1_VALUE_DECISIONS_OUTPUT_MISSING']));
    expect((await inspecter(c.id, h)).detail!.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ anomaly: 'T1_VALUE_DECISIONS_OUTPUT_MISSING' })]));
    const ins = await inspecter(c.id, h);
    expect(ins.detail).toMatchObject({ valueDecisionsOutput: { status: 'ABSENT', recoveredByReview: false } });

    // Ancien prompt sans marqueur : non évalué, aucun constat de sortie (comportement d'avant).
    await contrat(false);
    const k = await fichier(c);
    await analyser(c, k, [T1(sortie({ transcription: base, facts: faits() }))]);
    expect(await meta(k)).toMatchObject({ status: 'NOT_EVALUATED', conforming: true, contract: 'MARKER_MISSING' });
    expect((await inspecter(c.id, k)).verdict).toBe('CONSISTENT');
  });

  // ══ L108K-E2E-04 ═══════════════════════════════════════════════════════════

  it('L108K-E2E-04 — §D : 70 unités en constat → lots successifs (60 puis 10), jamais « revu » avant la fin, puis constat qualifié', async () => {
    process.env.COHERENCE_DECISION_REVIEW_BATCHES_MAX = '1';
    try {
      const c = await make.account();
      const f = await fichier(c);
      const lignes = Array.from({ length: 70 }, (_, k) => `Prestation ${String.fromCharCode(65 + (k % 26))}${k} : ${k + 1},50 €`);
      await analyser(c, f, [T1(sortie({ transcription: `Facture entretien\n${L_DATE}\n${lignes.join('\n')}`,
        facts: [fait(L_DATE, '2026-03-12'), ...lignes.map((l, k) => fait(l, `Prestation ${k}`))], valueDecisions: [] }))]);
      expect((await inspecter(c.id, f)).detail).toMatchObject({ omissionTotals: { units: 70, values: 70, displayedUnits: 20, truncatedDisplay: true }, review: { units: 70, examined: 0, remaining: 70 } });

      await rejouer([REEXAMEN(sortie({ facts: [], valueDecisions: [] }))]);
      await campagne([c.id], 'CORRECTIVE');
      expect(appelsT1()).toBe(1);
      const r1 = await reparations(c.id, f);
      expect(r1).toEqual([expect.objectContaining({ service: 'reviewDocumentValueDecisions',
        result: expect.objectContaining({ unitsRequested: 70, continuation: true, progress: expect.objectContaining({ requested: 70, examined: 60, remaining: 10, batches: 1, batchesPlanned: 2 }) }) })]);
      expect((await sql`SELECT 1 FROM document_value_review_units WHERE file_id = ${f} AND status = 'EXAMINED'`).length).toBe(60);
      // Jamais « revu » : réexamen en cours, 10 unités restantes, contrôle ciblé redemandé.
      const mi = await inspecter(c.id, f);
      expect(mi).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACT_DECISION_REVIEW_IN_PROGRESS', detail: expect.objectContaining({ review: expect.objectContaining({ examined: 60, remaining: 10 }) }) });
      expect((await preuve(c.id, f)).request_reason).toMatch(/^DECISION_REVIEW_CONTINUE:/);

      await rejouer([REEXAMEN(sortie({ facts: [], valueDecisions: [] }))]);
      await campagne([c.id], 'CORRECTIVE');
      expect(appelsT1()).toBe(1);
      expect((await sql`SELECT 1 FROM document_value_review_units WHERE file_id = ${f} AND status = 'EXAMINED'`).length).toBe(70);
      const fin = await inspecter(c.id, f);
      expect(fin).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT', detail: expect.objectContaining({
        motive: 'NO_VALID_DECISION_AFTER_REVIEW', decisionReview: 'TRIED', review: expect.objectContaining({ examined: 70, remaining: 0, attempts: 2 }) }) });
      expect((fin.detail!.allOmissions as unknown[]).length).toBe(70);
      // Relance répétée : idempotente, plus aucun appel.
      await rejouer([]);
      await campagne([c.id], 'CORRECTIVE');
      expect(appelsT1()).toBe(0);
      expect(await reparations(c.id, f)).toHaveLength(2);
    } finally {
      delete process.env.COHERENCE_DECISION_REVIEW_BATCHES_MAX;
    }
  });

  // ══ L108K-E2E-05 ═══════════════════════════════════════════════════════════

  it('L108K-E2E-05 — §E : identifiants en texte libre et en formulaire détectés avec leur unité, sans faux positif', async () => {
    await contrat(false);
    const c = await make.account();
    const f = await fichier(c);
    const LIBRE = 'Nous vous adressons la facture n° 2026001234 relative à l’entretien de la chaudière.';
    const FORM = '☑ Contrat n° CT-889911 résilié à échéance';
    const BRUIT = 'Réf. article AB1234X, poids 12KG, 12 rue des Lilas 75001 Paris, tél. 01 23 45 67 89';
    await analyser(c, f, [T1(sortie({ transcription: `Facture entretien\n${L_DATE}\n${LIBRE}\n\n${FORM}\n\n${BRUIT}`,
      facts: [fait(L_DATE, '2026-03-12'), fait(LIBRE, 'entretien chaudière'), fait(FORM, 'résilié'), fait(BRUIT, 'Lilas')] }))]);
    const us = await unitesDe(f);
    const i = await inspecter(c.id, f);
    const ids = ((i.detail?.allOmissions ?? []) as Json[]).map((o) => [us.find((u) => u.source_unit_id === o.unit)?.kind, (o.values as Json[]).map((x) => x.kind)]);
    expect(ids).toEqual(expect.arrayContaining([['TEXT_BLOCK', ['IDENTIFIER']], ['FORM_FIELD', ['IDENTIFIER']]]));
    expect(ids).toHaveLength(2);
    // Identifiant repris par T1 (fait situé sur la même unité) : connu.
    const g = await fichier(c);
    await analyser(c, g, [T1(sortie({ transcription: `Facture entretien\n${L_DATE}\n${LIBRE}`, facts: [fait(L_DATE, '2026-03-12'), fait(LIBRE, '2026001234', { rawKey: 'Numéro de facture' })] }))]);
    expect((await inspecter(c.id, g)).verdict).toBe('CONSISTENT');
  });

  // ══ L108K-E2E-06 ═══════════════════════════════════════════════════════════

  it('L108K-E2E-06 — §3 : diagnostic BO (activation, compteurs, bilan par document et par unité) ; rattrapage BO 18 simulé puis appliqué', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: `Facture entretien\n${L_DATE}\n${L_TOTAL}\n\n${L_CAPITAL}`,
      facts: [fait(L_DATE, '2026-03-12'), fait(L_TOTAL, '120.00'), fait('Paiement à réception', 'à réception')],
      valueDecisions: [
        decision('34,00 €', 'AMOUNT', L_TOTAL, 'COMPONENT_OR_CONTEXT', 'Frais de dossier déjà inclus dans le total TTC de 120,00 € : pas une seconde dépense.', { normalizedValue: '3400', relatedFactIndexes: [1] }),
        decision('10 000 €', 'AMOUNT', 'SARL au capital de 10 000 €', 'NOT_RETAINED', 'Déjà traité.'),
      ] }))]);
    // Constat établi à blanc (aucun appel) : le bloc BO 18 le reprendra.
    await rejouer([]);
    await campagne([c.id], 'DRY_RUN');
    await sql`UPDATE coherence_object_proofs SET last_result = 'FINDING' WHERE account_id = ${c.id} AND check_id = ${CHECK} AND object_id = ${f}`;
    const { t1DecisionsDiagnostic, t1DecisionsDiagnosticText } = await import('@/services/ai/source-analysis/value-decisions/diagnostic');
    const q = (t: string, p: unknown[]) => sql.unsafe(t, p as never[]) as unknown as Promise<Record<string, unknown>[]>;
    const d = await t1DecisionsDiagnostic(q, [c.id]);
    expect(d.checks.map((x) => [x.code, x.ok])).toEqual([['MARKER', true], ['SWITCH', true], ['TABLE_0798', true], ['TABLE_1090', true], ['VERSIONS', true]]);
    const a = d.accounts.find((x) => x.accountId === c.id)!;
    expect(a.counters).toMatchObject({ decisions: { active: { 'VALID:COMPONENT_OR_CONTEXT': 1, 'INVALID:NOT_RETAINED': 1 }, activeInvalidByReason: { REASON_GENERIC: 1 } }, t1Outputs: { byStatus: { PRESENT: 1 } } });
    expect(a.catchup).toMatchObject({ wouldRequest: 1, documents: [f] });
    const doc = a.documents!.find((x) => x.fileId === f)!;
    expect(doc).toMatchObject({ anomaly: 'FACT_OMITTED_COVERED_UNIT', omissionTotals: expect.objectContaining({ units: 1, values: 1 }), review: expect.objectContaining({ remaining: 1 }) });
    const txt = t1DecisionsDiagnosticText(d);
    expect(txt).toContain('[OK] Prompt T1 effectif porte le marqueur t1-value-decisions-v1');
    expect(txt).toContain(`  ${f} | `);
    expect(txt).toMatch(/AMOUNT 1000000 \[INVALID REASON_GENERIC\]/);
    // Global : compteurs seulement (pas de détail par document).
    expect((await t1DecisionsDiagnostic(q, null)).accounts.every((x) => x.documents === undefined)).toBe(true);

    // Rattrapage BO 18 : simulation (rien d'écrit, aucun appel) puis application contrôlée.
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const sim = await executeBackfill(sql, { script: 'extract-chain-decision-review', action: 'simulate', step: null, runId: null, accountId: c.id, reason: 'recette 108K' }, { log: () => {}, progress: () => {} });
    expect(summarizeBackfill('extract-chain-decision-review', 'simulate', null, sim).headline).toMatch(/Simulation : 1 document\(s\)/);
    expect(appelsT1()).toBe(0);
    await rejouer([REEXAMEN(sortie({ facts: [], valueDecisions: [decision('10 000 €', 'AMOUNT', 'SARL au capital de 10 000 €', 'NOT_RETAINED', 'Capital social du prestataire : mention légale sans rapport avec la prestation.')] }))]);
    const enVigueur = process.env.COHERENCE_CAMPAIGN_MODE;
    process.env.COHERENCE_CAMPAIGN_MODE = 'corrective';
    try {
      const out = await executeBackfill(sql, { script: 'extract-chain-decision-review', action: 'apply', step: null, runId: null, accountId: c.id, reason: 'recette 108K' }, { log: () => {}, progress: () => {} });
      expect(summarizeBackfill('extract-chain-decision-review', 'apply', null, out).headline).toMatch(/1 document\(s\) en constat d’omission repris/);
    } finally {
      if (enVigueur === undefined) delete process.env.COHERENCE_CAMPAIGN_MODE; else process.env.COHERENCE_CAMPAIGN_MODE = enVigueur;
    }
    expect(appelsT1()).toBe(1);
    const apres = await t1DecisionsDiagnostic(q, [c.id]);
    expect(apres.accounts.find((x) => x.accountId === c.id)!.documents!.find((x) => x.fileId === f)).toMatchObject({ verdict: 'CONSISTENT' });
    expect(apres.accounts.find((x) => x.accountId === c.id)!.counters).toMatchObject({ reviews: { aiCalls: 1 } });
  });
});
