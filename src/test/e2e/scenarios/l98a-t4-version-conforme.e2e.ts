/**
 * Lot 98A (P0-B) — version T4 active en mode historique (LEGACY_TEMPLATE,
 * sans `t4_output_v3`) → T4_INCOMPATIBLE. Sur PostgreSQL réel et par les
 * ROUTES du BO (garde administrateur réelle, seule la session est simulée) :
 *
 *  · E2E-98A-T4-01 diagnostic BO : version active incompatible, ce qui manque,
 *    chemin « même texte » ; « Préparer une version conforme » crée un
 *    BROUILLON au même texte (contexte structuré, t4_input_v2 / t4_output_v3),
 *    idempotent, la version active reste intacte et rien n'est activé ;
 *  · E2E-98A-T4-02 après activation MANUELLE du brouillon : le moteur « À
 *    traiter » voit une configuration compatible (plus de T4_INCOMPATIBLE),
 *    le BO affiche la version active compatible ; le bouton est refusé.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

type Json = Record<string, any>;

scenario('L98A-T4', 'Version T4 active conforme au contrat t4_output_v3 (BO)', ({ sql, make }) => {
  const session = { userId: 0, role: 'ADMIN', email: '' };
  let texte = '';
  let draftId = 0;

  async function api() {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const { NextRequest } = await import('next/server');
    const m = {
      detail: await import('@/app/api/admin/ai/master-prompts/[treatment]/route'),
      draft: await import('@/app/api/admin/ai/master-prompts/[treatment]/draft/route'),
      activate: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/activate/route'),
    };
    const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://app.test/api/admin/ai/master-prompts${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const p = <T extends Record<string, string>>(x: T) => ({ params: Promise.resolve(x) });
    const json = async (res: Response) => ({ status: res.status, body: await res.json() as Json });
    return {
      detail: async (t: string) => json(await m.detail.GET(req(`/${t}`), p({ treatment: t }))),
      conform: async (t: string) => json(await m.draft.POST(req(`/${t}/draft`, 'POST', { conformT4: true }), p({ treatment: t }))),
      activate: async (t: string, id: number) =>
        json(await m.activate.POST(req(`/${t}/versions/${id}/activate`, 'POST', {}), p({ treatment: t, versionId: String(id) }))),
    };
  }

  beforeAll(async () => {
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const u = await make.user({ role: 'ADMIN' });
    Object.assign(session, { userId: u.id, email: u.email, role: 'ADMIN' });
    texte = (await import('node:fs')).readFileSync((await import('node:path')).join(process.cwd(), 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf8');
    // État constaté en préproduction : version T4 active figée en mode historique (migration 0290).
    await sql`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at, first_activated_at, execution_mode)
      VALUES ('local', 'T4', 't4_master_v1', 3, 'ACTIVE', ${texte}, 'x', 'admin', now(), now(), 'LEGACY_TEMPLATE')`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
  });

  it('E2E-98A-T4-01 — diagnostic BO puis brouillon conforme au même texte, idempotent, rien d’activé', async () => {
    const fe = await import('@/services/to-process/document-field-evidence');
    fe.__setT4AssessmentConfigForTests(null);
    expect((await fe.t4AssessmentConfig()).interventionCapable).toBe(false);

    const a = await api();
    const d = await a.detail('T4');
    expect(d.status).toBe(200);
    expect(d.body.t4Compatibility.active).toMatchObject({ compatible: false, textReady: true, remedy: 'PREPARE_SAME_TEXT' });
    expect(d.body.t4Compatibility.active.issues.map((i: Json) => i.code)).toEqual(['LEGACY_TEMPLATE']);

    const r1 = await a.conform('T4');
    expect(r1.status).toBe(201);
    draftId = r1.body.draftId;
    const r2 = await a.conform('T4');
    expect(r2.body.draftId).toBe(draftId);
    expect(r2.body.detail.t4Compatibility.draft).toMatchObject({ compatible: true, remedy: 'NONE' });
    expect(r2.body.detail.draft.issues).toEqual([]);

    const lignes = await sql<Json[]>`SELECT status, content, execution_mode, input_contract_version, output_contract_version, allowed_tasks
      FROM ai_master_prompt_versions WHERE treatment = 'T4' ORDER BY id`;
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatchObject({ status: 'ACTIVE', execution_mode: 'LEGACY_TEMPLATE' });
    expect(lignes[1]).toMatchObject({ status: 'DRAFT', content: texte, execution_mode: 'STRUCTURED_CONTEXT', input_contract_version: 't4_input_v2', output_contract_version: 't4_output_v3' });
    expect(lignes[1].allowed_tasks).toEqual(['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY']);
    expect((await sql`SELECT count(*)::int AS n FROM ai_master_prompt_activations`)[0].n).toBe(0);
    // T3 : refus explicite (T4 seulement).
    expect((await a.conform('T3')).status).toBe(400);
  });

  it('E2E-98A-T4-02 — activation manuelle : moteur « À traiter » compatible, BO vert, bouton refusé', async () => {
    const a = await api();
    const r = await a.activate('T4', draftId);
    expect(r.status).toBe(200);
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const fe = await import('@/services/to-process/document-field-evidence');
    fe.__setT4AssessmentConfigForTests(null);
    const cfg = await fe.t4AssessmentConfig();
    expect(cfg.interventionCapable).toBe(true);
    expect(cfg.ref).toMatch(/t4_output_v3/);
    const d = await a.detail('T4');
    expect(d.body.t4Compatibility.active).toMatchObject({ compatible: true, remedy: 'NONE', issues: [] });
    const refus = await a.conform('T4');
    expect(refus.status).toBe(409);
    expect(refus.body.error ?? refus.body.code).toBe('ALREADY_COMPATIBLE');
  });
});
