/**
 * Lot 33D sur base réelle — tickets « rapports d'échec IA diagnostiquables »
 * et « réussite malgré les désalignements ». Sorties fautives simulées par le
 * rejeu (`replay-gateway`), derrière la passerelle RÉELLE.
 *
 *   · E2E-DIAG-01 (cas 5, 7) : trois modèles, même signature ; diagnostics
 *     en base (sortie masquée), détail BO (cascade, compteurs, statut
 *     technique vs résultat métier), job DONE / résultat FAILED, accès à la
 *     sortie journalisé ;
 *   · E2E-REPAIR-01 (audit T1, incident 2644) : sortie avec `null` pour les
 *     champs absents → analyse RÉUSSIE, faits persistés, diagnostic REPAIRED ;
 *   · E2E-REPAIR-02 (cas 8) : document déjà en échec INVALID_OUTPUT → rejeu
 *     automatique (tâche planifiée) → analyse réussie, idempotent (aucun
 *     second rejeu, aucun fait dupliqué) ;
 *   · migrations 0284 / 0285 idempotentes ; purge à l'horizon de rétention.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { analyserDocument, drainQueues, sortieT1, useTargetState } from '../chain';

const credits = vi.hoisted(() => ({ consume: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => credits.consume(...a),
}));

const IBAN = 'FR76 3000 6000 0112 3456 7890 189';

scenario('L33D', 'Diagnostic des échecs IA, réparation des sorties et rejeu automatique', ({ sql, make, useRecordings }) => {
  // Câblage de production (S3 local, abonnés T3/T4) et configuration T1 master.
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
  const jobDe = async (id: number) => (await sql<{ id: number; status: string; attempts: number; business_result: string | null; business_result_detail: Record<string, unknown> | null }[]>`
    SELECT id, status, attempts, business_result, business_result_detail FROM ai_job_queue
     WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];

  it('migrations 0284 et 0285 : idempotentes (deux passes)', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const f of ['0284_ai_call_diagnostics.sql', '0285_ai_output_replays.sql']) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const [t] = await sql<{ d: string | null; r: string | null }[]>`SELECT to_regclass('ai_call_diagnostics')::text AS d, to_regclass('ai_output_replays')::text AS r`;
    expect(t).toEqual({ d: 'ai_call_diagnostics', r: 'ai_output_replays' });
  });

  it('E2E-DIAG-01 (cas 5, 7) — 3 modèles même signature, job DONE / résultat métier FAILED, rapport complet', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    // Les trois modèles répondent… avec la mauvaise branche (et une donnée sensible).
    await useRecordings([{
      operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', repeat: true, inputTokens: 13_927, outputTokens: 1790,
      meta: { finishReason: 'STOP' },
      output: { task: 'GROUP_UPLOAD', groups: [[0]], reason: `IBAN ${IBAN}` },
    }]);
    expect(await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId })).toEqual([f.id]);
    expect(await runOne('T1')).toBe(true);
    const j1 = await jobDe(f.id);
    expect(j1).toMatchObject({ status: 'PENDING', attempts: 1 });
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${j1.id}`;
    expect(await runOne('T1')).toBe(true);

    // Cas 7 : DONE technique, résultat métier FAILED avec sa cause.
    const j2 = await jobDe(f.id);
    expect(j2).toMatchObject({ status: 'DONE', attempts: 2, business_result: 'FAILED' });
    expect(j2.business_result_detail).toMatchObject({ fileId: f.id, cause: 'INVALID_OUTPUT / INVALID_ENUM', stage: 'schema_validation' });

    // Diagnostics en base : 2 tentatives du job × 3 modèles, même signature, sortie masquée.
    const diags = await sql<{ outcome: string; failure_family: string; failure_subtype: string; signature: string; raw_output: string; model_rank: string; usage_event_id: number; schema_version: string }[]>`
      SELECT outcome, failure_family, failure_subtype, signature, raw_output, model_rank, usage_event_id, schema_version
        FROM ai_call_diagnostics WHERE source_ids @> ARRAY[${f.id}::int] ORDER BY id`;
    expect(diags).toHaveLength(6);
    expect(new Set(diags.map((d) => d.signature)).size).toBe(1);
    expect(diags.every((d) => d.outcome === 'FAILED' && d.failure_family === 'INVALID_OUTPUT' && d.failure_subtype === 'INVALID_ENUM')).toBe(true);
    expect(diags[0].schema_version).toBe('t1_analyze_document@v3');
    expect(diags[0].raw_output).toContain('[IBAN_MASQUE]');
    expect(diags.some((d) => d.raw_output.includes('3000 6000'))).toBe(false);

    // Détail BO : rapport par appel, cascade, compteurs explicites, résultat métier.
    const { getExecutionDetail } = await import('@/services/ai/telemetry/execution-log.repository');
    const detail = await getExecutionDetail(Number(diags[5].usage_event_id));
    expect(detail?.diagnosis.calls.map((c) => [c.label, c.status, c.cause])).toEqual([
      ['principal', 'FAILED', 'INVALID_OUTPUT / INVALID_ENUM'],
      ['fallback 1', 'FAILED', 'INVALID_OUTPUT / INVALID_ENUM'],
      ['fallback 2', 'FAILED', 'INVALID_OUTPUT / INVALID_ENUM'],
    ]);
    expect(detail?.diagnosis.cascade).toMatchObject({ identical: true, failedCalls: 3, path: '$.task' });
    expect(detail?.diagnosis.counters).toEqual({ jobAttempts: 2, modelCalls: 3, modelFallbacks: 2, repairCalls: 0 });
    expect(detail?.diagnosis.result).toMatchObject({ jobStatus: 'DONE', businessResult: 'FAILED', doneButFailed: true });
    expect(detail?.diagnosis.finalDiagnosis.join(' ')).toMatch(/Échec T1\..*même signature/);
    expect(JSON.stringify(detail)).not.toContain('IBAN_MASQUE'); // la sortie n'est jamais dans le détail

    // Sortie modèle : route dédiée, accès journalisé.
    const admin = await make.user();
    const { readModelOutputsForAdmin } = await import('@/services/ai/telemetry/model-output-access');
    const acces = await readModelOutputsForAdmin({ adminUserId: admin.id, callId: Number(diags[5].usage_event_id), purpose: 'detail' });
    expect(acces.ok && acces.outputs).toHaveLength(3);
    const [journal] = await sql<{ action_type: string; result: string }[]>`
      SELECT action_type, result FROM admin_audit_log WHERE admin_user_id = ${admin.id} ORDER BY id DESC LIMIT 1`;
    expect(journal).toEqual({ action_type: 'AI_MODEL_OUTPUT_READ', result: 'SUCCESS' });
  });

  /** Sortie T1 « à la Gemini » : champs absents rendus `null`, `entityId` omis. */
  const sortieAvecNulls = (assetId: number) => {
    const o = sortieT1({
      title: 'Facture entretien chaudière', date: '2026-04-24', documentTypeCode: 'MAINTENANCE_INVOICE',
      assets: [{ id: assetId, label: 'Maison' }],
      facts: [{ canonicalKey: 'lastRevision', value: '2026-04-24', valueType: 'date', excerpt: 'Entretien réalisé le 24/04/2026', assetId }],
    }) as Record<string, any>;
    o.document.supplier = null;
    o.document.amountCents = null;
    o.document.description = null;
    o.visual = null;
    o.entities.assets[0].reason = null;
    o.facts[0].normalizedValue = { day: 24, month: 4, year: 2026 };
    return o;
  };

  it('E2E-REPAIR-01 (audit T1, incident 2644) — `null` et date objet : analyse réussie, faits persistés, diagnostic REPAIRED', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const f = await make.assetFile(compte, { assetId: bien.id });
    const r = await analyserDocument(sql, useRecordings, {
      accountId: compte.id, userId: compte.ownerUserId, fileId: f.id, linkedAssetId: bien.id, output: sortieAvecNulls(bien.id),
    });
    expect(r.analysedCount).toBe(1);
    const [etat] = await sql<{ analysis_state: string }[]>`SELECT analysis_state FROM asset_files WHERE id = ${f.id}`;
    expect(etat.analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    const faits = await sql<{ fact_key: string }[]>`SELECT fact_key FROM document_facts WHERE file_id = ${f.id}`;
    expect(faits.map((x) => x.fact_key)).toContain('lastRevision');
    const [d] = await sql<{ outcome: string; diagnostic: { repairs: Array<{ rule: string; path: string }> } }[]>`
      SELECT outcome, diagnostic FROM ai_call_diagnostics WHERE source_ids @> ARRAY[${f.id}::int] ORDER BY id DESC LIMIT 1`;
    expect(d.outcome).toBe('REPAIRED');
    expect(d.diagnostic.repairs.map((x) => x.rule)).toEqual(expect.arrayContaining(['null_as_absent', 'date_object_to_iso']));
  });

  it('E2E-REPAIR-02 (cas 8) — document en échec INVALID_OUTPUT → rejeu automatique → analyse réussie, idempotent', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const bien = await make.asset(compte);
    const f = await fichierAnalysable(compte);
    await sql`UPDATE asset_files SET asset_id = ${bien.id}, analysis_state = 'ANALYSIS_FAILED', analysis_retry_count = 10,
                analysis_fail_reason = ${'Analyse impossible (prompt maître T1) : Tous les modèles ont échoué. gemini-2.5-pro : Sortie non conforme au schéma. document.supplier : Invalid input: expected object, received null'}
              WHERE id = ${f.id}`;
    const { registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const { runInvalidOutputReplay } = await import('@/services/ai/source-analysis/invalid-output-replay.job');
    registerSourceAnalysisHandler();
    const version = `e2e-${Date.now()}`;
    await useRecordings([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortieAvecNulls(bien.id), repeat: true }]);

    const r1 = await runInvalidOutputReplay({ version, maxPerRun: 200 });
    expect(r1.enqueued).toBeGreaterThanOrEqual(1);
    const [reserve] = await sql<{ status: string; failure_source: string; signature: string }[]>`
      SELECT status, failure_source, signature FROM ai_output_replays WHERE file_id = ${f.id} AND resolution_version = ${version}`;
    expect(reserve).toMatchObject({ status: 'ENQUEUED', failure_source: 'fail_reason' });
    // Sans action utilisateur : la file T1 existante analyse le document.
    await ecarterLesAutresJobsT1([f.id]);
    expect(await runOne('T1')).toBe(true);
    const [apres] = await sql<{ analysis_state: string }[]>`SELECT analysis_state FROM asset_files WHERE id = ${f.id}`;
    expect(apres.analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    // État métier observé : faits ACTIFS (les analyses précédentes sont
    // versionnées `superseded`), échéances, liaisons document → bien.
    const etatMetier = async () => {
      const [x] = await sql<{ faits: number; echeances: number; liens: number }[]>`
        SELECT (SELECT COUNT(*)::int FROM document_facts WHERE file_id = ${f.id} AND status = 'active') AS faits,
               (SELECT COUNT(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS echeances,
               (SELECT COUNT(*)::int FROM document_asset_links WHERE file_id = ${f.id}) AS liens`;
      return x;
    };
    await drainQueues(); // effets T3 / T4 de l'analyse rejouée (échéances, liaisons)
    const avant = await etatMetier();
    const nFaits = avant.faits;
    expect(nFaits).toBeGreaterThan(0);

    // Passage suivant : rejeu clos (SUCCEEDED), aucun second rejeu du même document.
    const r2 = await runInvalidOutputReplay({ version, maxPerRun: 200 });
    expect(r2.closed.succeeded).toBeGreaterThanOrEqual(1);
    const lignes = await sql<{ status: string }[]>`SELECT status FROM ai_output_replays WHERE file_id = ${f.id}`;
    expect(lignes.filter((l) => l.status === 'SUCCEEDED')).toHaveLength(1);
    expect(lignes).toHaveLength(1);
    const jobs = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND target_id = ${String(f.id)}`;
    expect(jobs[0].n).toBe(1);

    // Idempotence de l'analyse : une nouvelle analyse ne duplique aucun fait.
    await analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId: f.id, linkedAssetId: bien.id, output: sortieAvecNulls(bien.id) });
    // Idempotence (§30) : aucun fait, aucune échéance, aucune liaison en double.
    expect(await etatMetier()).toEqual(avant);
  });

  it('purge à l’horizon de rétention des traces IA (sortie modèle comprise)', async () => {
    const [vieux] = await sql<{ id: number }[]>`
      INSERT INTO ai_call_diagnostics (created_at, trace_id, operation_code, outcome, raw_output)
      VALUES (now() - interval '120 days', 'e2e-purge', 't1_analyze_document', 'FAILED', 'secret') RETURNING id`;
    const [recent] = await sql<{ id: number }[]>`
      INSERT INTO ai_call_diagnostics (trace_id, operation_code, outcome) VALUES ('e2e-purge', 't1_analyze_document', 'FAILED') RETURNING id`;
    const { purgeCallDiagnostics } = await import('@/services/ai/gateway/diagnostics/diagnostic.repository');
    expect(await purgeCallDiagnostics({ olderThanDays: 88 })).toBeGreaterThanOrEqual(1);
    const restants = await sql<{ id: number }[]>`SELECT id FROM ai_call_diagnostics WHERE id = ANY(${[vieux.id, recent.id]})`;
    expect(restants.map((r) => Number(r.id))).toEqual([Number(recent.id)]);
  });
});
