/**
 * Lot 34D — contrat runtime source unique (0291) et T4 en contexte structuré
 * (0290), sur PostgreSQL réel et par les ROUTES du BO (garde administrateur
 * réelle : seule la lecture du cookie de session est simulée).
 *
 *  · E2E-T4C-01 migration 0290 : versions T4 existantes → LEGACY_TEMPLATE
 *    explicite, autres traitements intacts, rejouable ; configuration figée
 *    hors brouillon (déclencheur) ;
 *  · E2E-T4C-02 BO : brouillon legacy → mode « contexte structuré » + texte
 *    livré → aperçu détaillé → activation SANS emplacement → utilisé à
 *    l'exécution (configuration résolue, versions tracées) ;
 *  · E2E-T4C-03 activation refusée sur un défaut TECHNIQUE (contrat de sortie
 *    absent), jamais sur la formulation ;
 *  · E2E-RTC-01 migration 0291 : contrat runtime en colonnes des diagnostics.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

type Json = Record<string, any>;

scenario('L34D', 'Contrat runtime et T4 en contexte structuré (migrations 0290-0291, BO)', ({ sql, make }) => {
  const session = { userId: 0, role: 'ADMIN', email: '' };

  async function api() {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const { NextRequest } = await import('next/server');
    const m = {
      detail: await import('@/app/api/admin/ai/master-prompts/[treatment]/route'),
      draft: await import('@/app/api/admin/ai/master-prompts/[treatment]/draft/route'),
      activate: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/activate/route'),
      preview: await import('@/app/api/admin/ai/master-prompts/[treatment]/preview/route'),
    };
    const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://app.test/api/admin/ai/master-prompts${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const p = <T extends Record<string, string>>(x: T) => ({ params: Promise.resolve(x) });
    const json = async (res: Response) => ({ status: res.status, body: await res.json() as Json });
    return {
      detail: async (t: string) => json(await m.detail.GET(req(`/${t}`), p({ treatment: t }))),
      startDraft: async (t: string) => json(await m.draft.POST(req(`/${t}/draft`, 'POST', {}), p({ treatment: t }))),
      saveDraft: async (t: string, body: unknown) => json(await m.draft.PUT(req(`/${t}/draft`, 'PUT', body), p({ treatment: t }))),
      activate: async (t: string, id: number) =>
        json(await m.activate.POST(req(`/${t}/versions/${id}/activate`, 'POST', {}), p({ treatment: t, versionId: String(id) }))),
      preview: async (t: string, body: unknown) => json(await m.preview.POST(req(`/${t}/preview`, 'POST', body), p({ treatment: t }))),
    };
  }

  const lire = async (rel: string) => (await import('node:fs/promises')).readFile((await import('node:path')).join(process.cwd(), rel), 'utf8');

  beforeAll(async () => {
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const u = await make.user({ role: 'ADMIN' });
    Object.assign(session, { userId: u.id, email: u.email, role: 'ADMIN' });
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
  });

  it('E2E-T4C-01 — migration 0290 : T4 existant → LEGACY_TEMPLATE explicite, autres intacts, rejouable, configuration figée', async () => {
    const legacy = await lire('src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt');
    // Base « avant 0290 » : une version T4 active (texte à emplacements) et une T2, sans configuration.
    await sql`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at, first_activated_at)
      VALUES ('local', 'T4', 't4_master_v1', 1, 'ACTIVE', ${legacy}, 'x', 'initial_file', now(), now()),
             ('local', 'T2', 't2_master_v1', 1, 'ACTIVE', 'texte T2', 'y', 'initial_file', now(), now())`;
    await sql`UPDATE ai_master_prompt_versions SET execution_mode = NULL`.catch(() => { /* déclencheur : déjà NULL */ });
    const migration = await lire('src/db/migrations/0290_master_prompt_execution_config.sql');
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    const lignes = await sql<{ treatment: string; execution_mode: string | null }[]>`SELECT treatment, execution_mode FROM ai_master_prompt_versions ORDER BY treatment`;
    expect(lignes).toEqual([{ treatment: 'T2', execution_mode: null }, { treatment: 'T4', execution_mode: 'LEGACY_TEMPLATE' }]);
    // Version active : configuration d'exécution immuable (comme son texte).
    await expect(sql`UPDATE ai_master_prompt_versions SET execution_mode = 'STRUCTURED_CONTEXT' WHERE treatment = 'T4'`).rejects.toThrow(/immuable/);
    await expect(sql`UPDATE ai_master_prompt_versions SET execution_mode = 'AUTRE' WHERE treatment = 'T2'`).rejects.toThrow(/execution_mode_ck/);
    // L'exécution suit le mode stocké : legacy, comportement conservé.
    const { invalidateConfigCache, resolveOperationConfig } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const cfg = await resolveOperationConfig('t4_classify_event');
    expect(cfg.masterExecution).toMatchObject({ mode: 'LEGACY_TEMPLATE' });
    expect(cfg.masterPromptText).toBe(legacy);
  });

  it('E2E-T4C-02 — BO : passage en contexte structuré, aperçu, activation sans emplacement, utilisé à l’exécution', async () => {
    const a = await api();
    const fichier = await lire('src/services/ai/prompts/agenda/t4_master_v1.txt');
    const d0 = await a.detail('T4');
    expect(d0.body.active.execution).toMatchObject({ mode: 'LEGACY_TEMPLATE' });
    expect(d0.body.structured.context.map((c: Json) => c.field)).toEqual(expect.arrayContaining(['task', 'evidence', 'agenda_item', 'temporal_candidates']));
    expect(d0.body.structured.references.STRUCTURED_CONTEXT).toBe(fichier);

    // Brouillon : reprend le mode de la version de départ (legacy).
    const s = await a.startDraft('T4');
    expect(s.status).toBe(201);
    const id = s.body.draftId as number;
    expect(s.body.detail.draft.execution).toMatchObject({ mode: 'LEGACY_TEMPLATE' });
    // Texte livré (sans {{…}}) + mode explicite, enregistrés ensemble.
    const sv = await a.saveDraft('T4', {
      versionId: id, content: fichier,
      execution: { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] },
    });
    expect(sv.status).toBe(200);
    expect(sv.body.detail.draft.execution).toEqual({ mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] });
    expect(sv.body.detail.draft).toMatchObject({ issues: [], warnings: [] });

    // Aperçu du brouillon : chaque étape inspectable.
    const pv = await a.preview('T4', { versionId: id, task: 'CLASSIFY_EVENT', scenarioId: 'P-T4-06' });
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ mode: 'STRUCTURED_CONTEXT', task: 'CLASSIFY_EVENT', contextError: null, outputContract: { contractId: 'T4_CLASSIFY_EVENT' }, validated: { ok: true } });
    expect(pv.body.prompt).toContain('EXECUTION_CONTEXT');

    // Activation sans aucun emplacement {{…}} dans le texte.
    const act = await a.activate('T4', id);
    expect(act.status).toBe(200);
    expect(act.body.detail.active).toMatchObject({ versionNumber: 2, execution: { mode: 'STRUCTURED_CONTEXT' } });
    const [ligne] = await sql<{ execution_mode: string; input_contract_version: string; output_contract_version: string; allowed_tasks: string[] }[]>`
      SELECT execution_mode, input_contract_version, output_contract_version, allowed_tasks FROM ai_master_prompt_versions WHERE treatment = 'T4' AND status = 'ACTIVE'`;
    expect(ligne).toMatchObject({ execution_mode: 'STRUCTURED_CONTEXT', input_contract_version: 't4_input_v1', output_contract_version: 't4_output_v1' });

    // Exécution réelle : contexte injecté, versions tracées.
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const { FakeProvider, setAiProvider } = await import('@/services/ai/gateway/providers');
    const fake = new FakeProvider();
    setAiProvider(fake);
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', businessType: null, homeCategory: 'information', confidence: 'certain', reason: 'période de facturation' }), inputTokens: 1, outputTokens: 1 }));
    const { classifyAgendaEvent } = await import('@/services/ai/agenda/agenda-intelligence.service');
    const compte = await make.account();
    const extrait = 'Facture internet — Période du 08/08/2026 au 07/09/2026 — 29,99 € TTC';
    const c = await classifyAgendaEvent({ title: 'Échéance abonnement internet', originType: 'document', description: extrait }, { accountId: compte.id, excerpt: extrait, date: '2026-09-07' });
    expect(c).toMatchObject({ category: 'information', source: 'model' });
    expect(fake.calls[0].prompt).toContain('\nEXECUTION_CONTEXT\n');
    expect(fake.calls[0].prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const [trace] = await sql<{ metadata: Json }[]>`SELECT metadata FROM ai_usage_event WHERE operation_code = 't4_classify_event' AND account_id = ${compte.id} ORDER BY id DESC LIMIT 1`;
    expect(trace.metadata.structuredContext).toMatchObject({ mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', task: 'CLASSIFY_EVENT' });
    expect(trace.metadata.runtimeContract).toMatchObject({ contractId: 'T4_CLASSIFY_EVENT', contractVersion: 1 });
  });

  it('E2E-T4C-03 — activation refusée sur un défaut technique (contrat de sortie inconnu), jamais sur la formulation', async () => {
    const a = await api();
    const s = await a.startDraft('T4');
    const id = s.body.draftId as number;
    expect(s.body.detail.draft.execution).toMatchObject({ mode: 'STRUCTURED_CONTEXT' });
    await a.saveDraft('T4', { versionId: id, content: 'Tu es T4. Règles métier réécrites librement, sans titre imposé.',
      execution: { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v7', allowedTasks: null } });
    const refus = await a.activate('T4', id);
    expect(refus.status).toBeGreaterThanOrEqual(400);
    expect(refus.body.error).toBe('TECHNICAL_CHECK_FAILED');
    expect(refus.body.message).toMatch(/contrat de sortie/i);
    // Même texte libre, contrat de sortie rétabli : activable.
    await a.saveDraft('T4', { versionId: id, content: 'Tu es T4. Règles métier réécrites librement, sans titre imposé.',
      execution: { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', allowedTasks: null } });
    expect((await a.activate('T4', id)).status).toBe(200);
  });

  it('E2E-RTC-01 — migration 0291 : contrat runtime en colonnes des diagnostics (rejouable)', async () => {
    await sql.unsafe(await lire('src/db/migrations/0291_ai_call_diagnostics_contract.sql'));
    const { recordCallDiagnostic, resetDiagnosticTableState } = await import('@/services/ai/gateway/diagnostics/diagnostic.repository');
    resetDiagnosticTableState();
    const { emptyControlChain } = await import('@/services/ai/gateway/diagnostics/taxonomy');
    await recordCallDiagnostic({
      traceId: 'e2e-l34d', usageEventId: null, callIndex: 0, accountId: null, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_group_upload',
      task: 'GROUP_UPLOAD', model: 'm', modelRank: 'primary', sourceIds: [],
      diagnostic: {
        outcome: 'FAILED', callKind: 'analysis', family: 'INTERNAL_ERROR', subtype: 'RUNTIME_CONTRACT_MISMATCH', stage: 'request_build', signature: 's',
        outputReceived: false, error: { message: 'm' }, issues: [], issueCount: 0, controls: emptyControlChain(),
        provider: {} as never, repairs: [],
        schema: { name: 'T1GroupUploadOutput', version: 't1_group_upload@v1', hash: 'abcdefabcdef', contractId: 'T1_GROUP_UPLOAD', contractVersion: 1, structuredOutput: false, providerSchemaHash: null },
      } as never,
      output: null,
    });
    const [d] = await sql<Json[]>`SELECT contract_id, contract_version, structured_output, provider_schema_hash, failure_subtype FROM ai_call_diagnostics WHERE trace_id = 'e2e-l34d'`;
    expect(d).toEqual({ contract_id: 'T1_GROUP_UPLOAD', contract_version: 1, structured_output: false, provider_schema_hash: null, failure_subtype: 'RUNTIME_CONTRACT_MISMATCH' });
  });
});
