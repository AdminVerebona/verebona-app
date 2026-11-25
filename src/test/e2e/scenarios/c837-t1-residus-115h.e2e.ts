/**
 * Carte Trello #837 — T1, RÉSIDUS DU LOT 115H (#785) : reprises exactes,
 * transactions, rattrapage, preuves et bilan — PostgreSQL RÉEL.
 *
 *   C837-E01  A3 / R3 : cinq clics simultanés + BO + planificateur + deux
 *             exécutants sur la MÊME demande canonique : un seul travail, une
 *             seule consommation, une seule ligne de demande ;
 *   C837-E02  A2 / R4 : travail TERMINÉ entre l'enfilement et l'inspection
 *             (déclencheur PostgreSQL) — jamais « en file » ; DONE métier KO
 *             → nouvelle tentative explicite ; DONE métier OK → acquis ;
 *   C837-E03  B1 / R5 : panne simulée ENTRE le passage à RECOVERED et la
 *             restitution — tout est annulé, rien n'est perdu ; reprise :
 *             restitution UNIQUE ; deux récupérateurs concurrents ;
 *   C837-E04  B3 / R6 : deux campagnes du MÊME processus (même libellé de
 *             titulaire) sur le même document ; bail d'une autre instance
 *             vivant puis expiré ;
 *   C837-E05  C1 / C2 / R8 : preuve modifiée (ancrage) SANS réécriture de la
 *             couverture ni changement de compteurs — rattrapée par le
 *             balayage des empreintes ; empreinte identique : aucun rejeu ;
 *   C837-E06  A1 / A4 / R2 : admission commune (compte non éligible, fichier
 *             supprimé, document complet) sans travail ni consommation ;
 *             refus planifié définitif → échéance retirée, BO cohérent ;
 *   C837-E07  D1 / D2 / R12 : campagne → demande → travail → appels, DONE
 *             métier KO ≠ réparation accomplie, appel non rattaché exclu ;
 *   C837-E08  D3 / R11 : plus de 5 000 documents classés exhaustivement ;
 *             lecture tronquée (budget) déclarée INCOMPLETE avec progression.
 *
 * Aucun appel à un fournisseur d'IA.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import type { CoveredSourceUnit, SourceLayer } from '@/services/ai/source-analysis/source-units/types';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const TEXTES = ['Référence dossier : AB-2291', 'Montant restant dû : 132,00 €', 'Échéance du 14/02/2026'];
const unite = (n: number, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
  sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text: TEXTES[n - 1], payload: {}, location: {},
  origin: 'PASS_1', salient: true, status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, ...over,
});
const illisible = { status: 'PARTIAL' as const, reason: 'source_unreadable', pagesExpected: 3, verified: [], missing: [], unverified: [1, 2, 3], scanned: [] };
const pagesManquantes = { status: 'PARTIAL' as const, reason: 'pages_missing', pagesExpected: 3, verified: [1, 2], missing: [3], unverified: [], scanned: [] };
const ENV = { T1_COMPLETENESS_MAX_RETRIES: '2' };

scenario('C837', 'T1 — résidus 115H : reprises exactes, transactions, rattrapage, preuves et bilan (#837)', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1'] });

  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const ecrire = async (compte: AccountRow, fileId: number, units: CoveredSourceUnit[], verification: unknown) => {
    const { buildCompletenessReport } = await import('@/services/ai/source-analysis/source-units/coverage');
    const { withResidualPolicies } = await import('@/services/ai/source-analysis/source-units/coverage-reconciliation');
    const { writeSourceLayer } = await import('@/services/ai/source-analysis/source-units/repository');
    const { SOURCE_LAYER_VERSION } = await import('@/services/ai/source-analysis/source-units/types');
    const u = withResidualPolicies(units);
    const layer: SourceLayer = {
      layerVersion: SOURCE_LAYER_VERSION, units: u, unresolvedFacts: [], retryable: true,
      report: buildCompletenessReport(u, {
        factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 1, chunkCount: 0,
        warningCodes: [], retryAllowed: true, verification: verification as never,
      }),
    };
    await sql.begin(async (tx) => { await writeSourceLayer(tx as never, { accountId: compte.id, fileId, extractionId: null, layer }); });
  };
  const preparer = async (compte: AccountRow, verification: unknown = illisible) => {
    const f = await fichier(compte);
    await ecrire(compte, f, [unite(1), unite(2)], verification);
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 0, next_retry_at = NULL WHERE file_id = ${f}`;
    return f;
  };
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT retry_attempts AS attempts, next_retry_at AS next, quality_state AS quality, last_retry_result AS result,
           updated_at, verification, unresolved_units, uncertain_units, failed_units
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const travaux = (fileId: number) => sql<Json[]>`
    SELECT id, status, business_result, coalesce_requested AS coalesce, payload, started_at
      FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)} ORDER BY id`;
  const demandes = (fileId: number) => sql<Json[]>`
    SELECT id, request_key, state, reserved_attempt, attempt_consumed, job_id, steps, cycles, history, campaign_ref, origin, requested_by
      FROM t1_requeue_requests WHERE file_id = ${fileId} ORDER BY id`;
  const demander = async (fileId: number, compte: AccountRow, over: Record<string, unknown> = {}) => {
    const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
    return jobs.requeueDocumentForRereadDetailed({
      fileId, accountId: compte.id, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1', env: ENV, ...over,
    });
  };

  it('C837-E01 — A3 : 5 clics simultanés + BO + planificateur + deux exécutants : UN travail, UNE consommation, UNE demande', async () => {
    const c = await make.account();
    const f = await preparer(c);
    const issues = await Promise.all([
      ...Array.from({ length: 5 }, () => demander(f, c, { requestedBy: 'BO' })),
      demander(f, c, { requestedBy: 'SCHEDULER', scheduled: true }),
      demander(f, c, { requestedBy: 'REVERIFICATION', origin: 't1-coverage-reverify' }),
      demander(f, c, { requestedBy: 'SCHEDULER', scheduled: true }),
    ]);
    // Exactement UNE demande a réservé et consommé ; toutes les autres ont CONSTATÉ le travail vivant.
    expect(issues.filter((r) => r.attemptConsumed)).toHaveLength(1);
    expect(issues.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    for (const r of issues) {
      expect(r.queued, r.status).toBe(true);
      expect(['ACCEPTED', 'IDENTICAL_REQUEST_ALIVE']).toContain(r.status);
    }
    const jobs = await travaux(f);
    expect(jobs.filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(jobs.every((j) => j.coalesce === false)).toBe(true);
    expect(Number((await couverture(f)).attempts)).toBe(1);
    // UNE demande canonique ; le canal est conservé comme provenance.
    const d = await demandes(f);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ attempt_consumed: true, cycles: 1 });
    expect(String(d[0].request_key)).toMatch(/^COMPLETENESS_REREAD:[0-9a-f]{32}$/);
    expect(['BO', 'SCHEDULER', 'REVERIFICATION']).toContain(String(d[0].requested_by));
    expect(d[0].steps).toMatchObject({ reserved: true, enqueued: true, inspected: true, counted: true, diagnosed: true });
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E02 — A2 : DONE entre enfilement et inspection, DONE métier KO, DONE métier OK', async () => {
    const c = await make.account();
    const f = await preparer(c);
    // (a) Le travail créé est TERMINÉ (échec métier) avant même l'inspection : déclencheur PostgreSQL sur l'insertion.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION c837_termine() RETURNS trigger AS $$
      BEGIN
        IF NEW.treatment = 'T1' AND NEW.target_id = '${f}' THEN
          NEW.status := 'DONE'; NEW.business_result := 'FAILED'; NEW.started_at := NOW(); NEW.finished_at := NOW();
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER c837_termine BEFORE INSERT ON ai_job_queue FOR EACH ROW EXECUTE FUNCTION c837_termine()`);
    let a: Awaited<ReturnType<typeof demander>>;
    try {
      a = await demander(f, c, { requestedBy: 'BO' });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS c837_termine ON ai_job_queue`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS c837_termine()`);
    }
    // Jamais « en file » ; la tentative a bien eu lieu (consommée) ; l'issue MÉTIER est dite.
    expect(a).toMatchObject({ status: 'COMPLETED', queued: false, attemptConsumed: true, businessResult: 'FAILED', result: 'REQUEUE_COMPLETED_BUSINESS_FAILED' });
    expect(await couverture(f)).toMatchObject({ result: 'REQUEUE_COMPLETED_BUSINESS_FAILED' });
    expect(Number((await couverture(f)).attempts)).toBe(1);

    // (b) Même demande (preuves inchangées), travail DONE métier KO : jamais « acquis » — nouvelle tentative, dans ses bornes.
    const b = await demander(f, c, { requestedBy: 'SCHEDULER', scheduled: true });
    expect(b).toMatchObject({ status: 'ACCEPTED', queued: true, attemptConsumed: true });
    expect(Number((await couverture(f)).attempts)).toBe(2);
    const d = await demandes(f);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ cycles: 2, state: 'CONFIRMED' });
    expect((d[0].history as Json[])).toHaveLength(1);
    // Le cycle précédent (travail créé, terminé en échec métier, tentative consommée) est CONSERVÉ dans l'historique.
    expect((d[0].history as Json[])[0]).toMatchObject({ state: 'CONFIRMED', attemptConsumed: true });

    // (c) Le travail se termine en SUCCÈS métier : la même demande est ACQUISE — rien n'est rejoué ni consommé.
    const [vivant] = (await travaux(f)).filter((j) => j.status === 'PENDING');
    await sql`UPDATE ai_job_queue SET status = 'DONE', business_result = 'APPLIED', started_at = NOW(), finished_at = NOW() WHERE id = ${vivant.id}`;
    const e = await demander(f, c, { requestedBy: 'BO' });
    expect(e).toMatchObject({ status: 'ALREADY_SATISFIED', queued: false, attemptConsumed: false, businessResult: 'APPLIED' });
    expect(Number((await couverture(f)).attempts)).toBe(2);
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E03 — B1 : panne ENTRE « RECOVERED » et la restitution ; reprise unique ; deux récupérateurs', async () => {
    const { recoverRequeueReservations } = await import('@/services/ai/source-analysis/source-units/requeue-identity');
    const c = await make.account();
    const f = await preparer(c);
    const orpheline = async (fileId: number, cle: string) => {
      await sql`UPDATE document_extraction_coverage SET retry_attempts = 1 WHERE file_id = ${fileId}`;
      await sql`
        INSERT INTO t1_requeue_requests (account_id, file_id, request_key, origin, requested_by, state, reserved_attempt, steps, lease_token, lease_expires_at)
        VALUES (${c.id}, ${fileId}, ${cle}, 't1-completeness-retry', 'BO', 'RESERVED', 1, '{"reserved":true}'::jsonb, gen_random_uuid(), NOW() - interval '1 minute')`;
    };
    await orpheline(f, 'panne:entre-deux');
    // Panne simulée APRÈS le passage à RECOVERED, AVANT la restitution : la transaction est annulée en entier.
    const panne = await recoverRequeueReservations({ accountId: c.id, beforeRestitution: () => { throw new Error('SIGKILL simulé'); } });
    expect(panne).toMatchObject({ examined: 1, released: 0, restituted: 0, errors: 1 });
    expect((await demandes(f))[0]).toMatchObject({ state: 'RESERVED' });
    expect(Number((await couverture(f)).attempts)).toBe(1);
    // Reprise : état ET restitution écrits ensemble, une seule fois.
    const reprise = await recoverRequeueReservations({ accountId: c.id });
    expect(reprise).toMatchObject({ examined: 1, released: 1, restituted: 1, errors: 0 });
    expect((await demandes(f))[0]).toMatchObject({ state: 'RECOVERED', attempt_consumed: false });
    expect((await demandes(f))[0].steps).toMatchObject({ recovered: true, restituted: true });
    expect(Number((await couverture(f)).attempts)).toBe(0);
    expect(await recoverRequeueReservations({ accountId: c.id })).toMatchObject({ examined: 0, released: 0 });
    expect(Number((await couverture(f)).attempts)).toBe(0);

    // Deux récupérateurs CONCURRENTS sur une autre réservation orpheline : une seule restitution.
    const g = await preparer(c);
    await orpheline(g, 'panne:concurrence');
    const [x, y] = await Promise.all([recoverRequeueReservations({ accountId: c.id }), recoverRequeueReservations({ accountId: c.id })]);
    expect(x.restituted + y.restituted).toBe(1);
    expect(Number((await couverture(g)).attempts)).toBe(0);

    // Réservation dont le bail est VIVANT : jamais récupérée (l'exécutant est encore là).
    const h = await preparer(c);
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 1 WHERE file_id = ${h}`;
    await sql`
      INSERT INTO t1_requeue_requests (account_id, file_id, request_key, origin, requested_by, state, reserved_attempt, steps, lease_token, lease_expires_at)
      VALUES (${c.id}, ${h}, 'en-cours', 't1-completeness-retry', 'BO', 'RESERVED', 1, '{"reserved":true}'::jsonb, gen_random_uuid(), NOW() + interval '5 minutes')`;
    expect(await recoverRequeueReservations({ accountId: c.id })).toMatchObject({ examined: 0 });
    expect(Number((await couverture(h)).attempts)).toBe(1);
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E04 — B3 : deux campagnes du MÊME processus ; bail d’une autre instance vivant puis expiré', async () => {
    const { reassessDocumentCoverage, T1_COVERAGE_RULES_VERSION } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    const c = await make.account();
    const f = await preparer(c, pagesManquantes);
    // Même libellé de titulaire (ancien défaut : `t1-reassessment:<pid>` partagé) — les jetons, eux, sont uniques.
    const [a, b] = await Promise.all([
      reassessDocumentCoverage({ accountId: c.id, fileId: f, owner: 'meme-processus' }),
      reassessDocumentCoverage({ accountId: c.id, fileId: f, owner: 'meme-processus' }),
    ]);
    const issues = [a.outcome, b.outcome];
    // Jamais deux succès : l'une est différée (bail tenu) — ou, si la première avait déjà fini, constate la même empreinte.
    expect(issues.filter((o) => o === 'DEFERRED').length + [a, b].filter((r) => r.detail.skipped === 'SAME_EVIDENCE').length).toBe(1);
    const [ligne] = await sql<Json[]>`SELECT outcome, lease_owner, lease_expires_at, steps FROM t1_coverage_reassessments WHERE file_id = ${f} AND rules_version = ${T1_COVERAGE_RULES_VERSION}`;
    expect(ligne.lease_owner).toBeNull();
    expect(ligne.steps).toMatchObject({ reverified: true, reconciled: true, alerted: true });

    // Une AUTRE instance tient le document (bail vivant) : différé, AUCUNE écriture.
    const g = await preparer(c, pagesManquantes);
    await sql`
      INSERT INTO t1_coverage_reassessments (account_id, file_id, rules_version, outcome, state_before, state_after, lease_owner, lease_expires_at)
      VALUES (${c.id}, ${g}, ${T1_COVERAGE_RULES_VERSION}, 'UNCONFIRMED', '{}'::jsonb, '{}'::jsonb, 'autre-instance#x', NOW() + interval '5 minutes')`;
    const avant = await couverture(g);
    const tenu = await reassessDocumentCoverage({ accountId: c.id, fileId: g });
    expect(tenu).toMatchObject({ outcome: 'DEFERRED', deferredCause: 'LEASE_HELD' });
    expect(String((await couverture(g)).updated_at)).toBe(String(avant.updated_at));
    // Bail EXPIRÉ : repris, traité, journalisé ; l'ancien titulaire ne peut plus écrire (jeton différent).
    await sql`UPDATE t1_coverage_reassessments SET lease_expires_at = NOW() - interval '1 minute' WHERE file_id = ${g}`;
    const repris = await reassessDocumentCoverage({ accountId: c.id, fileId: g });
    expect(repris.outcome).not.toBe('DEFERRED');
    const ecrit = await sql<Json[]>`
      UPDATE t1_coverage_reassessments SET outcome = 'RESOLVED'
       WHERE file_id = ${g} AND lease_owner = 'autre-instance#x' AND lease_expires_at > NOW() RETURNING file_id`;
    expect(ecrit).toHaveLength(0);
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E05 — C1/C2 : preuve modifiée sans réécriture de couverture ni changement de compteurs → rattrapée ; identique → pas de rejeu', async () => {
    const { runCoverageReassessment, T1_COVERAGE_RULES_VERSION } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    const c = await make.account();
    const f = await preparer(c, pagesManquantes);
    await runCoverageReassessment({ accountId: c.id });
    const journal = async () => (await sql<Json[]>`
      SELECT outcome, evidence_fingerprint AS empreinte, updated_at FROM t1_coverage_reassessments WHERE file_id = ${f} AND rules_version = ${T1_COVERAGE_RULES_VERSION}`)[0];
    const j1 = await journal();
    expect(j1.empreinte).toMatch(/^[0-9a-f]{32}$/);
    // Passage suivant, rien de nouveau : le balayage CONTRÔLE l'empreinte, ne rejoue rien, n'écrit rien.
    const p2 = await runCoverageReassessment({ accountId: c.id });
    expect(p2.evidenceChanged).toBe(0);
    expect(p2.unchangedEvidence).toBeGreaterThanOrEqual(1);
    expect(String((await journal()).updated_at)).toBe(String(j1.updated_at));

    // Preuve modifiée dans une AUTRE table (ancrage : libellé d'une unité), couverture NON réécrite, compteurs égaux.
    const cov = await couverture(f);
    await sql`UPDATE document_source_units SET label = 'libellé corrigé' WHERE file_id = ${f} AND source_unit_id = 'page:1:block:1'`;
    const covApres = await couverture(f);
    expect(String(covApres.updated_at)).toBe(String(cov.updated_at));
    expect([covApres.unresolved_units, covApres.uncertain_units, covApres.failed_units]).toEqual([cov.unresolved_units, cov.uncertain_units, cov.failed_units]);
    const p3 = await runCoverageReassessment({ accountId: c.id });
    // Rattrapée à version constante, sans redémarrage ni BO.
    expect(p3.evidenceChanged).toBe(1);
    const j3 = await journal();
    expect(j3.empreinte).not.toBe(j1.empreinte);
    // Et plus jamais rejouée tant que rien ne change.
    const p4 = await runCoverageReassessment({ accountId: c.id });
    expect(p4.evidenceChanged).toBe(0);
    expect((await journal()).empreinte).toBe(j3.empreinte);
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E06 — A1/A4 : admission commune sans travail ni consommation ; refus planifié définitif → échéance retirée', async () => {
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const c = await make.account();
    // Fichier SUPPRIMÉ : source non relisible.
    const supprime = await preparer(c);
    await sql`UPDATE asset_files SET deleted_at = NOW() WHERE id = ${supprime}`;
    expect(await demander(supprime, c, { requestedBy: 'BO' })).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'SOURCE_NOT_AVAILABLE', attemptConsumed: false });
    expect(await travaux(supprime)).toEqual([]);
    // Compte NON ÉLIGIBLE : refus temporaire, demande planifiée laissée due, aucun travail.
    const inactif = await make.account();
    const h = await preparer(inactif);
    await sql`UPDATE accounts SET is_active = false WHERE id = ${inactif.id}`;
    expect(await demander(h, inactif, { requestedBy: 'SCHEDULER', scheduled: true })).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'ACCOUNT_NOT_ELIGIBLE' });
    expect(await travaux(h)).toEqual([]);
    expect((await couverture(h)).next).not.toBeNull();
    expect(Number((await couverture(h)).attempts)).toBe(0);

    // Plafond ATTEINT, échéance historique encore posée : refus planifié DÉFINITIF → échéance retirée (plus de boucle).
    const f = await preparer(c);
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 2, next_retry_at = NOW() + interval '30 minutes' WHERE file_id = ${f}`;
    expect(await demander(f, c, { requestedBy: 'SCHEDULER', scheduled: true, attempt: 3 })).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRY_CAP_REACHED' });
    const cf = await couverture(f);
    expect(cf.next).toBeNull();
    expect(cf.verification.requeue).toMatchObject({ status: 'NOT_ADMISSIBLE', temporary: false });
    expect(cf.verification.requeue.previousNextRetryAt).not.toBeNull();
    // Demande MANUELLE refusée au plafond : l'échéance n'est pas touchée, mais le BO ne la présente PAS comme programmée.
    const g = await preparer(c);
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 2, next_retry_at = NOW() + interval '3 days' WHERE file_id = ${g}`;
    expect(await demander(g, c, { requestedBy: 'BO', attempt: 3 })).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRY_CAP_REACHED' });
    expect((await couverture(g)).next).not.toBeNull();
    const vue = await getT1CompletenessOverview({ days: 1, limit: 200 });
    const ligne = vue.rows.find((r) => Number(r.fileId) === g);
    expect(ligne?.issue?.issue).not.toBe('REPAIR_SCHEDULED');
    expect(ligne?.current?.retryScheduled).toBe(false);
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E07 — D1/D2 : campagne → demande → travail → appels ; DONE métier KO ≠ réparation accomplie ; appel non rattaché exclu', async () => {
    const { runCoverageReassessment, getCoverageReassessmentReport, T1_COVERAGE_RULES_VERSION } =
      await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    const { campaignRefOf } = await import('@/services/ai/source-analysis/source-units/jobs');
    const avant = await getCoverageReassessmentReport(T1_COVERAGE_RULES_VERSION);
    const c = await make.account();
    // Lacune réparable SANS échéance : la campagne la PROGRAMME et y attache sa référence.
    const ko = await preparer(c, pagesManquantes);
    const ok = await preparer(c, pagesManquantes);
    await runCoverageReassessment({ accountId: c.id });
    const campagne = campaignRefOf((await couverture(ko)).verification);
    expect(campagne).toBe(`t1-coverage-reassessment:v${T1_COVERAGE_RULES_VERSION}`);
    // La suite exécutée porte la référence (corrélation EXPLICITE, jamais par la date).
    const rko = await demander(ko, c, { requestedBy: 'SCHEDULER', scheduled: true, campaignRef: campaignRefOf((await couverture(ko)).verification) });
    const rok = await demander(ok, c, { requestedBy: 'SCHEDULER', scheduled: true, campaignRef: campaignRefOf((await couverture(ok)).verification) });
    expect([rko.status, rok.status]).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect((await demandes(ko))[0]).toMatchObject({ campaign_ref: campagne });
    // Travaux TERMINÉS : l'un en ÉCHEC métier, l'autre APPLIQUÉ ; un appel de l'exécution dans la fenêtre du travail.
    const [jko] = await travaux(ko);
    const [jok] = await travaux(ok);
    await sql`UPDATE ai_job_queue SET status = 'DONE', business_result = 'FAILED', started_at = NOW() - interval '1 minute', finished_at = NOW() + interval '1 minute' WHERE id = ${jko.id}`;
    await sql`UPDATE ai_job_queue SET status = 'DONE', business_result = 'APPLIED', started_at = NOW() - interval '1 minute', finished_at = NOW() + interval '1 minute' WHERE id = ${jok.id}`;
    // Exécution métier du travail : celle qu'il porte, sinon `T1:job:<id>` (même règle que `executionIdOfJob`).
    const execKo = String((jko.payload as Json | null)?.businessExecution?.id ?? `T1:job:${jko.id}`);
    await sql`
      INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, cost_micros, status, environment, business_execution_id)
      VALUES (${c.id}, ${ko}, 't1_analyze_document', 'test', 'test', 700, 'success', 'test', ${execKo}),
             (${c.id}, ${ko}, 't1_analyze_document', 'test', 'test', NULL, 'success', 'test', ${execKo})`;
    // Appel SANS rattachement (autre traitement du document) : jamais imputé à la campagne.
    await sql`
      INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, cost_micros, status, environment)
      VALUES (${c.id}, ${ko}, 't6_chat', 'test', 'test', 99999, 'success', 'test')`;

    const bilan = await getCoverageReassessmentReport(T1_COVERAGE_RULES_VERSION);
    expect(bilan.followUps.correlation).toBe('EXPLICIT');
    expect(bilan.followUps.requests - avant.followUps.requests).toBe(2);
    expect(bilan.followUps.uncorrelatedDocumentCalls - avant.followUps.uncorrelatedDocumentCalls).toBeGreaterThanOrEqual(1);
    expect(bilan.followUps.calls - avant.followUps.calls).toBe(2);
    expect(bilan.followUps.callsByKind.FULL_ANALYSIS).toBeGreaterThanOrEqual(2);
    expect(bilan.followUps.costMicros - avant.followUps.costMicros).toBe(700);
    // Coût non rendu : compté INCONNU, jamais 0.
    expect(bilan.followUps.callsWithUnknownCost - avant.followUps.callsWithUnknownCost).toBe(1);
    // Le coût de l'appel non rattaché n'apparaît nulle part dans les totaux de la campagne.
    expect(bilan.followUps.costMicros - avant.followUps.costMicros).toBeLessThan(99999);
    // DONE métier KO ≠ réparation accomplie ; DONE APPLIED = succès métier prouvé.
    expect(bilan.repairsCompleted - avant.repairsCompleted).toBe(1);
    expect(bilan.repairs.businessFailed - avant.repairs.businessFailed).toBe(1);
    expect(bilan.repairs.executed - avant.repairs.executed).toBe(2);
    expect(bilan.aiCalls).toBe(0);
    expect(replay.calls).toHaveLength(0);
  });

  it('C837-E08 — D3 : plus de 5 000 documents classés exhaustivement ; lecture tronquée déclarée INCOMPLETE', async () => {
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const c = await make.account();
    const [u] = await sql<Json[]>`SELECT owner_user_id AS uid FROM accounts WHERE id = ${c.id}`;
    // 5 200 documents d'un compte (+ ceux des scénarios précédents) : plus que l'ancien plafond silencieux.
    await sql`
      WITH f AS (
        INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type)
        SELECT ${u.uid}, ${c.id}, NULL, 'e2e/c837/' || g, 'application/pdf' FROM generate_series(1, 5200) g
        RETURNING id
      )
      INSERT INTO document_extraction_coverage (file_id, account_id, quality_state, anomalies, retry_attempts, next_retry_at)
      SELECT id, ${c.id}, CASE WHEN id % 3 = 0 THEN 'COMPLETE' WHEN id % 3 = 1 THEN 'INCOMPLETE_FINAL' ELSE 'COMPLETE_WITH_UNRESOLVED' END,
             '{}'::text[], 0, NULL FROM f`;
    const [{ n }] = await sql<Json[]>`SELECT COUNT(*)::int AS n FROM document_extraction_coverage WHERE updated_at >= NOW() - interval '1 day'`;
    expect(n).toBeGreaterThan(5000);
    const complet = await getT1CompletenessOverview({ days: 1, issueScan: { pageSize: 700 } });
    expect(complet.byIssueStatus).toBe('COMPLETE');
    expect(complet.byIssueTruncated).toBe(false);
    expect(complet.byIssueScanned).toBe(n);
    expect(complet.byIssueExpected).toBe(n);
    expect(Object.values(complet.byIssue ?? {}).reduce((a, b) => a + b, 0)).toBe(n);
    // Lecture interrompue par le budget : jamais « exhaustif » — cause, progression et curseur de reprise.
    const tronque = await getT1CompletenessOverview({ days: 1, issueScan: { pageSize: 50, budgetMs: 1 } });
    expect(tronque.byIssueStatus).toBe('INCOMPLETE');
    expect(tronque.byIssueTruncated).toBe(true);
    expect(tronque.byIssueIncomplete).toMatchObject({ cause: 'TIME_BUDGET', expected: n });
    expect(tronque.byIssueIncomplete!.scanned).toBeLessThan(n);
    // Reprise au curseur : le reste est classé, et la somme des deux lectures fait le total.
    const suite = await getT1CompletenessOverview({ days: 1, issueScan: { pageSize: 1000, cursor: tronque.byIssueIncomplete!.cursor } });
    expect(suite.byIssueStatus).toBe('COMPLETE');
    expect(tronque.byIssueIncomplete!.scanned + (suite.byIssueScanned ?? 0)).toBe(n);
    expect(replay.calls).toHaveLength(0);
  });
});
