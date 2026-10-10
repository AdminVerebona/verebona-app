/**
 * Lot 34C sur base réelle — ticket « ne plus exposer les erreurs techniques
 * IA aux utilisateurs et fiabiliser leur suivi dans BO › Exécutions IA ».
 * Sorties fautives simulées par le rejeu (`replay-gateway`) derrière la
 * passerelle RÉELLE, file durable réelle (`runOne`), routes de l'application
 * appelées comme par le navigateur.
 *
 *   · UXERR-01 : principal en échec, fallback en cours → « Analyse en cours »
 *     / BO : Principal FAILED, Fallback 1 RUNNING ;
 *   · UXERR-02 : tous les modèles échouent, vrai retry planifié → « En file
 *     d'attente » / BO : Tentative #1 FAILED, Retry OUI, Tentative #2 QUEUED ;
 *   · UXERR-03 : aucun retry → message générique / BO : FAILED_FINAL, Retry NON ;
 *   · UXERR-04 : INVALID_OUTPUT → aucune mention technique côté utilisateur,
 *     diagnostic complet côté BO ;
 *   · UXERR-05 : job DONE, T1 FAILED → deux statuts distincts ;
 *   · UXERR-06 : 2 tentatives × 3 modèles → « Tentatives du job : 2 » ;
 *   · UXERR-07 : « en file » seulement si un job est réellement PENDING ;
 *   · migration 0288 idempotente.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { useTargetState } from '../chain';

vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
vi.mock('@/lib/session-service', async (o) => ({
  ...(await o<object>()),
  SessionService: {
    getSession: async () => ({ ...session, role: 'USER' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ ...session, role: 'USER' }),
}));

/** Ce que l'utilisateur ne doit jamais voir (ticket, « Constat »). */
const JARGON = /prompt|ma[iî]tre|gemini|INVALID_OUTPUT|INVALID_ENUM|Invalid input|sch[ée]ma|schema|fallback|provider|fournisseur|document\.\w+|amountCents|\bT1\b|TASK|stack|Tous les modèles/i;
/** Toutes les VALEURS textuelles d'une réponse (les clés, comme `amountCents`, sont des champs métier). */
const textes = (v: unknown): string => (typeof v === 'string' ? v
  : Array.isArray(v) ? v.map(textes).join(' | ')
    : v && typeof v === 'object' ? Object.values(v).map(textes).join(' | ') : '');

scenario('L34C', 'Erreurs IA : statut fonctionnel côté utilisateur, diagnostic et retries dans BO › Exécutions IA', ({ sql, make, useRecordings }) => {
  useTargetState();
  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async (sauf: number[] = []) => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now()
         AND NOT (target_id = ANY(${sauf.map(String)})) RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  beforeAll(() => ecarterLesAutresJobsT1());
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });

  const fichierAnalysable = async (compte: Parameters<typeof make.assetFile>[0]) => {
    const f = await make.assetFile(compte);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const jobDe = async (id: number) => (await sql<{ id: number; status: string; attempts: number; business_result: string | null }[]>`
    SELECT id, status, attempts, business_result FROM ai_job_queue
     WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];
  const appelsDuJob = async (jobId: number) => (await sql<{ id: number }[]>`
    SELECT id FROM ai_usage_event WHERE job_id = ${jobId} ORDER BY id`).map((r) => Number(r.id));

  /** Vue utilisateur : routes de l'application, comme le tiroir et le bandeau. */
  const vueUtilisateur = async (compte: { id: number; ownerUserId: number }, fileId: number) => {
    session.userId = compte.ownerUserId;
    session.currentAccountId = compte.id;
    const params = { params: Promise.resolve({ id: String(fileId) }) };
    const fichier = await (await import('@/app/api/files/[id]/route')).GET(new NextRequest(`http://x/api/files/${fileId}`), params);
    const statut = await (await import('@/app/api/documents/[id]/analysis-status/route')).GET(new NextRequest(`http://x/api/documents/${fileId}/analysis-status`), params);
    const { getT1QueueStatus } = await import('@/services/ai/source-analysis/queue/t1-status');
    const file = await getT1QueueStatus(compte.id);
    return {
      fichier: await fichier.json() as Record<string, unknown>,
      statut: await statut.json() as Record<string, unknown>,
      enFile: file.files.find((x) => x.fileId === fileId) ?? null,
    };
  };

  const useEchecSurToutLaChaine = () => useRecordings([{
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', repeat: true, inputTokens: 13_927, outputTokens: 1790,
    output: { task: 'GROUP_UPLOAD', groups: [[0]], reason: 'branche inattendue' },
  }]);

  it('migration 0288 : idempotente (deux passes), colonne et index présents', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const f of ['0288_ai_job_attempt_history.sql', '0288_ai_job_attempt_history_idx_1.sql']) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const [c] = await sql<{ n: number; i: string | null }[]>`
      SELECT (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_name = 'ai_job_queue' AND column_name = 'attempt_history') AS n,
             to_regclass('ai_job_queue_live_target_idx')::text AS i`;
    expect(c).toEqual({ n: 1, i: 'ai_job_queue_live_target_idx' });
  });

  it('UXERR-02, 04, 05, 06 — échec sur toute la chaîne : retry réel « en file », puis échec définitif générique ; BO : 2 tentatives × 3 appels', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    await useEchecSurToutLaChaine();
    expect(await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId })).toEqual([f.id]);

    // Avant toute exécution : réellement en file (job PENDING, aucune exécution consommée).
    const avant = await vueUtilisateur(compte, f.id);
    expect(avant.fichier).toMatchObject({ processingStatus: 'PENDING', retryScheduled: false });
    expect(avant.enFile).toMatchObject({ state: 'queued' });

    // Tentative 1 : principal, fallback 1, fallback 2 en échec → retry réel.
    expect(await runOne('T1')).toBe(true);
    const j1 = await jobDe(f.id);
    expect(j1).toMatchObject({ status: 'PENDING', attempts: 1 });
    const u1 = await vueUtilisateur(compte, f.id);
    // UXERR-02 : « En file d'attente », retry explicite, aucune erreur.
    expect(u1.fichier).toMatchObject({ processingStatus: 'PENDING', retryScheduled: true, userMessageCode: null });
    expect(u1.statut).toMatchObject({ processingStatus: 'PENDING', retryScheduled: true });
    expect(u1.enFile).toMatchObject({ state: 'queued' });
    // UXERR-04 : le motif technique est en base, jamais dans les réponses.
    const [motif] = await sql<{ analysis_fail_reason: string | null }[]>`SELECT analysis_fail_reason FROM asset_files WHERE id = ${f.id}`;
    expect(motif.analysis_fail_reason).toMatch(/prompt maître T1/);
    expect(u1.fichier).not.toHaveProperty('analysisFailReason');
    expect(textes(u1)).not.toMatch(JARGON);

    // BO : Tentative #1 FAILED (3 appels), Retry OUI, Tentative #2 QUEUED.
    const { getExecutionDetail } = await import('@/services/ai/telemetry/execution-log.repository');
    const d1 = await getExecutionDetail((await appelsDuJob(j1.id))[2]);
    expect(d1?.jobExecution?.attempts.map((a) => [a.attempt, a.status, a.modelCalls])).toEqual([[1, 'FAILED', 3], [2, 'QUEUED', 0]]);
    expect(d1?.jobExecution?.attempts[0].calls.map((c) => [c.label, c.status])).toEqual([
      ['principal', 'FAILED'], ['fallback 1', 'FAILED'], ['fallback 2', 'FAILED'],
    ]);
    expect(d1?.jobExecution?.retry).toMatchObject({ currentAttempt: 2, maxAttempts: 5, automatic: true, state: 'QUEUED', scheduled: true });
    expect(d1?.jobExecution?.retry.reason).toMatch(/^INVALID_OUTPUT/);
    expect(d1?.jobExecution?.retry.nextAttempt).toBeTruthy();
    expect(d1?.userView).toMatchObject({ processingStatus: 'PENDING', retryScheduled: true });

    // Tentative 2 : même échec → job DONE, résultat métier FAILED, plus de retry.
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${j1.id}`;
    expect(await runOne('T1')).toBe(true);
    const j2 = await jobDe(f.id);
    expect(j2).toMatchObject({ status: 'DONE', attempts: 2, business_result: 'FAILED' });

    // Utilisateur : au plus le message générique, jamais « en file ».
    const u2 = await vueUtilisateur(compte, f.id);
    expect(u2.fichier).toMatchObject({ processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false });
    expect(u2.statut).toMatchObject({ processingStatus: 'FAILED_FINAL' });
    expect(u2.enFile).toBeNull();
    expect(textes(u2)).not.toMatch(JARGON);
    const { userMessageText } = await import('@/lib/ai/processing-status');
    expect(userMessageText(u2.fichier.userMessageCode)).toBe('L’analyse automatique de ce document n’a pas pu être finalisée.');

    // BO — UXERR-05 : statut job DONE ≠ résultat T1 FAILED ; UXERR-06 : 2 tentatives × 3 appels.
    const ids = await appelsDuJob(j2.id);
    expect(ids).toHaveLength(6);
    const d2 = await getExecutionDetail(ids[5]);
    expect(d2?.jobExecution).toMatchObject({ jobStatus: 'DONE', businessResult: 'FAILED', attemptsCount: 2 });
    expect(d2?.jobExecution?.attempts.map((a) => [a.attempt, a.status, a.modelCalls, a.retryScheduled])).toEqual([
      [1, 'FAILED', 3, true], [2, 'FAILED', 3, false],
    ]);
    expect(d2?.jobExecution?.retry).toMatchObject({ automatic: true, state: 'FAILED', scheduled: false, nextAttempt: null });
    expect(d2?.diagnosis.result).toMatchObject({ jobStatus: 'DONE', businessResult: 'FAILED', doneButFailed: true });
    expect(d2?.diagnosis.counters).toMatchObject({ jobAttempts: 2, modelCalls: 3 });
    // UXERR-04 : diagnostic complet côté BO (cause, chemin, attendu / reçu).
    expect(d2?.diagnosis.calls[0]).toMatchObject({ status: 'FAILED', cause: 'INVALID_OUTPUT / INVALID_ENUM' });
    expect(d2?.diagnosis.calls[0].diagnostic?.issues[0]).toMatchObject({ path: '$.task' });
    expect(d2?.userView).toMatchObject({ processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL' });
    // Historique des tentatives écrit par la file (0288).
    const [h] = await sql<{ h: Array<Record<string, unknown>> }[]>`SELECT attempt_history AS h FROM ai_job_queue WHERE id = ${j2.id}`;
    expect(h.h.map((e) => [e.attempt, e.outcome, e.retryScheduled, e.statusAfter])).toEqual([[1, 'failed', true, 'PENDING'], [2, 'done', false, 'DONE']]);
  });

  it('UXERR-03 — tous les modèles échouent, aucun retry (reprise déjà faite) : message générique ; BO : Retry automatique NON', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const { REQUEUE_ORIGIN_SUFFIX } = await import('@/services/ai/source-analysis/failure-policy');
    registerSourceAnalysisHandler();
    await useEchecSurToutLaChaine();
    await enqueueFileAnalyses([f.id], compte.id, { origin: `documents/analyze${REQUEUE_ORIGIN_SUFFIX}`, userId: compte.ownerUserId });
    expect(await runOne('T1')).toBe(true);
    const j = await jobDe(f.id);
    expect(j).toMatchObject({ status: 'DONE', attempts: 1, business_result: 'FAILED' });

    const u = await vueUtilisateur(compte, f.id);
    expect(u.fichier).toMatchObject({ processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false });
    expect(u.enFile).toBeNull();
    expect(textes(u)).not.toMatch(JARGON);

    const { getExecutionDetail } = await import('@/services/ai/telemetry/execution-log.repository');
    const d = await getExecutionDetail((await appelsDuJob(j.id))[0]);
    expect(d?.jobExecution?.retry).toMatchObject({ automatic: false, state: null, scheduled: false });
    expect(d?.jobExecution?.attempts.map((a) => [a.attempt, a.status, a.modelCalls])).toEqual([[1, 'FAILED', 3]]);
    expect(d?.userView).toMatchObject({ processingStatus: 'FAILED_FINAL' });
  });

  it('UXERR-01 — principal en échec, job toujours en cours : « Analyse en cours » ; BO : Principal FAILED, Fallback 1 RUNNING', async () => {
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    // État réel d'une cascade en cours : le job tourne (tentative 1), l'appel
    // principal a échoué et est tracé ; le document porte un échec transitoire.
    const [j] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, attempts, started_at, execution_id, lease_expires_at, payload)
      VALUES ('T1', ${compte.id}, 'asset_file', ${String(f.id)}, ${`T1:a${compte.id}:asset_file:${f.id}`}, 'RUNNING', 1, now(), gen_random_uuid(), now() + interval '5 minutes',
              ${JSON.stringify({ fileId: f.id })}::jsonb)
      RETURNING id`;
    await sql`UPDATE asset_files SET analysis_state = 'ANALYSIS_FAILED',
                analysis_fail_reason = 'Analyse impossible (prompt maître T1) : gemini-2.5-pro : Sortie non conforme au schéma' WHERE id = ${f.id}`;
    const [e] = await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, operation_code, use_case_code, provider, model, model_rank,
                                  status, error_code, error_message, job_id, duration_ms, input_tokens, output_tokens, metadata)
      VALUES (${compte.id}, ${f.id}, 't1_analyze_document', 't1_analyze_document', 'U1', 'google', 'gemini-2.5-pro', 'primary',
              'error', 'INVALID_OUTPUT', 'Sortie non conforme au schéma', ${j.id}, 30700, 13927, 1790,
              ${JSON.stringify({ traceId: randomUUID(), jobAttempt: 1 })}::jsonb)
      RETURNING id`;

    const u = await vueUtilisateur(compte, f.id);
    expect(u.fichier).toMatchObject({ processingStatus: 'PROCESSING', userMessageCode: null });
    expect(u.enFile).toMatchObject({ state: 'analyzing' });
    expect(textes(u)).not.toMatch(JARGON);

    const { getExecutionDetail } = await import('@/services/ai/telemetry/execution-log.repository');
    const d = await getExecutionDetail(Number(e.id));
    const t = d?.jobExecution?.attempts[0];
    expect(t).toMatchObject({ attempt: 1, status: 'RUNNING', runningCall: { label: 'fallback 1', rank: 'fallback_1' } });
    expect(t?.calls.map((c) => [c.label, c.status])).toEqual([['principal', 'FAILED']]);
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now() WHERE id = ${j.id}`;
  });

  it('UXERR-07 — « en file d’attente » seulement si un job est réellement PENDING (bandeau, document, assistant, mascotte)', async () => {
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    // Document resté « UPLOADED » sans aucun job (toutes tentatives terminées, aucun retry).
    await sql`UPDATE asset_files SET analysis_state = 'UPLOADED' WHERE id = ${f.id}`;
    const sans = await vueUtilisateur(compte, f.id);
    expect(sans.fichier.processingStatus).toBe('NOT_PROCESSED');
    expect(sans.enFile).toBeNull();
    const { loadAccountSuggestionState } = await import('@/services/verebona-assistant/core/account-state');
    expect((await loadAccountSuggestionState(compte.id)).documentsInAnalysis).toBe(0);

    // Un job réellement en attente : « en file ».
    await ecarterLesAutresJobsT1();
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE target_id = ${String(f.id)} AND status = 'PENDING'`;
    const avec = await vueUtilisateur(compte, f.id);
    expect(avec.fichier).toMatchObject({ processingStatus: 'PENDING' });
    expect(avec.enFile).toMatchObject({ state: 'queued' });
    expect((await loadAccountSuggestionState(compte.id)).documentsInAnalysis).toBe(1);

    // Job annulé : le statut disparaît aussitôt.
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now() WHERE target_id = ${String(f.id)} AND status = 'PENDING'`;
    const apres = await vueUtilisateur(compte, f.id);
    expect(apres.fichier.processingStatus).toBe('NOT_PROCESSED');
    expect(apres.enFile).toBeNull();
  });
});
