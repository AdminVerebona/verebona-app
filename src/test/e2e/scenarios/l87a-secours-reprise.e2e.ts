/**
 * Lot 87A — CDC Pilotage IA V2, phase P7 « secours ciblés, disponibilité,
 * reprises », sur PostgreSQL réel et la file réelle (`runOne`).
 *
 *   L87A-E01  état opérationnel lu AVANT appel (RUN-03) : chaîne T1 connue
 *             indisponible avec la clé active → aucun appel, aucune écriture
 *             métier ; travail SUSPENDU (cause explicite portée par le
 *             travail, tentative rendue, reprise différée) ; refus tracés
 *             (ai_usage_event, coût nul) ; exécution métier « suspendue »
 *             avec la cause (P2) ; fichier « en file » avec un motif sans
 *             jargon
 *   L87A-E02  rétablissement → reprise depuis un point sûr (RUN-04, DEC-04,
 *             R11, R54) : une seule analyse, un seul crédit, reprise tracée
 *             sur l'appel, instantané de configuration du travail tracé ;
 *             relancer la file ne réécrit rien (aucune double écriture)
 *   L87A-E03  analyse hors file suspendue : jamais « en échec » (aucun
 *             compteur, aucune analyse écrite), confiée à la file avec la
 *             suspension portée par le travail
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { sortieT1, useTargetState } from '../chain';

const credits = vi.hoisted(() => ({ consume: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => credits.consume(...a),
}));

const CLE = 'cle-e2e-l87a';

scenario('L87A-E', 'Secours par cause : suspension sans écriture, reprise depuis un point sûr (file réelle)', ({ sql, make, useRecordings }) => {
  useTargetState();

  let modeles: string[] = [];
  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  const empreinte = async () => (await import('@/services/ai/provider/model-operational.service')).keyFingerprint(CLE);
  const marquer = async (ok: boolean) => {
    const fp = await empreinte();
    for (const model of modeles) {
      await sql`DELETE FROM ai_model_operational_status WHERE provider = 'gemini' AND model = ${model} AND key_fingerprint = ${fp}`;
      // Contrôle RÉCENT : aucune vérification de rétablissement (sonde réelle) déclenchée.
      await sql`INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, error, source, checked_at, check_status)
                VALUES ('gemini', ${model}, ${fp}, ${ok}, ${ok ? null : '404 model no longer available'}, 'provider_test', now(), ${ok ? 'ok' : 'failed_confirmed'})`;
    }
    (await import('@/services/ai/gateway/fallback-context')).invalidateFallbackStatusCache();
  };

  beforeAll(async () => {
    await ecarterLesAutresJobsT1();
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    (await import('@/services/ai/gateway/fallback-context')).__enableFallbackContextDbForTests(true);
    const { resolveOperationConfig } = await import('@/services/ai/config/config-resolver');
    const chaines = await Promise.all(['t1_analyze_document', 't1_group_upload'].map((op) => resolveOperationConfig(op)));
    modeles = [...new Set(chaines.flatMap((c) => [c.primaryModel, ...c.fallbackModels]))];
    expect(modeles.length).toBeGreaterThan(0);
  });
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
    const fp = await empreinte();
    await sql`DELETE FROM ai_model_operational_status WHERE key_fingerprint = ${fp}`;
    (await import('@/services/ai/gateway/fallback-context')).__enableFallbackContextDbForTests(false);
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
  const analyses = async (id: number) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_runs WHERE asset_file_id = ${id}`)[0].n;
  const sortie = () => [{
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
    output: sortieT1({ title: 'Facture entretien chaudière', date: '2026-03-14', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [], facts: [] }),
  }];

  it('L87A-E01 / E02 — chaîne connue indisponible : suspension sans écriture, puis reprise depuis un point sûr sans double écriture', async () => {
    await ecarterLesAutresJobsT1();
    credits.consume.mockClear();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const { AI_SUSPENSION_USER_REASON } = await import('@/services/ai/queue/queue-policy');
    registerSourceAnalysisHandler();
    const replay = await useRecordings(sortie());
    await marquer(false);

    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    const avant = Date.now();
    expect(await runOne('T1')).toBe(true);

    // ── E01 : suspendu, rien d'écrit ─────────────────────────────────────
    const suspendu = await jobDe(f.id);
    expect(suspendu).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(suspendu.payload.aiSuspension).toMatchObject({ cause: 'KNOWN_UNAVAILABLE', count: 1, resumedAt: null });
    expect(((suspendu.payload.aiSuspension as { decisions: Array<{ decision: string }> }).decisions).every((d) => d.decision === 'KNOWN_UNAVAILABLE')).toBe(true);
    expect(new Date(suspendu.available_at).getTime()).toBeGreaterThanOrEqual(avant + 299_000);
    expect(suspendu.last_error).toMatch(/aucun secours admissible.*reprise automatique depuis un point sûr/);
    expect(replay.calls).toHaveLength(0);
    expect(await analyses(f.id)).toBe(0);
    expect(credits.consume).not.toHaveBeenCalled();
    expect(await etat(f.id)).toMatchObject({ analysis_state: 'UPLOADED', analysis_fail_reason: AI_SUSPENSION_USER_REASON });
    // Chaque refus tracé (cause, rang, modèle, motif), sans coût.
    const refus = await sql<{ model: string; error_code: string; cost_micros: number | null; is_billable: boolean; metadata: Record<string, unknown> }[]>`
      SELECT model, error_code, cost_micros, is_billable, metadata FROM ai_usage_event
       WHERE account_id = ${compte.id} AND job_id = ${suspendu.id} ORDER BY id`;
    expect(refus.length).toBeGreaterThan(0);
    for (const r of refus) {
      expect(r).toMatchObject({ error_code: 'MODEL_KNOWN_UNAVAILABLE', is_billable: false });
      expect(Number(r.cost_micros ?? 0)).toBe(0);
      expect(r.metadata.fallback).toMatchObject({ policy: 'p7-v1', decision: 'KNOWN_UNAVAILABLE', model: r.model, operational: { error: '404 model no longer available' } });
      expect(r.metadata.configSnapshot).toMatchObject({ scope: 'job' });
    }
    // Exécution métier (P2) : suspendue, cause explicite — ni échec, ni réussite.
    const { businessExecutionsOfJobs } = await import('@/services/ai/business-execution/repository');
    const x = (await businessExecutionsOfJobs([suspendu.id])).get(suspendu.id);
    expect(x).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    expect(x?.cause).toMatch(/^AI_SUSPENDED \(KNOWN_UNAVAILABLE\) : aucun secours admissible, aucune écriture/);
    // Pas de nouvelle tentative avant le délai.
    expect(await runOne('T1')).toBe(false);

    // ── E02 : rétablissement, reprise depuis un point sûr ────────────────
    await marquer(true);
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${suspendu.id}`;
    expect(await runOne('T1')).toBe(true);
    const repris = await jobDe(f.id);
    expect(repris.id).toBe(suspendu.id); // même travail, même exécution métier
    expect(repris.status).toBe('DONE');
    expect(typeof (repris.payload.aiSuspension as { resumedAt?: unknown }).resumedAt).toBe('string');
    expect(await analyses(f.id)).toBe(1);
    expect(credits.consume).toHaveBeenCalledTimes(1);
    const apres = await etat(f.id);
    expect(apres.analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    expect(apres.analysis_fail_reason).toBeNull();
    const [appel] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM ai_usage_event WHERE account_id = ${compte.id} AND job_id = ${suspendu.id} AND status = 'success' ORDER BY id LIMIT 1`;
    expect(appel.metadata.resumedFromSuspension).toMatchObject({ cause: 'KNOWN_UNAVAILABLE', count: 1 });
    expect(appel.metadata.fallback).toMatchObject({ decision: 'FIRST' });
    const fin = (await businessExecutionsOfJobs([suspendu.id])).get(suspendu.id);
    expect(fin?.outcome).not.toBe('FAILED');
    expect(fin?.progress ?? null).not.toBe('SUSPENDED');

    // Relancer la file ne réécrit rien.
    expect(await runOne('T1')).toBe(false);
    expect(await analyses(f.id)).toBe(1);
    expect(credits.consume).toHaveBeenCalledTimes(1);
  });

  it('L87A-E03 — analyse hors file suspendue : jamais en échec, confiée à la file avec la suspension', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const replay = await useRecordings(sortie());
    await marquer(false);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const { AI_SUSPENSION_USER_REASON } = await import('@/services/ai/queue/queue-policy');
    const r = await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, origin: 'documents/analyze' });
    expect(r).toMatchObject({ analysedCount: 0, failedSourceIds: [], aiSuspendedSourceIds: [f.id], aiSuspension: { cause: 'KNOWN_UNAVAILABLE' } });
    expect(replay.calls).toHaveLength(0);
    expect(await analyses(f.id)).toBe(0);
    const e = await etat(f.id);
    expect(e).toMatchObject({ analysis_state: 'UPLOADED', analysis_fail_reason: AI_SUSPENSION_USER_REASON });
    expect(Number(e.analysis_retry_count ?? 0)).toBe(0);
    const job = await jobDe(f.id);
    expect(job).toMatchObject({ status: 'PENDING' });
    expect(job.payload.aiSuspension).toMatchObject({ cause: 'KNOWN_UNAVAILABLE', count: 1, resumedAt: null });
    expect(new Date(job.available_at).getTime()).toBeGreaterThan(Date.now() + 200_000);
    await marquer(true);
  });
});
