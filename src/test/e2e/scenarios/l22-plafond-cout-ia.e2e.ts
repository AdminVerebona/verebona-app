/**
 * Lot 22, chantier A — plafond mensuel de coût IA par compte, sur base réelle.
 *
 *   · migration 0235 : table des dérogations et index du cumul, idempotente ;
 *   · plafond absent : comportement inchangé (analyse T1 menée à terme) ;
 *   · 80 % : UNE alerte `ai_alerts` par compte et par période, même depuis
 *     plusieurs instances ;
 *   · 100 % : T1 non lancé, job reporté au 1er du mois suivant (une seule
 *     reprise, aucune tentative consommée), fichier « en file » avec le motif,
 *     absent du bandeau ; repris à la période suivante ; T2 : repli « sources
 *     seules » (plafond refusé) ;
 *   · dérogation par compte prioritaire sur l'offre, posée par la route admin
 *     existante (`PATCH …/quota`), journalisée, travaux reportés remis en file ;
 *   · réglage par offre journalisé (`admin_audit_log`).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { sortieT1, useTargetState } from '../chain';

const credits = vi.hoisted(() => ({ consume: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => credits.consume(...a),
}));
const session = vi.hoisted(() => ({ adminId: 0, email: 'admin@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'ai_cost_cap_premium_duo_micros';
const PLAFOND = 10_000_000; // 10 $

scenario('L22-A', 'Plafond mensuel de coût IA par compte (offre, dérogation, report T1, repli T2)', ({ sql, make, useRecordings }) => {
  useTargetState();

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  beforeAll(async () => {
    await ecarterLesAutresJobsT1();
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    S.setAssistantSettingsStoreForTests(S.dbAssistantSettingsStore);
    const C = await import('@/services/ai/gateway/account-cost-cap');
    C.setCostCapStoreForTests(C.dbCostCapStore);
  });
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
    await sql`DELETE FROM verebona_assistant_settings WHERE key = ${CLE}`;
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    S.setAssistantSettingsStoreForTests(null);
    (await import('@/services/ai/gateway/account-cost-cap')).setCostCapStoreForTests(null);
  });

  const compteDuo = async () => {
    const c = await make.account();
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO' WHERE id = ${c.id}`;
    return c;
  };
  const depenser = async (accountId: number, micros: number, useCase = 'SOURCE_ANALYSIS') => {
    await sql`INSERT INTO ai_usage_event (account_id, operation_type, use_case_code, operation_code, cost_micros, status)
              VALUES (${accountId}, 't1_analyze_document', ${useCase}, 't1_analyze_document', ${micros}, 'success')`;
  };
  const poserPlafondOffre = async (micros: number) => {
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    const admin = await make.user({ role: 'ADMIN' });
    const r = await S.updateAssistantSetting({ key: CLE, value: micros, adminId: admin.id });
    (await import('@/services/ai/gateway/account-cost-cap')).resetCostCapCache();
    return { admin, r };
  };
  const fichierAnalysable = async (compte: Parameters<typeof make.assetFile>[0]) => {
    const f = await make.assetFile(compte);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const etat = async (id: number) => (await sql<{ analysis_state: string | null; analysis_fail_reason: string | null }[]>`
    SELECT analysis_state, analysis_fail_reason FROM asset_files WHERE id = ${id}`)[0];
  const jobDe = async (id: number) => (await sql<{ id: number; status: string; attempts: number; available_at: Date; last_error: string | null; payload: Record<string, unknown> }[]>`
    SELECT id, status, attempts, available_at, last_error, payload FROM ai_job_queue
     WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];
  const sortie = () => [{
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
    output: sortieT1({ title: 'Facture entretien', date: '2026-03-14', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [], facts: [] }),
  }];

  it('migration 0235 : idempotente (table et index valide)', async () => {
    for (const fichier of ['0235_ai_account_cost_cap.sql', '0235_ai_account_cost_cap_idx_1.sql']) {
      const texte = await readFile(join(process.cwd(), 'src/db/migrations', fichier), 'utf-8');
      const cnx = await sql.reserve();
      try {
        const runner: SqlRunner = {
          unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown>,
          reserve: async () => {
            const r = await sql.reserve();
            return { unsafe: (q: string, p?: never[]) => r.unsafe(q, p as never) as unknown as Promise<unknown>, release: () => r.release() };
          },
        };
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${fichier} passe ${passe}`).resolves.toBeDefined();
      } finally {
        cnx.release();
      }
    }
    const [idx] = await sql<{ valide: boolean }[]>`
      SELECT i.indisvalid AS valide FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'ai_usage_event_account_created_idx'`;
    expect(idx?.valide).toBe(true);
    const [t] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'ai_account_cost_caps'`;
    expect(t.n).toBe(1);
  });

  it('plafond absent : aucun plafond, analyse T1 menée à terme (comportement inchangé)', async () => {
    await ecarterLesAutresJobsT1();
    await sql`DELETE FROM verebona_assistant_settings WHERE key = ${CLE}`;
    const C = await import('@/services/ai/gateway/account-cost-cap');
    C.resetCostCapCache();
    const compte = await compteDuo();
    await depenser(compte.id, 999_000_000);
    expect(await C.getAccountCostCapStatus(compte.id)).toMatchObject({ capMicros: null, level: 'none', spentMicros: null });

    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    await useRecordings(sortie());
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    expect(await runOne('T1')).toBe(true);
    expect((await jobDe(f.id)).status).toBe('DONE');
    expect((await etat(f.id)).analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
  });

  it('réglage par offre journalisé (auteur, avant / après)', async () => {
    const { admin, r } = await poserPlafondOffre(PLAFOND);
    expect(r).toMatchObject({ status: 'APPLIED', after: PLAFOND });
    const [j] = await sql<{ admin_email: string; old_value: unknown; new_value: unknown; result: string }[]>`
      SELECT admin_email, old_value, new_value, result FROM admin_audit_log
       WHERE action_type = 'ASSISTANT_SETTING_UPDATE' AND admin_user_id = ${admin.id} ORDER BY id DESC LIMIT 1`;
    expect(j).toMatchObject({ admin_email: admin.email, result: 'SUCCESS', new_value: { key: CLE, value: PLAFOND } });
  });

  it('80 % : UNE alerte par compte et par période, même depuis deux instances', async () => {
    await poserPlafondOffre(PLAFOND);
    const C = await import('@/services/ai/gateway/account-cost-cap');
    const compte = await compteDuo();
    await depenser(compte.id, 8_500_000);
    await depenser(compte.id, 50_000_000, 'AI_GOVERNANCE'); // T5 : hors cumul
    const appel = () => C.assertAccountCostCap({ accountId: compte.id, useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 't2_answer' });
    await expect(appel()).resolves.toBeUndefined();
    await appel();
    C.resetCostCapCache(); // seconde instance : mémoire vide, dédoublonnage en base
    await appel();
    const alertes = await sql<{ code: string; severity: string; dedupe_key: string }[]>`
      SELECT code, severity, dedupe_key FROM ai_alerts WHERE account_id = ${compte.id}`;
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toMatchObject({ code: 'account_cost_cap_threshold', severity: 'warning' });
    expect(alertes[0].dedupe_key).toBe(`account_cost_cap:threshold:${compte.id}:${C.costCapPeriod().key}:${PLAFOND}`);
  });

  it('100 % : T1 reporté au 1er (motif, hors bandeau), T2 en repli ; repris à la période suivante', async () => {
    await ecarterLesAutresJobsT1();
    credits.consume.mockClear();
    await poserPlafondOffre(PLAFOND);
    const C = await import('@/services/ai/gateway/account-cost-cap');
    const compte = await compteDuo();
    await depenser(compte.id, PLAFOND + 1);
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    const replay = await useRecordings(sortie());

    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    expect(await runOne('T1')).toBe(true);

    const reporte = await jobDe(f.id);
    const reprise = C.costCapPeriod().end;
    expect(reporte).toMatchObject({ status: 'PENDING', attempts: 0, payload: { costCapDeferredUntil: reprise.toISOString() } });
    expect(new Date(reporte.available_at).getTime()).toBe(reprise.getTime() + 60_000); // marge de 60 s
    expect(reporte.last_error).toMatch(/^Plafond IA du mois atteint, reprise le 1er /);
    expect(await etat(f.id)).toMatchObject({ analysis_state: 'UPLOADED', analysis_fail_reason: C.costCapAnalysisReason(reprise) });
    expect(replay.calls).toHaveLength(0);
    expect(credits.consume).not.toHaveBeenCalled();
    // Bandeau : pas « analyse en cours » pendant des semaines.
    const { getT1QueueStatus } = await import('@/services/ai/source-analysis/queue/t1-status');
    expect((await getT1QueueStatus(compte.id)).files.find((x) => x.fileId === f.id)).toBeUndefined();
    // Aucune relance avant la période suivante (le job n'est pas disponible).
    const [dispo] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE id = ${reporte.id} AND available_at <= now()`;
    expect(dispo.n).toBe(0);
    // Alerte critique, une fois.
    const [crit] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE account_id = ${compte.id} AND code = 'account_cost_cap_reached'`;
    expect(crit.n).toBe(1);

    // T2 : plafond du compte refusé → repli « sources seules » ; la passerelle refuse aussi.
    const { checkMonthlyBudget } = await import('@/services/verebona-assistant/core/budget.service');
    expect((await checkMonthlyBudget(compte.id)).allowed).toBe(false);
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const { z } = await import('zod');
    await expect(AiGateway.execute({
      useCaseCode: 'HOME_MASCOT', operationCode: 't6_formulate', accountId: compte.id,
      promptVariables: { INPUT_JSON: '{}' }, outputSchema: z.any(), idempotencyKey: `l22-${compte.id}`,
    })).rejects.toMatchObject({ code: 'COST_CAP_REACHED' });

    // Période suivante : le cumul du nouveau mois est nul, le job devient disponible.
    await sql`UPDATE ai_usage_event SET created_at = created_at - interval '40 days' WHERE account_id = ${compte.id}`;
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${reporte.id}`;
    C.resetCostCapCache();
    expect(await runOne('T1')).toBe(true);
    expect((await jobDe(f.id)).status).toBe('DONE');
    const apres = await etat(f.id);
    expect(apres.analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    expect(apres.analysis_fail_reason).toBeNull(); // motif plafond effacé à la reprise
    expect(credits.consume).toHaveBeenCalledWith(compte.id, 1);
  });

  it('100 %, analyse directe (hors file) : rien lancé, source confiée à la file au 1er, motif daté', async () => {
    await ecarterLesAutresJobsT1();
    await poserPlafondOffre(PLAFOND);
    const C = await import('@/services/ai/gateway/account-cost-cap');
    const compte = await compteDuo();
    await depenser(compte.id, PLAFOND);
    const f = await fichierAnalysable(compte);
    const replay = await useRecordings(sortie());
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, origin: 'documents/analyze' });
    expect(r).toMatchObject({ skippedReason: 'cost_cap', analysedCount: 0, failedSourceIds: [] });
    expect(replay.calls).toHaveLength(0);
    const reprise = C.costCapPeriod().end;
    const job = await jobDe(f.id);
    expect(job).toMatchObject({ status: 'PENDING', payload: { fileId: f.id, origin: 'documents/analyze', costCapDeferredUntil: reprise.toISOString() } });
    expect(Math.abs(new Date(job.available_at).getTime() - (reprise.getTime() + 60_000))).toBeLessThan(5_000);
    expect(await etat(f.id)).toMatchObject({ analysis_state: 'UPLOADED', analysis_fail_reason: C.costCapAnalysisReason(reprise) });
    await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE id = ${job.id}`;
  });

  it('dérogation par compte (PATCH …/quota) : prioritaire, journalisée, travaux reportés remis en file', async () => {
    await ecarterLesAutresJobsT1();
    await poserPlafondOffre(PLAFOND);
    const C = await import('@/services/ai/gateway/account-cost-cap');
    const compte = await compteDuo();
    await depenser(compte.id, PLAFOND + 1);
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    await runOne('T1');
    expect((await jobDe(f.id)).payload).toHaveProperty('costCapDeferredUntil');

    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    session.email = admin.email;
    const { PATCH } = await import('@/app/api/admin/ai/accounts/[accountId]/quota/route');
    const { NextRequest } = await import('next/server');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/admin/ai/accounts/${compte.id}/quota`, {
        method: 'PATCH', body: JSON.stringify({ monthlyCostCapMicros: 50_000_000, reason: 'client pilote' }),
      }),
      { params: Promise.resolve({ accountId: String(compte.id) }) },
    );
    expect(res.status).toBe(200);
    const corps = await res.json() as { costCap: { capMicros: number; source: string; level: string } };
    expect(corps.costCap).toMatchObject({ capMicros: 50_000_000, source: 'override', level: 'ok' });

    const [audit] = await sql<{ action_type: string; before_value: unknown; after_value: unknown; reason: string; admin_email: string }[]>`
      SELECT action_type, before_value, after_value, reason, admin_email FROM ai_admin_audit_log
       WHERE target_account_id = ${compte.id} ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({
      action_type: 'modify_quota', before_value: { monthlyCostCapMicros: null },
      after_value: { monthlyCostCapMicros: 50_000_000 }, reason: 'client pilote', admin_email: admin.email,
    });
    // Le job reporté est remis en file tout de suite (plafond relevé).
    const remis = await jobDe(f.id);
    expect(remis.payload).not.toHaveProperty('costCapDeferredUntil');
    expect((await etat(f.id)).analysis_fail_reason).toBeNull(); // motif plus d'actualité
    expect(new Date(remis.available_at).getTime()).toBeLessThanOrEqual(Date.now());
    await expect(C.assertAccountCostCap({ accountId: compte.id, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_analyze_document' })).resolves.toBeUndefined();

    // Dérogation 0 = sans plafond ; null = retour au plafond de l'offre.
    await C.setAccountCostCapOverride(compte.id, 0, { id: admin.id }, null);
    expect(await C.getAccountCostCapStatus(compte.id)).toMatchObject({ capMicros: null, source: 'override' });
    await C.setAccountCostCapOverride(compte.id, null, { id: admin.id }, null);
    expect(await C.getAccountCostCapStatus(compte.id)).toMatchObject({ capMicros: PLAFOND, source: 'offer', level: 'reached' });
    await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE id = ${remis.id}`;

    // Compte inexistant → 404 ; nombre transmis en texte → 400 (validation stricte).
    const appeler = (id: number, body: unknown) => PATCH(
      new NextRequest(`http://localhost/api/admin/ai/accounts/${id}/quota`, { method: 'PATCH', body: JSON.stringify(body) }),
      { params: Promise.resolve({ accountId: String(id) }) },
    );
    expect((await appeler(99_999_999, { monthlyCostCapMicros: 1 })).status).toBe(404);
    expect((await appeler(compte.id, { monthlyCostCapMicros: '5000000' })).status).toBe(400);
    expect((await appeler(compte.id, { monthlyCostCapMicros: 1.5 })).status).toBe(400);
    expect((await appeler(compte.id, { monthlyCostCapMicros: 1_000_000_001 })).status).toBe(400);
  });

  it('plafond franchi PENDANT une analyse directe : jamais ANALYSIS_FAILED, « en file » avec le motif, confiée à la file au 1er', async () => {
    await ecarterLesAutresJobsT1();
    await poserPlafondOffre(PLAFOND);
    const C = await import('@/services/ai/gateway/account-cost-cap');
    const compte = await compteDuo();
    await depenser(compte.id, PLAFOND);
    // Contrôle préalable sous le plafond, refus de la passerelle ensuite.
    let lectures = 0;
    C.setCostCapStoreForTests({ ...C.dbCostCapStore, spent: async (...a) => (lectures++ === 0 ? 0 : C.dbCostCapStore.spent(...a)) });
    try {
      const f = await fichierAnalysable(compte);
      const replay = await useRecordings(sortie());
      const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
      const r = await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, origin: 'documents/analyze' });
      expect(lectures).toBeGreaterThanOrEqual(2);
      expect(replay.calls).toHaveLength(0);
      expect(r).toMatchObject({ skippedReason: 'cost_cap', failedSourceIds: [], costCapSourceIds: [f.id] });
      const reprise = C.costCapPeriod().end;
      const [e] = await sql<{ analysis_state: string; analysis_fail_reason: string; analysis_retry_count: number }[]>`
        SELECT analysis_state, analysis_fail_reason, analysis_retry_count FROM asset_files WHERE id = ${f.id}`;
      expect(e).toMatchObject({ analysis_state: 'UPLOADED', analysis_fail_reason: C.costCapAnalysisReason(reprise), analysis_retry_count: 0 });
      const job = await jobDe(f.id);
      expect(job).toMatchObject({ status: 'PENDING', payload: { costCapDeferredUntil: reprise.toISOString() } });
      await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE id = ${job.id}`;
    } finally {
      C.setCostCapStoreForTests(C.dbCostCapStore);
    }
  });

  it('remise en file : un contexte remplacé (payloadOnDedupe « replace ») garde le marqueur de report', async () => {
    const compte = await compteDuo();
    const repo = await import('@/services/ai/queue/job-queue.repository');
    const scope = { accountId: compte.id, targetType: 'asset_file', targetId: 777_000 + compte.id };
    const { jobId } = await repo.enqueue({ treatment: 'T4', scope, payload: { v: 1 }, delaySeconds: 86_400 });
    await sql`UPDATE ai_job_queue SET payload = payload || '{"costCapDeferredUntil":"2099-01-01T00:00:00.000Z"}'::jsonb WHERE id = ${jobId}`;
    await repo.enqueue({ treatment: 'T4', scope, payload: { v: 2 }, payloadOnDedupe: 'replace' });
    const [j] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM ai_job_queue WHERE id = ${jobId}`;
    expect(j.payload).toMatchObject({ v: 2, costCapDeferredUntil: '2099-01-01T00:00:00.000Z' });
    expect(await repo.releaseCostCapDeferredJobs(compte.id)).toBe(1);
    await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE id = ${jobId}`;
  });
});
