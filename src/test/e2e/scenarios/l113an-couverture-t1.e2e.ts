/**
 * Lot 113AN (Trello #741) sur PostgreSQL 16 réel — faux UNRESOLVED de la
 * couverture T1, réparation ciblée bornée, politique des unités restantes,
 * rapport de complétude. Point d'entrée de PRODUCTION (`analyzeFileSources`,
 * passerelle réelle, sorties Gemini REJOUÉES : aucun réseau). Recette du
 * ticket 1 à 6, scénarios « type 126 » et « type 388 » reproduits
 * génériquement (aucune donnée réelle).
 *
 *   L113AN-E01  migration 1665 rejouable, colonnes présentes ;
 *   L113AN-E02  « type 388 » : unité page:1:field:2 transcrite par l'appel de
 *               réparation (fait identique + décision de valeur) → COUVERTE,
 *               décision persistée sur l'unité, aucun doublon de fait,
 *               répétition de la page 2 couverte sur preuve, coût mesuré
 *               (1 appel de réparation, consigné), COMPLETE démontré ;
 *               rapport BO unité par unité SANS contenu ;
 *   L113AN-E03  « type 126 » : tableau transcrit couvert sans appel, vraie
 *               omission réparée, prose conservée (politique), jamais COMPLETE ;
 *               rapport d'exécution : projection non écrite ≠ perte ;
 *   L113AN-E04  document analysé AVANT le correctif (faux not_extracted
 *               persistés) : réconciliation sans IA — simulation (rien
 *               d'écrit), application (provenance, rapport recalculé),
 *               rejeu (inchangé) ;
 *   L113AN-E05  vraie omission non réparée à l'analyse (réparation
 *               désactivée) : politique REPAIR_NOT_RUN ; reprise ciblée
 *               (route BO) : seules les vraies lacunes envoyées, fait ajouté,
 *               aucune boucle (plafond), aucun doublon au rejeu ;
 *   L113AN-E06  décision de valeur arrivée APRÈS l'analyse (réexamen) :
 *               couverture mise à jour par la réconciliation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
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
/** PDF servi au découpage et à la vérification : jamais de lecture S3 réelle. */
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => pdf.bytes,
}));

type Json = Record<string, any>;
type Fait = Record<string, unknown>;
const RACINE = process.cwd();
const T1_LIVRE = readFileSync(join(RACINE, 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
const GUIDE = readFileSync(join(RACINE, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
const ANCRE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';
/** Prompt T1 avec le bloc 91D du guide (décisions de valeur), appliqué comme le PO. */
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
const sortie = (p: { transcription?: string; facts?: Fait[]; tables?: unknown[]; valueDecisions?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Facture eau', confidence: 'certain', evidence: { excerpt: 'Facture eau', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: p.tables ?? [], facts: p.facts ?? [], hasExploitableContent: true,
  ...(p.valueDecisions ? { valueDecisions: p.valueDecisions } : {}),
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
/** Passe de réparation ciblée : SOURCES « extrait ciblé ». */
const REPARATION = (output: unknown) => T1(output, { promptIncludes: 'extrait ciblé' });

/** « Type 388 » : facture d'eau, référence répétée, date de relevé en page 1 ET dans le récapitulatif de la page 2. */
const T388 = [
  '--- page 1 ---', 'Facture eau', 'N° client : 556677889', 'Date de relevé : 12/03/2026', 'Total à payer : 132,00 €',
  '--- page 2 ---', 'N° client : 556677889', 'Relevé effectué le 12/03/2026 par télérelève',
].join('\n');
const faits388 = () => [
  fait('N° client : 556677889', '556677889', { rawKey: 'client.numero' }),
  fait('Total à payer : 132,00 €', '132.00', { rawKey: 'total.ttc' }),
  fait('12/03/2026', '2026-03-12', { rawKey: 'releve.date', evidence: { excerpt: '12/03/2026', page: 2 } }),
];
const reparation388 = () => sortie({
  transcription: '[page:1:field:2]\nDate de relevé : 12/03/2026',
  facts: [fait('12/03/2026', '2026-03-12', { rawKey: 'releve.date' })],
  valueDecisions: [{ value: '12/03/2026', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'STRUCTURED', reason: 'Date du relevé du compteur reprise dans le fait de relevé.',
    sourceUnitId: '[page:1:field:2]', evidence: { excerpt: '12/03/2026', page: 1 }, relatedFactIndexes: [0], relatedCandidateKeys: [], confidence: 'certain' }],
});

/** « Type 126 » : avis d'échéance, tableau des garanties transcrit, prose, coordonnée oubliée. */
const T126 = [
  'Avis échéance assurance moto', 'Contrat n° : MOTO-778899', '',
  'Garantie responsabilité civile 210,00 €', '', 'Garantie vol incendie 95,50 €', '',
  'Votre conseiller reste à votre écoute pour toute question sur vos garanties.', '',
  'Contact : service.client@assureur-exemple.fr',
].join('\n');
const tables126 = [{ title: 'Garanties', pageStart: 1, pageEnd: 1, columns: [{ header: 'Garantie' }, { header: 'Prime' }],
  rows: [{ cells: [{ column: 0, value: 'Garantie responsabilité civile' }, { column: 1, value: '210,00 €' }] },
    { cells: [{ column: 0, value: 'Garantie vol incendie' }, { column: 1, value: '95,50 €' }] }] }];
const premiere126 = () => sortie({ transcription: T126, tables: tables126, facts: [fait('Contrat n° : MOTO-778899', 'MOTO-778899', { rawKey: 'contrat.numero' })] });
const reparation126 = () => sortie({ facts: [fait('Contact : service.client@assureur-exemple.fr', 'service.client@assureur-exemple.fr', { rawKey: 'contact.email' })] });

scenario('L113AN', 'T1 — faux UNRESOLVED, réparation ciblée bornée, rapport de complétude (#741)', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let deuxPages: Uint8Array;
  let unePage: Uint8Array;
  beforeAll(async () => {
    const { PDFDocument } = await import('pdf-lib');
    const d2 = await PDFDocument.create();
    d2.addPage(); d2.addPage();
    deuxPages = await d2.save();
    const d1 = await PDFDocument.create();
    d1.addPage();
    unePage = await d1.save();
  });
  beforeEach(async () => {
    pdf.bytes = unePage;
    await contrat(true);
  });
  afterEach(() => { delete process.env.T1_MAX_REPAIR_PASSES; });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  async function contrat(porte: boolean) {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: porte ? 99642 : 99641, treatment: 'T1', versionNumber: porte ? 9642 : 9641, content: porte ? T1_AVEC_CONTRAT : T1_LIVRE }]);
    (await import('@/services/ai/source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests();
  }
  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/l113an' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const appelsT1 = () => replay.calls.filter((c) => c.operationCode === 't1_analyze_document');
  const unites = (fileId: number) => sql<Json[]>`
    SELECT source_unit_id AS id, kind, page, content_text, coverage_status AS status, coverage_reason AS reason, repair_state, repair_attempts AS attempts,
           coverage_provenance AS prov, residual_policy AS policy
      FROM document_source_units WHERE file_id = ${fileId} ORDER BY ordinal`;
  const unite = async (fileId: number, id: string) => (await unites(fileId)).find((u) => u.id === id);
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT quality_state, covered_units, unresolved_units, uncertain_units, total_units, verification, last_retry_result, retry_attempts
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const faitsActifs = (fileId: number) => sql<Json[]>`SELECT id::int AS id, value_text, excerpt FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;

  it('L113AN-E01 — migration 1665 rejouable (additive, idempotente), colonnes présentes', async () => {
    const m = readFileSync(join(RACINE, 'src/db/migrations/1665_l113an_couverture_t1_provenance.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(m); });
    await sql.begin(async (tx) => { await tx.unsafe(m); });
    const cols = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'document_source_units' AND column_name IN ('coverage_provenance', 'residual_policy') ORDER BY 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['coverage_provenance', 'residual_policy']);
  });

  it('L113AN-E02 — « type 388 » : page:1:field:2 relue par la réparation → COUVERTE, décision persistée, aucun doublon, COMPLETE démontré ; BO sans contenu', async () => {
    pdf.bytes = deuxPages;
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: T388, facts: faits388() })), REPARATION(reparation388())]);
    // Recette 5 : 1 analyse + 1 réparation ciblée (appel « analysis » de la passerelle), rien d'autre.
    expect(appelsT1()).toHaveLength(2);
    expect(appelsT1()[1].prompt).toContain('[page:1:field:2]');
    expect(appelsT1()[1].attachments).toEqual([]);
    // Recette 2 : l'unité n'est plus « not_extracted » — couverte par le fait relu, provenance de la réparation.
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ status: 'COVERED', reason: 'fact', repair_state: 'SUCCEEDED', attempts: 1, policy: null });
    // Répétition de la page 2 : couverte sur preuve (texte identique), provenance persistée.
    expect(await unite(f, 'page:2:field:1')).toMatchObject({ status: 'COVERED', reason: 'duplicate',
      prov: expect.objectContaining({ rule: 'duplicate_of_covered_unit', refs: ['unit:page:1:field:1'], previous: { status: 'UNRESOLVED', reason: 'not_extracted' } }) });
    // Aucun doublon de fait (3 faits) ; décision de la réparation persistée, ancrée sur l'unité, rattachée au fait existant.
    const faits = await faitsActifs(f);
    expect(faits.map((x) => x.value_text)).toEqual(['556677889', '132.00', '2026-03-12']);
    const d = await sql<Json[]>`SELECT source_unit_id, decision, validity, related_fact_ids::int[] AS ids FROM document_value_decisions WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect(d).toEqual([{ source_unit_id: 'page:1:field:2', decision: 'STRUCTURED', validity: 'VALID', ids: [faits[2].id] }]);
    // Recette 6 : COMPLETE seulement parce que TOUTE unité est couverte ou non informative.
    const cov = await couverture(f);
    expect(cov).toMatchObject({ quality_state: 'COMPLETE', unresolved_units: 0, uncertain_units: 0 });
    expect(cov.verification.coverageRepair).toMatchObject({ passes: 1, calls: 1, selected: 1, attempted: 1, resolved: 1, factsAdded: 0, factsConfirmed: 1, decisions: 1, skipped: null });

    // Rapport de complétude BO : totaux, réparation, unités, sans aucun contenu du document.
    const { loadCompletenessDetail } = await import('@/services/ai/source-analysis/source-units/completeness-detail');
    const det = await loadCompletenessDetail(f, { all: true });
    expect(det!.totals).toMatchObject({ total: cov.total_units, unresolved: 0, requalified: 1 });
    expect(det!.coverageRepair).toMatchObject({ calls: 1 });
    expect(det!.units.find((u) => u.unitId === 'page:1:field:2')).toMatchObject({ status: 'COVERED', valueKinds: { DATE: 1 } });
    const json = JSON.stringify(det);
    for (const secret of ['556677889', '12/03/2026', '132,00', 'Relevé']) expect(json).not.toContain(secret);
  });

  it('L113AN-E03 — « type 126 » : tableau transcrit sans appel, vraie omission réparée, prose conservée, jamais COMPLETE ; projection non écrite ≠ perte', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiere126()), REPARATION(reparation126())]);
    expect(appelsT1()).toHaveLength(2);
    // Recette 3 : seule la vraie lacune est envoyée.
    expect(appelsT1()[1].prompt).toContain('service.client@assureur-exemple.fr');
    expect(appelsT1()[1].prompt).not.toContain('210,00');
    expect(appelsT1()[1].prompt).not.toContain('Votre conseiller');
    const us = await unites(f);
    const par = (t: string) => us.find((u) => String(u.content_text ?? '').startsWith(t))!;
    expect(par('Garantie responsabilité civile')).toMatchObject({ status: 'COVERED', reason: 'table_transcription', prov: expect.objectContaining({ sources: ['TABLE'] }) });
    expect(par('Contact')).toMatchObject({ status: 'COVERED', reason: 'fact', repair_state: 'SUCCEEDED' });
    expect(par('Votre conseiller')).toMatchObject({ status: 'UNRESOLVED', reason: 'not_structured', policy: 'PRESERVED_UNSTRUCTURED' });
    const cov = await couverture(f);
    expect(cov.quality_state).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(cov.verification.residualPolicies).toEqual({ PRESERVED_UNSTRUCTURED: 2 });
    // Recette 4 (doublons) : rejouer la même analyse ne duplique rien.
    await analyser(c, f, [T1(premiere126()), REPARATION(reparation126())]);
    expect((await faitsActifs(f)).map((x) => x.value_text).sort()).toEqual(['MOTO-778899', 'service.client@assureur-exemple.fr']);
    // Rapport d'exécution T1 : une projection non écrite (fait générique) est une connaissance CONSERVÉE, pas une perte.
    const proj = await sql<Json[]>`
      SELECT e.reason_code, e.links FROM ai_execution_report_entries e JOIN ai_execution_reports r ON r.id = e.report_id
       WHERE r.file_id = ${f} AND e.section = 'PROJECTION' ORDER BY e.seq`;
    for (const p of proj) expect(p.links).toMatchObject({ knowledgePreserved: true, lossFamily: 'PROJECTION_ONLY_KNOWLEDGE_KEPT' });
    // Rapport d'exécution : unités par état (une unité non résolue est une lacune, une projection non écrite ne l'est pas).
    const [rep] = await sql<Json[]>`SELECT counters FROM ai_execution_reports WHERE file_id = ${f} AND treatment = 'T1' ORDER BY id DESC LIMIT 1`;
    expect(rep.counters).toMatchObject({ sourceUnits_UNRESOLVED: 2, sourceUnitsRequalified: 2 });
  });

  it('L113AN-E04 — document analysé AVANT le correctif : réconciliation sans IA (simulation, application, rejeu inchangé)', async () => {
    pdf.bytes = deuxPages;
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: T388, facts: faits388() })), REPARATION(reparation388())]);
    // État d'avant le lot : répétition et unité relue laissées « not_extracted », sans provenance, couverture incomplète.
    await sql`UPDATE document_source_units SET coverage_status = 'UNRESOLVED', coverage_reason = 'not_extracted', coverage_provenance = NULL, residual_policy = NULL
               WHERE file_id = ${f} AND source_unit_id = 'page:2:field:1'`;
    await sql`UPDATE document_extraction_coverage SET quality_state = 'COMPLETE_WITH_UNRESOLVED', unresolved_units = 1, covered_units = covered_units - 1 WHERE file_id = ${f}`;
    const { reconcileStoredDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reconciliation');
    const sim = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: f, apply: false, origin: 'e2e' });
    expect(sim).toMatchObject({ outcome: 'SIMULATED', before: { qualityState: 'COMPLETE_WITH_UNRESOLVED' }, after: { qualityState: 'COMPLETE' } });
    expect(sim.requalified.map((r) => [r.unitId, r.to.status, r.rule])).toEqual([['page:2:field:1', 'COVERED', 'duplicate_of_covered_unit']]);
    expect(await unite(f, 'page:2:field:1')).toMatchObject({ status: 'UNRESOLVED' });
    const app = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: f, apply: true, origin: 'e2e' });
    expect(app.outcome).toBe('APPLIED');
    expect(await unite(f, 'page:2:field:1')).toMatchObject({ status: 'COVERED', reason: 'duplicate', prov: expect.objectContaining({ stage: 'STORED' }) });
    expect(await couverture(f)).toMatchObject({ quality_state: 'COMPLETE', unresolved_units: 0, last_retry_result: 'RECONCILED_1' });
    // Faits, décisions et coût inchangés ; rejeu idempotent.
    expect((await faitsActifs(f))).toHaveLength(3);
    expect((await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: f, apply: true, origin: 'e2e' })).outcome).toBe('UNCHANGED');
  });

  it('L113AN-E05 — vraie omission non réparée à l’analyse : politique explicite ; reprise ciblée bornée ; aucune boucle ni doublon', async () => {
    process.env.T1_MAX_REPAIR_PASSES = '0';
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiere126())]);
    expect(appelsT1()).toHaveLength(1);
    const contact = (await unites(f)).find((u) => String(u.content_text ?? '').startsWith('Contact'))!;
    expect(contact).toMatchObject({ status: 'UNRESOLVED', policy: 'REPAIR_NOT_RUN:DISABLED' });
    expect((await couverture(f)).verification.coverageRepair).toMatchObject({ calls: 0, skipped: 'DISABLED' });
    delete process.env.T1_MAX_REPAIR_PASSES;

    // Reprise ciblée (route BO) : seules les unités RÉELLEMENT non couvertes, depuis le texte persisté.
    await rejouer([REPARATION(reparation126())]);
    const { repairDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/jobs');
    const r = await repairDocumentSourceUnits({ accountId: c.id, fileId: f });
    expect(r).toMatchObject({ outcome: 'repaired', calls: 1, newFacts: 1 });
    expect(r.attempted).toEqual([contact.id]);
    expect(appelsT1()[0].prompt).not.toContain('210,00');
    expect(await unite(f, contact.id)).toMatchObject({ status: 'COVERED', reason: 'fact', repair_state: 'SUCCEEDED', policy: null });
    // Rejeu : plus rien à réparer (aucun appel), aucun doublon ; plafond de reprises respecté.
    await rejouer([]);
    const r2 = await repairDocumentSourceUnits({ accountId: c.id, fileId: f });
    expect(r2.calls).toBe(0);
    expect(appelsT1()).toHaveLength(0);
    expect((await faitsActifs(f)).map((x) => x.value_text).sort()).toEqual(['MOTO-778899', 'service.client@assureur-exemple.fr']);
    for (let i = 0; i < 4; i++) await repairDocumentSourceUnits({ accountId: c.id, fileId: f });
    expect(Number((await couverture(f)).retry_attempts)).toBeLessThanOrEqual(2);
  });

  it('L113AN-E06 — décision de valeur arrivée APRÈS l’analyse (réexamen) : la couverture est réconciliée', async () => {
    process.env.T1_MAX_REPAIR_PASSES = '0';
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: 'Facture eau\nN° client : 556677889\nDate de relevé : 12/03/2026', facts: [fait('N° client : 556677889', '556677889')] }))]);
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ status: 'UNRESOLVED', reason: 'not_extracted' });
    // Le réexamen (contrôle de cohérence) persiste une décision NOT_RETAINED justifiée sur l'unité.
    const { insertValueDecisions } = await import('@/services/ai/source-analysis/value-decisions/store');
    const { unitFingerprint } = await import('@/services/ai/source-analysis/value-decisions/validate');
    await sql.begin(async (tx) => {
      await insertValueDecisions(tx as never, { accountId: c.id, fileId: f, extractionId: null, analysisRunId: null, promptVersion: 'e2e', aiTraceId: null, factIds: new Map() }, [{
        origin: 'REVIEW', sourceUnitId: 'page:1:field:2', unitFingerprint: unitFingerprint('Date de relevé : 12/03/2026'), kind: 'DATE', rawValue: '12/03/2026',
        normalizedValue: '2026-03-12', decision: 'NOT_RETAINED', reason: 'Date de télérelève du compteur, distincte de la date de facture.', confidence: 'certain',
        evidence: {}, relatedFactRefs: [], relatedCandidateKeys: [], validity: 'VALID', invalidReason: null,
      }]);
    });
    const { reconcileStoredDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reconciliation');
    await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: f, apply: true, origin: 'value-review:e2e' });
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ status: 'COVERED', reason: 'value_decision_not_retained',
      prov: expect.objectContaining({ sources: ['VALUE_DECISION'], previous: { status: 'UNRESOLVED', reason: 'not_extracted' } }) });
  });
});
