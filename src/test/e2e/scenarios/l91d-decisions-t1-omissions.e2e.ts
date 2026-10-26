/**
 * Lot 91D — traçabilité des décisions T1 sur les valeurs significatives et
 * qualification des omissions documentaires (COH-DOC-EXTRACT-CHAIN, contrat
 * `t1-value-decisions-v1`, demande historique 82B-t1-omissions-extract), sur
 * PostgreSQL 16 réel. Analyses T1 par le point d'entrée de PRODUCTION
 * (`analyzeFileSources`, passerelle réelle, sorties modèle rejouées),
 * campagnes de l'orchestrateur unique. Version BO du prompt T1 posée par le
 * test (texte livré, avec ou sans le bloc du guide du PO).
 *
 *   L91D-E2E-01  facture 120 € dont 34 € de frais : contrat ABSENT → constat
 *                d'avant (pendingContract), aucune décision persistée même si
 *                le modèle en rend, aucun réexamen ; contrat PORTÉ →
 *                réexamen ciblé (unités en constat seulement), décision
 *                « composante du total » validée et persistée, rattachée au
 *                fait du total, constat résolu ; aucune dépense ni aucun fait
 *                supplémentaire ; second passage sans appel ;
 *   L91D-E2E-02  décisions de l'ANALYSE : exclusion justifiée, composante,
 *                indéterminée, et une VÉRITABLE omission → à blanc rien
 *                d'écrit ; correctif : réexamen une fois, puis constat
 *                qualifié (omission non justifiée, décision indéterminée
 *                listée) ; nouvelle extraction : décisions supersédées SANS
 *                destruction, historique conservé, aucun doublon ;
 *   L91D-E2E-03  reprise épuisée : réexamen une fois → décision indéterminée
 *                (FACT_DECISION_UNDETERMINED, jamais une conformité), plus
 *                aucun appel ; Supervision : constats persistants qualifiés ;
 *                rattrapage (automatique et bloc BO 18) : rien sans contrat,
 *                documents en constat repris avec contrat, idempotent ;
 *   L91D-E2E-04  correction utilisateur protégée : un fait ajouté par le
 *                réexamen n'écrase jamais la valeur saisie par l'utilisateur.
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
/** PDF servi au découpage et à la vérification : jamais de lecture S3 réelle. */
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
/** Texte T1 après l'étape 4 du guide, appliquée comme le PO (bloc collé avant la ligne repère). */
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
const sortie = (p: { transcription?: string; facts?: Fait[]; valueDecisions?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Facture entretien', confidence: 'certain', evidence: { excerpt: 'Facture entretien', page: 1 } },
    documentDate: { value: '2026-03-12', confidence: 'certain', evidence: { excerpt: 'Date : 12/03/2026', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: [], facts: p.facts ?? [], hasExploitableContent: true,
  ...(p.valueDecisions ? { valueDecisions: p.valueDecisions } : {}),
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
/** Réexamen ciblé demandé par le contrôle : son prompt porte le nom de la source « réexamen des valeurs significatives ». */
const REEXAMEN = (output: unknown) => T1(output, { promptIncludes: 'réexamen des valeurs significatives' });

const L_TOTAL = 'Total TTC : 120,00 € dont frais de dossier 34,00 €';
const FACTURE_SIMPLE = `Facture entretien\nDate : 12/03/2026\n${L_TOTAL}`;
const faitsSimples = () => [fait('Date : 12/03/2026', '2026-03-12'), fait(L_TOTAL, '120.00')];
const fraisComposante = (idx: number) => decision('34,00 €', 'AMOUNT', L_TOTAL, 'COMPONENT_OR_CONTEXT',
  'Frais de dossier déjà inclus dans le total TTC de 120,00 € : pas une seconde dépense.', { normalizedValue: '3400', relatedFactIndexes: [idx] });

scenario('L91D', 'Décisions T1 sur les valeurs significatives et omissions documentaires (COH-DOC-EXTRACT-CHAIN)', ({ sql, make, replay, useRecordings: rejouer }) => {
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
    await contrat(false);
  });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  // ── Outils ───────────────────────────────────────────────────────────────
  /** Version BO active du prompt T1 : texte livré, avec ou sans le bloc de l'étape 4 du guide. */
  async function contrat(porte: boolean) {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: porte ? 99192 : 99191, treatment: 'T1', versionNumber: porte ? 9192 : 9191, content: porte ? T1_AVEC_CONTRAT : T1_LIVRE }]);
    (await import('@/services/ai/source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests();
  }
  const fichier = async (compte: AccountRow, assetId: number | null = null) => {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`facture-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/l91d' });
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
  const preuve = async (accountId: number, objectId: number) => (await sql<Json[]>`
    SELECT last_result, last_mode, finding, finding_streak FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number, fileId: number) => sql<Json[]>`
    SELECT service, outcome, recheck_verdict, anomaly, result, ai_calls FROM coherence_repairs
     WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${fileId} ORDER BY id`;
  const decisions = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, origin, contract_version, source_unit_id, unit_fingerprint, value_kind, raw_value, normalized_value, decision, reason, confidence,
           related_fact_ids::int[] AS related_fact_ids, validity, invalid_reason, status, superseded_reason, extraction_id::int AS extraction_id, prompt_version
      FROM document_value_decisions WHERE file_id = ${fileId} ORDER BY id`;
  const faitsActifs = (fileId: number) => sql<Json[]>`SELECT id::int AS id, value_text, canonical_key FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const valeursSignalees = (f: Json) => ((f?.observed ?? []) as Array<{ values: Array<{ value: string; decision?: { state: string } }> }>)
    .flatMap((o) => o.values.map((x) => `${x.value}:${x.decision?.state ?? '-'}`)).sort();

  // ══ L91D-E2E-01 ════════════════════════════════════════════════════════════

  it('L91D-E2E-01 — 120 € dont 34 € de frais : contrat absent → constat d’avant ; contrat porté → réexamen ciblé, décision justifiée, aucune dépense en plus', async () => {
    const c = await make.account();
    const f = await fichier(c);
    // Le modèle rend spontanément des décisions, mais le prompt actif ne porte pas le contrat : rien n'est conservé.
    await analyser(c, f, [T1(sortie({ transcription: FACTURE_SIMPLE, facts: faitsSimples(), valueDecisions: [fraisComposante(1)] }))]);
    expect(await decisions(f)).toEqual([]);
    const faits0 = await faitsActifs(f);
    expect(faits0.map((x) => x.value_text)).toEqual(['2026-03-12', '120.00']);

    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    expect(await preuve(c.id, f)).toMatchObject({
      last_result: 'FINDING',
      finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_COVERED_UNIT',
        detail: expect.objectContaining({ pendingContract: '82B-t1-omissions-extract', t1Relaunch: false, qualification: 'UNJUSTIFIED_OMISSION', valueDecisions: { contract: 'MARKER_MISSING' } }) }),
    });
    expect(await reparations(c.id, f)).toEqual([]);

    // Le PO colle le bloc T1 du guide : réexamen ciblé des SEULES unités en constat, depuis le texte déjà extrait.
    await contrat(true);
    await rejouer([REEXAMEN(sortie({ facts: [fait(L_TOTAL, '120.00')], valueDecisions: [{ ...fraisComposante(0), sourceUnitId: 'page:1:field:2' }] }))]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(1);
    const appel = replay.calls.find((x) => x.operationCode === 't1_analyze_document')!;
    expect(appel.attachments).toEqual([]);
    expect(appel.prompt).toContain('[page:1:field:2]');
    const [d] = await decisions(f);
    expect(d).toMatchObject({
      origin: 'REVIEW', contract_version: 't1-value-decisions-v1', source_unit_id: 'page:1:field:2', value_kind: 'AMOUNT', raw_value: '34,00 €', normalized_value: '3400',
      decision: 'COMPONENT_OR_CONTEXT', validity: 'VALID', invalid_reason: null, status: 'ACTIVE', related_fact_ids: [faits0[1].id],
    });
    expect(d.unit_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(await reparations(c.id, f)).toEqual([expect.objectContaining({
      service: 'reviewDocumentValueDecisions', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'FACT_OMITTED_COVERED_UNIT',
      result: expect.objectContaining({ outcome: 'REVIEWED', calls: 1, newFacts: 0, units: ['page:1:field:2'], decisions: expect.objectContaining({ valid: 1, invalid: 0, written: 1 }) }),
    })]);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    // Aucun fait, aucun candidat, aucune composante financière en plus : les 34 € ne deviennent pas une seconde dépense.
    expect(await faitsActifs(f)).toEqual(faits0);
    expect((await sql`SELECT 1 FROM document_operation_candidates WHERE file_id = ${f}`)).toHaveLength(0);
    expect((await sql`SELECT 1 FROM business_operation_financial_components WHERE account_id = ${c.id}`)).toHaveLength(0);

    // Second passage : cohérent, motif de résolution tracé, aucun appel.
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await reparations(c.id, f)).toHaveLength(1);
  });

  // ══ L91D-E2E-02 ════════════════════════════════════════════════════════════

  const L_PENALITE = 'Pénalité de retard applicable : 50,00 € (article 4)';
  const L_PAIEMENT = 'Paiement à réception. SARL au capital de 10 000 €, remise possible de 15,00 €';
  const FACTURE_COMPLETE = `${FACTURE_SIMPLE}\n\n${L_PENALITE}\n\n${L_PAIEMENT}`;

  it('L91D-E2E-02 — décisions de l’analyse : justifiées, indéterminée, VÉRITABLE omission ; réexamen une fois ; nouvelle extraction sans destruction', async () => {
    await contrat(true);
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({
      transcription: FACTURE_COMPLETE,
      facts: [...faitsSimples(), fait(L_PENALITE, 'article 4'), fait('Paiement à réception', 'à réception')],
      valueDecisions: [
        fraisComposante(1),
        decision('10 000 €', 'AMOUNT', 'SARL au capital de 10 000 €', 'NOT_RETAINED', 'Capital social du prestataire : mention légale sans rapport avec la prestation.'),
        decision('15,00 €', 'AMOUNT', 'remise possible de 15,00 €', 'UNDETERMINED', 'Remise évoquée sans dire si elle a été appliquée au total.', { confidence: 'probable' }),
        // Une décision mal formée n'invalide pas la réponse : elle est conservée INVALIDE.
        decision('', 'AMOUNT', L_PENALITE, 'NOT_RETAINED', 'motif'),
      ],
    }))]);
    const ext = (await sql<{ id: number }[]>`SELECT id::int AS id FROM document_extractions WHERE file_id = ${f}`)[0].id;
    const d0 = await decisions(f);
    expect(d0.map((d) => [d.decision, d.validity, d.normalized_value, d.origin])).toEqual([
      ['COMPONENT_OR_CONTEXT', 'VALID', '3400', 'ANALYSIS'], ['NOT_RETAINED', 'VALID', '1000000', 'ANALYSIS'],
      ['UNDETERMINED', 'VALID', '1500', 'ANALYSIS'], ['NOT_RETAINED', 'INVALID', null, 'ANALYSIS'],
    ]);
    expect(d0[3].invalid_reason).toBe('INVALID_SCHEMA');
    expect(d0.every((d) => d.extraction_id === ext && d.status === 'ACTIVE' && d.prompt_version)).toBe(true);
    expect(d0[0].related_fact_ids).toHaveLength(1);

    // À blanc : réexamen annoncé, rien d'écrit, aucun appel ; la véritable omission (50 €) reste signalée.
    await rejouer([]);
    const photo = async () => ({ d: await decisions(f), fa: await faitsActifs(f) });
    const avant = await photo();
    await campagne([c.id], 'DRY_RUN');
    expect(appelsT1()).toBe(0);
    expect(await photo()).toEqual(avant);
    const blanc = await preuve(c.id, f);
    expect(blanc).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_COVERED_UNIT',
      detail: expect.objectContaining({ repair: 'DECISION_REVIEW', decisionReview: 'DUE', valueDecisions: expect.objectContaining({ contract: 'CARRIED', justified: 2, undetermined: 1, absent: 1 }) }) }) });
    expect(valeursSignalees(blanc.finding)).toEqual(['5000:ABSENT']);

    // Correctif : UN réexamen ciblé (T1 ne qualifie toujours pas les 50 €), puis constat qualifié — jamais justifié par le code.
    await rejouer([REEXAMEN(sortie({ facts: [fait(L_PENALITE, 'article 4')], valueDecisions: [] }))]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(1);
    expect(await reparations(c.id, f)).toEqual([expect.objectContaining({ service: 'reviewDocumentValueDecisions', outcome: 'INEFFECTIVE' })]);
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    const p = await preuve(c.id, f);
    expect(p).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_COVERED_UNIT',
      detail: expect.objectContaining({ qualification: 'UNJUSTIFIED_OMISSION', motive: 'NO_VALID_DECISION_AFTER_REVIEW', decisionReview: 'TRIED' }) }) });
    expect(p.finding.detail.pendingContract).toBeUndefined();
    expect(p.finding.detail.diagnostics.map((x: Json) => x.anomaly)).toEqual(['FACT_OMITTED_COVERED_UNIT', 'FACT_DECISION_UNDETERMINED']);
    expect(await reparations(c.id, f)).toHaveLength(1);

    // Modification documentaire : nouvelle extraction → décisions supersédées SANS destruction, nouvelles décisions actives.
    await analyser(c, f, [T1(sortie({
      transcription: `${FACTURE_SIMPLE}\n\n${L_PAIEMENT}`,
      facts: [...faitsSimples(), fait('Paiement à réception', 'à réception')],
      valueDecisions: [
        fraisComposante(1),
        decision('10 000 €', 'AMOUNT', 'SARL au capital de 10 000 €', 'NOT_RETAINED', 'Capital social du prestataire : mention légale sans rapport avec la prestation.'),
        decision('15,00 €', 'AMOUNT', 'remise possible de 15,00 €', 'COMPONENT_OR_CONTEXT', 'Remise déjà déduite du total TTC de 120,00 €.', { relatedFactIndexes: [1] }),
      ],
    }))]);
    const d1 = await decisions(f);
    expect(d1.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(4);
    expect(d1.filter((d) => d.status === 'SUPERSEDED').every((d) => d.superseded_reason === 'REANALYSIS')).toBe(true);
    expect(d1.filter((d) => d.status === 'ACTIVE').map((d) => d.decision)).toEqual(['COMPONENT_OR_CONTEXT', 'NOT_RETAINED', 'COMPONENT_OR_CONTEXT']);
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'CONSISTENT' });
    // Aucun doublon : une valeur garde UNE décision active ; la même écriture rejouée n'ajoute rien.
    const { insertValueDecisions } = await import('@/services/ai/source-analysis/value-decisions/store');
    const actives = (await decisions(f)).filter((d) => d.status === 'ACTIVE');
    const { pgClient } = await import('@/db');
    const relu = actives.map((d) => ({
      origin: 'PASS_1' as const, sourceUnitId: d.source_unit_id, unitFingerprint: d.unit_fingerprint, kind: d.value_kind, rawValue: d.raw_value,
      normalizedValue: d.normalized_value, decision: d.decision, reason: d.reason, confidence: d.confidence, evidence: {},
      relatedFactRefs: [], relatedCandidateKeys: [], validity: d.validity, invalidReason: d.invalid_reason,
    }));
    const n1 = await pgClient.begin((tx) => insertValueDecisions(tx as never, { accountId: c.id, fileId: f, extractionId: ext, analysisRunId: null, promptVersion: null, factIds: new Map() }, relu as never));
    const n2 = await pgClient.begin((tx) => insertValueDecisions(tx as never, { accountId: c.id, fileId: f, extractionId: ext, analysisRunId: null, promptVersion: null, factIds: new Map() }, relu as never));
    // L'exclusion (sans rattachement) est identique : rien n'est réécrit ; les deux autres (rattachements différents) remplacent l'ancienne ligne.
    expect([n1, n2]).toEqual([2, 0]);
    expect((await decisions(f)).filter((d) => d.status === 'ACTIVE')).toHaveLength(3);
    expect((await decisions(f)).filter((d) => d.superseded_reason === 'REPLACED')).toHaveLength(2);
  });

  // ══ L91D-E2E-03 ════════════════════════════════════════════════════════════

  it('L91D-E2E-03 — reprise épuisée → réexamen une fois, décision indéterminée signalée ; Supervision qualifiée ; rattrapage BO idempotent', async () => {
    const c = await make.account();
    const f = await fichier(c);
    // Montant d'une unité NON couverte, passe de réparation de l'analyse sans résultat, reprises épuisées.
    const L_MONTANT = 'Montant TTC : 1 234,00 €';
    await analyser(c, f, [
      T1(sortie({ facts: [] }), { promptIncludes: '[page:1:field:' }),
      T1(sortie({ transcription: `Facture entretien\nDate : 12/03/2026\n${L_MONTANT}`, facts: [fait('Date : 12/03/2026', '2026-03-12')] })),
    ]);
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 2, next_retry_at = NULL WHERE file_id = ${f}`;
    await sql`UPDATE document_source_units SET repair_attempts = 9 WHERE file_id = ${f} AND kind = 'LABEL_VALUE'`;

    // Contrat absent : constat historique « reprise épuisée », qualifié technique.
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED',
      detail: expect.objectContaining({ qualification: 'REPAIR_TECHNICAL', motive: 'REPAIR_EXHAUSTED' }) }) });
    const orch = await import('@/services/coherence/orchestrator');
    // Rattrapage sans contrat : rien n'est repris.
    expect((await orch.requestCatchupChecks({ apply: false, accountId: c.id, sql, checkIds: [CHECK] })).requested[CHECK] ?? 0).toBe(0);

    // Contrat porté : le rattrapage reprend le document (simulation puis bloc BO), le contrôle fait UN réexamen.
    await contrat(true);
    const sim = await orch.requestCatchupChecks({ apply: false, accountId: c.id, sql, checkIds: [CHECK] });
    expect(sim.items).toEqual([{ checkId: CHECK, accountId: c.id, objectId: f, reason: 'DECISION_REVIEW' }]);
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    await rejouer([REEXAMEN(sortie({ facts: [], valueDecisions: [
      decision('1 234,00 €', 'AMOUNT', L_MONTANT, 'UNDETERMINED', 'Montant TTC lu, mais le document ne dit pas s’il a été payé ni à quoi il se rapporte.', { sourceUnitId: 'page:1:field:2' }),
    ] }))]);
    const enVigueur = process.env.COHERENCE_CAMPAIGN_MODE;
    process.env.COHERENCE_CAMPAIGN_MODE = 'corrective';
    try {
      const out = await executeBackfill(sql, { script: 'extract-chain-decision-review', action: 'apply', step: null, runId: null, accountId: c.id, reason: 'recette 91D' },
        { log: () => {}, progress: () => {} });
      expect(summarizeBackfill('extract-chain-decision-review', 'apply', null, out).headline).toMatch(/1 document\(s\) en constat d’omission repris/);
    } finally {
      if (enVigueur === undefined) delete process.env.COHERENCE_CAMPAIGN_MODE; else process.env.COHERENCE_CAMPAIGN_MODE = enVigueur;
    }
    expect(appelsT1()).toBe(1);
    expect(await reparations(c.id, f)).toEqual([expect.objectContaining({ service: 'reviewDocumentValueDecisions', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED' })]);
    expect((await decisions(f)).map((d) => [d.decision, d.validity, d.origin])).toEqual([['UNDETERMINED', 'VALID', 'REVIEW']]);
    // Incertitude : jamais une conformité ; plus aucun appel ; le rattrapage ne redemande rien (idempotent).
    await rejouer([]);
    for (let i = 0; i < 3; i++) await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    const p = await preuve(c.id, f);
    expect(p).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'FACT_DECISION_UNDETERMINED',
      detail: expect.objectContaining({ qualification: 'UNDETERMINED_DECISION', motive: 'T1_UNDETERMINED' }) }) });
    expect(valeursSignalees(p.finding)).toEqual(['123400:UNDETERMINED']);
    expect((await orch.requestCatchupChecks({ apply: false, accountId: c.id, sql, checkIds: [CHECK] })).requested[CHECK] ?? 0).toBe(0);
    expect(await reparations(c.id, f)).toHaveLength(1);

    // Supervision : le constat persistant est qualifié (décision indéterminée ≠ omission ≠ problème de reprise).
    const { computeCoherenceAlerts } = await import('@/services/coherence/supervision');
    const alerte = (await computeCoherenceAlerts(new Date(), sql)).find((a) => a.fingerprint.endsWith(`${CHECK.toLowerCase()}:persistent`));
    expect(alerte?.detail.qualifications).toMatch(/décisions T1 indéterminées : \d+/);
  });

  // ══ L91D-E2E-04 ════════════════════════════════════════════════════════════

  it('L91D-E2E-04 — correction utilisateur protégée : le fait ajouté par le réexamen ne remplace jamais la valeur saisie', async () => {
    await contrat(true);
    const c = await make.account();
    const voiture = await make.asset(c, { category: 'VEHICULE', name: 'Clio' });
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({ assetId: voiture.id, accountId: c.id, origin: 'USER', source: { type: 'e2e' }, writes: [{ key: 'lastRevision', value: '2025-12-01' }] });
    const f = await fichier(c, voiture.id);
    const L_ENTRETIEN = 'Entretien réalisé le 15/11/2025 : total 89,00 €';
    await analyser(c, f, [T1(sortie({ transcription: `Facture entretien\nDate : 12/03/2026\n${L_ENTRETIEN}`, facts: [fait('Date : 12/03/2026', '2026-03-12'), fait(L_ENTRETIEN, '89.00')], valueDecisions: [] }))]);
    const valeur = async () => (await canon.getCanonicalAssetState(voiture.id, c.id))!.fields.lastRevision?.value ?? null;
    expect(await valeur()).toBe('2025-12-01');
    // Réexamen : T1 structure la date d'entretien (fait canonique ciblé sur le bien) et le dit.
    await rejouer([REEXAMEN(sortie({
      facts: [fait(L_ENTRETIEN, '2025-11-15', { canonicalKey: 'lastRevision', rawKey: 'Entretien réalisé le', rawValue: '15/11/2025', normalizedValue: '2025-11-15', valueType: 'date',
        target: { type: 'ASSET', entityId: voiture.id, rawLabel: 'Clio', confidence: 'certain', evidenceSignals: [] }, semanticEvent: { type: 'maintenance', nature: 'HISTORICAL' } })],
      valueDecisions: [decision('15/11/2025', 'DATE', L_ENTRETIEN, 'STRUCTURED', 'Date de l’entretien réalisé, reprise comme dernier entretien du véhicule.', { normalizedValue: '2025-11-15', relatedFactIndexes: [0] })],
    }))]);
    await campagne([c.id], 'CORRECTIVE');
    await drainQueues();
    expect(appelsT1()).toBe(1);
    const nouveau = (await faitsActifs(f)).find((x) => x.canonical_key === 'lastRevision');
    expect(nouveau).toBeTruthy();
    expect((await decisions(f)).filter((d) => d.status === 'ACTIVE')).toEqual([expect.objectContaining({ decision: 'STRUCTURED', validity: 'VALID', related_fact_ids: [nouveau!.id] })]);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'REPAIRED' });
    // La valeur saisie par l'utilisateur reste : aucun retraitement ne l'écrase.
    expect(await valeur()).toBe('2025-12-01');
  });
});
