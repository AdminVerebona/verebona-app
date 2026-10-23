/**
 * Lot 83B — contrôle de cohérence : chaîne document → extract → T1 → aval
 * (C-Q7), rattachements et séparation bien / équipement (C3), Opérations
 * (invariants O-1 branchés, identité 78A périodique — C4), sur PostgreSQL 16
 * réel. Analyses T1 par le point d'entrée de PRODUCTION
 * (`analyzeFileSources`, passerelle réelle, sorties modèle rejouées), file T1
 * réelle (`runOne`), campagnes de l'orchestrateur unique.
 *
 *   L83B-E2E-01  montant de l'extract OUBLIÉ par T1 (unité non couverte) →
 *                diagnostic (b) à blanc sans écriture ni IA, puis UNE relance
 *                T1 ciblée (passe de réparation existante), recontrôle, coût
 *                IA mesuré ; second passage : aucune relance ;
 *   L83B-E2E-02  information PRÉSENTE dans T1 mais pas exploitée en aval →
 *                réparation aval seule (projection), aucune relance T1 ;
 *   L83B-E2E-03  extract SUSPECT (lacune de pages, reprise perdue) →
 *                nouvelle extraction par la file T1 existante, tracée
 *                (PENDING), jamais relancée en double, close au contrôle
 *                suivant (REPAIRED) ;
 *   L83B-E2E-04  aucune boucle : relance T1 sans effet → plus jamais relancée
 *                (diagnostic identique) ; omission sur unité COUVERTE →
 *                constat seul (contrat IA attendu), aucune relance ;
 *   L83B-E2E-05  compte non éligible : aucun contrôle, aucune relance ;
 *   L83B-E2E-06  invariant O-1 violé → réparé par le service de regroupement
 *                puis recontrôlé ; à blanc sans écriture ; anti-cartésien :
 *                constat seul ; second passage sans écriture ;
 *   L83B-E2E-07  identité économique 78A, périodique, en DÉTECTION : stock
 *                contredit constaté sans écriture ; cohérent après le
 *                réexamen 78A (consolidation T3) ;
 *   L83B-E2E-08  document d'équipement laissé au seul bien, association
 *                suggérée par l'Opération seulement → constat (P19), jamais
 *                de lien posé ; lien de l'utilisateur → cohérent ;
 *   L83B-E2E-09  donnée d'équipement attribuée au bien, provenance DÉMONTRÉE
 *                → réparée par le rattrapage existant (tracé), puis cohérent ;
 *   L83B-E2E-10  écriture d'une Opération → contrôle ciblé durable (O-1, 78A) ;
 *   L83B-E2E-11  budget des relances IA épuisé : constat, aucun appel ; rétabli : relance.
 *
 * Campagnes BORNÉES aux comptes créés ici ; assertions sur ces comptes seuls.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';
import { RECETTE_TODAY, cand, cible, fh, operationsKit, type OperationsKit } from '../datasets/operations-v1';

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

const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Facture entretien', confidence: 'certain', evidence: { excerpt: 'Facture entretien', page: 1 } },
    documentDate: { value: '2026-03-12', confidence: 'certain', evidence: { excerpt: 'Date : 12/03/2026', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: [], facts: p.facts ?? [], hasExploitableContent: true,
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
/** Passe de réparation ciblée : son prompt porte l'identifiant des unités. */
const REPARATION = (output: unknown, unit = '[page:1:field:') => T1(output, { promptIncludes: unit });
const FACTURE = 'Facture entretien\nDate : 12/03/2026\nMontant TTC : 1 234,00 €';

scenario('L83B', 'Cohérence : chaîne extract → T1 → aval (C-Q7), rattachements (C3), Opérations O-1 et 78A (C4)', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let k: OperationsKit;
  let pageUnique: Uint8Array;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage();
    pageUnique = await d.save();
  });
  beforeEach(() => { pdf.bytes = pageUnique; });

  // ── Outils ───────────────────────────────────────────────────────────────
  const orchestrateur = () => import('@/services/coherence/orchestrator');
  const fichier = async (compte: AccountRow, assetId: number | null = null) => {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`facture-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  /** Analyse T1 par le point d'entrée de production ; les enregistrements CIBLÉS (réparation) avant la sortie principale. */
  const analyser = async (compte: AccountRow & { ownerUserId?: number }, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/l83b' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const appelsT1 = () => replay.calls.filter((c) => c.operationCode === 't1_analyze_document').length;
  /**
   * Appels modèle hors T6 : la pré-génération de la mascotte (T6) part en
   * arrière-plan après les changements d'agenda d'une ANALYSE (indépendante du
   * contrôle de cohérence, qui ne la déclenche jamais) — son horaire n'est pas
   * déterministe dans le harnais.
   */
  const horsT6 = () => replay.calls.filter((c) => !String(c.operationCode ?? '').startsWith('t6_'));
  const appelsIA = () => horsT6().length;
  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await orchestrateur();
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: scope });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: RECETTE_TODAY });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuve = async (accountId: number, check: string, objectId: number) => (await sql<Json[]>`
    SELECT last_result, last_mode, finding, finding_streak, last_repair_hash, rules_version, last_error FROM coherence_object_proofs
     WHERE account_id = ${accountId} AND check_id = ${check} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number, check?: string) => sql<Json[]>`
    SELECT check_id, object_id::int AS object_id, service, outcome, recheck_verdict, anomaly, faulty_link, input_hash, result, rollback_ref, ai_calls, settled_at, error
      FROM coherence_repairs WHERE account_id = ${accountId} AND (${check ?? null}::text IS NULL OR check_id = ${check ?? null}) ORDER BY id`;
  const unite = async (fileId: number, unitId: string) => (await sql<Json[]>`
    SELECT coverage_status, coverage_reason, repair_attempts FROM document_source_units WHERE file_id = ${fileId} AND source_unit_id = ${unitId}`)[0];
  const faits = (fileId: number) => sql<Json[]>`SELECT value_text FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT quality_state, retry_attempts, next_retry_at, last_retry_result, total_units, failed_units FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];

  /** Document analysé dont le montant TTC (unité non couverte) a été oublié par T1, réparation d'analyse sans résultat. */
  async function factureMontantOublie(compte: AccountRow) {
    const f = await fichier(compte);
    await analyser(compte, f, [REPARATION(sortie({ facts: [] })), T1(sortie({ transcription: FACTURE, facts: [fait('Date : 12/03/2026', '2026-03-12')] }))]);
    return f;
  }

  // ══ L83B-E2E-01 ════════════════════════════════════════════════════════════

  it('L83B-E2E-01 — montant de l’extract oublié par T1 : diagnostic (b) à blanc sans écriture ni IA, puis UNE relance ciblée, recontrôle, coût mesuré ; aucune relance au second passage', async () => {
    const c = await make.account();
    const f = await factureMontantOublie(c);
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ coverage_status: 'UNRESOLVED', coverage_reason: 'not_extracted', repair_attempts: 1 });
    expect((await faits(f)).map((x) => x.value_text)).toEqual(['2026-03-12']);
    const cov0 = await couverture(f);
    expect(cov0.next_retry_at).toBeNull();

    // À blanc : diagnostic consigné, AUCUNE écriture, AUCUN appel IA.
    await rejouer([]);
    const photo = async () => ({ u: await sql`SELECT * FROM document_source_units WHERE file_id = ${f} ORDER BY id`, fa: await faits(f), c: await couverture(f) });
    const avant = await photo();
    const blanc = await campagne([c.id], 'DRY_RUN');
    expect(blanc).toMatchObject({ mode: 'DRY_RUN', status: 'COMPLETE' });
    expect(appelsIA()).toBe(0);
    expect(await photo()).toEqual(avant);
    expect(await reparations(c.id)).toEqual([]);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({
      last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN', rules_version: 1,
      finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_BY_T1', faultyLink: 'T1',
        observed: [{ unit: 'page:1:field:2', status: 'UNRESOLVED', values: [{ kind: 'AMOUNT', value: '123400' }] }],
        detail: expect.objectContaining({ repair: 'T1_REPAIR', t1Relaunch: true }) }),
    });

    // Correctif : UNE passe T1 ciblée (unités non couvertes seulement), fait prouvé par l'unité, recontrôle cohérent.
    await rejouer([REPARATION(sortie({ facts: [fait('Montant TTC : 1 234,00 €', '1234.00')] }), '[page:1:field:2]')]);
    const corr = await campagne([c.id], 'CORRECTIVE');
    expect(corr.status).toBe('COMPLETE');
    expect(appelsT1()).toBe(1);
    expect(replay.calls.find((x) => x.operationCode === 't1_analyze_document')!.attachments).toEqual([]);
    expect((await faits(f)).map((x) => x.value_text)).toEqual(['2026-03-12', '1234.00']);
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ coverage_status: 'COVERED' });
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    const j = await reparations(c.id, CHECK);
    expect(j).toEqual([expect.objectContaining({
      object_id: f, service: 'repairDocumentSourceUnits', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'FACT_OMITTED_BY_T1', faulty_link: 'T1',
      result: expect.objectContaining({ outcome: 'repaired', calls: 1, newFacts: 1 }),
    })]);
    expect(j[0].ai_calls).toBeGreaterThanOrEqual(1);
    expect(corr.metrics.aiCalls).toBeGreaterThanOrEqual(1);
    // Reprise consommée selon les règles existantes (même plafond que t1-completeness-retry).
    expect(await couverture(f)).toMatchObject({ retry_attempts: 1, next_retry_at: null });

    // Second passage : rien à relancer, aucun appel, aucune nouvelle ligne au journal.
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsIA()).toBe(0);
    expect(await reparations(c.id, CHECK)).toHaveLength(1);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L83B-E2E-02 ════════════════════════════════════════════════════════════

  it('L83B-E2E-02 — information présente dans T1 mais jamais projetée sur le bien : réparation AVAL seule, aucune relance T1', async () => {
    const c = await make.account();
    const voiture = await make.asset(c, { category: 'VEHICULE', name: 'Clio' });
    const f = await fichier(c, voiture.id);
    await analyser(c, f, [T1(sortie({
      transcription: 'Facture entretien\nDate : 12/03/2026\nKilométrage : 78 000 km',
      facts: [
        fait('Date : 12/03/2026', '2026-03-12'),
        fait('Kilométrage : 78 000 km', '78000', {
          canonicalKey: 'mileage', rawKey: 'Kilométrage', rawValue: '78 000 km', normalizedValue: '78000', valueType: 'number', canonicalUnit: 'km',
          target: { type: 'ASSET', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
        }),
      ],
    }))]);
    const preuves = () => sql<Json[]>`SELECT field_key FROM field_evidence WHERE source_id = ${f} AND asset_id = ${voiture.id} ORDER BY id`;
    expect((await preuves()).map((x) => x.field_key)).toContain('mileage');
    // État historique : la projection sur le bien s'est perdue (preuves absentes), les faits T1 restent.
    await sql`DELETE FROM field_evidence WHERE source_id = ${f}`;
    await rejouer([]);
    await campagne([c.id], 'DRY_RUN');
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'FACTS_NOT_PROJECTED', faultyLink: 'PERSISTENCE' }) });
    expect(await preuves()).toEqual([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(0);
    expect((await preuves()).map((x) => x.field_key)).toContain('mileage');
    expect(await reparations(c.id, CHECK)).toEqual([expect.objectContaining({
      service: 'projectDocumentKnowledgeToAsset', outcome: 'REPAIRED', anomaly: 'FACTS_NOT_PROJECTED', recheck_verdict: 'CONSISTENT',
      result: expect.objectContaining({ t1Relaunch: false }),
    })]);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'REPAIRED' });
  });

  // ══ L83B-E2E-03 ════════════════════════════════════════════════════════════

  it('L83B-E2E-03 — extract suspect (pages non lues, reprise perdue) : nouvelle extraction par la file T1, tracée, jamais doublée, close au contrôle suivant', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: 'Facture entretien\nDate : 12/03/2026', facts: [fait('Date : 12/03/2026', '2026-03-12')] }))]);
    // Stock historique : lacune de la page 2 (réessayable), reprise jamais programmée.
    await sql.begin(async (tx) => {
      const [e] = await tx<{ extraction_id: number }[]>`SELECT extraction_id FROM document_extraction_coverage WHERE file_id = ${f}`;
      await tx`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, content_text, payload, location, origin, salient, coverage_status, coverage_reason)
               VALUES (${c.id}, ${f}, ${e.extraction_id}, 'page:2:gap:2', 'PAGE_GAP', 2, 999, NULL, '{"retryable": true}'::jsonb, '{"pageStart": 2, "pageEnd": 2}'::jsonb, 'CHUNK', true, 'FAILED', 'chunk_failed')`;
      await tx`UPDATE document_extraction_coverage SET total_units = total_units + 1, failed_units = failed_units + 1, quality_state = 'INCOMPLETE_RETRYABLE',
                      next_retry_at = NULL, retry_attempts = 0 WHERE file_id = ${f}`;
    });
    const travauxT1 = async () => (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND account_id = ${c.id} AND target_id = ${String(f)}`)[0].n;
    const t0 = await travauxT1();
    await campagne([c.id], 'DRY_RUN');
    expect(await travauxT1()).toBe(t0);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'EXTRACT_INCOMPLETE', faultyLink: 'EXTRACT' }) });

    await campagne([c.id], 'CORRECTIVE');
    expect(await travauxT1()).toBe(t0 + 1);
    expect(await couverture(f)).toMatchObject({ last_retry_result: 'REQUEUED_T1_COHERENCE', retry_attempts: 1 });
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'REPAIR_PENDING' });
    expect(await reparations(c.id, CHECK)).toEqual([expect.objectContaining({ service: 'requeueDocumentForReread', outcome: 'PENDING', recheck_verdict: null, anomaly: 'EXTRACT_INCOMPLETE', settled_at: null })]);
    // Relance en attente : aucun second envoi, même diagnostic attendu.
    await campagne([c.id], 'CORRECTIVE');
    expect(await travauxT1()).toBe(t0 + 1);
    expect(await reparations(c.id, CHECK)).toHaveLength(1);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'REPAIR_PENDING' });

    // La file T1 exécute la nouvelle extraction (réanalyse complète, aucune lacune).
    await rejouer([T1(sortie({ transcription: 'Facture entretien\nDate : 12/03/2026', facts: [fait('Date : 12/03/2026', '2026-03-12')] }))]);
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    (await import('@/services/ai/source-analysis/queue/t1-handler')).registerSourceAnalysisHandler();
    expect(await runOne('T1')).toBe(true);
    await drainQueues();
    expect(appelsT1()).toBe(1);
    expect((await sql`SELECT 1 FROM document_source_units WHERE file_id = ${f} AND kind = 'PAGE_GAP'`)).toHaveLength(0);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    const [j] = await reparations(c.id, CHECK);
    expect(j).toMatchObject({ outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT' });
    expect(j.settled_at).not.toBeNull();
  });

  // ══ L83B-E2E-04 ════════════════════════════════════════════════════════════

  it('L83B-E2E-04 — aucune boucle : relance T1 sans effet jamais rejouée ; omission sur unité COUVERTE : constat (contrat IA), aucune relance', async () => {
    const c = await make.account();
    const f = await factureMontantOublie(c);
    // La relance ciblée ne retrouve rien (T1 maintient l'omission).
    await rejouer([REPARATION(sortie({ facts: [] }), '[page:1:field:2]')]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(1);
    const j = await reparations(c.id, CHECK);
    expect(j).toEqual([expect.objectContaining({ service: 'repairDocumentSourceUnits', outcome: 'INEFFECTIVE', recheck_verdict: 'REPAIRABLE' })]);
    // Deux passages de plus : ni appel, ni relance, constat tracé (même diagnostic déjà relancé).
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    await campagne([c.id], 'CORRECTIVE');
    expect(horsT6().map((x) => x.operationCode)).toEqual([]);
    expect(await reparations(c.id, CHECK)).toHaveLength(1);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'RELAUNCH_ALREADY_TRIED' }) });

    // Unité COUVERTE portant une valeur absente de T1 (« dont frais 34,00 € ») : constat seul.
    const g = await fichier(c);
    await analyser(c, g, [T1(sortie({
      transcription: 'Facture entretien\nTotal TTC : 120,00 € dont frais 34,00 €',
      facts: [fait('Total TTC : 120,00 € dont frais 34,00 €', '120.00')],
    }))]);
    expect(await unite(g, 'page:1:field:1')).toMatchObject({ coverage_status: 'COVERED' });
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(horsT6().map((x) => x.operationCode)).toEqual([]);
    expect(await preuve(c.id, CHECK, g)).toMatchObject({
      last_result: 'FINDING',
      finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_COVERED_UNIT', detail: expect.objectContaining({ pendingContract: '82B-t1-omissions-extract', t1Relaunch: false }) }),
    });
    expect((await reparations(c.id, CHECK)).filter((x) => x.object_id === g)).toEqual([]);
  });

  // ══ L83B-E2E-05 ════════════════════════════════════════════════════════════

  it('L83B-E2E-05 — compte non éligible (sans abonnement) : jamais contrôlé, aucune relance, aucun appel IA', async () => {
    const actif = await make.account();
    const f = await factureMontantOublie(actif);
    // Le compte perd son abonnement (lecture seule) avant la campagne.
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${actif.id}`;
    await rejouer([]);
    const camp = await campagne([actif.id], 'CORRECTIVE');
    expect(camp.accounts).toMatchObject({ visited: 0, skipped: { NO_SUBSCRIPTION: 1 } });
    expect(appelsIA()).toBe(0);
    expect(await preuve(actif.id, CHECK, f)).toBeUndefined();
    expect(await reparations(actif.id)).toEqual([]);
    const { requestTargetedChecks } = await orchestrateur();
    expect(await requestTargetedChecks({ accountId: actif.id, event: { type: 'SOURCE_ANALYZED', entityId: f } })).toEqual({});
    // La passe ciblée elle-même refuse un compte non éligible (défense en profondeur, C-Q10).
    const { repairDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/jobs');
    expect(await repairDocumentSourceUnits({ accountId: actif.id, fileId: f })).toMatchObject({ outcome: 'NOT_ELIGIBLE', calls: 0 });
    expect(appelsIA()).toBe(0);
  });

  // ══ L83B-E2E-06 ════════════════════════════════════════════════════════════

  it('L83B-E2E-06 — invariants O-1 violés : à blanc sans écriture ; réparés par le service de regroupement puis recontrôlés ; anti-cartésien constat seul ; second passage sans écriture', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = (await make.assetFile(c, { assetId: maison.id })).id;
    const f2 = (await make.assetFile(c, { assetId: maison.id })).id;
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const creer = async (fileId: number) => (await withBusinessOperationWrite(c.id, (repo) => repo.create({
      type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: '2026-03-12', technicalLabel: 'Dégât des eaux',
      source: { kind: 'DOCUMENT', entityKey: fileId, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
    const op = await creer(f1);
    const absorbee = await creer(f2);
    const p = await make.agendaItem(c, { title: 'Dégât des eaux' });
    const s = await make.agendaItem(c, { title: 'Ancienne étape' });
    const { designatePrincipal, withGroupingWrite } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c.id, (g) => designatePrincipal(g, { operationId: op, itemId: p.id, origin: 'T4', reasonCode: 'E2E' }));
    // Écarts historiques injectés hors déclencheurs : élément lié à une Opération fusionnée, lien sans provenance.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE business_operations SET merged_into_operation_id = ${op}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${absorbee}`;
      await tx`UPDATE agenda_items SET business_operation_id = ${absorbee}, operation_role = 'RELATED' WHERE id = ${s.id}`;
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${s.id}, ${f2}, '{}')`;
    });
    const etat = async () => ({
      items: await sql`SELECT id, business_operation_id, operation_role FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`,
      liens: await sql`SELECT agenda_item_id, asset_file_id, provenances FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${c.id} ORDER BY 1, 2`,
      historique: await k.historique(c),
    });
    const avant = await etat();
    await campagne([c.id], 'DRY_RUN');
    expect(await etat()).toEqual(avant);
    expect(await preuve(c.id, 'COH-O1-AGENDA-ONE-OPERATION', c.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'GROUPING_INVARIANT_VIOLATED' }) });
    expect(await preuve(c.id, 'COH-O1-LINK-PROVENANCE', c.id)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect(await reparations(c.id)).toEqual([]);

    const camp = await campagne([c.id], 'CORRECTIVE');
    expect((await sql<Json[]>`SELECT business_operation_id::int AS op, operation_role AS role FROM agenda_items WHERE id = ${s.id}`)[0]).toEqual({ op, role: 'RELATED' });
    expect((await sql<Json[]>`SELECT provenances FROM agenda_file_links WHERE agenda_item_id = ${s.id} AND asset_file_id = ${f2}`)[0].provenances).not.toEqual([]);
    for (const id of ['COH-O1-AGENDA-ONE-OPERATION', 'COH-O1-LINK-PROVENANCE']) {
      expect(await preuve(c.id, id, c.id), id).toMatchObject({ last_result: 'REPAIRED', finding: null });
    }
    const j = (await reparations(c.id)).filter((x) => x.check_id.startsWith('COH-O1-'));
    expect(j.map((x) => [x.check_id, x.service, x.outcome, x.recheck_verdict]).sort()).toEqual([
      ['COH-O1-AGENDA-ONE-OPERATION', 'repairGroupingFinding', 'REPAIRED', 'CONSISTENT'],
      ['COH-O1-LINK-PROVENANCE', 'repairGroupingFinding', 'REPAIRED', 'CONSISTENT'],
    ]);
    expect(j.every((x) => String(x.rollback_ref).startsWith(`business_operation_history:correlation_id=coherence:manual-${camp.id}`))).toBe(true);
    // Recontrôle par le moteur : plus aucun constat O-1 (détection du service).
    const { detectGroupingFindings } = await import('@/services/business-operations/grouping/invariants');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    expect(await detectGroupingFindings(postgresRunner(sql), c.id)).toEqual([]);

    // Second passage : aucune écriture, aucune nouvelle réparation.
    const apres = await etat();
    await campagne([c.id], 'CORRECTIVE');
    expect(await etat()).toEqual(apres);
    expect((await reparations(c.id)).filter((x) => x.check_id.startsWith('COH-O1-'))).toHaveLength(2);
    expect(await preuve(c.id, 'COH-O1-AGENDA-ONE-OPERATION', c.id)).toMatchObject({ last_result: 'CONSISTENT' });

    // Anti-cartésien : produit Documents × Équipements automatique → constat seul, rien n'est retiré.
    const e1 = await k.equipement(maison, 'Alarme');
    const e2 = await k.equipement(maison, 'Caméra');
    const { attachEquipment, attachDocument } = await import('@/services/business-operations/grouping/service');
    for (const e of [e1, e2]) await withGroupingWrite(c.id, (g) => attachEquipment(g, { operationId: op, equipmentId: e, origin: 'USER', reasonCode: 'E2E' }));
    await withGroupingWrite(c.id, (g) => attachDocument(g, { operationId: op, fileId: f2, reasonCode: 'E2E' }));
    for (const fid of [f1, f2]) for (const e of [e1, e2]) {
      await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, confidence, status)
                VALUES (${c.id}, ${fid}, ${maison.id}, ${e}, 'SECONDARY', 'AI', 1, 'ACTIVE') ON CONFLICT DO NOTHING`;
    }
    const liens = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_asset_links WHERE account_id = ${c.id} AND status = 'ACTIVE' AND equipment_id IS NOT NULL`)[0].n;
    const nLiens = await liens();
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-O1-ANTI-CARTESIAN', c.id)).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ detail: expect.objectContaining({ invariant: 'O1-ANTI-CARTESIAN' }) }) });
    expect(await liens()).toBe(nLiens);
    expect((await reparations(c.id, 'COH-O1-ANTI-CARTESIAN'))).toEqual([]);
  });

  // ══ L83B-E2E-07 ════════════════════════════════════════════════════════════

  it('L83B-E2E-07 — identité 78A périodique en DÉTECTION : stock contredit constaté sans écriture ; cohérent après le réexamen 78A (T3)', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const fTika = await k.document(c, maison.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Commande de quatre chaises', provider: 'Tikamoon', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      temporalHints: { realizedDate: '2025-05-12' }, financialHints: [fh('REALIZED_COST', 27735, { economicDate: '2025-05-12' })],
    })], { title: 'Commande' });
    await k.passer(c);
    const [op] = await k.actives(c);
    const acte = await k.document(c, maison.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Acte authentique de vente de la maison', provider: 'Office notarial', sourceRoleHint: 'SALE_DOCUMENT',
      targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2021-06-30' }, financialHints: [fh('REALIZED_COST', 49_000_000, { economicDate: '2021-06-30' })],
    })], { title: 'Acte' });
    // Rattachement M2 historique, enregistré avant le contrôle 78A (stock).
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(c.id, async (repo, session) => {
      const [x] = await sql<{ id: number; candidate_key: string }[]>`SELECT id::int AS id, candidate_key FROM document_operation_candidates WHERE file_id = ${acte} AND status = 'ACTIVE'`;
      const version = `c${x.id}|a${maison.id}|t`;
      const sid = await repo.addSource(op.id, {
        kind: 'DOCUMENT', entityKey: acte, version, role: 'SALE_DOCUMENT', locator: { candidateKey: x.candidate_key }, authority: 'DOCUMENT',
        confidence: 'certain', matchMethod: 'M2', matchReason: 'MATCH_M2',
      }, 'T3_MATCH_AND_ENRICH');
      await repo.refreshSourceVersion(sid, version);
      await session.tx.execute((await import('drizzle-orm')).sql`
        UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now(), t3_outcome = 'MATCH_AND_ENRICH', t3_reason = 'MATCH_M2', t3_operation_id = ${op.id}
         WHERE id = ${x.id}`);
    });
    await sql`UPDATE document_operation_candidates SET t3_detail = COALESCE(t3_detail, '{}'::jsonb) - 'identityReview' WHERE account_id = ${c.id}`;
    // Intégration lot 83 : d'autres contrôles du registre (projection Agenda 83E, O-7 83A) réparent
    // légitimement ce compte au premier passage correctif — on les laisse converger, puis on mesure
    // que COH-OPS-IDENTITY, lui, n'écrit rien.
    await campagne([c.id], 'CORRECTIVE');
    const h = await k.historique(c);
    const sources = () => sql`SELECT id, active FROM business_operation_sources WHERE operation_id = ${op.id} ORDER BY id`;
    const s0 = await sources();
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-OPS-IDENTITY', op.id)).toMatchObject({
      last_error: null,
      last_result: 'FINDING',
      finding: expect.objectContaining({ anomaly: 'IDENTITY_CONTRADICTED', faultyLink: 'T3', observed: [expect.objectContaining({ outcome: 'SEPARATE', signals: expect.arrayContaining(['!AMOUNT_INCOMPATIBLE']) })] }),
    });
    // Détection seule : aucune écriture (sources, historique), aucune réparation.
    expect(await sources()).toEqual(s0);
    expect(await k.historique(c)).toBe(h);
    expect(await reparations(c.id, 'COH-OPS-IDENTITY')).toEqual([]);
    // Le réexamen 78A existant (consolidation T3) sépare ; le contrôle suivant constate la cohérence.
    await k.passer(c);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-OPS-IDENTITY', op.id)).toMatchObject({ last_result: 'CONSISTENT', finding: null });
    void fTika;
  });

  // ══ L83B-E2E-08 ════════════════════════════════════════════════════════════

  it('L83B-E2E-08 — document d’équipement laissé au seul bien (association suggérée par l’Opération seulement) : constat P19, jamais de lien ; lien de l’utilisateur → cohérent', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const alarme = await k.equipement(maison, 'Alarme', 'ALARM');
    const facture = await k.document(c, maison.id, [cand({ typeHint: 'CONTRACT', summary: 'Abonnement télésurveillance', provider: 'Homiris', targetHints: [cible(maison.id)] })], { title: 'Facture Homiris' });
    await k.passer(c);
    const [op] = await k.actives(c);
    const { attachEquipment, withGroupingWrite } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c.id, (g) => attachEquipment(g, { operationId: op.id, equipmentId: alarme, origin: 'USER', reasonCode: 'E2E' }));
    const liens = () => sql`SELECT equipment_id FROM document_asset_links WHERE file_id = ${facture} AND status = 'ACTIVE' AND equipment_id IS NOT NULL`;
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-DOC-LINKS', facture)).toMatchObject({
      last_result: 'FINDING', rules_version: 2,
      finding: expect.objectContaining({ anomaly: 'EQUIPMENT_ASSOCIATION_UNPROVEN', observed: { operationIds: [op.id], equipmentIds: [alarme] },
        detail: expect.objectContaining({ pendingContract: '82D-t3-document-equipement' }) }),
    });
    expect(await liens()).toEqual([]);
    expect(await reparations(c.id, 'COH-DOC-LINKS')).toEqual([]);
    // L'utilisateur relie lui-même la facture à l'alarme : plus d'écart.
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, confidence, status)
              VALUES (${c.id}, ${facture}, ${maison.id}, ${alarme}, 'SECONDARY', 'USER', 1, 'ACTIVE')`;
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-DOC-LINKS', facture)).toMatchObject({ last_result: 'CONSISTENT', finding: null });
  });

  // ══ L83B-E2E-09 ════════════════════════════════════════════════════════════

  it('L83B-E2E-09 — donnée d’équipement recopiée du bien (même preuve de l’acte) : provenance démontrée → réparée par le rattrapage existant, tracée ; puis cohérent', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { acquisitionDate: '2019-06-14', acquisitionDate__origin: 'RECONCILIATION' } });
    const [{ id: chaudiere }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics) VALUES (${maison.id}, 'Chaudière', ${JSON.stringify({ acquisitionDate: '2019-06-14', acquisitionDate__origin: 'RECONCILIATION' })}::jsonb) RETURNING id`;
    const acte = (await make.assetFile(c, { assetId: maison.id })).id;
    const { recordEvidence } = await import('@/services/ai/evidence/field-evidence.service');
    const preuveActe = (equipmentId?: number) => recordEvidence({
      accountId: c.id, assetId: maison.id, fieldKey: 'acquisitionDate', value: '2019-06-14', normalizedValue: '2019-06-14', sourceType: 'document', sourceId: acte,
      location: {}, excerpt: 'Signé le 14/06/2019', confidence: 'certain', authorityScore: 60, documentType: 'ACTE_NOTARIE', canonicalKey: 'acquisitionDate',
      projectionOrigin: 'MODEL_CANONICAL', projectionRule: null,
      target: equipmentId ? { type: 'EQUIPMENT', entityId: equipmentId, label: null, confidence: 'certain' } : { type: 'ASSET', entityId: maison.id, label: null, confidence: 'certain' },
    });
    await preuveActe();
    await preuveActe(chaudiere);
    const actives = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE account_id = ${c.id} AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE'`)[0].n;
    const n0 = await actives();
    await campagne([c.id], 'DRY_RUN');
    expect(await preuve(c.id, 'COH-ASSET-EQUIPMENT-SEPARATION', maison.id)).toMatchObject({
      last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'DATA_ATTRIBUTED_TO_WRONG_ENTITY', observed: [expect.objectContaining({ kind: 'EQUIPMENT_EVIDENCE_WITHDRAWN', equipmentId: chaudiere })] }),
    });
    expect(await actives()).toBe(n0);
    expect(await sql`SELECT id FROM data_separation_corrections WHERE account_id = ${c.id}`).toEqual([]);
    await campagne([c.id], 'CORRECTIVE');
    expect(await actives()).toBe(n0 - 1);
    const corrections = await sql<Json[]>`SELECT kind, subject_type, run_id::text AS run_id, reason FROM data_separation_corrections WHERE account_id = ${c.id}`;
    expect(corrections).toEqual([expect.objectContaining({ kind: 'EQUIPMENT_EVIDENCE_WITHDRAWN', subject_type: 'FIELD_EVIDENCE' })]);
    expect(String(corrections[0].reason)).toMatch(/^contrôle de cohérence/);
    expect(await preuve(c.id, 'COH-ASSET-EQUIPMENT-SEPARATION', maison.id)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await reparations(c.id, 'COH-ASSET-EQUIPMENT-SEPARATION')).toEqual([expect.objectContaining({
      service: 'runDataSeparationBackfill', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', rollback_ref: `data_separation_corrections:run_id=${corrections[0].run_id}`,
    })]);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-ASSET-EQUIPMENT-SEPARATION', maison.id)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await reparations(c.id, 'COH-ASSET-EQUIPMENT-SEPARATION')).toHaveLength(1);
  });

  // ══ L83B-E2E-11 ════════════════════════════════════════════════════════════

  it('L83B-E2E-11 — budget des relances IA (C-Q1) épuisé : même diagnostic en constat, aucun appel ; budget rétabli → relance unique', async () => {
    const c = await make.account();
    const f = await factureMontantOublie(c);
    const avant = process.env.COHERENCE_T1_RELAUNCH_DAILY_MAX;
    process.env.COHERENCE_T1_RELAUNCH_DAILY_MAX = '0';
    try {
      await rejouer([]);
      await campagne([c.id], 'CORRECTIVE');
      expect(appelsIA()).toBe(0);
      expect(await preuve(c.id, CHECK, f)).toMatchObject({
        last_result: 'FINDING', last_repair_hash: null,
        finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_BY_T1', detail: expect.objectContaining({ relaunchBudgetReached: true }) }),
      });
      expect(await reparations(c.id, CHECK)).toEqual([]);
    } finally {
      if (avant === undefined) delete process.env.COHERENCE_T1_RELAUNCH_DAILY_MAX; else process.env.COHERENCE_T1_RELAUNCH_DAILY_MAX = avant;
    }
    await rejouer([REPARATION(sortie({ facts: [fait('Montant TTC : 1 234,00 €', '1234.00')] }), '[page:1:field:2]')]);
    await campagne([c.id], 'CORRECTIVE');
    expect(appelsT1()).toBe(1);
    expect(await preuve(c.id, CHECK, f)).toMatchObject({ last_result: 'REPAIRED' });
  });

  // ══ L83B-E2E-10 ════════════════════════════════════════════════════════════

  it('L83B-E2E-10 — déclencheur : une écriture d’Opération (bus des Opérations, après commit) demande DURABLEMENT le contrôle ciblé O-1 et 78A', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const f = (await make.assetFile(c, { assetId: maison.id })).id;
    const { registerCoherenceTriggers, __resetCoherenceTriggersForTests } = await import('@/services/coherence/events');
    await registerCoherenceTriggers();
    try {
      const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
      const op = (await withBusinessOperationWrite(c.id, (repo) => repo.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2026-03-12', technicalLabel: 'Ramonage',
        source: { kind: 'DOCUMENT', entityKey: f, authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
      }))).id;
      const demande = async (check: string, id: number) => (await sql<{ r: string | null }[]>`
        SELECT request_reason AS r FROM coherence_object_proofs WHERE account_id = ${c.id} AND check_id = ${check} AND object_id = ${id} AND requested_at IS NOT NULL`)[0]?.r ?? null;
      let r: string | null = null;
      for (let i = 0; i < 50 && !(r = await demande('COH-OPS-IDENTITY', op)); i++) await new Promise((x) => setTimeout(x, 50));
      expect(r).toBe(`BUSINESS_OPERATION_CHANGED:${op}`);
      expect(await demande('COH-O1-PRINCIPAL-UNIQUE', c.id)).toBe(`BUSINESS_OPERATION_CHANGED:${op}`);
    } finally {
      __resetCoherenceTriggersForTests();
      (await import('@/services/ai/source-analysis/events')).clearSourceAnalyzedHandlers();
    }
  });

  afterAll(() => { vi.restoreAllMocks(); });
});
