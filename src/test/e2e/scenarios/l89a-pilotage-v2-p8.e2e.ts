/**
 * Lot 89A — CDC Pilotage IA V2, phase P8 (MIG-02, MIG-03, LOG-08, R23, R59,
 * LIV-02), sur base PostgreSQL réelle. Assertions limitées aux appels,
 * travaux et versions créés par ce scénario.
 *
 *   L89A-E2E-MIG  migrations 0776 / 0777 idempotentes (deux passes), colonnes et index
 *   L89A-E2E-01   reclassement : simulation sans écriture ; application (métier
 *                 prouvé + issue, technique, non déterminable motivé) ; appels du
 *                 nouveau chemin jamais touchés ; colonnes d'origine intactes
 *   L89A-E2E-02   idempotent : seconde application = aucune écriture, mêmes valeurs
 *   L89A-E2E-03   agrégats : appels et coûts de l'exécution, exécution du détail d'appel
 *   L89A-E2E-04   configurations existantes « manuel, non qualifié » ; candidate
 *                 automatique jamais marquée ; résolution des configurations
 *                 strictement identique (aucun changement de comportement)
 *   L89A-E2E-05   retour arrière : « Restaurer » retire classements et marques ; rejouable
 *   L89A-E2E-06   tâche planifiée : rien sans AI_PILOTAGE_V2=on ; classe avec on
 */
import { afterAll, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

scenario('L89A', 'Reclassement de l’historique et configurations existantes (Pilotage IA V2 P8)', ({ sql, make }) => {
  const svc = () => import('@/services/ai/history-reclassification/service');
  const ANCIEN = '2026-01-15T10:00:00.000Z';
  const mesAppels: number[] = [];
  const mesVersions: number[] = [];
  const avantPilotage = process.env.AI_PILOTAGE_V2;
  afterAll(() => {
    if (avantPilotage === undefined) delete process.env.AI_PILOTAGE_V2; else process.env.AI_PILOTAGE_V2 = avantPilotage;
  });

  const appel = async (o: { account: number | null; useCase: string | null; op: string; job?: number | null; trace?: string; meta?: Record<string, unknown>; be?: string | null; cost?: number | null; status?: string }) => {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, is_billable, operation_type, use_case_code, operation_code, provider, model, status, cost_micros, job_id, metadata, business_execution_id, created_at)
      VALUES (${o.account}, ${o.account !== null}, ${o.op}, ${o.useCase}, ${o.op}, 'gemini', 'gemini-2.5-flash', ${o.status ?? 'success'}, ${o.cost === undefined ? 120 : o.cost}, ${o.job ?? null},
              ${JSON.stringify({ traceId: o.trace ?? `l89a-${Math.random()}`, ...(o.meta ?? {}) })}::jsonb, ${o.be ?? null}, ${ANCIEN}::timestamptz)
      RETURNING id`;
    mesAppels.push(Number(r.id));
    return Number(r.id);
  };
  const ligne = async (id: number) => (await sql<Array<Record<string, unknown>>>`SELECT * FROM ai_usage_event WHERE id = ${id}`)[0];
  const sansHistorique = (r: Record<string, unknown>) => { const { history_class: _a, history_execution_id: _b, ...rest } = r; return rest; };

  let ids: Record<string, number> = {};
  let t3Exec = '';

  it('L89A-E2E-MIG — migrations 0776 et 0777 idempotentes (deux passes), colonnes et index présents', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const f of (await readdir(join(process.cwd(), 'src/db/migrations'))).filter((x) => /^077[67]_l89a_/.test(x)).sort()) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const cols = await sql<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns
      WHERE (table_name = 'ai_usage_event' AND column_name IN ('history_class', 'history_execution_id'))
         OR (table_name = 'ai_config_versions' AND column_name = 'provenance_mark') ORDER BY 1`;
    expect(cols.map((x) => x.c)).toEqual(['ai_config_versions.provenance_mark', 'ai_usage_event.history_class', 'ai_usage_event.history_execution_id']);
    expect(await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'ai_usage_event_history_execution_idx'`).toHaveLength(1);
    // Aucune table nouvelle : rien à classer au registre de couverture ni au catalogue de recette.
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'ai_history%'`).toHaveLength(0);
  });

  it('L89A-E2E-01 — simulation sans écriture, puis application : métier prouvé + issue, technique, non déterminable ; nouveau chemin intact', async () => {
    const c = await make.account();
    const [job] = await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts,
        business_result, created_at, started_at, finished_at, payload)
      VALUES ('T3', ${c.id}, 'asset', '1', ${`l89a:${Math.random()}`}, 'DONE', 'automatic', 'source_analyzed', 1, 'APPLIED',
              ${ANCIEN}::timestamptz, ${ANCIEN}::timestamptz, ${ANCIEN}::timestamptz, '{}'::jsonb) RETURNING id`;
    t3Exec = `T3:${job.id}`;
    ids = {
      t3: await appel({ account: c.id, useCase: 'DATA_RECONCILIATION', op: 't3_value_conflict', job: job.id, cost: 300 }),
      t2: await appel({ account: c.id, useCase: 'INTELLIGENT_ASSISTANT', op: 't2_answer' }),
      sonde: await appel({ account: null, useCase: 'AI_GOVERNANCE', op: 'model_probe' }),
      disparu: await appel({ account: c.id, useCase: 'AGENDA_INTELLIGENCE', op: 't4_classify_event', job: 2_000_000_000 }),
      nouveau: await appel({ account: c.id, useCase: 'SOURCE_ANALYSIS', op: 't1_analyze_document', be: 'T1:job:1' }),
      groupe: await appel({ account: c.id, useCase: 'HOME_MASCOT', op: 't6_evaluate', meta: { businessExecutionIds: ['T6E:1:1', 'T6E:2:1'] } }),
    };
    const avant = new Map(await Promise.all(Object.values(ids).map(async (id) => [id, await ligne(id)] as const)));
    const { runHistoryReclassification } = await svc();

    const sim = await runHistoryReclassification({ apply: false });
    expect(sim.disabled).toBeNull();
    expect(sim.calls.classified).toBe(0);
    expect(sim.calls.samples.length).toBeGreaterThan(0);
    for (const id of Object.values(ids)) expect((await ligne(id)).history_class).toBeNull();

    const app = await runHistoryReclassification({ apply: true });
    expect(app.calls.classified).toBeGreaterThanOrEqual(4);
    const k = async (id: number) => (await ligne(id)).history_class as Record<string, unknown> | null;
    expect(await k(ids.t3)).toMatchObject({ rule: 'p8-historique-v1', nature: 'BUSINESS', treatment: 'T3', executionId: t3Exec, outcome: 'SUCCEEDED', reason: null });
    expect((await ligne(ids.t3)).history_execution_id).toBe(t3Exec);
    expect(((await k(ids.t3))!.evidence as Array<{ source: string }>).map((e) => e.source)).toEqual(['ai_usage_event', 'ai_job_queue']);
    expect(await k(ids.sonde)).toMatchObject({ nature: 'TECHNICAL', executionId: null });
    const t2 = await k(ids.t2);
    expect(t2).toMatchObject({ nature: 'UNDETERMINED', treatment: 'T2', executionId: null, outcome: 'UNDETERMINED' });
    expect(String(t2!.reason)).toContain('ne prouve rien');
    expect(await k(ids.disparu)).toMatchObject({ nature: 'UNDETERMINED', treatment: 'T4' });
    for (const id of [ids.t2, ids.sonde, ids.disparu]) expect((await ligne(id)).history_execution_id).toBeNull();
    // Nouveau chemin (colonne renseignée, ou liste T6 EVALUATE) : jamais touché.
    expect(await k(ids.nouveau)).toBeNull();
    expect(await k(ids.groupe)).toBeNull();
    // Non destructif : toutes les colonnes d'origine identiques.
    for (const [id, r] of avant) expect(sansHistorique(await ligne(id)), `appel ${id}`).toEqual(sansHistorique(r));
  });

  it('L89A-E2E-02 — idempotent : seconde application sans écriture, classements inchangés', async () => {
    const avant = await sql<{ id: number; history_class: unknown }[]>`SELECT id, history_class FROM ai_usage_event WHERE id = ANY(${mesAppels}) ORDER BY id`;
    const { runHistoryReclassification } = await svc();
    const r = await runHistoryReclassification({ apply: true });
    const apres = await sql<{ id: number; history_class: unknown }[]>`SELECT id, history_class FROM ai_usage_event WHERE id = ANY(${mesAppels}) ORDER BY id`;
    expect(apres).toEqual(avant);
    expect(r.calls.alreadyClassified).toBeGreaterThanOrEqual(4);
  });

  it('L89A-E2E-03 — agrégats : l’appel reclassé compte dans les appels et coûts de son exécution ; détail d’appel → exécution', async () => {
    const repo = await import('@/services/ai/business-execution/repository');
    const calls = await repo.callsOfExecutions([{ id: t3Exec, traceIds: [] }]);
    expect(calls.get(t3Exec)).toMatchObject({ calls: 1, costMicros: 300, usageEventIds: [ids.t3] });
    expect(await repo.businessExecutionIdsOfCall(ids.t3)).toEqual([t3Exec]);
    expect(await repo.businessExecutionIdsOfCall(ids.t2)).toEqual([]);
    const { readExecutionCalls } = await import('@/services/ai/business-execution/detail');
    expect((await readExecutionCalls({ id: t3Exec, traceIds: [] })).calls.map((x) => x.id)).toEqual([ids.t3]);
    // Colonne « traitement » de la vue technique et ligne du détail.
    const { searchExecutions } = await import('@/services/ai/telemetry/execution-log.repository');
    const page = await searchExecutions({ operationCode: 't2_answer', since: new Date('2026-01-15T00:00:00Z'), until: new Date('2026-01-16T00:00:00Z'), limit: 200 });
    const r = page.rows.find((x) => x.id === ids.t2);
    expect(r?.history).toMatchObject({ nature: 'UNDETERMINED', treatment: 'T2' });
  });

  it('L89A-E2E-04 — configurations existantes « manuel, non qualifié », candidate jamais marquée, comportement identique', async () => {
    const [m] = await sql<{ id: number }[]>`INSERT INTO ai_config_versions (environment, status, label, created_at, updated_at)
      VALUES ('local', 'DRAFT', 'l89a manuelle', ${'2026-01-10T08:00:00Z'}::timestamptz, ${'2026-01-10T08:00:00Z'}::timestamptz) RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO ai_config_versions (environment, status, label, origin, candidate_state, created_at)
      VALUES ('local', 'DRAFT', 'l89a candidate', 'auto', 'CREATED', ${'2026-01-10T08:00:00Z'}::timestamptz) RETURNING id`;
    mesVersions.push(Number(m.id), Number(a.id));
    await sql`UPDATE ai_config_versions SET provenance_mark = NULL WHERE id = ANY(${mesVersions})`;
    const resolver = await import('@/services/ai/config/config-resolver');
    const resoudre = async () => {
      resolver.invalidateConfigCache();
      const out: unknown[] = [];
      for (const t of ['T1', 'T2', 'T3', 'T4', 'T6'] as const) out.push(await resolver.resolveTreatmentConfig(t));
      out.push(await resolver.resolveOperationConfig('t1_analyze_document'), await resolver.resolveEffectiveVersionId());
      return JSON.parse(JSON.stringify(out));
    };
    const avant = await resoudre();
    const majAvant = await sql<{ id: number; updated_at: Date | null }[]>`SELECT id, updated_at FROM ai_config_versions ORDER BY id`;
    const { runHistoryReclassification } = await svc();
    const r = await runHistoryReclassification({ apply: true });
    expect(r.configurations.versionIds).toContain(Number(m.id));
    expect(r.configurations.versionIds).not.toContain(Number(a.id));
    const marque = await sql<{ id: number; provenance_mark: Record<string, unknown> | null }[]>`SELECT id, provenance_mark FROM ai_config_versions WHERE id = ANY(${mesVersions}) ORDER BY id`;
    expect(marque.find((x) => x.id === m.id)?.provenance_mark).toMatchObject({ provenance: 'manual', proof: 'not_qualified', label: 'manuel, non qualifié', rule: 'p8-historique-v1' });
    expect(marque.find((x) => x.id === a.id)?.provenance_mark).toBeNull();
    // Comportement inchangé : même résolution, aucune date de modification touchée.
    expect(await resoudre()).toEqual(avant);
    expect(await sql<{ id: number; updated_at: Date | null }[]>`SELECT id, updated_at FROM ai_config_versions ORDER BY id`).toEqual(majAvant);
    // Lecture BO : la version porte sa marque.
    const repo = await import('@/services/ai/config/config-version.repository');
    const liste = await repo.listVersions('local', 1000);
    expect(liste.find((v) => v.id === m.id)?.provenanceMark).toMatchObject({ label: 'manuel, non qualifié' });
    expect(liste.find((v) => v.id === a.id)?.provenanceMark ?? null).toBeNull();
  });

  it('L89A-E2E-05 — retour arrière : « Restaurer » retire classements et marques, sans toucher l’origine ; rejouable', async () => {
    const { restoreHistoryReclassification, runHistoryReclassification } = await svc();
    const { HISTORY_RULE_RUN_ID } = await import('@/services/ai/history-reclassification/rule');
    const avant = await ligne(ids.t3);
    const r = await restoreHistoryReclassification(HISTORY_RULE_RUN_ID);
    expect(r.callsRestored).toBeGreaterThanOrEqual(4);
    expect(r.configurationsRestored).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT 1 FROM ai_usage_event WHERE id = ANY(${mesAppels}) AND (history_class IS NOT NULL OR history_execution_id IS NOT NULL)`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM ai_config_versions WHERE id = ANY(${mesVersions}) AND provenance_mark IS NOT NULL`).toHaveLength(0);
    expect(sansHistorique(await ligne(ids.t3))).toEqual(sansHistorique(avant));
    const again = await runHistoryReclassification({ apply: true });
    expect(again.calls.classified).toBeGreaterThanOrEqual(4);
    expect((await ligne(ids.t3)).history_execution_id).toBe(t3Exec);
  });

  it('L89A-E2E-06 — tâche planifiée : rien sans AI_PILOTAGE_V2=on, classe avec on', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const tache = SCHEDULED_TASKS.find((t) => t.code === 'ai-history-reclassification')!;
    const { restoreHistoryReclassification } = await svc();
    const { HISTORY_RULE_RUN_ID } = await import('@/services/ai/history-reclassification/rule');
    await restoreHistoryReclassification(HISTORY_RULE_RUN_ID);
    delete process.env.AI_PILOTAGE_V2;
    const off = await tache.run({ deadline: Date.now() + 60_000, trigger: 'startup' });
    expect((off as { note?: string }).note).toContain('en attente du jour J');
    expect(await sql`SELECT 1 FROM ai_usage_event WHERE id = ANY(${mesAppels}) AND history_class IS NOT NULL`).toHaveLength(0);
    process.env.AI_PILOTAGE_V2 = 'on';
    const on = await tache.run({ deadline: Date.now() + 60_000, trigger: 'startup' });
    expect((on as { note?: string }).note).toContain('p8-historique-v1');
    expect((await ligne(ids.t3)).history_execution_id).toBe(t3Exec);
    expect((await ligne(ids.nouveau)).history_class).toBeNull();
  });
});
