/**
 * Lot 49 (49E) — ticket 12 « BO IA — Supprimer définitivement T5 (Prompt
 * Control) sans régression des traitements IA », plan NR-03 / NR-04 sur
 * PostgreSQL réel :
 *   · migration 0336 exécutée une première puis une seconde fois : état
 *     opérationnel T5 archivé (copie vérifiable, réversible) puis neutralisé,
 *     historique intact, aucune ligne d'un autre traitement touchée, aucune
 *     NOUVELLE version / activation / test de prompt maître T5 (déclencheur),
 *     lignes historiques modifiables sans réécriture du traitement ;
 *     configuration T5 refusée par le serveur ;
 *   · lecture d'une ancienne version contenant T5, restauration (rollback)
 *     sans réactivation de T5, nouvelle version à cinq traitements ;
 *   · anciens prompts maîtres T5 conservés mais jamais proposés ;
 *   · anciennes traces t5_analyze / t5_modify consultables, distinctes des
 *     sondes techniques ; coûts techniques isolés, sans double comptage.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l49e-t5@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

scenario('L49E-12', 'Retrait de T5 : migration 0336, versions historiques, rollback, historiques et coûts', ({ sql, make }) => {
  let adminId = 0;
  let ancienne = 0;
  let activeAvant: number[] = [];
  let env = 'local';
  const debut = new Date(Date.now() - 1000);

  /** Pose une ligne HISTORIQUE (antérieure au lot 49) : déclencheurs suspendus le temps de la transaction. */
  const historique = (fn: (tx: typeof sql) => Promise<unknown>) => sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL session_replication_role = replica`);
    await fn(tx as unknown as typeof sql);
  });
  const rejouer0336 = async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0336_ai_retire_t5.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      await runMigrationSql(runner, texte);
    } finally {
      cnx.release();
    }
  };

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
  });

  afterAll(async () => {
    await sql`UPDATE ai_config_versions SET status = 'ARCHIVED' WHERE label LIKE 'e2e-l49e-12%' AND status <> 'ARCHIVED'`;
    await sql`UPDATE ai_config_versions SET status = 'VALIDATED' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE' WHERE id = ANY(${activeAvant})`;
    await sql`DELETE FROM ai_master_prompt_versions WHERE treatment = 'T5'`;
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
  });

  it('T12-AC14 — migration 0336 rejouée deux fois : état T5 archivé puis neutralisé, historique et autres traitements intacts', async () => {
    await historique(async (tx) => {
      await tx`INSERT INTO ai_treatment_state (treatment, state, suspended_reason) VALUES ('T5', 'DISABLED', 'e2e historique')
               ON CONFLICT (treatment) DO UPDATE SET state = 'DISABLED', suspended_reason = 'e2e historique'`;
      await tx`INSERT INTO ai_cost_settings (scope, monthly_budget_micros) VALUES ('T5', 4200000)
               ON CONFLICT (scope) DO UPDATE SET monthly_budget_micros = 4200000`;
    });
    await sql`INSERT INTO ai_treatment_state (treatment, state) VALUES ('T1', 'ENABLED') ON CONFLICT (treatment) DO NOTHING`;
    const t1Avant = JSON.stringify(await sql`SELECT * FROM ai_treatment_state WHERE treatment <> 'T5' ORDER BY treatment`);
    const [origine] = await sql<Record<string, unknown>[]>`SELECT * FROM ai_treatment_state WHERE treatment = 'T5'`;
    await sql`DELETE FROM ai_retired_treatment_archive WHERE treatment = 'T5'`;

    await rejouer0336();
    await rejouer0336();

    expect(await sql`SELECT 1 FROM ai_treatment_state WHERE treatment = 'T5'`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM ai_cost_settings WHERE scope = 'T5'`).toHaveLength(0);
    expect(JSON.stringify(await sql`SELECT * FROM ai_treatment_state WHERE treatment <> 'T5' ORDER BY treatment`)).toBe(t1Avant);
    const archives = await sql<{ source_table: string; row_key: string }[]>`
      SELECT source_table, row_key FROM ai_retired_treatment_archive WHERE treatment = 'T5' ORDER BY source_table`;
    expect(archives).toEqual([
      { source_table: 'ai_cost_settings', row_key: 'scope=T5' },
      { source_table: 'ai_treatment_state', row_key: 'treatment=T5' },
    ]);
    // Vérifiable et réversible : la copie restitue la ligne à l'identique.
    const [restituee] = await sql<Record<string, unknown>[]>`
      SELECT (jsonb_populate_record(NULL::ai_treatment_state, row_data)).* FROM ai_retired_treatment_archive
       WHERE source_table = 'ai_treatment_state' AND row_key = 'treatment=T5'`;
    expect(JSON.stringify(restituee)).toBe(JSON.stringify(origine));
    const [budget] = await sql<{ b: string }[]>`SELECT row_data->>'monthly_budget_micros' AS b FROM ai_retired_treatment_archive WHERE row_key = 'scope=T5'`;
    expect(budget.b).toBe('4200000');
  });

  it('T12-AC11 — aucune NOUVELLE version, activation ni test de prompt maître T5 (garde SQL) ; configuration refusée par le serveur ; historique modifiable', async () => {
    await expect(sql`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin)
                     VALUES (${env}, 'T5', 't5_master_v1', 99, 'DRAFT', 'x', 'x', 'admin')`).rejects.toThrow(/T5/);
    const [{ n: gardes }] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT c.relname)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'ai_retired_treatment_guard'
         AND c.relname IN ('ai_master_prompt_versions', 'ai_master_prompt_activations', 'ai_master_prompt_test_runs')`;
    expect(gardes).toBe(3);
    // Retour arrière applicatif : aucune garde sur la configuration, l'état et les budgets.
    const [{ n: sansGarde }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'ai_retired_treatment_guard'
         AND c.relname IN ('ai_config_entries', 'ai_treatment_state', 'ai_cost_settings', 'ai_job_queue', 'ai_master_corpus_runs')`;
    expect(sansGarde).toBe(0);
    // Une version historique ne peut pas DEVENIR T5 ; ses autres colonnes restent modifiables.
    await historique((tx) => tx`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin)
                                VALUES (${env}, 'T5', 't5_master_v1', 98, 'DRAFT', 'brouillon historique', 'x', 'prompt_control')`);
    await sql`UPDATE ai_master_prompt_versions SET updated_at = now() WHERE treatment = 'T5' AND version_number = 98`;
    await historique((tx) => tx`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin)
                                VALUES (${env}, 'T6', 't6_master_v1', 97, 'DRAFT', 'e2e', 'x', 'admin')`);
    await expect(sql`UPDATE ai_master_prompt_versions SET treatment = 'T5' WHERE treatment = 'T6' AND version_number = 97`).rejects.toThrow(/T5/);
    await sql`DELETE FROM ai_master_prompt_versions WHERE version_number IN (97, 98)`;

    // Configuration : le code refuse (dépôt) — aucune ligne T5 dans une nouvelle version.
    const repo = await import('@/services/ai/config/config-version.repository');
    const brouillon = await repo.createDraft(adminId, 'e2e-l49e-12 garde', env as never);
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    await expect(repo.saveEntry(brouillon.id, { ...emptyTreatmentConfig('T6'), treatment: 'T5' as never }, adminId)).rejects.toThrow(/inconnu ou retiré/);
    expect(await sql`SELECT 1 FROM ai_config_entries WHERE version_id = ${brouillon.id} AND treatment = 'T5'`).toHaveLength(0);
  });

  it('T12-AC09 / T12-AC08 / T12-AC11 — ancienne version à six lignes : lisible, restaurée sans réactiver T5 ; nouvelle version à cinq traitements', async () => {
    const repo = await import('@/services/ai/config/config-version.repository');
    const base = await repo.createDraft(adminId, 'e2e-l49e-12 ancienne', env as never);
    ancienne = base.id;
    await historique((tx) => tx`INSERT INTO ai_config_entries (version_id, treatment, prompt, primary_model)
                                VALUES (${ancienne}, 'T5', 'ancien préambule T5', 'gemini-3.6-flash')`);
    await sql`UPDATE ai_config_versions SET status = 'VALIDATED', activated_at = now() - interval '2 days', activated_by = ${adminId} WHERE id = ${ancienne}`;
    const [{ n: lignes }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_config_entries WHERE version_id = ${ancienne}`;
    expect(lignes).toBe(6);

    // Lecture : lisible, T5 signalé et écarté.
    const lue = await repo.getVersion(ancienne);
    expect(lue!.entries.map((e) => e.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(lue!.retiredTreatments).toEqual(['T5']);
    const { GET } = await import('@/app/api/admin/ai/config-versions/[id]/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://app.test/api/admin/ai/config-versions/${ancienne}`), { params: Promise.resolve({ id: String(ancienne) }) });
    expect(res.status).toBe(200);
    const corps = await res.json() as Record<string, any>;
    expect(JSON.stringify(corps)).toMatch(/"retiredTreatments":\["T5"\]/);

    // Restauration (rollback) : aucune réactivation de T5.
    const svc = await import('@/services/ai/config/config-version.service');
    await svc.rollback(ancienne, adminId);
    const active = await repo.getActiveVersion(env as never);
    expect(active!.id).toBe(ancienne);
    expect(active!.entries.map((e) => e.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    const { resolveTreatmentConfig, invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    expect(await resolveTreatmentConfig('T5' as never)).toBeNull();
    expect(await sql`SELECT 1 FROM ai_treatment_state WHERE treatment = 'T5'`).toHaveLength(0);
    // La ligne historique est conservée telle quelle (audit).
    const [t5] = await sql<{ prompt: string }[]>`SELECT prompt FROM ai_config_entries WHERE version_id = ${ancienne} AND treatment = 'T5'`;
    expect(t5.prompt).toBe('ancien préambule T5');

    // Nouvelle version depuis l'Active restaurée : exactement cinq traitements.
    const nouvelle = await repo.createDraft(adminId, 'e2e-l49e-12 nouvelle', env as never);
    const stockees = await sql<{ treatment: string }[]>`SELECT treatment FROM ai_config_entries WHERE version_id = ${nouvelle.id} ORDER BY treatment`;
    expect(stockees.map((r) => r.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    // Lot 86B : l'ancien package est retiré ; le fichier global de la version restaurée est sans T5.
    const exp = await import('@/services/ai/config/config-export.service');
    const inputs = (await exp.gatherExportInputs(env as never))!;
    const doc = exp.buildExportDocument(inputs, { exportId: '00000000-0000-4000-8000-000000000000', exportedAt: new Date('2026-10-20T10:00:00Z'), userId: adminId, email: null });
    expect(doc.configuration.treatments.map((t) => t.code)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(doc.allowedPairs.some((p) => (p.treatment as string) === 'T5')).toBe(false);
  });

  it('T12-AC04 / T12-AC10 — anciens prompts maîtres T5 conservés en base, jamais proposés en édition', async () => {
    await historique((tx) => tx`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at)
                                VALUES (${env}, 'T5', 't5_master_v1', 1, 'ACTIVE', 'ancien texte T5', 'sha', 'initial_file', now())`);
    const { GET } = await import('@/app/api/admin/ai/master-prompts/route');
    const { NextRequest } = await import('next/server');
    const l = await (await GET(new NextRequest('http://app.test/api/admin/ai/master-prompts'))).json() as { prompts: Array<{ treatment: string }> };
    expect(l.prompts.map((p) => p.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    const detail = await import('@/app/api/admin/ai/master-prompts/[treatment]/route');
    const d = await detail.GET(new NextRequest('http://app.test/api/admin/ai/master-prompts/T5'), { params: Promise.resolve({ treatment: 'T5' }) });
    expect(d.status).toBe(404);
    expect(await sql`SELECT 1 FROM ai_master_prompt_versions WHERE treatment = 'T5'`).toHaveLength(1);
  });

  it('T12-AC10 / T12-AC07 — anciennes traces T5 consultables, sondes « Technique », coûts techniques isolés sans double comptage', async () => {
    const compte = await make.account();
    const insert = (op: string, useCase: string, micros: number, account: number | null) => sql`
      INSERT INTO ai_usage_event (account_id, operation_type, use_case_code, operation_code, provider, model, cost_micros, status, is_billable)
      VALUES (${account}, ${op}, ${useCase}, ${op}, 'gemini', 'gemini-3.6-flash', ${micros}, 'success', FALSE)`;
    await insert('t5_analyze', 'AI_GOVERNANCE', 3000, null);
    await insert('t5_modify', 'AI_GOVERNANCE', 2000, null);
    await insert('model_operational_probe', 'AI_GOVERNANCE', 10, null);
    await insert('t2_answer', 'ASSISTANT', 7000, compte.id);

    const { searchExecutions } = await import('@/services/ai/telemetry/execution-log.repository');
    const { executionScopeLabel } = await import('@/services/ai/telemetry/execution-filters');
    const t5 = await searchExecutions({ operationCode: 't5_analyze', since: debut });
    expect(t5.rows).toHaveLength(1);
    expect(t5.rows[0].treatment).toBeNull();
    expect(executionScopeLabel(t5.rows[0])).toBe('T5 (retiré)');
    const sonde = await searchExecutions({ operationCode: 'model_operational_probe', since: debut });
    expect(executionScopeLabel(sonde.rows[0])).toBe('Technique');

    const { getCostReport } = await import('@/services/ai/telemetry/cost-report.repository');
    const rapport = await getCostReport({ since: debut });
    const technique = rapport.byTreatment.find((b) => /^Technique · Gouvernance IA/.test(b.label));
    expect(technique).toBeDefined();
    expect(rapport.byTreatment.some((b) => /^T5\b/.test(b.label))).toBe(false);
    // Aucune ligne comptée deux fois : la somme par traitement = le total.
    const somme = (k: 'functionalMicros' | 'technicalMicros') => rapport.byTreatment.reduce((n, b) => n + Number((b as never as Record<string, number>)[k] ?? 0), 0);
    expect(somme('functionalMicros') + somme('technicalMicros')).toBe(rapport.totals.functionalMicros + rapport.totals.technicalMicros);
  });
});
