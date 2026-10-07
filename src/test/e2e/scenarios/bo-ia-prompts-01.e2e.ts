/**
 * BO-IA-PROMPTS-01 — prompts maîtres administrés depuis le BO, sur
 * PostgreSQL réel et par les ROUTES du BO (garde administrateur réelle :
 * seule la lecture du cookie de session est simulée).
 *
 *   Modifier → Enregistrer → (éventuellement Tester) → Activer
 *   Historique → Réactiver une ancienne version
 *
 * Chaque critère d'acceptation AC01 à AC15 a son test nommé. Migrations
 * 0254 (versions, journal, immuabilité) et 0255 (tests du corpus).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

type Json = Record<string, any>;

scenario('BO-IA-PROMPTS-01', 'Prompts maîtres : Brouillon → Actif, corpus facultatif, historique, rollback', ({ sql, make }) => {
  const session = { userId: 0, role: 'ADMIN', email: '' };
  let admin: { id: number; email: string };

  async function r() {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const { NextRequest } = await import('next/server');
    const m = {
      list: await import('@/app/api/admin/ai/master-prompts/route'),
      detail: await import('@/app/api/admin/ai/master-prompts/[treatment]/route'),
      draft: await import('@/app/api/admin/ai/master-prompts/[treatment]/draft/route'),
      version: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/route'),
      activate: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/activate/route'),
      reactivate: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/reactivate/route'),
      tests: await import('@/app/api/admin/ai/master-prompts/[treatment]/versions/[versionId]/tests/route'),
      run: await import('@/app/api/admin/ai/master-prompts/[treatment]/tests/[runId]/route'),
    };
    const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://app.test/api/admin/ai/master-prompts${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const p = <T extends Record<string, string>>(x: T) => ({ params: Promise.resolve(x) });
    const json = async (res: Response) => ({ status: res.status, body: await res.json() as Json });
    return {
      list: async () => json(await m.list.GET(req(''))),
      detail: async (t: string) => json(await m.detail.GET(req(`/${t}`), p({ treatment: t }))),
      startDraft: async (t: string, body: unknown = {}) => json(await m.draft.POST(req(`/${t}/draft`, 'POST', body), p({ treatment: t }))),
      saveDraft: async (t: string, versionId: number, content: string) =>
        json(await m.draft.PUT(req(`/${t}/draft`, 'PUT', { versionId, content }), p({ treatment: t }))),
      discard: async (t: string, versionId: number) =>
        json(await m.draft.DELETE(req(`/${t}/draft?versionId=${versionId}`, 'DELETE'), p({ treatment: t }))),
      version: async (t: string, id: number) => json(await m.version.GET(req(`/${t}/versions/${id}`), p({ treatment: t, versionId: String(id) }))),
      activate: async (t: string, id: number) =>
        json(await m.activate.POST(req(`/${t}/versions/${id}/activate`, 'POST', {}), p({ treatment: t, versionId: String(id) }))),
      reactivate: async (t: string, id: number) =>
        json(await m.reactivate.POST(req(`/${t}/versions/${id}/reactivate`, 'POST', {}), p({ treatment: t, versionId: String(id) }))),
      test: async (t: string, id: number | 'active') =>
        json(await m.tests.POST(req(`/${t}/versions/${id}/tests`, 'POST', {}), p({ treatment: t, versionId: String(id) }))),
      run: async (t: string, id: number) => json(await m.run.GET(req(`/${t}/tests/${id}`), p({ treatment: t, runId: String(id) }))),
    };
  }

  const fichier = async (code: string) => (await import('@/services/ai/governance/master-corpus/cases')).readMasterFileFromRepo(code);

  /** Résolution d'exécution RÉELLE (base + clé de version partagée), comme en production. */
  async function resolution(op: string) {
    const { resolveOperationConfig } = await import('@/services/ai/config/config-resolver');
    const { resolveMasterPrompt, masterPromptVersionOf } = await import('@/services/ai/prompts/prompt-loader');
    const cfg = await resolveOperationConfig(op);
    const code = op.startsWith('t2') ? 't2_master_v1' : op.startsWith('t6') ? 't6_master_v1' : 't4_master_v1';
    return {
      cfg,
      version: masterPromptVersionOf({
        masterPromptCode: code, configuredText: cfg.masterPromptText, configVersionId: cfg.configVersionId, promptVersionId: cfg.masterPromptVersionId,
      }),
      resolveMasterPrompt,
    };
  }

  beforeAll(async () => {
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    await sql`DELETE FROM ai_master_corpus_runs`;
    const u = await make.user({ role: 'ADMIN' });
    admin = { id: u.id, email: u.email };
    session.userId = u.id; session.email = u.email; session.role = 'ADMIN';
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Aucune version de prompt laissée aux scénarios suivants (même base).
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    await sql`DELETE FROM ai_master_corpus_runs`;
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
  });

  it('vue d’ensemble : T1 à T6 administrables (T5 depuis le lot 32B, PO 15) ; non-admin refusé', async () => {
    const api = await r();
    const l = await api.list();
    expect(l.status).toBe(200);
    expect(l.body.prompts.map((p: Json) => p.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    expect(l.body.prompts.every((p: Json) => p.active.initial === true && p.draft === null)).toBe(true);
    expect((await api.detail('T5')).status).toBe(200);
    expect((await api.detail('T9')).status).toBe(404);
    const simple = await make.user({ role: 'USER' });
    Object.assign(session, { userId: simple.id, email: simple.email, role: 'USER' });
    expect((await api.list()).status).toBe(403);
    Object.assign(session, { userId: admin.id, email: admin.email, role: 'ADMIN' });
  });

  it('AC01 — modifier un prompt actif n’altère pas la version utilisée', async () => {
    const api = await r();
    const avant = await api.detail('T2');
    expect(avant.body.initial).toBe(true);
    const texteEnService = avant.body.initialContent.content as string;

    const d = await api.startDraft('T2');
    expect(d.status).toBe(201);
    const draftId = d.body.draftId as number;
    const modifie = `${texteEnService}\n\nRÈGLE BO-IA-PROMPTS-01 (AC01) — répondre en une phrase quand c’est possible.`;
    const s = await api.saveDraft('T2', draftId, modifie);
    expect(s.status).toBe(200);

    // L'Actif (v1, texte en service) est intact ; le texte modifié est dans le brouillon.
    const [actif] = await sql<{ content: string; version_number: number; status: string }[]>`
      SELECT content, version_number, status FROM ai_master_prompt_versions WHERE treatment = 'T2' AND status = 'ACTIVE'`;
    expect(actif).toMatchObject({ content: texteEnService, version_number: 1 });
    const { cfg } = await resolution('t2_answer');
    expect(cfg.masterPromptText).toBe(texteEnService);
    // Une version activée n'est jamais modifiable : ni par l'API…
    const refus = await api.saveDraft('T2', s.body.detail.active.id, 'texte pirate');
    expect(refus.status).toBe(409);
    expect(refus.body.error).toBe('VERSION_NOT_EDITABLE');
    // … ni en base (déclencheur 0254).
    await expect(sql`UPDATE ai_master_prompt_versions SET content = 'x' WHERE status = 'ACTIVE' AND treatment = 'T2'`).rejects.toThrow(/immuable/);
  });

  it('AC02 — la modification produit un brouillon indépendant de la version active', async () => {
    const api = await r();
    const d = await api.detail('T2');
    expect(d.body.draft).toMatchObject({ status: 'DRAFT', versionNumber: 2, basedOnVersionNumber: 1 });
    expect(d.body.draft.content).toMatch(/AC01/);
    expect(d.body.active).toMatchObject({ status: 'ACTIVE', versionNumber: 1 });
    expect(d.body.active.content).not.toMatch(/AC01/);
    // Le brouillon n'est jamais utilisé par l'application.
    const { cfg } = await resolution('t2_answer');
    expect(cfg.masterPromptText).not.toMatch(/AC01/);
    expect(cfg.masterPromptVersionId).toBe(d.body.active.id);
    // Rouvrir « Modifier » reprend LE brouillon (un seul par prompt).
    const again = await api.startDraft('T2');
    expect(again.body.draftId).toBe(d.body.draft.id);
  });

  it('AC03 — un brouillon s’active depuis le BO sans exécution préalable du corpus', async () => {
    const api = await r();
    const d = await api.detail('T2');
    expect(d.body.draft.test).toMatchObject({ state: 'never', label: 'Non testé' });
    const a = await api.activate('T2', d.body.draft.id);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ activated: true, previousVersionNumber: 1, activeVersionNumber: 2 });
    // Avertissement informatif seulement.
    expect(a.body.notices).toContain('Cette version n’a pas encore été testée avec le corpus.');
    expect(a.body.detail.active).toMatchObject({ versionNumber: 2, status: 'ACTIVE' });
    expect(a.body.detail.draft).toBeNull();
  });

  it('AC04 — l’absence de corpus enregistré n’empêche pas l’activation', async () => {
    const api = await r();
    expect((await sql`SELECT 1 FROM ai_master_corpus_runs`).length).toBe(0);
    expect((await sql`SELECT 1 FROM ai_master_prompt_test_runs WHERE treatment = 'T4'`).length).toBe(0);
    const d = await api.startDraft('T4');
    const base = d.body.detail.draft.content as string;
    await api.saveDraft('T4', d.body.draftId, `${base}\n\nRÈGLE AC04 — sans aucun corpus.`);
    const a = await api.activate('T4', d.body.draftId);
    expect(a.status).toBe(200);
    expect(a.body.activeVersionNumber).toBe(2);
  });

  it('AC05 — un corpus en échec n’empêche pas l’activation (information affichée)', async () => {
    const api = await r();
    const d = await api.startDraft('T4');
    const draft = d.body.detail.draft as Json;
    // Résultat ROUGE rattaché à la version et au texte exacts : 3 échecs sur 50.
    await sql`INSERT INTO ai_master_prompt_test_runs
                (prompt_version_id, environment, treatment, content_sha256, status, scenarios_total, scenarios_passed, scenarios_failed, failures, finished_at)
              VALUES (${draft.id}, 'local', 'T4', ${draft.technical.contentSha256}, 'DONE', 50, 47, 3,
                      ${JSON.stringify([{ scenario: 'P-T4-X', description: 'd', branch: 'CLASSIFY_EVENT', expected: 'a', obtained: 'b' }])}::jsonb, now())`;
    // … et un corpus rouge « historique » sur la même empreinte.
    await sql`INSERT INTO ai_master_corpus_runs (treatment, master_prompt_code, master_prompt_version, text_sha256, text_source, status, source)
              VALUES ('T4', 't4_master_v1', 'x', ${draft.technical.contentSha256}, 'config', 'FAILED', 'preprod')`;
    const vue = await api.detail('T4');
    expect(vue.body.draft.test).toMatchObject({ state: 'done', label: 'Tests 47/50', message: '3 scénarios en échec sur 50.' });
    const a = await api.activate('T4', draft.id);
    expect(a.status).toBe(200);
    expect(a.body.notices).toContain('3 scénarios en échec sur 50.');
    const [j] = await sql<{ test_summary: string }[]>`
      SELECT test_summary FROM ai_master_prompt_activations WHERE treatment = 'T4' ORDER BY id DESC LIMIT 1`;
    expect(j.test_summary).toBe('Testée : 3 échec(s) sur 50');
  });

  it('AC06 — activer T6 ne dépend pas de l’état des tests de T1, T2, T3, T4', async () => {
    const api = await r();
    // T1 : brouillon cassé, test ROUGE ; T3 : jamais testé ; T2/T4 non testés.
    const t1 = await api.startDraft('T1');
    const casse = (t1.body.detail.draft.content as string).replace(/BRANCHE TASK = GROUP_UPLOAD/g, 'SECTION SUPPRIMÉE');
    await api.saveDraft('T1', t1.body.draftId, casse);
    const rouge = await api.test('T1', t1.body.draftId);
    expect(rouge.body.failed).toBeGreaterThan(0);
    const t6 = await api.startDraft('T6');
    await api.saveDraft('T6', t6.body.draftId, `${t6.body.detail.draft.content}\n\nRÈGLE AC06.`);
    const a = await api.activate('T6', t6.body.draftId);
    expect(a.status).toBe(200);
    expect(a.body.activeVersionNumber).toBe(2);
    // T1 n'a pas bougé : toujours sa version initiale active, son brouillon intact.
    const d1 = await api.detail('T1');
    expect(d1.body.active).toMatchObject({ versionNumber: 1 });
    expect(d1.body.draft).toMatchObject({ versionNumber: 2 });
  });

  it('AC07 — le parcours ne demande jamais d’exécuter une commande', async () => {
    const api = await r();
    const t1 = (await api.detail('T1')).body;
    const refus = await api.activate('T1', t1.draft.id);
    const textes = [
      JSON.stringify((await api.list()).body),
      JSON.stringify(t1.draft.issues),
      JSON.stringify(t1.draft.test),
      refus.body.message,
      JSON.stringify((await api.run('T1', t1.draft.test.run.id)).body),
    ].join('\n');
    expect(textes).not.toMatch(/npm run|npx |ai:corpus|--record|--live|terminal|commande/i);
  });

  it('AC08 — empreintes, CI et références techniques hors du message principal', async () => {
    const api = await r();
    const t6 = await api.startDraft('T6');
    await api.saveDraft('T6', t6.body.draftId, `${t6.body.detail.draft.content}\n\nRÈGLE AC08.`);
    const a = await api.activate('T6', t6.body.draftId);
    const principal = [a.body.notices.join(' '), a.body.detail.active.test.message, a.body.detail.active.statusLabel, a.body.detail.active.originLabel].join(' ');
    expect(principal).not.toMatch(/[0-9a-f]{12,}|sha|empreinte|\bCI\b|préprod|github|branche git|src\/|\.txt|@pv|@cfg|t6_master_v1/i);
    // Ces informations restent disponibles dans « Détails techniques ».
    expect(a.body.detail.active.technical).toMatchObject({
      masterPromptCode: 't6_master_v1', contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/), runtimeVersion: expect.stringMatching(/^t6_master_v1@pv\d+:/),
    });
  });

  it('AC09 — les défauts techniques réels bloquent l’activation (motif en clair)', async () => {
    const api = await r();
    const d = await api.startDraft('T3');
    const id = d.body.draftId as number;
    const original = d.body.detail.draft.content as string;
    const essais: Array<[string, RegExp]> = [
      ['', /Le prompt est vide/],
      [`${original}\n{{VARIABLE_INCONNUE}}`, /\{\{VARIABLE_INCONNUE\}\}.*inconnu/],
      [original.replace(/BRANCHE TASK = VALUE_CONFLICT/g, 'X'), /BRANCHE TASK = VALUE_CONFLICT.*absente/],
      [original.replace(/\{\{TASK\}\}/g, 'TASK'), /emplacement de branche/i],
      [`${original}\u0001`, /caractères invalides/],
    ];
    for (const [texte, motif] of essais) {
      const s = await api.saveDraft('T3', id, texte);
      expect(s.status, 'un brouillon imparfait s’enregistre').toBe(200);
      expect(s.body.detail.draft.issues.length).toBeGreaterThan(0);
      const a = await api.activate('T3', id);
      expect(a.status).toBe(422);
      expect(a.body.error).toBe('TECHNICAL_CHECK_FAILED');
      expect(a.body.message).toMatch(motif);
    }
    // Caractère impossible à stocker : refusé dès l'enregistrement.
    const nul = await api.saveDraft('T3', id, `${original}\u0000`);
    expect(nul.status).toBe(400);
    expect(nul.body.error).toBe('INVALID_CONTENT');
    // Rien n'a changé : T3 tourne toujours sur sa version initiale, intacte.
    const t3 = (await api.detail('T3')).body;
    expect(t3.active).toMatchObject({ versionNumber: 1, content: original });
    expect(t3.activations).toEqual([]);
    await api.discard('T3', id);
    expect((await api.detail('T3')).body.draft).toBeNull();
  });

  it('AC10 — chaque activation conserve l’ancienne version, immuable, et est journalisée', async () => {
    const api = await r();
    const d = await api.startDraft('T2');
    await api.saveDraft('T2', d.body.draftId, `${d.body.detail.draft.content}\nRÈGLE AC10 (v3).`);
    await api.activate('T2', d.body.draftId);
    const h = (await api.detail('T2')).body;
    expect(h.history.map((v: Json) => [v.versionNumber, v.statusLabel])).toEqual([[3, 'Active'], [2, 'Ancienne'], [1, 'Ancienne']]);
    const v2 = await api.version('T2', h.history[1].id);
    expect(v2.body.content).toMatch(/AC01/);
    expect(v2.body.content).not.toMatch(/AC10/);
    const journal = await sql<Json[]>`
      SELECT action, from_version_number, to_version_number, user_id, user_email, created_at
        FROM ai_master_prompt_activations WHERE treatment = 'T2' ORDER BY id`;
    expect(journal.map((j) => [j.action, j.from_version_number, j.to_version_number])).toEqual([['activate', 1, 2], ['activate', 2, 3]]);
    for (const j of journal) {
      expect(j).toMatchObject({ user_id: admin.id, user_email: admin.email });
      expect(new Date(j.created_at).getTime()).toBeGreaterThan(Date.now() - 3_600_000);
    }
    const [audit] = await sql<Json[]>`SELECT before_value, after_value, admin_user_id FROM ai_admin_audit_log
      WHERE action_type = 'ai_master_prompt_activate' AND after_value->>'treatment' = 'T2' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ admin_user_id: admin.id, before_value: { versionNumber: 2 }, after_value: { versionNumber: 3 } });
  });

  it('AC11 — rollback : « Réactiver cette version » depuis le BO, la version courante reste dans l’historique', async () => {
    const api = await r();
    const h = (await api.detail('T2')).body;
    const v2 = h.history.find((v: Json) => v.versionNumber === 2);
    const rb = await api.reactivate('T2', v2.id);
    expect(rb.status).toBe(200);
    expect(rb.body).toMatchObject({ activeVersionNumber: 2, previousVersionNumber: 3 });
    const apres = rb.body.detail;
    expect(apres.history.map((v: Json) => [v.versionNumber, v.statusLabel])).toEqual([[3, 'Ancienne'], [2, 'Active'], [1, 'Ancienne']]);
    expect(apres.active.content).toMatch(/AC01/);
    expect(apres.active.content).not.toMatch(/AC10/);
    expect(apres.activations[0]).toMatchObject({ action: 'rollback', actionLabel: 'Réactivation', fromVersionNumber: 3, toVersionNumber: 2, user: admin.email });
    const [audit] = await sql<Json[]>`SELECT admin_user_id FROM ai_admin_audit_log WHERE action_type = 'ai_master_prompt_rollback' ORDER BY id DESC LIMIT 1`;
    expect(audit.admin_user_id).toBe(admin.id);
    // Une version déjà active ne se « réactive » pas ; un brouillon s'active.
    expect((await api.reactivate('T2', v2.id)).body.error).toBe('NOT_REACTIVABLE');
  });

  it('AC12 — « Tester avec le corpus » se lance manuellement depuis le BO, sur une version au choix', async () => {
    const api = await r();
    const d = await api.startDraft('T4');
    const run = await api.test('T4', d.body.draftId);
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ status: 'DONE', current: true, failed: 0, requestedBy: admin.email });
    expect(run.body.total).toBeGreaterThan(0);
    // Sur la version active (ou initiale, historisée alors en v1).
    const actif = await api.test('T3', 'active');
    expect(actif.body).toMatchObject({ status: 'DONE', failed: 0 });
    expect((await api.detail('T3')).body.active).toMatchObject({ versionNumber: 1, test: { state: 'done' } });
  });

  it('AC13 — résultats consultables par version : date, version, scénarios, succès, échecs, attendu / obtenu', async () => {
    const api = await r();
    const d1 = (await api.detail('T1')).body;
    // Brouillon T1 v2 (cassé en AC06) : test ROUGE rattaché à cette version.
    const detailV2 = await api.version('T1', d1.draft.id);
    const rouge = detailV2.body.runs[0];
    expect(rouge).toMatchObject({ status: 'DONE', current: true });
    expect(rouge.startedAt).toEqual(expect.any(String));
    expect(rouge.total).toBe(rouge.passed + rouge.failed);
    expect(rouge.failures.length).toBeGreaterThan(0);
    for (const f of rouge.failures) {
      expect(f).toMatchObject({ scenario: expect.any(String), branch: expect.any(String), expected: expect.any(String), obtained: expect.any(String) });
    }
    expect(rouge.failures.map((f: Json) => f.branch)).toContain('GROUP_UPLOAD');
    const parId = await api.run('T1', rouge.id);
    expect(parId.body).toMatchObject({ id: rouge.id, failed: rouge.failed, total: rouge.total });
    // Rattaché à cette version : la v1 active n'en hérite pas.
    expect(d1.active).toMatchObject({ versionNumber: 1, test: { state: 'never' } });
  });

  it('AC14 — modifier après un test ne réutilise pas le résultat (« pas encore testée »)', async () => {
    const api = await r();
    const d = (await api.detail('T4')).body.draft;
    expect(d.test.state).toBe('done');
    const runId = d.test.run.id;
    const s = await api.saveDraft('T4', d.id, `${d.content}\nRÈGLE AC14.`);
    const apres = s.body.detail.draft;
    expect(apres.test).toMatchObject({ state: 'never', message: 'Cette version n’a pas encore été testée.' });
    // L'ancien résultat reste visible, désigné comme celui d'un contenu précédent.
    expect(apres.test.previous).toMatchObject({ id: runId, current: false });
    expect((await api.run('T4', runId)).body).toMatchObject({ id: runId, current: false });
    // Revenir au texte testé retrouve le résultat de CE texte.
    const retour = await api.saveDraft('T4', d.id, d.content);
    expect(retour.body.detail.draft.test).toMatchObject({ state: 'done', run: { id: runId } });
  });

  it('AC15 — après activation, la nouvelle version est celle utilisée (cette instance et les autres conteneurs)', async () => {
    const api = await r();
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    // Cache peuplé avec l'Actif courant (v2 après le rollback AC11).
    const avant = await resolution('t2_answer');
    expect(avant.cfg.masterPromptText).toMatch(/AC01/);

    // 1. Activation par la route : utilisée dès l'appel suivant, sur cette instance.
    const d = await api.startDraft('T2');
    const nouveau = `${d.body.detail.draft.content}\nRÈGLE AC15 — version de production.`;
    await api.saveDraft('T2', d.body.draftId, nouveau);
    const a = await api.activate('T2', d.body.draftId);
    const apres = await resolution('t2_answer');
    expect(apres.cfg.masterPromptText).toBe(nouveau);
    expect(apres.cfg.masterPromptVersionId).toBe(a.body.activeVersionId);
    expect(apres.version).toMatch(new RegExp(`^t2_master_v1@pv${a.body.activeVersionId}:`));
    // Rendu réel du master par le chargeur, comme la passerelle.
    const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
    const { declaredMasterVariables } = await import('@/services/ai/config/prompt-architecture');
    const op = AI_OPERATIONS.t2_answer;
    const rendu = await apres.resolveMasterPrompt({
      masterPromptCode: 't2_master_v1', task: op.task!, useCaseCode: op.useCaseCode,
      variables: Object.fromEntries(declaredMasterVariables('t2_master_v1').map((v) => [v, 'x'])),
      configuredText: apres.cfg.masterPromptText, configVersionId: apres.cfg.configVersionId, promptVersionId: apres.cfg.masterPromptVersionId,
    });
    expect(rendu.text).toContain('RÈGLE AC15');
    expect(rendu.version).toBe(apres.version);

    // 2. Autre conteneur : la bascule faite AILLEURS (base + clé partagée,
    // sans invalidation locale ici) est vue à l'appel suivant (≤ 1 s).
    const h = (await api.detail('T2')).body;
    const v3 = h.history.find((v: Json) => v.versionNumber === 3);
    await sql.begin(async (tx) => {
      await tx`UPDATE ai_master_prompt_versions SET status = 'PREVIOUS' WHERE treatment = 'T2' AND status = 'ACTIVE'`;
      await tx`UPDATE ai_master_prompt_versions SET status = 'ACTIVE', activated_at = now() WHERE id = ${v3.id}`;
    });
    const { dbConfigVersionCounterStore, COUNTER_MEMO_MS } = await import('@/services/ai/config/config-cache-version');
    await dbConfigVersionCounterStore.bump('e2e:autre-conteneur');
    await new Promise((ok) => setTimeout(ok, COUNTER_MEMO_MS + 200));
    const ailleurs = await resolution('t2_answer');
    expect(ailleurs.cfg.masterPromptText).toMatch(/AC10/);
    expect(ailleurs.cfg.masterPromptVersionId).toBe(v3.id);

    // T5 sans version au BO : fichier du dépôt (parcours T5 : scénario PO15 ci-dessous).
    const t5 = await (await import('@/services/ai/config/config-resolver')).resolveOperationConfig('t5_modify');
    expect(t5.masterPromptVersionId ?? null).toBeNull();
    expect(await fichier('t5_master_v1')).toMatch(/MODE/);
  });

  it('PO15-11 — migration 0272 : une base dont la contrainte excluait T5 (0254) l’accepte après rejeu ; rejouable sans effet', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await sql.unsafe(`ALTER TABLE ai_master_prompt_versions DROP CONSTRAINT IF EXISTS ai_master_prompt_versions_treatment_ck`);
    await sql.unsafe(`ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_treatment_ck CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T6'))`);
    const migration = await readFile(join(process.cwd(), 'src/db/migrations/0272_ai_master_prompt_t5.sql'), 'utf8');
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    const [c] = await sql<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_treatment_ck'`;
    expect(c.def).toContain('T5');
    const [t] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'ai_model_operational_status'`;
    expect(t.n).toBe(1);
  });

  it('PO15-10 — T5 par les routes du BO, sur PostgreSQL (migration 0272) : brouillon → actif, contrôles, test du corpus, rollback, utilisé à l’exécution', async () => {
    const api = await r();
    const base = await fichier('t5_master_v1');
    const d = await api.startDraft('T5');
    expect(d.status).toBe(201);
    const draftId = d.body.detail.draft.id as number;
    // Contrôle technique propre à T5 : mode MODIFY retiré → activation refusée (422), motif clair.
    await api.saveDraft('T5', draftId, base.replace('Valeurs autorisées : ANALYZE | MODIFY', 'Valeurs autorisées : ANALYZE'));
    const ko = await api.activate('T5', draftId);
    expect(ko.status).toBe(422);
    expect(ko.body.message).toMatch(/mode MODIFY est absent/);
    // Texte valide : test facultatif, puis activation.
    await api.saveDraft('T5', draftId, `${base}\n\nR9 — RÈGLE T5 ADMINISTRÉE (E2E).`);
    const test = await api.test('T5', draftId);
    expect(test.status).toBe(201);
    expect(test.body).toMatchObject({ status: 'DONE', failed: 0 });
    const ok = await api.activate('T5', draftId);
    expect(ok.status).toBe(200);
    const [ligne] = await sql<{ treatment: string; status: string }[]>`SELECT treatment, status FROM ai_master_prompt_versions WHERE id = ${draftId}`;
    expect(ligne).toEqual({ treatment: 'T5', status: 'ACTIVE' });
    const { resolveOperationConfig } = await import('@/services/ai/config/config-resolver');
    const enService = await resolveOperationConfig('t5_analyze');
    expect(enService.masterPromptText).toMatch(/RÈGLE T5 ADMINISTRÉE/);
    expect(enService.masterPromptVersionId).toBe(draftId);
    // Rollback : la v1 (texte du dépôt) se réactive.
    const detail = await api.detail('T5');
    const v1 = (detail.body.history as Json[]).find((v) => v.versionNumber === 1)!;
    const back = await api.reactivate('T5', v1.id);
    expect(back.status).toBe(200);
    expect((await resolveOperationConfig('t5_analyze')).masterPromptText).toBe(base);
    // T5-002 : Prompt Control ne lit jamais T5 comme cible.
    const svc = await import('@/services/ai/master-prompts/master-prompt.service');
    expect([...(await svc.workingTexts('modify')).keys()]).not.toContain('T5');
  });

  it('Prompt Control : écriture conditionnelle dans le brouillon du prompt, jamais dans l’Actif', async () => {
    const svc = await import('@/services/ai/master-prompts/master-prompt.service');
    const textes = await svc.workingTexts('modify');
    const t6 = textes.get('T6')!;
    expect(t6.draftId).toBeNull();
    const ecrit = await svc.writeDraftFromPromptControl({
      treatment: 'T6', expected: t6.text, readDraftId: null, readActiveId: t6.activeId, next: `${t6.text}\nRÈGLE T5.`, userId: admin.id,
    });
    expect(ecrit).toMatchObject({ status: 'DRAFT', origin: 'prompt_control' });
    // Second passage sur un texte lu périmé : conflit, rien écrasé.
    const conflit = await svc.writeDraftFromPromptControl({
      treatment: 'T6', expected: 'ancien texte', readDraftId: ecrit!.id, readActiveId: t6.activeId, next: 'écrasement', userId: admin.id,
    });
    expect(conflit).toBeNull();
    const [actif] = await sql<{ content: string }[]>`SELECT content FROM ai_master_prompt_versions WHERE treatment = 'T6' AND status = 'ACTIVE'`;
    expect(actif.content).toBe(t6.text);
  });
});
