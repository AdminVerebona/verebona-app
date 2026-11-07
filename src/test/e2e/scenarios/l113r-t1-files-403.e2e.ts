/**
 * Lot 113R (carte Trello #717) sur PostgreSQL réel, file réelle (`runOne`),
 * passerelle réelle, Files API SIMULÉE derrière le VRAI chemin d'envoi
 * (`transferBufferToFilesApi`) — aucun réseau.
 *
 *   L113R-E01  403 avec message (incident du document 387) : refus d'accès
 *              DISTANT classé comme tel ; travail SUSPENDU (file durable,
 *              aucune seconde file), document « en attente technique » (jamais
 *              « en cours », aucun « Relancer ») ; réponse du fournisseur
 *              figée avec la tentative (usage, diagnostic, colonnes d'export),
 *              sans secret ; secours non appelés, `usedFallback` faux ;
 *              aucune génération, aucun crédit ; alerte d'exploitation
 *   L113R-E02  corps non JSON, corps vide, 429, 5xx, réseau : nature exacte,
 *              absence de raison signalée ; vraie erreur LOCALE : échec
 *              ordinaire, jamais suspendue
 *   L113R-E03  rétablissement : 403 toujours présent → rien n'est libéré (la
 *              sonde le montre) ; sonde réussie → reprise automatique,
 *              aboutit, une seule analyse, un seul crédit, motif initial
 *              conservé sur SA tentative ; alerte résolue
 *   L113R-E04  documents HISTORIQUES en échec (réponse non conservée à
 *              l'époque, compteur au plafond) : rattachés à la file en attente
 *              technique, repris après rétablissement vérifié, non facturés,
 *              sans doublon avec la reprise serveur
 *   L113R-E05  migration 1535 idempotente ; test d'envoi du BO conservé sans
 *              secret
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { sortieT1, useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const credits = vi.hoisted(() => ({ consume: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => credits.consume(...a),
}));

const CLE = 'AIzaSyE2E-l113r-cle-de-test-0000000000000';
const ERRINFO_403 = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED',
  message: `Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.FileService.CreateFile are blocked. key=${CLE}`,
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } }] } });
const R403 = { status: 403, body: ERRINFO_403, headers: { 'content-type': 'application/json', 'x-guploader-uploadid': 'UP-E2E-9302' } };

/** Files API simulée pour la sonde d'envoi (test BO, vérification automatique). */
const sonde = vi.hoisted(() => ({ mode: 'refus' as 'refus' | 'ok', appels: 0 }));

scenario('L113R', 'T1 : 403 Files API — cause conservée, attente technique, reprise automatique après rétablissement vérifié', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now()
         AND NOT (payload ? 'aiSuspension') RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };

  beforeAll(async () => {
    await ecarterLesAutresJobsT1();
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(async () => CLE);
    (await import('@/services/ai/transfer/transfer-probe')).__setTransferProbeFetchForTests(async (input, init) => {
      sonde.appels++;
      const url = typeof input === 'string' ? input : input.url;
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (sonde.mode === 'refus') return new Response(ERRINFO_403, { status: 403, headers: { 'content-type': 'application/json' } });
      if (url.includes('/upload/')) return new Response(JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/sonde', state: 'ACTIVE' } }), { status: 200 });
      return new Response(null, { status: 200 });
    });
    // Aucune sonde ni vérification antérieure (autre scénario) ne doit compter.
    await sql`DELETE FROM ai_provider_transfer_checks`;
  });
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
    (await import('@/services/ai/transfer/transfer-probe')).__setTransferProbeFetchForTests(null);
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(null);
  });

  const fichierAnalysable = async (compte: Parameters<typeof make.assetFile>[0]) => {
    const f = await make.assetFile(compte);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const etat = async (id: number) => (await sql<{ analysis_state: string | null; analysis_fail_reason: string | null; analysis_retry_count: number | null }[]>`
    SELECT analysis_state, analysis_fail_reason, analysis_retry_count FROM asset_files WHERE id = ${id}`)[0];
  const jobDe = async (id: number) => (await sql<{ id: number; status: string; attempts: number; available_at: Date; last_error: string | null; payload: Record<string, unknown> }[]>`
    SELECT id, status, attempts, available_at, last_error, payload FROM ai_job_queue
     WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];
  const jobsVivants = async (id: number) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} AND status IN ('PENDING', 'RUNNING')`)[0].n);
  const analyses = async (id: number) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_runs WHERE asset_file_id = ${id}`)[0].n;
  const sortie = (transfer?: unknown[]) => ({
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
    output: sortieT1({ title: 'Facture entretien chaudière', date: '2026-11-06', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [], facts: [] }),
    ...(transfer ? { transfer } : {}),
  });
  const suspendreAvec = async (transfer: unknown[]) => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    const replay = await rejouer([sortie(transfer) as never]);
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    expect(await runOne('T1')).toBe(true);
    return { compte, f, replay, job: await jobDe(f.id) };
  };
  const appelsDuJob = (jobId: number) => sql<{ id: number; model: string; model_rank: string | null; error_code: string | null; is_fallback: boolean; cost_micros: number | null; is_billable: boolean; metadata: Record<string, unknown> }[]>`
    SELECT id, model, model_rank, error_code, is_fallback, cost_micros, is_billable, metadata FROM ai_usage_event WHERE job_id = ${jobId} ORDER BY id`;

  let e01: { fileId: number; jobId: number; accountId: number; ownerUserId: number } | null = null;

  it('L113R-E01 — 403 avec message : refus d’accès distant, attente technique, réponse conservée sans secret', async () => {
    credits.consume.mockClear();
    const { compte, f, job } = await suspendreAvec([R403]);
    e01 = { fileId: f.id, jobId: job.id, accountId: compte.id, ownerUserId: compte.ownerUserId };
    const { AI_TRANSFER_WAIT_REASON } = await import('@/services/ai/queue/queue-policy');

    // File durable existante : SUSPENDU (jamais FAILED, jamais une seconde file), tentative rendue.
    expect(job).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(job.payload.aiSuspension).toMatchObject({
      cause: 'TRANSFER_ACCESS_DENIED', count: 1, resumedAt: null,
      transfer: { step: 'provider_upload', httpStatus: 403, providerStatus: 'PERMISSION_DENIED', providerReason: 'API_KEY_SERVICE_BLOCKED', requestId: 'UP-E2E-9302' },
    });
    expect(job.last_error).toMatch(/envoi du document refusé par le fournisseur/);
    expect(await analyses(f.id)).toBe(0);
    expect(credits.consume).not.toHaveBeenCalled();

    // Document : en attente technique, ni « en cours » ni échec, aucun « Relancer ».
    expect(await etat(f.id)).toMatchObject({ analysis_state: 'UPLOADED', analysis_fail_reason: AI_TRANSFER_WAIT_REASON });
    const { getFileProcessingView } = await import('@/services/ai/processing-status/processing-status.service');
    const vue = await getFileProcessingView(f.id, compte.id);
    expect(vue).toMatchObject({ processingStatus: 'PENDING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL', retryScheduled: true });
    const { getT1QueueStatus } = await import('@/services/ai/source-analysis/queue/t1-status');
    expect((await getT1QueueStatus(compte.id)).files.map((x) => x.fileId)).not.toContain(f.id);

    // Appel tracé : transfert refusé, aucune génération ; secours NON appelés, usedFallback faux.
    const appels = await appelsDuJob(job.id);
    expect(appels).toHaveLength(3);
    const [tentative, ...nonAppeles] = appels;
    expect(tentative).toMatchObject({ error_code: 'ATTACHMENT_TRANSFER_FAILED', is_fallback: false, is_billable: false });
    expect(Number(tentative.cost_micros ?? 0)).toBe(0);
    expect(tentative.metadata.failure).toMatchObject({ family: 'AUTH_ERROR', stage: 'attachment_transfer' });
    expect(tentative.metadata.transfer).toMatchObject({ httpStatus: 403, providerStatus: 'PERMISSION_DENIED', providerReason: 'API_KEY_SERVICE_BLOCKED', generationRequested: false });
    for (const n of nonAppeles) {
      expect(n).toMatchObject({ error_code: 'FALLBACK_NOT_ADMISSIBLE', is_fallback: false });
      expect(n.metadata.fallback).toMatchObject({ decision: 'SHARED_TRANSFER', afterCause: 'TRANSFER_ACCESS_DENIED' });
    }
    // Aucun secret persisté (usage, diagnostic, travail).
    const brut = JSON.stringify(appels) + JSON.stringify(job.payload)
      + JSON.stringify(await sql`SELECT diagnostic FROM ai_call_diagnostics WHERE source_ids @> ARRAY[${f.id}]::int[]`);
    expect(brut).not.toContain(CLE);
    const [diag] = await sql<{ failure_family: string; failure_stage: string; diagnostic: { transfer?: Record<string, unknown> } }[]>`
      SELECT failure_family, failure_stage, diagnostic FROM ai_call_diagnostics WHERE source_ids @> ARRAY[${f.id}]::int[] ORDER BY id DESC LIMIT 1`;
    expect(diag).toMatchObject({ failure_family: 'AUTH_ERROR', failure_stage: 'attachment_transfer', diagnostic: { transfer: { httpStatus: 403 } } });

    // Exports : colonnes d'appel (diagnostic, exécution métier) et export d'exécution BO.
    const { USAGE_COLS } = await import('@/services/admin/diagnostics-export/trace');
    const lignes = await sql.unsafe(`SELECT ${USAGE_COLS} FROM ai_usage_event WHERE job_id = $1 ORDER BY id`, [job.id] as never[]) as unknown as Array<Record<string, unknown>>;
    expect(lignes[0]).toMatchObject({ transfert: { httpStatus: 403, providerReason: 'API_KEY_SERVICE_BLOCKED' }, is_fallback: false, non_sollicite: false });
    expect(lignes.slice(1).every((l) => l.non_sollicite === true && l.is_fallback === false)).toBe(true);
    const { getExecutionDetail } = await import('@/services/ai/telemetry/execution-log.repository');
    const { buildExecutionExport } = await import('@/services/ai/telemetry/execution-export');
    const detail = await getExecutionDetail(tentative.id);
    expect(detail?.diagnosis?.counters).toMatchObject({ modelCalls: 1, modelFallbacks: 0, notCalled: 2, transferFailures: 1, generationsRequested: 0 });
    expect(detail?.diagnosis?.finalDiagnosis.join(' ')).toMatch(/ni le prompt ni le modèle ne sont en cause/);
    const x = buildExecutionExport(detail!);
    expect(x.costs).toMatchObject({ calls: 1, notCalled: 2, transferFailures: 1, generationsRequested: 0 });
    expect(x.calls.filter((c) => c.usedFallback)).toHaveLength(0);

    // Exécution métier : suspendue, cause fournisseur distincte de la suspension.
    const { businessExecutionsOfJobs } = await import('@/services/ai/business-execution/repository');
    const be = (await businessExecutionsOfJobs([job.id])).get(job.id);
    expect(be).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    expect(be?.cause).toMatch(/TRANSFER_ACCESS_DENIED.*envoi du document au fournisseur refusé \(HTTP 403 PERMISSION_DENIED API_KEY_SERVICE_BLOCKED\), aucune génération — attente technique/);

    // Alerte d'exploitation unique.
    const [alerte] = await sql<{ code: string; message: string; resolved_at: Date | null }[]>`
      SELECT code, message, resolved_at FROM ai_alerts WHERE code = 'T1_ATTACHMENT_TRANSFER_BLOCKED' AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`;
    expect(alerte?.message).toMatch(/envoi des documents au fournisseur refusé \(HTTP 403/);
  });

  it('L113R-E02 — corps non JSON, corps vide, 429, 5xx, réseau ; vraie erreur locale', async () => {
    const cas: Array<[string, unknown[], string, Record<string, unknown>]> = [
      ['non JSON', [{ status: 403, body: '<html>Forbidden</html>', headers: { 'content-type': 'text/html' } }], 'TRANSFER_ACCESS_DENIED', { providerDetail: 'TEXT', httpStatus: 403 }],
      ['corps vide', [{ status: 403, body: '' }], 'TRANSFER_ACCESS_DENIED', { providerDetail: 'NONE', httpStatus: 403, providerMessage: null }],
      ['429', [{ status: 429, body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }) }], 'TRANSFER_UNAVAILABLE', { httpStatus: 429 }],
      ['503', [{ status: 503, body: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }) }], 'TRANSFER_UNAVAILABLE', { httpStatus: 503 }],
      ['réseau', [{ networkCode: 'ECONNRESET' }], 'TRANSFER_UNAVAILABLE', { kind: 'network', networkCode: 'ECONNRESET', httpStatus: null }],
    ];
    for (const [nom, transfer, cause, attendu] of cas) {
      const { job } = await suspendreAvec(transfer);
      expect(job.status, nom).toBe('PENDING');
      expect(job.payload.aiSuspension, nom).toMatchObject({ cause, count: 1 });
      const [t] = await appelsDuJob(job.id);
      expect(t.error_code, nom).toBe('ATTACHMENT_TRANSFER_FAILED');
      expect(t.metadata.transfer, nom).toMatchObject(attendu);
      if (nom === 'corps vide') expect(String(t.metadata.transfer && (t.metadata.transfer as { message: string }).message)).toMatch(/aucun détail fourni par le fournisseur/);
    }
    // Vraie erreur LOCALE de construction : échec ordinaire (reprise de la file), jamais une attente technique.
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: null,
      error: { name: 'TypeError', message: 'Cannot convert argument to a ByteString because the character at index 4 has a value of 768', stage: 'request_build' } } as never]);
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    expect(await runOne('T1')).toBe(true);
    const local = await jobDe(f.id);
    expect(local.payload.aiSuspension).toBeUndefined();
    const [t] = await appelsDuJob(local.id);
    expect(t.error_code).toBe('REQUEST_BUILD_FAILED');
    expect(t.metadata.transfer).toBeUndefined();
    // Nettoyage : ces travaux ne doivent pas être repris par E03.
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
               WHERE treatment = 'T1' AND status = 'PENDING' AND payload ? 'aiSuspension' AND target_id <> ${String(e01!.fileId)}`;
  });

  it('L113R-E02b — reprises rapprochées épuisées : jamais d’abandon silencieux (attente longue, alerte critique)', async () => {
    const { job, f, replay } = await suspendreAvec([R403]);
    expect(job.payload.aiSuspension).toMatchObject({ count: 1 });
    await sql`UPDATE ai_job_queue SET available_at = now(),
                     payload = jsonb_set(payload, '{aiSuspension,count}', to_jsonb(24)) WHERE id = ${job.id}`;
    replay.add(sortie([R403]) as never);
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    expect(await runOne('T1')).toBe(true);
    const garde = await jobDe(f.id);
    expect(garde).toMatchObject({ id: job.id, status: 'PENDING' });
    expect(garde.payload.aiSuspension).toMatchObject({ count: 25, parked: true, cause: 'TRANSFER_ACCESS_DENIED' });
    expect(new Date(garde.available_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(garde.last_error).toMatch(/reprises rapprochées épuisées.*exploitation alertée/);
    expect((await etat(f.id)).analysis_state).toBe('UPLOADED');
    const [alerte] = await sql<{ severity: string }[]>`
      SELECT severity FROM ai_alerts WHERE code = 'T1_ATTACHMENT_TRANSFER_BLOCKED' AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`;
    expect(alerte?.severity).toBe('critical');
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now() WHERE id = ${job.id}`;
  });

  it('L113R-E03 — rétablissement vérifié : 403 encore présent → rien ; sonde réussie → reprise, une analyse, un crédit, motif initial conservé', async () => {
    expect(e01).not.toBeNull();
    const { fileId, jobId } = e01!;
    const { reexamineTransferBlocked } = await import('@/services/ai/transfer/transfer-recovery');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    credits.consume.mockClear();

    // 403 toujours présent (y compris après une « réactivation » de T1) : rien n'est libéré, la sonde le conserve.
    sonde.mode = 'refus';
    await sql`UPDATE ai_treatment_state SET updated_at = now() WHERE treatment = 'T1'`;
    const r1 = await reexamineTransferBlocked();
    expect(r1).toMatchObject({ probed: true, probeOk: false, released: 0 });
    const [c1] = await sql<{ ok: boolean; origin: string; http_status: number; provider_reason: string; failure: unknown; config: Record<string, unknown> }[]>`
      SELECT ok, origin, http_status, provider_reason, failure, config FROM ai_provider_transfer_checks ORDER BY id DESC LIMIT 1`;
    expect(c1).toMatchObject({ ok: false, origin: 'auto_probe', http_status: 403, provider_reason: 'API_KEY_SERVICE_BLOCKED' });
    expect(JSON.stringify(c1)).not.toContain(CLE);
    expect(new Date((await jobDe(fileId)).available_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    // Vérification récente en échec : aucune sonde de plus (pas de boucle rapide).
    const avant = sonde.appels;
    expect(await reexamineTransferBlocked()).toMatchObject({ probed: false, skipped: 'recent_check_failed' });
    expect(sonde.appels).toBe(avant);

    // Rétablissement : la sonde réussit → libération, reprise automatique, aboutit.
    sonde.mode = 'ok';
    await rejouer([sortie() as never]);
    const r2 = await reexamineTransferBlocked({ force: true });
    expect(r2).toMatchObject({ probed: true, probeOk: true });
    expect(r2.released).toBeGreaterThanOrEqual(1);
    const libere = await jobDe(fileId);
    expect(libere.id).toBe(jobId);
    expect(new Date(libere.available_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await runOne('T1')).toBe(true);
    const fin = await jobDe(fileId);
    expect(fin).toMatchObject({ id: jobId, status: 'DONE' });
    expect(await analyses(fileId)).toBe(1);
    expect(credits.consume).toHaveBeenCalledTimes(1);
    expect((await etat(fileId)).analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    // Motif initial lié à SA tentative, conservé après la réussite.
    const appels = await appelsDuJob(jobId);
    expect(appels[0].metadata.transfer).toMatchObject({ httpStatus: 403, providerReason: 'API_KEY_SERVICE_BLOCKED' });
    expect(appels.some((a) => a.error_code === null && (a.metadata.resumedFromSuspension as { cause?: string } | undefined)?.cause === 'TRANSFER_ACCESS_DENIED')).toBe(true);
    // Aucune double exécution ni double crédit ; alerte résolue.
    expect(await runOne('T1')).toBe(false);
    expect(await reexamineTransferBlocked()).toMatchObject({ released: 0 });
    expect(credits.consume).toHaveBeenCalledTimes(1);
    const ouvertes = await sql`SELECT id FROM ai_alerts WHERE code = 'T1_ATTACHMENT_TRANSFER_BLOCKED' AND resolved_at IS NULL`;
    expect(ouvertes).toHaveLength(0);
  });

  it('L113R-E04 — documents HISTORIQUES en échec (compteur au plafond) : rattachés, repris après rétablissement, non facturés, sans doublon', async () => {
    await ecarterLesAutresJobsT1();
    credits.consume.mockClear();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    await sql`UPDATE asset_files SET analysis_state = 'ANALYSIS_FAILED', analysis_retry_count = 10,
                     analysis_fail_reason = 'Analyse impossible après plusieurs tentatives.' WHERE id = ${f.id}`;
    // Trace ANTÉRIEURE au lot 113R : réponse du fournisseur perdue, seul le message subsiste.
    await sql`INSERT INTO ai_call_diagnostics (trace_id, call_index, call_kind, account_id, use_case_code, operation_code, model, model_rank,
                                               outcome, failure_family, failure_stage, source_ids, diagnostic)
              VALUES ('b0bb6228-e2e', 0, 'analysis', ${compte.id}, 'SOURCE_ANALYSIS', 't1_analyze_document', 'gemini-x', 'primary',
                      'FAILED', 'INTERNAL_ERROR', 'request_build', ARRAY[${f.id}]::int[],
                      ${JSON.stringify({ error: { message: 'Upload Files API échoué : HTTP 403' } })}::jsonb)`;
    const { reexamineTransferBlocked } = await import('@/services/ai/transfer/transfer-recovery');
    const { runAnalysisRecovery } = await import('@/services/document-ai/analysis-recovery.service');
    const { runOne } = await import('@/services/ai/queue/queue-worker');

    sonde.mode = 'refus';
    const r1 = await reexamineTransferBlocked({ force: true });
    expect(r1.adopted).toBeGreaterThanOrEqual(1);
    expect(r1.probeOk).toBe(false);
    const job = await jobDe(f.id);
    expect(job).toMatchObject({ status: 'PENDING' });
    expect(job.payload).toMatchObject({ origin: 'transfer-recovery', billable: false });
    expect(job.payload.aiSuspension).toMatchObject({ cause: 'TRANSFER_ACCESS_DENIED', historical: true, parked: true, transfer: { providerDetail: 'NOT_RETAINED_HISTORICALLY' } });
    const { getFileProcessingView } = await import('@/services/ai/processing-status/processing-status.service');
    expect(await getFileProcessingView(f.id, compte.id)).toMatchObject({ processingStatus: 'PENDING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL' });
    // Reprise serveur : aucun doublon (travail vivant), aucun second rattachement.
    await runAnalysisRecovery();
    expect(await jobsVivants(f.id)).toBe(1);

    sonde.mode = 'ok';
    await rejouer([sortie() as never]);
    const r2 = await reexamineTransferBlocked({ force: true });
    expect(r2).toMatchObject({ probeOk: true });
    expect(await runOne('T1')).toBe(true);
    expect(await jobDe(f.id)).toMatchObject({ id: job.id, status: 'DONE' });
    expect(await analyses(f.id)).toBe(1);
    expect((await etat(f.id)).analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    // Réexamen non facturé (la reprise n'est pas une nouvelle demande de l'utilisateur).
    expect(credits.consume).not.toHaveBeenCalled();
    // Réussi : plus jamais rattaché.
    expect(await reexamineTransferBlocked({ force: true })).toMatchObject({ adopted: 0 });
  });

  it('L113R-E05 — migration 1535 idempotente ; test d’envoi du BO conservé sans secret', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const texte = await readFile(join(process.cwd(), 'src/db/migrations', '1535_l113r_transfert_fournisseur.sql'), 'utf-8');
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    await expect(sql`INSERT INTO ai_provider_transfer_checks (origin, ok) VALUES ('autre', true)`).rejects.toThrow(/origin_chk/);
    sonde.mode = 'refus';
    const { runTransferProbe, listTransferChecks } = await import('@/services/ai/transfer/transfer-probe');
    const v = await runTransferProbe({ origin: 'admin_test', adminUserId: e01?.ownerUserId ?? null });
    expect(v).toMatchObject({ ok: false, origin: 'admin_test', failure: { httpStatus: 403, providerStatus: 'PERMISSION_DENIED' } });
    expect(v.hypotheses.map((x) => x.code)).toContain('KEY_API_RESTRICTION');
    expect(v.config).toMatchObject({ endpoint: 'POST generativelanguage.googleapis.com/upload/v1beta/files', envVariablesConsulted: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY'] });
    const [dernier] = await listTransferChecks(1);
    expect(dernier).toMatchObject({ id: v.id, ok: false, failure: { providerReason: 'API_KEY_SERVICE_BLOCKED' } });
    expect(JSON.stringify(dernier)).not.toContain(CLE);
    sonde.mode = 'ok';
    expect(await runTransferProbe({ origin: 'admin_test' })).toMatchObject({ ok: true, fileState: 'ACTIVE', cleanupOk: true });
  });
});
