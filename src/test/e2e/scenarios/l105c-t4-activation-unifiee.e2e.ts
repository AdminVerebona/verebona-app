/**
 * Lot 105C — BO T4 : UN PROMPT MAÎTRE, UNE ACTIVATION. PostgreSQL 16 réel,
 * ROUTES du BO (garde administrateur réelle, seule la session est simulée),
 * passerelle IA réelle derrière le fournisseur de rejeu (aucun réseau).
 *
 * État de départ = blocage constaté le 02/11 : version T4 active t4_input_v2 /
 * t4_output_v3 (trois fonctions) et brouillon où AGENDA_REPRESENTATION est
 * cochée avec ces mêmes contrats (« ne décrit pas la TASK… »).
 *
 *  E2E-105C-01  normalisation : le brouillon v2/v3 devient le bundle complet, texte intact, aucune erreur
 *               de sélection ; « Modifier » réutilise le brouillon ; l'active n'est pas touchée
 *  E2E-105C-02  atomicité : moteur incompatible, modèle non configuré, échec de la transaction →
 *               AUCUNE activation, version active inchangée, texte conservé dans le brouillon
 *  E2E-105C-03  activation UNIQUE avec texte NON enregistré : bundle figé avec la version, journal,
 *               caches et capacités invalidés (intervention, représentation) sans attendre
 *  E2E-105C-04  moteur : les QUATRE TASK exécutées par la passerelle (contexte structuré construit et
 *               validé, sortie stricte distincte par TASK, traces bundle / contrats / TASK) ; une sortie
 *               hors contrat n'est jamais rendue
 *  E2E-105C-05  « Tester T4 » (rejeu) : quatre branches, synthèse par fonction ; non-régressions §H
 *  E2E-105C-06  marqueur supprimé, texte reformulé : représentation Agenda APPLIQUÉE par la chaîne de
 *               production ; réponse violant le monde fermé refusée en bloc, aucune écriture
 *  E2E-105C-07  retour arrière exact (texte, contrats, TASK, capacités) avec fonctions limitées signalées ;
 *               aucune modification rétroactive ; relectures et migration ne changent pas l'active
 *  E2E-105C-08  migration 0990 rejouable ; bundle immuable hors brouillon
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import type { AccountRow, AssetRow } from '../factories';
import { cand, cible, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-11-02';
const RACINE = process.cwd();
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf8');
const LIVRE = lire('src/services/ai/prompts/agenda/t4_master_v1.txt');
const V2V3 = { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] };
const TACHES = ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY', 'AGENDA_REPRESENTATION'];
const BROUILLON_PO = `${LIVRE}\n\nRÈGLE DU PO — brouillon en cours (lot 105C).`;
const NON_ENREGISTRE = `${LIVRE}\n\nRÈGLE DU PO — ajout NON enregistré avant « Activer la version ».`;
/** Texte reformulé : aucun marqueur, aucun mot « magique » (ni t4-agenda-representation-v1, ni toProcessAssessment). */
const REFORMULE = `${LIVRE.replaceAll('toProcessAssessment', 'demande d’évaluation').replaceAll('t4-agenda-representation-v1', '')}\n\nRègles reformulées librement par le PO.`;

const appels = { t4: [] as Json[] };
/** T4 simulé : lit le contexte structuré RÉEL injecté par la passerelle et regroupe les éléments à décider. */
function t4Representation(input: ProviderCallInput): unknown {
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { agenda_representation: { agendaItems: Array<{ ref: string; inScope: boolean; role: string | null }> } };
  appels.t4.push(ctx);
  const items = ctx.agenda_representation.agendaItems.filter((x) => x.inScope);
  const keep = (items.find((x) => x.role === 'PRINCIPAL') ?? items[0]).ref;
  return {
    task: 'AGENDA_REPRESENTATION', outcome: 'DECIDED', restorations: [], identityConcern: null, reason: 'Une seule réparation (e2e 105C).',
    occurrences: [{ items: items.map((x) => x.ref), keep, role: 'PRINCIPAL', confidence: 'certain', evidence: [], reason: 'Même réparation décrite deux fois.' }],
  };
}

scenario('L105C', 'T4 : un prompt maître, une activation (bundle complet)', ({ sql, make }) => {
  const session = { userId: 0, role: 'ADMIN', email: '' };
  let k: OperationsKit;
  let draftId = 0;
  let activeInitialeId = 0;

  async function api() {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const { NextRequest } = await import('next/server');
    const m = {
      detail: await import('@/app/api/admin/ai/master-prompts/[treatment]/route'),
      draft: await import('@/app/api/admin/ai/master-prompts/[treatment]/draft/route'),
      activate: await import('@/app/api/admin/ai/master-prompts/[treatment]/activate/route'),
      reactivate: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/reactivate/route'),
      tests: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/tests/route'),
    };
    const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://app.test/api/admin/ai/master-prompts${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const p = <T extends Record<string, string>>(x: T) => ({ params: Promise.resolve(x) });
    const json = async (res: Response) => ({ status: res.status, body: await res.json() as Json });
    return {
      detail: async () => json(await m.detail.GET(req('/T4'), p({ treatment: 'T4' }))),
      modifier: async () => json(await m.draft.POST(req('/T4/draft', 'POST', {}), p({ treatment: 'T4' }))),
      enregistrer: async (body: Json) => json(await m.draft.PUT(req('/T4/draft', 'PUT', body), p({ treatment: 'T4' }))),
      activer: async (content: string, id: number | null) => json(await m.activate.POST(req('/T4/activate', 'POST', { content, draftId: id }), p({ treatment: 'T4' }))),
      reactiver: async (id: number) => json(await m.reactivate.POST(req(`/T4/versions/${id}/reactivate`, 'POST', {}), p({ treatment: 'T4', versionId: String(id) }))),
      tester: async (id: number | 'active') => json(await m.tests.POST(req(`/T4/versions/${id}/tests`, 'POST', {}), p({ treatment: 'T4', versionId: String(id) }))),
    };
  }
  const versions = () => sql<Json[]>`
    SELECT id, version_number, status, content, content_sha256, execution_mode, input_contract_version, output_contract_version, allowed_tasks, execution_bundle, updated_at
      FROM ai_master_prompt_versions WHERE treatment = 'T4' ORDER BY id`;
  const activations = async () => Number((await sql`SELECT count(*)::int AS n FROM ai_master_prompt_activations WHERE treatment = 'T4'`)[0].n);
  const actif = async () => (await versions()).find((v) => v.status === 'ACTIVE')!;
  async function caches() {
    const fe = await import('@/services/to-process/document-field-evidence');
    const dec = await import('@/services/business-operations/semantic/decider');
    return { t4: () => fe.t4AssessmentConfig(), representation: () => dec.productionRepresentationDecider.capability() };
  }

  beforeAll(async () => {
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const u = await make.user({ role: 'ADMIN' });
    Object.assign(session, { userId: u.id, email: u.email, role: 'ADMIN' });
    // Blocage reproduit : active v2 / v3 (trois fonctions) + brouillon AGENDA_REPRESENTATION coché avec v2 / v3.
    const [a] = await sql<Json[]>`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin,
        activated_at, first_activated_at, execution_mode, input_contract_version, output_contract_version, allowed_tasks)
      VALUES ('local', 'T4', 't4_master_v1', 3, 'ACTIVE', ${LIVRE}, encode(sha256(convert_to(${LIVRE}, 'UTF8')), 'hex'), 'admin', now(), now(),
        'STRUCTURED_CONTEXT', 't4_input_v2', 't4_output_v3', ${JSON.stringify(V2V3.allowedTasks)}::jsonb) RETURNING id`;
    activeInitialeId = Number(a.id);
    const [d] = await sql<Json[]>`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin,
        based_on_id, execution_mode, input_contract_version, output_contract_version, allowed_tasks)
      VALUES ('local', 'T4', 't4_master_v1', 4, 'DRAFT', ${BROUILLON_PO}, encode(sha256(convert_to(${BROUILLON_PO}, 'UTF8')), 'hex'), 'admin', ${activeInitialeId},
        'STRUCTURED_CONTEXT', 't4_input_v2', 't4_output_v3', ${JSON.stringify([...V2V3.allowedTasks, 'AGENDA_REPRESENTATION'])}::jsonb) RETURNING id`;
    draftId = Number(d.id);
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', null);
    await sql`DROP TRIGGER IF EXISTS l105c_echec ON ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
    (await import('@/services/business-operations/semantic/decider')).__resetRepresentationCapabilityCacheForTests();
  });

  it('E2E-105C-01 — brouillon v2/v3 normalisé au bundle complet, texte intact ; « Modifier » le réutilise ; active intacte', async () => {
    const a = await api();
    const d = await a.detail();
    expect(d.status).toBe(200);
    expect(d.body.draft).toMatchObject({ id: draftId, content: BROUILLON_PO, issues: [] });
    expect(d.body.draft.execution).toEqual({ mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4', allowedTasks: TACHES, bundleId: 't4-bundle-v1' });
    expect(JSON.stringify(d.body.draft.issues)).not.toMatch(/ne décrit pas la TASK|ne couvre pas la TASK/);
    expect(d.body.draft.functions.every((f: Json) => f.available && !f.partial)).toBe(true);
    expect(d.body.unified).toMatchObject({ bundleIssues: [], bundle: { id: 't4-bundle-v1', tasks: TACHES } });
    expect(d.body.unified.activeFunctions.find((f: Json) => f.task === 'AGENDA_REPRESENTATION')).toMatchObject({ available: false });

    const m = await a.modifier();
    expect(m.status).toBe(201);
    expect(m.body.draftId).toBe(draftId);
    const l = await versions();
    expect(l).toHaveLength(2);
    expect(l[1]).toMatchObject({ status: 'DRAFT', content: BROUILLON_PO, input_contract_version: 't4_input_v3', output_contract_version: 't4_output_v4', allowed_tasks: TACHES, execution_bundle: { id: 't4-bundle-v1' } });
    expect(l[0]).toMatchObject({ id: activeInitialeId, status: 'ACTIVE', content: LIVRE, input_contract_version: 't4_input_v2', output_contract_version: 't4_output_v3', allowed_tasks: V2V3.allowedTasks, execution_bundle: null });
    // Une configuration envoyée par un ancien écran est ignorée : rien de partiel.
    const sv = await a.enregistrer({ versionId: draftId, content: BROUILLON_PO, execution: V2V3 });
    expect(sv.status).toBe(200);
    expect(sv.body.detail.draft.execution).toMatchObject({ inputContractVersion: 't4_input_v3', bundleId: 't4-bundle-v1' });
    expect(await activations()).toBe(0);
  });

  it('E2E-105C-02 — échec (moteur incompatible, modèle absent, transaction) : zéro activation, active inchangée, texte conservé', async () => {
    const a = await api();
    const { T4_EXECUTION_SPEC } = await import('@/services/ai/agenda/master/t4-execution-contract');
    const b = T4_EXECUTION_SPEC.completeBundle as { outputContractVersion: string };
    // a) Contrat de sortie absent du code déployé.
    b.outputContractVersion = 't4_output_v9';
    let r;
    try { r = await a.activer(`${BROUILLON_PO}\nessai A`, draftId); } finally { b.outputContractVersion = 't4_output_v4'; }
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'ENGINE_INCOMPATIBLE', message: 'Impossible d’activer T4 : configuration du moteur incompatible', details: { draftSaved: true } });
    expect(r.body.details.issues.length).toBeGreaterThan(0);
    expect(r.body.message).not.toMatch(/t4_(input|output)_v|choisissez|sélectionnez|cochez/i);
    expect((await actif()).id).toBe(activeInitialeId);
    expect((await versions()).find((v) => v.id === draftId)!.content).toBe(`${BROUILLON_PO}\nessai A`);

    // b) Modèle non configuré pour une TASK.
    const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
    const op = AI_OPERATIONS.t4_agenda_representation as { primaryModel?: string };
    const modele = op.primaryModel;
    op.primaryModel = undefined;
    try { r = await a.activer(`${BROUILLON_PO}\nessai B`, draftId); } finally { op.primaryModel = modele; }
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('ENGINE_INCOMPATIBLE');
    expect(r.body.details.issues.map((i: Json) => i.code)).toContain('MODEL_CONFIG_INVALID');

    // c) Échec DANS la transaction de bascule (journal impossible) : tout est annulé, bundle non figé.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l105c_echec() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'panne simulée'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS l105c_echec ON ai_master_prompt_activations;
      CREATE TRIGGER l105c_echec BEFORE INSERT ON ai_master_prompt_activations FOR EACH ROW EXECUTE FUNCTION l105c_echec();`);
    try {
      r = await a.activer(`${BROUILLON_PO}\nessai C`, draftId);
    } finally {
      await sql`DROP TRIGGER IF EXISTS l105c_echec ON ai_master_prompt_activations`;
    }
    expect(r.status).toBeGreaterThanOrEqual(500);
    const l = await versions();
    expect(l.find((v) => v.status === 'ACTIVE')!.id).toBe(activeInitialeId);
    expect(l.find((v) => v.id === draftId)).toMatchObject({ status: 'DRAFT', content: `${BROUILLON_PO}\nessai C`, execution_bundle: { id: 't4-bundle-v1' } });
    expect(l.find((v) => v.id === draftId)!.execution_bundle.frozenAt).toBeUndefined();
    expect(await activations()).toBe(0);
  });

  it('E2E-105C-03 — activation UNIQUE avec texte non enregistré : bundle figé, quatre fonctions, caches et capacités invalidés', async () => {
    const a = await api();
    const c = await caches();
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
    (await import('@/services/business-operations/semantic/decider')).__resetRepresentationCapabilityCacheForTests();
    // Caches amorcés sur l'active v2 / v3.
    expect((await c.t4()).ref).toMatch(/t4_output_v3/);
    expect(await c.representation()).toMatchObject({ available: false });

    const r = await a.activer(NON_ENREGISTRE, draftId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ activated: true, previousVersionNumber: 3, activeVersionNumber: 4, draftVersionNumber: 4 });
    expect(r.body.functions.map((f: Json) => [f.task, f.available, f.partial])).toEqual(TACHES.map((t) => [t, true, false]));
    expect(r.body.detail.active).toMatchObject({ id: draftId, content: NON_ENREGISTRE });
    expect(r.body.detail.draft).toBeNull();

    const l = await versions();
    const nouvelle = l.find((v) => v.id === draftId)!;
    expect(nouvelle).toMatchObject({ status: 'ACTIVE', content: NON_ENREGISTRE, execution_mode: 'STRUCTURED_CONTEXT', input_contract_version: 't4_input_v3', output_contract_version: 't4_output_v4', allowed_tasks: TACHES });
    expect(nouvelle.execution_bundle).toMatchObject({
      id: 't4-bundle-v1', mode: 'STRUCTURED_CONTEXT', tasks: TACHES, promptSha256: nouvelle.content_sha256,
      outputs: { CLASSIFY_EVENT: 'T4ClassifyEventV3Output@3', VERIFY_COMPLETION: 'T4VerifyCompletionOutput@1', TEMPORAL_AMBIGUITY: 'T4TemporalAmbiguityOutput@1', AGENDA_REPRESENTATION: 'T4AgendaRepresentationOutput@1' },
    });
    expect(typeof nouvelle.execution_bundle.frozenAt).toBe('string');
    // Ancienne active : intacte (aucune modification rétroactive).
    expect(l.find((v) => v.id === activeInitialeId)).toMatchObject({ status: 'PREVIOUS', content: LIVRE, input_contract_version: 't4_input_v2', output_contract_version: 't4_output_v3', allowed_tasks: V2V3.allowedTasks, execution_bundle: null });
    expect(await activations()).toBe(1);

    // Caches et capacités : la nouvelle version s'applique immédiatement (sans attendre l'expiration).
    expect((await c.t4())).toMatchObject({ interventionCapable: true, ref: expect.stringMatching(/t4_output_v4/) });
    expect(await c.representation()).toMatchObject({ available: true, reason: 'AVAILABLE', version: expect.stringMatching(/^t4_master_v1@pv/) });
    const { resolveOperationConfig } = await import('@/services/ai/config/config-resolver');
    expect((await resolveOperationConfig('t4_agenda_representation')).masterExecution).toMatchObject({ bundleId: 't4-bundle-v1', outputContractVersion: 't4_output_v4' });
    // Bundle figé immuable.
    await expect(sql`UPDATE ai_master_prompt_versions SET execution_bundle = '{"id":"autre"}'::jsonb WHERE id = ${draftId}`).rejects.toThrow(/immuable/);
  });

  it('E2E-105C-04 — les quatre TASK exécutées par la passerelle, sorties strictes distinctes, traces bundle ; hors contrat jamais rendu', async () => {
    const compte = await make.account({ plan: 'premium' });
    const [{ loadMasterCorpusCases, readMasterFileFromRepo }, { liveVariablesFor }, { masterOutputSchemaFor }, { AiGateway }] = await Promise.all([
      import('@/services/ai/governance/master-corpus/cases'), import('@/services/ai/governance/master-corpus/live'),
      import('@/services/ai/gateway/master-output-schemas'), import('@/services/ai/gateway/ai-gateway'),
    ]);
    const cas = loadMasterCorpusCases(readMasterFileFromRepo);
    const plan: Array<[string, string, string, string]> = [
      ['CLASSIFY_EVENT', 't4_classify_event', 'P-T4-V3-13', 'T4ClassifyEventV3Output'],
      ['VERIFY_COMPLETION', 't4_verify_completion', 'P-T4-03', 'T4VerifyCompletionOutput'],
      ['TEMPORAL_AMBIGUITY', 't4_temporal_ambiguity', 'P-T4-04', 'T4TemporalAmbiguityOutput'],
      ['AGENDA_REPRESENTATION', 't4_agenda_representation', 'P-T4-V4-15', 'T4AgendaRepresentationOutput'],
    ];
    const contrats = new Set<string>();
    for (const [task, op, id, schema] of plan) {
      const c = cas.find((x) => x.id === id)!;
      expect(c, id).toBeTruthy();
      const prompts: string[] = [];
      setDefaultResponder(op, task, (input) => { prompts.push(input.prompt); return c.output; });
      try {
        const res = await AiGateway.execute({
          useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: op, accountId: compte.id,
          promptVariables: (await liveVariablesFor(c))!, outputSchema: masterOutputSchemaFor(schema)!,
        } as never);
        expect((res.data as Json).task).toBe(task);
        if (task === 'CLASSIFY_EVENT') expect((res.data as Json).intervention).toBeTruthy();
      } finally { setDefaultResponder(op, task, null); }
      expect(prompts[0]).toContain('\nEXECUTION_CONTEXT\n');
      expect(prompts[0]).toContain(`"task":"${task}"`);
      expect(prompts[0].startsWith(NON_ENREGISTRE.trimEnd())).toBe(true);
      const [trace] = await sql<{ metadata: Json }[]>`SELECT metadata FROM ai_usage_event WHERE operation_code = ${op} AND account_id = ${compte.id} ORDER BY id DESC LIMIT 1`;
      expect(trace.metadata.structuredContext).toMatchObject({
        mode: 'STRUCTURED_CONTEXT', task, inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4', bundleId: 't4-bundle-v1', allowedTasks: TACHES,
      });
      expect(trace.metadata.structuredContext.promptHash).toMatch(/^[0-9a-f]{12}$/);
      contrats.add(String(trace.metadata.runtimeContract?.contractId));
    }
    expect(contrats.size).toBe(4);

    // Sortie hors contrat (JSON générique) pour la représentation : jamais rendue à l'appelant.
    setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', () => ({ task: 'AGENDA_REPRESENTATION', result: 'ok' }));
    try {
      const c = cas.find((x) => x.id === 'P-T4-V4-15')!;
      await expect(AiGateway.execute({
        useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: 't4_agenda_representation', accountId: compte.id,
        promptVariables: (await liveVariablesFor(c))!, outputSchema: masterOutputSchemaFor('T4AgendaRepresentationOutput')!,
      } as never)).rejects.toThrow();
    } finally { setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', null); }
  });

  it('E2E-105C-05 — « Tester T4 » : rejeu des quatre branches, synthèse par fonction ; non-régressions §H', async () => {
    const a = await api();
    const t = await a.tester('active');
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: 'DONE', failed: 0, current: true });
    expect(Object.keys(t.body.byBranch).sort()).toEqual([...TACHES].sort());
    for (const b of TACHES) expect(t.body.byBranch[b].total).toBeGreaterThan(0);

    const [{ runMasterCorpus }, { loadMasterCorpusCases, readMasterFileFromRepo }] = await Promise.all([
      import('@/services/ai/governance/master-corpus/runner'), import('@/services/ai/governance/master-corpus/cases'),
    ]);
    const v = await actif();
    const [r] = await runMasterCorpus({
      readMasterFile: readMasterFileFromRepo, cases: loadMasterCorpusCases(readMasterFileFromRepo), treatments: ['T4'],
      texts: { t4_master_v1: { text: v.content, source: 'config', execution: { mode: 'STRUCTURED_CONTEXT', inputContractVersion: v.input_contract_version, outputContractVersion: v.output_contract_version, allowedTasks: v.allowed_tasks, bundleId: v.execution_bundle.id } } },
    });
    expect(r.status).toBe('PASSED');
    const reussis = new Set(r.cases.filter((c) => c.passed).map((c) => c.id));
    for (const id of [
      'P-T4-V3-07', 'P-T4-V3-10', // facture périodique ≠ fin de contrat
      'P-T4-V3-13', 'P-T4-V3-14', // intervention « À traiter » uniquement si utile
      'P-T4-03', //                 preuve rattachée à la bonne occurrence
      'P-T4-05', //                 abstention temporelle
      'P-T4-V4-15', //              projection + facture : même événement
      'P-T4-V4-16', //              monde fermé : décision hors contexte refusée en bloc
    ]) expect(reussis.has(id), id).toBe(true);
  });

  it('E2E-105C-06 — marqueur supprimé, texte reformulé : représentation appliquée par la production ; réponse hors monde fermé refusée', async () => {
    const a = await api();
    expect((await a.modifier()).status).toBe(201);
    const brouillon = (await a.detail()).body.draft;
    const r = await a.activer(REFORMULE, brouillon.id);
    expect(r.status).toBe(200);
    expect(r.body.functions.every((f: Json) => f.available && !f.partial)).toBe(true);
    expect((await actif()).content).not.toContain('t4-agenda-representation-v1');
    const c = await caches();
    expect(await c.representation()).toMatchObject({ available: true });
    expect(await c.t4()).toMatchObject({ interventionCapable: true });

    async function operationADeuxElements() {
      const compte: AccountRow = await make.account({ plan: 'premium' });
      const maison: AssetRow = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
      const doc = (summary: string, type: string) => k.document(compte, maison.id, [cand({
        summary, provider: 'Plomberie Durand', targetHints: [cible(maison.id)], businessReferences: [ref('INVOICE', 'F-105-01')], temporalHints: { realizedDate: '2026-03-20' },
      })], { type, title: summary, date: '2026-03-20' });
      const f1 = await doc('Réparation fuite cuisine', 'WORKS_INVOICE');
      const f2 = await doc('Rapport d’intervention fuite', 'INTERVENTION_REPORT');
      await k.passer(compte, { today: AUJ });
      const ops = await k.actives(compte);
      expect(ops).toHaveLength(1);
      const evt = (fileId: number, title: string) => ({
        action: 'create', title, date: '2026-03-20', category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
        sourceFileId: fileId, nature: 'HISTORICAL', businessType: 'repair', occurrenceIndex: '2026-03-20', target: { type: 'ASSET', id: maison.id }, sources: [{ fileId, role: 'SOURCE' }],
      });
      const persistence = await import('@/services/agenda/agenda-persistence');
      await persistence.persistAgendaDecisions([evt(f1, 'Réparation — Maison')] as never[], compte.id, maison.id, { sourceFileId: f1, analysisComplete: true });
      await persistence.persistAgendaDecisions([evt(f2, 'Intervention plombier')] as never[], compte.id, maison.id, { sourceFileId: f2, analysisComplete: true });
      return { compte, op: ops[0].id as number };
    }
    const sem = await import('@/services/business-operations/semantic/orchestrator');

    // a) Décision valide : appliquée (un seul événement, principal), tracée — sans aucun marqueur dans le texte actif.
    setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', t4Representation);
    try {
      const x = await operationADeuxElements();
      const res = await sem.reevaluateRepresentation({ accountId: x.compte.id, operationId: x.op, trigger: 'MANUAL', today: AUJ, extraItemIds: [] });
      expect(res).toMatchObject({ status: 'APPLIED', aiCalls: 1 });
      expect(appels.t4.at(-1)).toMatchObject({ task: 'AGENDA_REPRESENTATION' });
      const evts = await sql<Json[]>`SELECT operation_role FROM agenda_items WHERE account_id = ${x.compte.id}`;
      expect(evts).toEqual([{ operation_role: 'PRINCIPAL' }]);

      // b) Réponse qui désigne un élément absent du contexte : refusée en bloc, aucune écriture.
      setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', (input) => {
        const o = t4Representation(input) as Json;
        o.occurrences[0].keep = 'A99';
        o.occurrences[0].items = [...o.occurrences[0].items, 'A99'];
        return o;
      });
      const y = await operationADeuxElements();
      const refus = await sem.reevaluateRepresentation({ accountId: y.compte.id, operationId: y.op, trigger: 'MANUAL', today: AUJ, extraItemIds: [] });
      expect(refus.status).not.toBe('APPLIED');
      expect(await sql<Json[]>`SELECT id FROM agenda_items WHERE account_id = ${y.compte.id}`).toHaveLength(2);
    } finally { setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', null); }
  });

  it('E2E-105C-07 — retour arrière exact, fonctions limitées signalées ; aucune modification rétroactive ; relectures et migration sans effet sur l’active', async () => {
    const a = await api();
    const avant = await versions();
    const bundleV4 = avant.find((v) => v.id === draftId)!;
    const r = await a.reactiver(activeInitialeId);
    expect(r.status).toBe(200);
    expect(r.body.notices.join(' ')).toMatch(/Fonctions limitées : Représentation Agenda multi-événements — indisponible/);
    expect(r.body.functions.find((f: Json) => f.task === 'AGENDA_REPRESENTATION')).toMatchObject({ available: false });
    expect(r.body.detail.unified.activeFunctions.find((f: Json) => f.task === 'AGENDA_REPRESENTATION')).toMatchObject({ available: false });
    const restauree = await actif();
    expect(restauree).toMatchObject({ id: activeInitialeId, content: LIVRE, input_contract_version: 't4_input_v2', output_contract_version: 't4_output_v3', allowed_tasks: V2V3.allowedTasks, execution_bundle: null });
    const c = await caches();
    expect(await c.representation()).toMatchObject({ available: false });
    expect((await c.t4()).ref).toMatch(/t4_output_v3/);
    // Retour vers la version à bundle : identique à son activation (bundle figé conservé).
    const r2 = await a.reactiver(draftId);
    expect(r2.status).toBe(200);
    expect(r2.body.notices.join(' ')).not.toMatch(/Fonctions limitées/);
    const rev = await actif();
    expect(rev.execution_bundle).toEqual(bundleV4.execution_bundle);
    expect(rev.content).toBe(NON_ENREGISTRE);
    expect(await c.representation()).toMatchObject({ available: true });

    // Relectures, résumés, rechargement de configuration, migration rejouée : aucune bascule.
    const n = await activations();
    const instant = await versions();
    await a.detail();
    const svc = await import('@/services/ai/master-prompts/master-prompt.service');
    await svc.listPromptSummaries();
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    await sql.unsafe(lire('src/db/migrations/0990_l105c_t4_bundle_complet.sql'));
    expect(await activations()).toBe(n);
    expect((await versions()).map((v) => [v.id, v.status, v.content_sha256, v.execution_bundle])).toEqual(instant.map((v) => [v.id, v.status, v.content_sha256, v.execution_bundle]));
  });

  it('E2E-105C-08 — migration 0990 rejouable ; bundle immuable hors brouillon, jamais posé a posteriori', async () => {
    const m = lire('src/db/migrations/0990_l105c_t4_bundle_complet.sql');
    await sql.unsafe(m);
    await sql.unsafe(m);
    await expect(sql`UPDATE ai_master_prompt_versions SET execution_bundle = '{"id":"t4-bundle-v1"}'::jsonb WHERE id = ${activeInitialeId}`).rejects.toThrow(/immuable/);
    const a = await api();
    const d = await a.modifier();
    expect(d.status).toBe(201);
    await sql`UPDATE ai_master_prompt_versions SET execution_bundle = '{"id":"t4-bundle-v1"}'::jsonb WHERE id = ${d.body.draftId}`;
    const dd = await a.detail();
    expect(dd.body.draft.execution.bundleId).toBe('t4-bundle-v1');
  });
});
