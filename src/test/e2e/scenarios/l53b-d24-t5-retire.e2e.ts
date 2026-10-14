/**
 * Lot 53 (53B) — retour PO D24 « T5 retiré : historique accessible » sur
 * PostgreSQL réel :
 *
 *   PO-D24-05  les anciennes versions du prompt maître T5 (conservées depuis
 *              le lot 49) sont CONSULTABLES dans le BO, en lecture seule, sous
 *              le libellé « retiré » ; elles ne sont jamais proposées en
 *              édition ni administrables ;
 *   PO-D24-06  les anciennes exécutions T5 restent consultables (journal des
 *              exécutions), libellées « T5 (retiré) », distinctes des sondes
 *              opérationnelles (« Technique ») ; aucun nouveau travail T5 ne
 *              peut être mis en file (contrainte de la file).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l53b-d24@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

scenario('L53B-D24', 'T5 retiré : historique accessible en lecture seule, libellé « retiré »', ({ sql, make }) => {
  let env = 'local';
  const debut = new Date(Date.now() - 1000);

  beforeAll(async () => {
    session.adminId = (await make.user({ role: 'ADMIN' })).id;
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    // Versions HISTORIQUES (antérieures au lot 49) : le déclencheur 0336 refuse toute nouvelle ligne T5.
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL session_replication_role = replica`);
      await tx`DELETE FROM ai_master_prompt_versions WHERE treatment = 'T5' AND environment = ${env}`;
      await tx`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at)
               VALUES (${env}, 'T5', 't5_master_v1', 1, 'PREVIOUS', 'TEXTE T5 v1', 'sha1', 'initial_file', now() - interval '90 days'),
                      (${env}, 'T5', 't5_master_v1', 2, 'ACTIVE', 'TEXTE T5 v2', 'sha2', 'prompt_control', now() - interval '30 days')`;
    });
    await expect(sql`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin)
                     VALUES (${env}, 'T5', 't5_master_v1', 3, 'DRAFT', 'nouveau', 'sha3', 'admin')`).rejects.toThrow();
  });

  it('PO-D24-05 — anciennes versions T5 consultables dans le BO, lecture seule, libellé « retiré » ; jamais administrables', async () => {
    const { GET } = await import('@/app/api/admin/ai/master-prompts/route');
    const r = await GET(new NextRequest('http://app.test/api/admin/ai/master-prompts'));
    expect(r.status).toBe(200);
    const b = await r.json() as { prompts: Array<{ treatment: string }>; retired: Array<{ treatment: string; statusLabel: string; versions: Array<{ versionNumber: number; content: string; status: string }> }> };
    expect(b.prompts.map((p) => p.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(b.retired).toHaveLength(1);
    expect(b.retired[0]).toMatchObject({ treatment: 'T5', statusLabel: 'retiré' });
    expect(b.retired[0].versions.map((v) => [v.versionNumber, v.content])).toEqual([[2, 'TEXTE T5 v2'], [1, 'TEXTE T5 v1']]);
    // Toujours non administrable (lecture, brouillon, activation).
    const detail = await import('@/app/api/admin/ai/master-prompts/[treatment]/route');
    expect((await detail.GET(new NextRequest('http://app.test/api/admin/ai/master-prompts/T5'), { params: Promise.resolve({ treatment: 'T5' }) })).status).toBe(404);
    expect(await sql`SELECT 1 FROM ai_master_prompt_versions WHERE treatment = 'T5' AND environment = ${env}`).toHaveLength(2);
  });

  it('PO-D24-06 — anciennes exécutions T5 consultables « T5 (retiré) », sondes « Technique » ; aucun travail T5 mis en file', async () => {
    const insert = (op: string) => sql`
      INSERT INTO ai_usage_event (account_id, operation_type, use_case_code, operation_code, provider, model, cost_micros, status, is_billable)
      VALUES (NULL, ${op}, 'AI_GOVERNANCE', ${op}, 'gemini', 'gemini-3.6-flash', 10, 'success', FALSE)`;
    await insert('t5_modify');
    await insert('model_operational_probe');
    const { searchExecutions } = await import('@/services/ai/telemetry/execution-log.repository');
    const { executionScopeLabel } = await import('@/services/ai/telemetry/execution-filters');
    const t5 = await searchExecutions({ operationCode: 't5_modify', since: debut });
    expect(t5.rows.length).toBeGreaterThanOrEqual(1);
    expect(executionScopeLabel(t5.rows[0])).toBe('T5 (retiré)');
    const sonde = await searchExecutions({ operationCode: 'model_operational_probe', since: debut });
    expect(executionScopeLabel(sonde.rows[0])).toBe('Technique');
    // File : la contrainte n'accepte que T1, T3, T4 — aucun travail T5 possible.
    await expect(sql`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload)
                     VALUES ('T5', NULL, 'asset', '1', 'l53b-d24', 'automatic', 'manual', '{}'::jsonb)`).rejects.toThrow(/ai_job_queue_treatment_check/);
  });
});
