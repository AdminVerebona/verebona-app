/**
 * Lot 86B sur PostgreSQL 16 réel — CDC Pilotage IA V2, phase P6 « fichier
 * global, import atomique, routage » (VER-02..09, ACT-03/04, DEC-03, OPT-03,
 * RUN-05, R14, R15, R51, R52, R55, R68 ; décisions PO 02, 06, 07, 15).
 * Migrations 0728, 0729, 0730.
 *
 *   L86B-E01  signature altérée : import refusé, configuration active
 *             inchangée, refus journalisé (R14)
 *   L86B-E02  modèle Preview et modèle absent de la clé cible (R52) :
 *             refusés, active inchangée ; aucun sous-ensemble appliqué
 *   L86B-E03  ancien format 1.0.0 et ancien package v1 : 422 avec message
 *             clair (R68)
 *   L86B-E04  prévisualisation EXACTE : écarts, modifications locales
 *             écrasées, exclusion et gel levés, promotion remise à zéro,
 *             modèle réautorisé ; base périmée → refus sans écriture
 *   L86B-E05  atomicité : panne en fin de transaction → rien n'est appliqué
 *   L86B-E06  import valide = remplacement COMPLET (R15) : nouvelle version
 *             active identique au fichier, prompts maîtres du fichier,
 *             interventions levées, routage remis à zéro, historique ; le
 *             résolveur applique la nouvelle configuration ; aucun appel réseau
 *   L86B-E07  réimport sans doublon (VER-04) ; double confirmation simultanée
 *   L86B-E08  retour à la configuration antérieure (RUN-05) : version et
 *             révision remplacées, interventions et promotions rétablies ;
 *             second retour refusé
 *   L86B-E09  routage réversible : promotion manuelle appliquée à
 *             l'exécution puis annulée ; promotion automatique refusée sans
 *             preuve admissible (R51) et pendant un gel (R55) ; exclusion qui
 *             viderait une chaîne refusée ; routes 85D (garde admin)
 *   L86B-E10  migrations 0728-0730 rejouables
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l86b@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'cle-e2e-l86b';
const BASE = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-9-pro-preview'];
const listing = () => ({
  models: BASE.map((m) => ({
    name: `models/${m}`, displayName: m, supportedGenerationMethods: ['generateContent', 'countTokens'],
    inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2,
  })),
});
const qualif = vi.fn(async (i: { responseSchema?: unknown; attachments: unknown[] }) => ({
  rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : i.attachments.length ? 'Rouge' : 'OK', inputTokens: 4, outputTokens: 2,
}));

type Doc = import('@/services/ai/config/config-export.service').ConfigExportDocument;

scenario('L86B', 'Fichier global, import atomique et routage (Pilotage IA V2 P6)', ({ sql, make }) => {
  let adminId = 0;
  let env = 'local';
  let activeAvant: number[] = [];
  let promptsAvant: Array<{ id: number; status: string }> = [];
  let fichier = '';
  let source: Doc;
  let sourceVersionId = 0;
  let localVersionId = 0;
  let localRevisionId = 0;
  let exclusionId = 0;
  let gelId = 0;
  let promotionId = 0;
  let importId = 0;

  const svc = () => import('@/services/ai/config/config-version.service');
  const repo = () => import('@/services/ai/config/config-version.repository');
  const imp = () => import('@/services/ai/config/config-import.service');
  const exp = () => import('@/services/ai/config/config-export.service');

  async function post(path: string, mod: Promise<{ POST: (r: never, c?: never) => Promise<Response> }>, body: unknown, params?: Record<string, string>) {
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(`http://app.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await (await mod).POST(req as never, (params ? { params: Promise.resolve(params) } : undefined) as never);
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  const previewRoute = (content: string) => post('/api/admin/ai/config-imports/preview', import('@/app/api/admin/ai/config-imports/preview/route') as never, { content });
  const importRoute = (content: string, expectedBase: string) => post('/api/admin/ai/config-imports', import('@/app/api/admin/ai/config-imports/route') as never, { content, expectedBase });

  /** Fichier modifié puis RE-SIGNÉ (simule un export légitime d'une autre configuration). */
  async function resigne(mutate: (d: Doc) => void): Promise<string> {
    const { configurationSha256, documentSignature } = await exp();
    const d = JSON.parse(fichier) as Doc;
    mutate(d);
    d.integrity.configurationSha256 = configurationSha256(d);
    d.integrity.signature = documentSignature(d);
    return JSON.stringify(d, null, 2);
  }
  const etatConfig = async () => (await sql<{ id: number; current_revision_id: number }[]>`
    SELECT id, current_revision_id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0];
  const nbVersions = async () => Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_config_versions WHERE environment = ${env}`)[0].n);
  const interventionsActives = async () => (await sql<{ id: string; kind: string }[]>`SELECT id, kind FROM ai_config_interventions WHERE environment = ${env} AND lifted_at IS NULL ORDER BY id`).map((r) => ({ id: Number(r.id), kind: r.kind }));
  const promotionsActives = async () => (await sql<{ id: string; model: string }[]>`SELECT id, model FROM ai_routing_promotions WHERE environment = ${env} AND reverted_at IS NULL ORDER BY id`).map((r) => ({ id: Number(r.id), model: r.model }));

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
    promptsAvant = await sql<{ id: number; status: string }[]>`SELECT id, status FROM ai_master_prompt_versions WHERE environment = ${env}`;
    // Catalogue de la clé de cet environnement (API Models simulée, qualification technique réussie).
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    const r = await syncAiCatalog({ trigger: 'schedule' }, {
      fetcher: (async () => new Response(JSON.stringify(listing()), { status: 200 })) as unknown as typeof fetch,
      qualificationCall: qualif as never, probeCall: async () => ({ rawText: 'OK' }), maxQualifications: 50,
      pricing: { fetchPage: async () => { throw new Error('hors ligne'); }, billing: null }, raiseAlert: async () => false,
    });
    expect(r.ok).toBe(true);

    // Configuration « source » (préproduction simulée) : activée puis exportée.
    const s = await svc();
    const v = await s.createConfigVersion(adminId, { label: 'e2e-l86b source' });
    const lignes = v.entries.map((e) => ({
      ...e,
      primaryModel: e.treatment === 'T1' ? 'gemini-3.6-flash' : 'gemini-3.5-flash',
      fallback1: e.treatment === 'T3' || e.treatment === 'T4' ? null : e.treatment === 'T1' ? 'gemini-3.5-flash' : 'gemini-3.6-flash',
      fallback2: null, reasoningPrimary: 'standard' as const, reasoningFallback1: null, reasoningFallback2: null, maxOutputTokens: 4096,
    }));
    await s.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries: lignes }, adminId);
    await s.activate(v.id, adminId);
    sourceVersionId = v.id;
    const e = await (await exp()).exportActiveConfiguration(adminId);
    fichier = e.content;
    source = JSON.parse(fichier) as Doc;
    expect(source.formatVersion).toBe('2.0.0');

    // « Cible » : modifications LOCALES après l'export — nouvelle version active modifiée,
    // exclusion, gel et promotion manuels.
    const local = await s.createConfigVersion(adminId, { label: 'e2e-l86b locale' });
    const t3 = local.entries.find((x) => x.treatment === 'T3')!;
    await s.saveConfiguration(local.id, { expectedRevision: local.currentRevisionNumber, entries: [{ ...t3, maxOutputTokens: 1234 }] }, adminId);
    await s.activate(local.id, adminId);
    localVersionId = local.id;
    localRevisionId = (await etatConfig()).current_revision_id;
    const iv = await import('@/services/ai/config/config-interventions.service');
    exclusionId = (await iv.createExclusion({ model: 'gemini-3.6-flash', treatment: 'T2', reason: 'incident e2e' }, adminId)).intervention.id;
    gelId = (await iv.createFreeze({ treatment: null, reason: 'gel e2e' }, adminId)).intervention.id;
    const rs = await import('@/services/ai/config/routing-state.service');
    promotionId = (await rs.promote({ operationCode: 't1_analyze_document', model: 'gemini-3.5-flash', justification: 'essai e2e', origin: 'admin' }, adminId)).id;
  });

  afterAll(async () => {
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(null);
    await sql`UPDATE ai_config_interventions SET lifted_at = now(), lift_reason = 'admin' WHERE lifted_at IS NULL`;
    await sql`UPDATE ai_routing_promotions SET reverted_at = now(), revert_reason = 'admin' WHERE reverted_at IS NULL`;
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE', deleted_at = NULL WHERE id = ANY(${activeAvant})`;
    // Prompts maîtres : état d'avant le scénario (les versions créées restent, non actives).
    await sql`UPDATE ai_master_prompt_versions SET status = 'PREVIOUS' WHERE environment = ${env} AND status = 'ACTIVE'`;
    for (const p of promptsAvant.filter((x) => x.status === 'ACTIVE')) await sql`UPDATE ai_master_prompt_versions SET status = 'ACTIVE' WHERE id = ${p.id}`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    (await import('@/services/ai/provider/model-capabilities.repository')).invalidateModelCapabilities();
  });

  it('L86B-E01 — signature altérée : import refusé, configuration active inchangée, refus journalisé (R14)', async () => {
    const avant = await etatConfig();
    const d = JSON.parse(fichier) as Doc;
    d.configuration.treatments[0].models.maxOutputTokens = 77777; // altération sans re-signature
    const altere = JSON.stringify(d);
    const p = await previewRoute(altere);
    expect(p.status).toBe(200);
    expect(p.body.ok).toBe(false);
    expect((p.body.issues as any[]).find((i) => i.path === 'integrity.signature')).toMatchObject({ blocking: true, category: 'integrity' });
    const r = await importRoute(altere, p.body.base);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'IMPORT_REFUSED' });
    expect(r.body.message).toMatch(/La configuration active est inchangée/);
    expect(await etatConfig()).toEqual(avant);
    expect((await interventionsActives()).map((x) => x.id)).toEqual([exclusionId, gelId]);
    expect((await promotionsActives()).map((x) => x.id)).toEqual([promotionId]);
    const [j] = await sql<{ status: string; diagnostics: any[]; file_content: string | null }[]>`
      SELECT status, diagnostics, file_content FROM ai_config_imports WHERE environment = ${env} ORDER BY id DESC LIMIT 1`;
    expect(j.status).toBe('refused');
    expect(j.file_content).toBeNull();
    expect(j.diagnostics.some((x) => x.path === 'integrity.signature')).toBe(true);
    const audit = await sql`SELECT 1 FROM ai_admin_audit_log WHERE action_type = 'ai_config_import_refused' AND admin_user_id = ${adminId}`;
    expect(audit.length).toBeGreaterThan(0);
  });

  it('L86B-E02 — Preview et modèle absent de la clé cible (R52) : refus, active inchangée, rien de partiel', async () => {
    const avant = await etatConfig();
    const versions = await nbVersions();
    const preview = await resigne((d) => { d.configuration.treatments.find((t) => t.code === 'T2')!.models.fallbacks = ['gemini-9-pro-preview']; });
    const absent = await resigne((d) => { d.configuration.treatments.find((t) => t.code === 'T6')!.models.primary = 'gemini-7-inexistant'; });
    const ip = await imp();
    const p1 = await ip.previewImport(preview);
    expect(p1.ok).toBe(false);
    expect(p1.issues.find((i) => i.blocking && i.category === 'preview')).toMatchObject({ treatment: 'T2', model: 'gemini-9-pro-preview' });
    await expect(ip.applyImport(preview, { expectedBase: p1.base }, adminId)).rejects.toMatchObject({ code: 'IMPORT_REFUSED' });
    const p2 = await ip.previewImport(absent);
    expect(p2.issues.find((i) => i.blocking && i.category === 'access')).toMatchObject({ treatment: 'T6', model: 'gemini-7-inexistant' });
    await expect(ip.applyImport(absent, { expectedBase: p2.base }, adminId)).rejects.toMatchObject({ code: 'IMPORT_REFUSED' });
    expect(await etatConfig()).toEqual(avant);
    expect(await nbVersions()).toBe(versions);
  });

  it('L86B-E03 — ancien format 1.0.0 et ancien package v1 : 422 avec message clair (R68)', async () => {
    const v1 = JSON.stringify({ ...JSON.parse(fichier), formatVersion: '1.0.0' });
    const a = await previewRoute(v1);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ error: 'LEGACY_EXPORT_FORMAT' });
    expect(a.body.message).toMatch(/ancien format 1\.0\.0[\s\S]*Réexportez/);
    const pkg = JSON.stringify({ schemaVersion: 'ai-config-package-v1', sourceEnvironment: 'preprod', visibleNumber: 3, label: null, entries: [] });
    const b = await importRoute(pkg, 'x');
    expect(b.status).toBe(422);
    expect(b.body).toMatchObject({ error: 'LEGACY_PACKAGE_FORMAT' });
    expect(b.body.message).toMatch(/retiré[\s\S]*Exporter la configuration/);
  });

  it('L86B-E04 — prévisualisation exacte ; base périmée refusée sans écriture', async () => {
    const p = await previewRoute(fichier);
    expect(p.status).toBe(200);
    const v = p.body;
    expect(v.ok).toBe(true);
    expect(v.alreadyApplied).toBe(false);
    expect(v.file).toMatchObject({ signature: source.integrity.signature, formatVersion: '2.0.0', sourceEnvironment: env });
    expect(v.target.active).toMatchObject({ versionId: localVersionId });
    expect(v.treatments).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    // Écart avec l'active : la modification locale de T3 (1234 → 4096).
    const t3 = (v.diff.treatments as any[]).find((t) => t.treatment === 'T3');
    expect(t3.changes.find((c: any) => c.field === 'maxOutputTokens')).toMatchObject({ before: '1234', after: '4096' });
    expect(v.localChanges.note).toMatch(/Aucun import précédent/);
    expect((v.lostExclusions as any[]).map((x) => x.id)).toEqual([exclusionId]);
    expect((v.liftedFreezes as any[]).map((x) => x.id)).toEqual([gelId]);
    expect((v.resetPromotions as any[]).map((x) => x.id)).toEqual([promotionId]);
    expect(v.reauthorizedModels).toEqual([{ model: 'gemini-3.6-flash', treatment: 'T2', exclusionId }]);
    expect((v.settingsNotImported as string[]).some((s) => /Clé API/.test(s))).toBe(true);
    // Rien n'a été écrit par la prévisualisation.
    expect((await interventionsActives()).length).toBe(2);
    // Un geste APRÈS la prévisualisation : la confirmation est refusée, rien n'est écrit.
    const iv = await import('@/services/ai/config/config-interventions.service');
    const tard = await iv.createExclusion({ model: 'gemini-3.5-flash-lite', treatment: null, reason: 'après prévisualisation' }, adminId);
    const versions = await nbVersions();
    const r = await importRoute(fichier, v.base);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'PREVIEW_STALE' });
    expect(await nbVersions()).toBe(versions);
    await iv.liftIntervention(tard.intervention.id, adminId);
  });

  it('L86B-E05 — atomicité : panne en fin de transaction → rien n’est appliqué', async () => {
    const ip = await imp();
    const avant = await etatConfig();
    const versions = await nbVersions();
    const nbImports = Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_config_imports WHERE status = 'applied'`)[0].n);
    const p = await ip.previewImport(fichier);
    await expect(ip.applyImport(fichier, { expectedBase: p.base }, adminId, { failAt: 'after_interventions' })).rejects.toThrow(/panne simulée/);
    expect(await etatConfig()).toEqual(avant);
    expect(await nbVersions()).toBe(versions);
    expect((await interventionsActives()).map((x) => x.id)).toEqual([exclusionId, gelId]);
    expect((await promotionsActives()).map((x) => x.id)).toEqual([promotionId]);
    expect(Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_config_imports WHERE status = 'applied'`)[0].n)).toBe(nbImports);
  });

  it('L86B-E06 — import valide : remplacement complet, interventions levées, routage remis à zéro, historique ; aucun appel réseau (R15)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const appels = Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_usage_event`)[0].n);
    const p = await previewRoute(fichier);
    const r = await importRoute(fichier, p.body.base);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ outcome: 'applied', previousVersionId: localVersionId, liftedInterventions: 2, resetPromotions: 1 });
    importId = r.body.importId;
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_usage_event`)[0].n)).toBe(appels);

    // Nouvelle version active = le fichier, traitement par traitement.
    const active = (await (await repo()).getActiveVersion(env as never))!;
    expect(active.id).toBe(r.body.versionId);
    expect(active.id).not.toBe(sourceVersionId);
    const attendu = (await imp()).incomingEntries(source);
    const { snapshotEntry } = await import('@/services/ai/config/config-snapshot');
    expect(active.entries.map((e) => snapshotEntry(e))).toEqual(attendu);
    for (const t of source.configuration.treatments) {
      expect(active.masterPrompts?.[t.code]?.contentSha256, t.code).toBe(t.masterPrompt!.sha256);
    }
    const actifs = await sql<{ treatment: string; content_sha256: string }[]>`SELECT treatment, content_sha256 FROM ai_master_prompt_versions WHERE environment = ${env} AND status = 'ACTIVE' ORDER BY treatment`;
    expect(actifs.map((a) => [a.treatment, a.content_sha256])).toEqual(source.configuration.treatments.map((t) => [t.code, t.masterPrompt!.sha256]));
    // Interventions et routage : levés / remis à zéro PAR CET IMPORT.
    expect(await interventionsActives()).toEqual([]);
    expect(await promotionsActives()).toEqual([]);
    const levees = await sql<{ lift_reason: string; import_id: number }[]>`SELECT lift_reason, import_id FROM ai_config_interventions WHERE id = ANY(${[exclusionId, gelId]})`;
    expect(levees.every((l) => l.lift_reason === 'import' && Number(l.import_id) === importId)).toBe(true);
    // Journal : texte exact du fichier, configuration remplacée.
    const [j] = await sql<{ status: string; file_content: string; previous_version_id: number; previous_revision_id: number; file_signature: string }[]>`
      SELECT status, file_content, previous_version_id, previous_revision_id, file_signature FROM ai_config_imports WHERE id = ${importId}`;
    expect([j.status, j.file_content, Number(j.previous_version_id), Number(j.previous_revision_id), j.file_signature])
      .toEqual(['applied', fichier, localVersionId, localRevisionId, source.integrity.signature]);
    expect((await sql`SELECT 1 FROM ai_admin_audit_log WHERE action_type = 'ai_config_import' AND admin_user_id = ${adminId}`).length).toBe(1);
    // L'exécution suit la nouvelle configuration (aucune promotion ni exclusion).
    const { resolveOperationConfig, invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const c = await resolveOperationConfig('t1_analyze_document');
    expect([c.configVersionId, c.primaryModel, c.fallbackModels, c.routing]).toEqual([active.id, 'gemini-3.6-flash', ['gemini-3.5-flash'], undefined]);
    const c3 = await resolveOperationConfig('t3_value_conflict');
    expect(c3.maxOutputTokens).toBe(4096);
    // BO : historique.
    const { GET } = await import('@/app/api/admin/ai/config-imports/route');
    const { NextRequest } = await import('next/server');
    const h = await (await GET(new NextRequest('http://app.test/api/admin/ai/config-imports'))).json() as { lastApplied: { id: number }; imports: Array<{ status: string }> };
    expect(h.lastApplied.id).toBe(importId);
  });

  it('L86B-E07 — réimport sans doublon ; double confirmation simultanée', async () => {
    const ip = await imp();
    const versions = await nbVersions();
    const imports = Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_config_imports`)[0].n);
    const p = await ip.previewImport(fichier);
    expect(p.alreadyApplied).toBe(true);
    const r = await ip.applyImport(fichier, { expectedBase: p.base }, adminId);
    expect(r).toMatchObject({ outcome: 'recognized', importId });
    expect(await nbVersions()).toBe(versions);
    expect(Number((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_config_imports`)[0].n)).toBe(imports);
    // Autre fichier, deux confirmations simultanées sur la même prévisualisation : une seule application.
    const autre = await resigne((d) => { d.configuration.treatments.find((t) => t.code === 'T4')!.models.maxOutputTokens = 2048; });
    const p2 = await ip.previewImport(autre);
    const res = await Promise.allSettled([
      ip.applyImport(autre, { expectedBase: p2.base }, adminId),
      ip.applyImport(autre, { expectedBase: p2.base }, adminId),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'PREVIEW_STALE' });
    expect(await nbVersions()).toBe(versions + 1);
    // Retour au fichier d'origine (import complet) pour la suite.
    const p3 = await ip.previewImport(fichier);
    expect(p3.alreadyApplied).toBe(false);
    expect(p3.localChanges.note).toMatch(/Aucune modification locale|depuis le dernier import/);
    const r3 = await ip.applyImport(fichier, { expectedBase: p3.base }, adminId);
    importId = r3.importId!;
  });

  it('L86B-E08 — retour à la configuration antérieure (RUN-05) ; second retour refusé', async () => {
    const ip = await imp();
    // Un geste local après l'import, puis retour arrière.
    const iv = await import('@/services/ai/config/config-interventions.service');
    const [{ previous_version_id: avantVersion, previous_revision_id: avantRevision }] = await sql<{ previous_version_id: number; previous_revision_id: number }[]>`
      SELECT previous_version_id, previous_revision_id FROM ai_config_imports WHERE id = ${importId}`;
    const apres = await iv.createExclusion({ model: 'gemini-3.5-flash-lite', treatment: 'T6', reason: 'après import' }, adminId);
    const r = await post(`/api/admin/ai/config-imports/${importId}/rollback`, import('@/app/api/admin/ai/config-imports/[id]/rollback/route') as never, {}, { id: String(importId) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ importId, versionId: Number(avantVersion) });
    const etat = await etatConfig();
    expect(etat.id).toBe(Number(avantVersion));
    // Configuration antérieure EXACTE (instantané de la révision remplacée).
    const { snapshotsEqual } = await import('@/services/ai/config/config-snapshot');
    const rv = await repo();
    const [a, b] = [await rv.getRevision(Number(etat.current_revision_id)), await rv.getRevision(Number(avantRevision))];
    expect(snapshotsEqual(a!.snapshot, b!.snapshot)).toBe(true);
    // L'exclusion créée après l'import reste en place (geste humain prioritaire).
    expect((await interventionsActives()).map((x) => x.id)).toContain(apres.intervention.id);
    const [j] = await sql<{ action: string; rollback_of: number }[]>`SELECT action, rollback_of FROM ai_config_imports WHERE environment = ${env} ORDER BY id DESC LIMIT 1`;
    expect([j.action, Number(j.rollback_of)]).toEqual(['rollback', importId]);
    await expect(ip.rollbackImport(importId, {}, adminId)).rejects.toMatchObject({ code: 'ALREADY_ROLLED_BACK' });
    await iv.liftIntervention(apres.intervention.id, adminId);
  });

  it('L86B-E08b — retour arrière : exclusion et promotion levées par l’import rétablies ; exclusion prioritaire sur une promotion', async () => {
    const ip = await imp();
    const iv = await import('@/services/ai/config/config-interventions.service');
    const rs = await import('@/services/ai/config/routing-state.service');
    const ex = await iv.createExclusion({ model: 'gemini-3.6-flash', treatment: 'T2', reason: 'avant import' }, adminId);
    // Modèle exclu pour T2 : sa promotion est refusée (ACT-03).
    await expect(rs.promote({ operationCode: 't2_answer', model: 'gemini-3.6-flash', justification: 'x', origin: 'admin' }, adminId)).rejects.toMatchObject({ code: 'MODEL_EXCLUDED' });
    const promo = await rs.promote({ operationCode: 't1_group_upload', model: 'gemini-3.5-flash', justification: 'avant import', origin: 'admin' }, adminId);
    const p = await ip.previewImport(fichier);
    const r = await ip.applyImport(fichier, { expectedBase: p.base }, adminId);
    expect(r).toMatchObject({ outcome: 'applied', liftedInterventions: 1, resetPromotions: 1 });
    expect(await interventionsActives()).toEqual([]);
    const rb = await ip.rollbackImport(r.importId!, {}, adminId);
    expect(rb).toMatchObject({ restoredInterventions: 1, restoredPromotions: 1 });
    expect((await interventionsActives()).map((x) => x.id)).toEqual([ex.intervention.id]);
    expect((await promotionsActives()).map((x) => x.id)).toEqual([promo.id]);
    await iv.liftIntervention(ex.intervention.id, adminId);
    await rs.revertPromotion(promo.id, adminId);
  });

  it('L86B-E09 — routage réversible ; promotion automatique refusée sans preuve (R51) et pendant un gel (R55)', async () => {
    const rs = await import('@/services/ai/config/routing-state.service');
    const iv = await import('@/services/ai/config/config-interventions.service');
    const ip = await imp();
    const p = await ip.previewImport(fichier);
    if (!p.alreadyApplied) await ip.applyImport(fichier, { expectedBase: p.base }, adminId);
    const { resolveOperationConfig } = await import('@/services/ai/config/config-resolver');
    // Promotion manuelle via la route BO : appliquée à l'exécution de CETTE opération seulement.
    const r = await post('/api/admin/ai/routing', import('@/app/api/admin/ai/routing/route') as never,
      { operationCode: 't1_analyze_document', model: 'gemini-3.5-flash', justification: 'latence observée' });
    expect(r.status).toBe(201);
    const promo = r.body.promotion;
    expect(promo).toMatchObject({ origin: 'admin', chainBefore: ['gemini-3.6-flash', 'gemini-3.5-flash'], chainAfter: ['gemini-3.5-flash', 'gemini-3.6-flash'], evidence: { qualified: false } });
    const { loadRoutingOverlay } = await import('@/services/ai/config/routing-state.service');
    expect((await loadRoutingOverlay(env)).promotions.get('t1_analyze_document')).toEqual({ model: 'gemini-3.5-flash', promotionId: promo.id });
    const c = await resolveOperationConfig('t1_analyze_document');
    expect([c.primaryModel, c.fallbackModels, c.routing?.promotionId]).toEqual(['gemini-3.5-flash', ['gemini-3.6-flash'], promo.id]);
    expect((await resolveOperationConfig('t1_group_upload')).primaryModel).toBe('gemini-3.6-flash');
    // Annulation : ordre configuré rétabli.
    const rv = await post(`/api/admin/ai/routing/promotions/${promo.id}/revert`, import('@/app/api/admin/ai/routing/promotions/[id]/revert/route') as never, {}, { id: String(promo.id) });
    expect(rv.status).toBe(200);
    expect((await resolveOperationConfig('t1_analyze_document')).primaryModel).toBe('gemini-3.6-flash');
    // Hors de la chaîne configurée : refus (OPT-03).
    await expect(rs.promote({ operationCode: 't1_analyze_document', model: 'gemini-3.5-flash-lite', justification: 'x', origin: 'admin' }, adminId)).rejects.toMatchObject({ code: 'MODEL_NOT_IN_CHAIN' });
    // Automatique : preuve du fichier = qualification technique seulement → refus (R51).
    await expect(rs.promote({ operationCode: 't1_analyze_document', model: 'gemini-3.5-flash', justification: 'auto', origin: 'system' }, adminId)).rejects.toMatchObject({ code: 'PAIR_NOT_QUALIFIED' });
    // Preuve admissible injectée : la porte s'ouvre ; puis gel → refus (R55), même avec preuve.
    const admissible = async () => ({ admissible: true, detail: { status: 'admissible' } });
    const auto = await rs.promote({ operationCode: 't1_analyze_document', model: 'gemini-3.5-flash', justification: 'auto', origin: 'system' }, adminId, { automaticEvidence: admissible });
    expect(auto).toMatchObject({ origin: 'system', evidence: { qualified: true } });
    await rs.revertPromotion(auto.id, adminId);
    const gel = await iv.createFreeze({ treatment: 'T1', reason: 'gel R55' }, adminId);
    await expect(rs.promote({ operationCode: 't1_analyze_document', model: 'gemini-3.5-flash', justification: 'auto', origin: 'system' }, adminId, { automaticEvidence: admissible }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_FROZEN' });
    expect(await iv.isAutomaticChangeFrozen('T1', env)).toBe(true);
    expect(await iv.isAutomaticChangeFrozen('T3', env)).toBe(false);
    await iv.liftIntervention(gel.intervention.id, adminId);
    // Exclusion qui laisserait T3 sans modèle : refusée.
    const x = await post('/api/admin/ai/config-interventions', import('@/app/api/admin/ai/config-interventions/route') as never,
      { kind: 'EXCLUSION', model: 'gemini-3.5-flash', treatment: 'T3', reason: 'test' });
    expect(x.status).toBe(409);
    expect(x.body).toMatchObject({ error: 'EXCLUSION_EMPTIES_CHAIN' });
    // Exclusion valide via la route : appliquée à l'exécution, puis levée.
    const ok = await post('/api/admin/ai/config-interventions', import('@/app/api/admin/ai/config-interventions/route') as never,
      { kind: 'EXCLUSION', model: 'gemini-3.6-flash', treatment: 'T1', reason: 'incident' });
    expect(ok.status).toBe(201);
    const ex = await resolveOperationConfig('t1_analyze_document');
    expect([ex.primaryModel, ex.fallbackModels, ex.routing?.excludedModels]).toEqual(['gemini-3.5-flash', [], ['gemini-3.6-flash']]);
    const lift = await post(`/api/admin/ai/config-interventions/${ok.body.intervention.id}/lift`, import('@/app/api/admin/ai/config-interventions/[id]/lift/route') as never, {}, { id: String(ok.body.intervention.id) });
    expect(lift.status).toBe(200);
    expect((await resolveOperationConfig('t1_analyze_document')).primaryModel).toBe('gemini-3.6-flash');
    // Garde 85D : routes admin (exception existante « admin/ »), présentes dans l'audit statique.
    const { auditWriteRoutes } = await import('@/app/api/__tests__/write-guard-audit');
    const routes = auditWriteRoutes().map((h) => h.route);
    for (const f of ['admin/ai/config-imports/route.ts', 'admin/ai/config-imports/preview/route.ts', 'admin/ai/config-imports/[id]/rollback/route.ts', 'admin/ai/routing/route.ts', 'admin/ai/config-interventions/route.ts']) {
      expect(routes, f).toContain(f);
    }
    // Journal d'administration : promotions, exclusions, levées tracées.
    const types = (await sql<{ action_type: string }[]>`SELECT DISTINCT action_type FROM ai_admin_audit_log WHERE admin_user_id = ${adminId}`).map((t) => t.action_type);
    expect(types).toEqual(expect.arrayContaining(['ai_routing_promotion', 'ai_routing_promotion_revert', 'ai_model_exclusion_create', 'ai_model_exclusion_lift', 'ai_config_freeze_create', 'ai_config_import', 'ai_config_import_rollback']));
  });

  it('L86B-E10 — migrations 0728-0730 rejouables', async () => {
    for (const f of ['0728_l86b_imports_configuration_ia.sql', '0729_l86b_interventions_manuelles_ia.sql', '0730_l86b_routage_production_ia.sql']) {
      await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8')); });
    }
    const [n] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_config_imports`;
    expect(n.n).toBeGreaterThan(0);
  });
});
