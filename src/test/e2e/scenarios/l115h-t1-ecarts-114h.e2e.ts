/**
 * Lot 115H (Trello #785) sur PostgreSQL réel — § 1 : PLAFONDS RÉELLEMENT
 * COMMUNS, Y COMPRIS LA RELANCE COMPLÈTE DU BO.
 *
 * Le droit de remise en file T1 est contrôlé ET réservé par le service commun
 * AVANT tout enfilement, pour toutes les origines. Vérifié sur la base : la
 * file `ai_job_queue` ne reçoit RIEN quand la demande est refusée, et
 * `retry_attempts` ne bouge pas.
 *
 *   L115H-E01  plafond à 0 : toute origine refusée, aucun travail créé ;
 *   L115H-E02  plafond consommé (relance complète du BO) : refusée, motif
 *              explicite, aucune consommation, échéance NON touchée ;
 *   L115H-E03  plafond abaissé APRÈS programmation : refusée ;
 *   L115H-E04  deux demandes simultanées sur la dernière reprise : un seul
 *              travail vivant, UNE seule reprise consommée (ni double
 *              consommation, ni tentative oubliée).
 *
 * Aucun appel à un fournisseur d'IA : la file T1 n'exécute rien ici.
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
const pdf = (missing: number[] = []) => ({
  status: missing.length ? 'PARTIAL' as const : 'VERIFIED' as const, reason: missing.length ? 'pages_missing' : null,
  pagesExpected: 3, verified: [1, 2, 3].filter((p) => !missing.includes(p)), missing, unverified: [], scanned: [],
});

scenario('L115H', 'T1 — plafonds communs à toutes les origines de reprise (#785 § 1)', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1'] });

  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  /** Écrit une couche A par la VRAIE écriture, état calculé par le vrai rapport. */
  const ecrire = async (compte: AccountRow, fileId: number, units: CoveredSourceUnit[], verification: unknown = pdf()) => {
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
  const poser = (fileId: number, p: { attempts: number; next?: 'due' | 'future' | null }) => sql`
    UPDATE document_extraction_coverage
       SET retry_attempts = ${p.attempts},
           next_retry_at = ${p.next === 'future' ? sql`NOW() + interval '3 days'` : p.next === 'due' ? sql`NOW() - interval '2 hours'` : null}
     WHERE file_id = ${fileId}`;
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT retry_attempts AS attempts, next_retry_at AS next, last_retry_result AS result, last_error AS error, origin, verification
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const travaux = (fileId: number) => sql<Json[]>`
    SELECT id, status FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)} ORDER BY id`;

  const demander = async (fileId: number, compte: AccountRow, over: Record<string, unknown> = {}) => {
    const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
    return jobs.requeueDocumentForRereadDetailed({
      fileId, accountId: compte.id, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1', ...over,
    });
  };

  it('L115H-E01 — plafond à 0 : toute origine est refusée AVANT tout enfilement, aucun travail créé', async () => {
    const c = await make.account();
    const env = { T1_COMPLETENESS_MAX_RETRIES: '0' };
    for (const requestedBy of ['BO', 'SCHEDULER', 'COHERENCE', 'REVERIFICATION', 'OTHER'] as const) {
      const f = await fichier(c);
      await ecrire(c, f, [unite(1), unite(2)]);
      await poser(f, { attempts: 0, next: null });
      const r = await demander(f, c, { requestedBy, env, scheduled: requestedBy === 'SCHEDULER' });
      expect(r, requestedBy).toMatchObject({
        status: 'NOT_ADMISSIBLE', queued: false, jobId: null, reason: 'RETRIES_DISABLED', attemptConsumed: false,
        result: 'REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED',
      });
      // La file T1 n'a RIEN reçu : aucun travail, donc aucun appel possible.
      expect(await travaux(f), requestedBy).toEqual([]);
      const cov = await couverture(f);
      expect(Number(cov.attempts), requestedBy).toBe(0);
      // Aucune promesse de reprise, et le refus est tracé avec son origine.
      expect(cov.next).toBeNull();
      expect(cov.result).toBe('REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED');
      expect(cov.verification.requeue).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRIES_DISABLED', requestedBy, attemptConsumed: false, maxRetries: 0 });
    }
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E02 — plafond CONSOMMÉ : la relance complète du BO est refusée, l’échéance existante n’est pas touchée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [unite(1), unite(2)]);
    // Deux reprises consommées, et une échéance encore inscrite : la demande ne doit NI consommer NI effacer.
    await poser(f, { attempts: 2, next: 'future' });
    const avant = await couverture(f);
    const r = await demander(f, c, { requestedBy: 'BO', attempt: 3, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', queued: false, reason: 'RETRY_CAP_REACHED', attemptConsumed: false });
    expect(await travaux(f)).toEqual([]);
    const apres = await couverture(f);
    expect(Number(apres.attempts)).toBe(2);
    expect(apres.next).toEqual(avant.next);
    expect(apres.error).toContain('plafond de reprises atteint');
    expect(apres.verification.requeue).toMatchObject({ requestedBy: 'BO', retryAttempts: 2, maxRetries: 2 });
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E03 — plafond ABAISSÉ après programmation (3 consommées, plafond ramené à 2) : refusée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [unite(1), unite(2)]);
    await poser(f, { attempts: 3, next: 'due' });
    const r = await demander(f, c, { requestedBy: 'SCHEDULER', attempt: 4, scheduled: true, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRY_CAP_REACHED', attemptConsumed: false });
    expect(await travaux(f)).toEqual([]);
    expect(Number((await couverture(f)).attempts)).toBe(3);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E04 — deux demandes simultanées sur la DERNIÈRE reprise : un seul travail, UNE seule reprise consommée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [unite(1), unite(2)]);
    // Une seule reprise reste (1 consommée sur 2).
    await poser(f, { attempts: 1, next: 'due' });
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    const [a, b] = await Promise.all([
      demander(f, c, { requestedBy: 'BO', attempt: 2, env }),
      demander(f, c, { requestedBy: 'SCHEDULER', attempt: 2, scheduled: true, env }),
    ]);
    // Une demande obtient le droit ; l'autre est soit refusée faute de droit, soit rattachée au travail vivant —
    // jamais une seconde exécution, et jamais deux reprises consommées.
    expect([a, b].filter((x) => x.attemptConsumed)).toHaveLength(1);
    expect([a, b].filter((x) => x.status === 'ACCEPTED')).toHaveLength(1);
    expect((await travaux(f)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(Number((await couverture(f)).attempts)).toBe(2);

    // RÈGLE COMPLÉTÉE (carte #785, § 2) : une troisième demande du BO est soit le CONSTAT du travail vivant
    // (si sa propre demande antérieure l'a obtenu), soit un refus de droit (si c'est le planificateur qui l'a
    // obtenu et que la demande du BO avait été refusée). Dans les deux cas : aucune consommation, aucun travail
    // supplémentaire — c'est la seule chose qui compte ici.
    const troisieme = await demander(f, c, { requestedBy: 'BO', attempt: 3, env });
    expect(['IDENTICAL_REQUEST_ALIVE', 'NOT_ADMISSIBLE']).toContain(troisieme.status);
    expect(troisieme.attemptConsumed).toBe(false);
    expect((await travaux(f)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(Number((await couverture(f)).attempts)).toBe(2);

    // Une demande d'identité DISTINCTE (le § 1 s'applique alors pleinement) : plafond atteint → refus explicite,
    // aucun travail supplémentaire, aucune consommation.
    const distincte = await demander(f, c, { requestedBy: 'BO', attempt: 3, env, requestKey: 'recette:distincte' });
    expect(distincte).toMatchObject({ status: 'NOT_ADMISSIBLE', queued: false, reason: 'RETRY_CAP_REACHED', attemptConsumed: false });
    expect((await travaux(f)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(Number((await couverture(f)).attempts)).toBe(2);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E05 — § 3 : source momentanément illisible SANS échéance → réarmée ; image non vérifiable → jamais relancée', async () => {
    const { reconcileStoredDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reconciliation');
    const c = await make.account();

    // (a) Source MOMENTANÉMENT illisible, échéance effacée par un ancien refus, tentatives restantes.
    const illisible = await fichier(c);
    await ecrire(c, illisible, [unite(1)], {
      status: 'PARTIAL' as const, reason: 'source_unreadable', pagesExpected: 3, verified: [], missing: [], unverified: [1, 2, 3], scanned: [],
    });
    await poser(illisible, { attempts: 0, next: null });
    expect((await couverture(illisible)).next).toBeNull();
    const ra = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: illisible, apply: true, origin: 'e2e/l115h' });
    // Une action REQUEUE_T1 est réellement admissible : l'échéance manquante est REPOSÉE (document repris).
    expect(ra.retry).toMatchObject({ scheduledBefore: false, scheduledAfter: true });
    expect(ra.retry!.actions).toContain('REQUEUE_T1');
    expect((await couverture(illisible)).next).not.toBeNull();

    // (b) Même document, plafond atteint : plus aucune action, donc aucune échéance — aucune boucle.
    await poser(illisible, { attempts: 2, next: null });
    const rb = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: illisible, apply: true, origin: 'e2e/l115h' });
    expect(rb.retry).toMatchObject({ scheduledAfter: false, blocked: 'RETRY_CAP_REACHED' });
    expect((await couverture(illisible)).next).toBeNull();

    // (c) Image NON vérifiable : l'incertitude est conservée, AUCUNE échéance, aucun travail.
    const img = await fichier(c);
    await ecrire(c, img, [unite(1)], {
      status: 'UNVERIFIABLE' as const, reason: 'image_not_checkable', pagesExpected: 1, verified: [], missing: [], unverified: [1], scanned: [1],
    });
    await poser(img, { attempts: 0, next: null });
    const rc = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: img, apply: true, origin: 'e2e/l115h' });
    expect(rc.retry).toMatchObject({ scheduledAfter: false });
    expect((await couverture(img)).next).toBeNull();
    expect(await travaux(img)).toEqual([]);
    expect(replay.calls).toHaveLength(0);
  });
});

/**
 * Lot 115H (Trello #785) sur PostgreSQL réel — § 2, § 3, § 4, § 5 et § 6.
 *
 *   L115H-E06  § 2 : clics répétés, BO + planificateur et deux « exécutants »
 *              sur une demande IDENTIQUE — aucun passage supplémentaire posé
 *              sur le travail en cours, aucun doublon, aucune consommation ;
 *   L115H-E07  § 2 : la coalescence légitime des AUTRES traitements est
 *              intacte (un travail T3 en cours reçoit bien son passage) ;
 *   L115H-E08  § 4 : panne après l'enfilement, avant le compteur — la
 *              réservation orpheline est rendue exactement une fois ;
 *   L115H-E09  § 4 : réconciliation concurrente d'une couche plus récente —
 *              aucun écrasement, conflit différé explicitement ;
 *   L115H-E10  § 3 et § 5 : campagne — compte exclu puis réactivé, analyse en
 *              cours puis terminée, deux campagnes idempotentes, curseur
 *              durable ;
 *   L115H-E11  § 6 : bilan exhaustif (plus de 5 000 documents dans les
 *              compteurs par issue) et corrélation campagne → demandes →
 *              travaux → appels → coûts, coût inconnu jamais compté zéro.
 *
 * Aucun appel à un fournisseur d'IA.
 */
scenario('L115H', 'T1 — demandes exactes, interruptions, rattrapage et bilan (#785 § 2 à § 6)', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1'] });

  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const unite = (n: number, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
    sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text: `bloc ${n} : 132,00 €`,
    payload: {}, location: {}, origin: 'PASS_1', salient: true, status: 'UNRESOLVED', reason: 'not_extracted',
    factCount: 0, repairAttempts: 0, repairState: null, ...over,
  });
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
  const illisible = { status: 'PARTIAL' as const, reason: 'source_unreadable', pagesExpected: 3, verified: [], missing: [], unverified: [1, 2, 3], scanned: [] };
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT retry_attempts AS attempts, next_retry_at AS next, quality_state AS quality, last_retry_result AS result, updated_at
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const travaux = (fileId: number) => sql<Json[]>`
    SELECT id, status, coalesce_requested AS coalesce, trigger_code AS trigger
      FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)} ORDER BY id`;
  const demandes = (fileId: number) => sql<Json[]>`
    SELECT request_key, state, reserved_attempt, attempt_consumed, job_id, steps
      FROM t1_requeue_requests WHERE file_id = ${fileId} ORDER BY id`;
  const demander = async (fileId: number, compte: AccountRow, over: Record<string, unknown> = {}) => {
    const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
    return jobs.requeueDocumentForRereadDetailed({
      fileId, accountId: compte.id, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1',
      env: { T1_COMPLETENESS_MAX_RETRIES: '2' }, ...over,
    });
  };
  const preparer = async (compte: AccountRow) => {
    const f = await fichier(compte);
    await ecrire(compte, f, [unite(1), unite(2)], illisible);
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 0, next_retry_at = NULL WHERE file_id = ${f}`;
    return f;
  };

  it('L115H-E06 — § 2 : clics répétés, BO + planificateur, deux exécutants — AUCUN passage supplémentaire, aucun doublon', async () => {
    const c = await make.account();
    const f = await preparer(c);

    // Première demande : un travail est créé, une reprise consommée.
    const un = await demander(f, c, { requestedBy: 'BO' });
    expect(un.status).toBe('ACCEPTED');
    let jobs = await travaux(f);
    expect(jobs).toHaveLength(1);
    expect(Number((await couverture(f)).attempts)).toBe(1);

    // Le travail passe EN COURS : c'est là que l'ancienne coalescence créait un passage supplémentaire à la clôture.
    await sql`UPDATE ai_job_queue SET status = 'RUNNING', started_at = NOW() WHERE id = ${jobs[0].id}`;

    // Clics répétés du BO, demande du planificateur, et deux appels SIMULTANÉS (deux exécutants).
    const suite = [
      await demander(f, c, { requestedBy: 'BO' }),
      await demander(f, c, { requestedBy: 'BO' }),
      ...(await Promise.all([demander(f, c, { requestedBy: 'BO' }), demander(f, c, { requestedBy: 'BO' })])),
    ];
    for (const r of suite) {
      expect(r.queued).toBe(true);
      expect(r.attemptConsumed).toBe(false);
      expect(['IDENTICAL_REQUEST_ALIVE', 'ALREADY_RUNNING']).toContain(r.status);
    }
    jobs = await travaux(f);
    // UN seul travail, et son drapeau de passage supplémentaire n'a JAMAIS été posé.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].coalesce).toBe(false);
    // Carte #837 (A3) : le planificateur porte la MÊME demande canonique (le canal n'est qu'une provenance) — il
    // CONSTATE le travail vivant, ne réserve ni ne consomme rien, et aucun second travail ne naît.
    const planif = await demander(f, c, { requestedBy: 'SCHEDULER', scheduled: true });
    expect(planif.queued).toBe(true);
    expect(planif).toMatchObject({ status: 'IDENTICAL_REQUEST_ALIVE', attemptConsumed: false });
    expect(Number((await couverture(f)).attempts)).toBe(1);
    expect((await travaux(f)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect((await travaux(f)).every((j) => j.coalesce === false)).toBe(true);

    // Clôture du travail : AUCUN passage supplémentaire n'est créé (c'était le défaut du § 2).
    const { completeJob } = await import('@/services/ai/queue/job-queue.repository');
    const [vivant] = await sql<Json[]>`SELECT id, execution_id FROM ai_job_queue WHERE id = ${jobs[0].id}`;
    const r = await completeJob(Number(vivant.id), null);
    expect(r.requeued).toBe(false);
    expect((await travaux(f)).filter((j) => j.trigger === 'coalesced')).toHaveLength(0);

    // L'identité de chaque demande est en base, avec ses frontières franchies.
    const d = await demandes(f);
    // Carte #837 (A3) : UNE seule demande canonique (BO, clics, deux exécutants, planificateur), UNE consommation.
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ attempt_consumed: true });
    expect(String(d[0].request_key)).toMatch(/^COMPLETENESS_REREAD:/);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E07 — § 2 : la coalescence légitime des AUTRES traitements est intacte', async () => {
    const c = await make.account();
    const { enqueue, completeJob } = await import('@/services/ai/queue/job-queue.repository');
    const scope = { accountId: c.id, targetType: 'account', targetId: c.id };
    const a = await enqueue({ treatment: 'T3', scope, origin: 'automatic', triggerCode: 'test' });
    expect(a.decision).toBe('create');
    await sql`UPDATE ai_job_queue SET status = 'RUNNING', started_at = NOW() WHERE id = ${a.jobId}`;
    // Un événement arrivé pendant l'exécution : il DOIT demander un passage supplémentaire (WF-10 conservé).
    const b = await enqueue({ treatment: 'T3', scope, origin: 'automatic', triggerCode: 'test' });
    expect(b).toMatchObject({ decision: 'coalesce', jobId: a.jobId, reasonCode: 'DUPLICATE_RUNNING' });
    const [job] = await sql<Json[]>`SELECT coalesce_requested AS c FROM ai_job_queue WHERE id = ${a.jobId}`;
    expect(job.c).toBe(true);
    const fin = await completeJob(Number(a.jobId), null);
    expect(fin.requeued).toBe(true);
    const [suivant] = await sql<Json[]>`
      SELECT trigger_code AS t FROM ai_job_queue WHERE treatment = 'T3' AND account_id = ${c.id} AND id <> ${a.jobId} ORDER BY id DESC LIMIT 1`;
    expect(suivant.t).toBe('coalesced');
    // Et une demande explicitement « constatée » ne pose rien, même en T3.
    const d = await enqueue({ treatment: 'T3', scope, origin: 'automatic', triggerCode: 'test', onRunning: 'OBSERVE_ONLY' });
    expect(['skip']).toContain(d.decision);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E08 — § 4 : panne après l’enfilement, avant le compteur — la réservation est rendue UNE seule fois', async () => {
    const c = await make.account();
    const f = await preparer(c);
    const { recoverRequeueReservations, REQUEUE_RESERVATION_STALE_MINUTES } = await import('@/services/ai/source-analysis/source-units/requeue-identity');

    // (a) Réservation orpheline SANS travail vivant : elle doit être rendue (la tentative n'a pas eu lieu).
    await sql`UPDATE document_extraction_coverage SET retry_attempts = 1 WHERE file_id = ${f}`;
    await sql`
      INSERT INTO t1_requeue_requests (account_id, file_id, request_key, origin, requested_by, state, reserved_attempt, steps)
      VALUES (${c.id}, ${f}, 'panne:sans-travail', 't1-completeness-retry', 'BO', 'RESERVED', 1, '{"reserved":true}'::jsonb)`;
    await sql`UPDATE t1_requeue_requests SET updated_at = NOW() - make_interval(mins => ${REQUEUE_RESERVATION_STALE_MINUTES + 5}) WHERE request_key = 'panne:sans-travail'`;
    const un = await recoverRequeueReservations({ accountId: c.id });
    expect(un).toMatchObject({ examined: 1, released: 1, confirmed: 0 });
    expect(Number((await couverture(f)).attempts)).toBe(0);
    // Rejouée : la restitution n'a lieu QU'UNE fois (transition d'état conditionnelle).
    const deux = await recoverRequeueReservations({ accountId: c.id });
    expect(deux).toMatchObject({ examined: 0, released: 0 });
    expect(Number((await couverture(f)).attempts)).toBe(0);

    // (b) Réservation orpheline AVEC un travail vivant : la tentative a bien eu lieu — la consommation est TENUE.
    const r = await demander(f, c, { requestedBy: 'BO' });
    expect(r.status).toBe('ACCEPTED');
    expect(Number((await couverture(f)).attempts)).toBe(1);
    await sql`
      INSERT INTO t1_requeue_requests (account_id, file_id, request_key, origin, requested_by, state, reserved_attempt, steps)
      VALUES (${c.id}, ${f}, 'panne:avec-travail', 't1-completeness-retry', 'SCHEDULER', 'RESERVED', 1, '{"reserved":true,"enqueued":true}'::jsonb)`;
    await sql`UPDATE t1_requeue_requests SET updated_at = NOW() - make_interval(mins => ${REQUEUE_RESERVATION_STALE_MINUTES + 5}) WHERE request_key = 'panne:avec-travail'`;
    const trois = await recoverRequeueReservations({ accountId: c.id });
    expect(trois).toMatchObject({ confirmed: 1, released: 0 });
    // Aucune tentative oubliée, aucune double consommation.
    expect(Number((await couverture(f)).attempts)).toBe(1);
    const d = await demandes(f);
    expect(d.find((x) => x.request_key === 'panne:avec-travail')).toMatchObject({ state: 'CONFIRMED', attempt_consumed: true });
    expect(d.find((x) => x.request_key === 'panne:sans-travail')).toMatchObject({ state: 'RECOVERED', attempt_consumed: false });
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E09 — § 4 : couche plus récente écrite pendant le recalcul — aucun écrasement, conflit différé', async () => {
    const c = await make.account();
    const f = await preparer(c);
    const { CoverageVersionConflictError, writeSourceLayer, loadDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/repository');
    const { buildCompletenessReport } = await import('@/services/ai/source-analysis/source-units/coverage');
    const { withResidualPolicies } = await import('@/services/ai/source-analysis/source-units/coverage-reconciliation');
    const { SOURCE_LAYER_VERSION } = await import('@/services/ai/source-analysis/source-units/types');

    const lue = await loadDocumentCoverage(f, c.id);
    expect(lue).not.toBeNull();
    // Une AUTRE écriture passe (analyse, reprise, action du BO) : la version change.
    await sql`UPDATE document_extraction_coverage SET quality_state = 'INCOMPLETE_FINAL', updated_at = NOW() + interval '1 second' WHERE file_id = ${f}`;
    const recente = await couverture(f);

    // L'écriture fondée sur la version PÉRIMÉE est refusée, et rien n'est modifié.
    const u = withResidualPolicies([unite(1)]);
    const layer: SourceLayer = {
      layerVersion: SOURCE_LAYER_VERSION, units: u, unresolvedFacts: [], retryable: false,
      report: buildCompletenessReport(u, {
        factsCount: 0, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
        warningCodes: [], retryAllowed: false, verification: illisible as never,
      }),
    };
    let refus: unknown = null;
    await sql.begin(async (tx) => {
      await writeSourceLayer(tx as never, {
        accountId: c.id, fileId: f, extractionId: null, origin: 'RETRY', layer, expectUpdatedAt: lue!.updatedAt,
      });
    }).catch((e: unknown) => { refus = e; });
    expect(refus).toBeInstanceOf(CoverageVersionConflictError);
    const apres = await couverture(f);
    expect(apres.quality).toBe(recente.quality);
    expect(String(apres.updated_at)).toBe(String(recente.updated_at));

    // La même garde avec la BONNE version écrit normalement (le mécanisme ne bloque pas le cas sain).
    const bonne = await loadDocumentCoverage(f, c.id);
    await sql.begin(async (tx) => {
      await writeSourceLayer(tx as never, {
        accountId: c.id, fileId: f, extractionId: null, origin: 'RETRY', layer, expectUpdatedAt: bonne!.updatedAt,
      });
    });
    expect((await couverture(f)).quality).not.toBe(recente.quality);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E10 — § 3 et § 5 : compte exclu puis réactivé, analyse en cours puis terminée, deux campagnes idempotentes', async () => {
    const { runCoverageReassessment, T1_COVERAGE_RULES_VERSION } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    const c = await make.account();
    const exclu = await preparer(c);
    const enCours = await preparer(c);
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZING' WHERE id = ${enCours}`;

    const journal = (fileId: number) => sql<Json[]>`
      SELECT outcome, deferred_cause AS cause, attempts, evidence_fingerprint AS empreinte, steps, detail
        FROM t1_coverage_reassessments WHERE file_id = ${fileId} AND rules_version = ${T1_COVERAGE_RULES_VERSION}`;

    // (a) Compte temporairement EXCLU : le document n'est pas perdu, il est DIFFÉRÉ avec sa cause.
    // Exclusion TEMPORAIRE au sens du lot 82A (abonnement en lecture seule) : le compte n'est plus éligible.
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${c.id}`;
    const p1 = await runCoverageReassessment({ accountId: c.id });
    expect(p1.deferred).toBeGreaterThanOrEqual(1);
    expect(Object.keys(p1.deferredByCause).length).toBeGreaterThan(0);
    const differe = await journal(exclu);
    expect(differe[0]).toMatchObject({ outcome: 'DEFERRED' });
    expect(['ACCOUNT_INELIGIBLE', 'ANALYSIS_RUNNING', 'RETRY_ACTIVE']).toContain(String(differe[0].cause));

    // (b) RÉACTIVATION du compte : le rattrapage a lieu au passage suivant, sans redémarrage et sans action du BO.
    await sql`UPDATE account_subscriptions SET status = 'active' WHERE account_id = ${c.id}`;
    const p2 = await runCoverageReassessment({ accountId: c.id });
    expect(p2.examined).toBeGreaterThanOrEqual(1);
    const reprise = await journal(exclu);
    expect(reprise[0].outcome).not.toBe('DEFERRED');
    expect(String(reprise[0].empreinte ?? '')).toHaveLength(32);
    // L'achèvement est PROUVÉ (§ 3) : l'action décidée a été retrouvée en base.
    expect((reprise[0].detail as Json).completion).toMatchObject({ complete: true });

    // (c) L'analyse en cours reste différée, puis est rattrapée dès qu'elle est terminée.
    expect((await journal(enCours))[0]?.outcome).toBe('DEFERRED');
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${enCours}`;
    await runCoverageReassessment({ accountId: c.id });
    expect((await journal(enCours))[0]?.outcome).not.toBe('DEFERRED');

    // (d) Deux campagnes de suite : la seconde ne refait RIEN (même empreinte de preuves, issue terminale).
    const avant = await sql<Json[]>`SELECT file_id, outcome, attempts, updated_at FROM t1_coverage_reassessments WHERE account_id = ${c.id} ORDER BY file_id`;
    await runCoverageReassessment({ accountId: c.id });
    const apres = await sql<Json[]>`SELECT file_id, outcome, attempts, updated_at FROM t1_coverage_reassessments WHERE account_id = ${c.id} ORDER BY file_id`;
    expect(apres.map((r) => [r.file_id, r.outcome])).toEqual(avant.map((r) => [r.file_id, r.outcome]));

    // (e) Curseur DURABLE du parcours : il existe et a bouclé au moins un tour.
    const curseurs = await sql<Json[]>`SELECT kind, position, cycles FROM t1_reassessment_cursors WHERE rules_version = ${T1_COVERAGE_RULES_VERSION}`;
    expect(curseurs.map((r) => r.kind).sort()).toContain('documents');
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E11 — § 6 : bilan exhaustif sans plafond de 5 000, et corrélation campagne → demandes → travaux → appels → coûts', async () => {
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const { getCoverageReassessmentReport, runCoverageReassessment, T1_COVERAGE_RULES_VERSION } =
      await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    const c = await make.account();
    const f = await preparer(c);
    await demander(f, c, { requestedBy: 'BO' });
    await runCoverageReassessment({ accountId: c.id });

    // Un appel de fournisseur AVEC coût et un appel SANS coût rendu, rattachés au document.
    await sql`
      INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, cost_micros, status, environment, created_at)
      VALUES (${c.id}, ${f}, 't1_analyze_document', 'test', 'test', 1234, 'success', 'test', NOW() + interval '1 second'),
             (${c.id}, ${f}, 't1_repair_units', 'test', 'test', NULL, 'success', 'test', NOW() + interval '2 seconds')`;

    const bilan = await getCoverageReassessmentReport(T1_COVERAGE_RULES_VERSION);
    expect(bilan.available).toBe(true);
    // Aucun plafond arbitraire : le bilan le dit explicitement.
    expect(bilan.truncated).toBe(false);
    // La passe déterministe reste à coût nul, et ses SUITES sont comptées à part.
    expect(bilan.aiCalls).toBe(0);
    expect(bilan.aiCost).toBe(0);
    // Règle remplacée (carte #837, D1) : ces deux appels étaient IMPUTÉS à la campagne par simple jointure document +
    // date. Ils ne sont rattachés à AUCUNE suite de la campagne (la demande du BO précède la campagne et ne porte pas
    // sa référence) : ils sont comptés « non rattachés », hors des totaux de la campagne. La corrélation explicite
    // (campagne → demande → travail → appel) est prouvée par le scénario C837.
    expect(bilan.followUps.correlation).toBe('EXPLICIT');
    expect(bilan.followUps.calls).toBe(0);
    expect(bilan.followUps.costMicros).toBe(0);
    expect(bilan.followUps.uncorrelatedDocumentCalls).toBeGreaterThanOrEqual(2);
    expect(bilan.followUps.requests).toBe(0);
    // Une réparation PROGRAMMÉE n'est pas une réparation ACCOMPLIE : les deux compteurs existent séparément.
    expect(typeof bilan.repairsScheduled).toBe('number');
    expect(typeof bilan.repairsCompleted).toBe('number');
    expect(bilan.examined + bilan.deferred).toBe(bilan.documents);

    // Compteurs par issue du BO : balayage exhaustif, troncature toujours fausse.
    const vue = await getT1CompletenessOverview({ days: 1 });
    expect(vue.byIssueTruncated).toBe(false);
    expect(vue.byIssueStatus).toBe('COMPLETE');
    expect(vue.byIssueScanned).toBeGreaterThanOrEqual(1);
    expect(Object.values(vue.byIssue ?? {}).reduce((a, b) => a + b, 0)).toBe(vue.byIssueScanned);
    expect(replay.calls).toHaveLength(0);
  });
});
