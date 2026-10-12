/**
 * Lot 49 (49E) — ticket 11 « BO IA — Fiabiliser la détection “modèle actif
 * indisponible” et les sondes Gemini », sur PostgreSQL réel (migration 0335) :
 *   · synchronisation du catalogue (même fonction que le bouton « Actualiser
 *     le catalogue » et la tâche `ai-catalog-sync`) avec sondes simulées ;
 *   · un modèle sain n'est jamais déclassé par une réponse vide, un 429 ou
 *     une erreur globale de clé ; un retrait explicite est confirmé ;
 *   · gemini-3.6-flash employé à cinq endroits : UNE alerte d'exploitation,
 *     `details.usages` complet, et le BO (route catalog-status) affiche
 *     « 1 modèle actif indisponible — 5 usages impactés » avec le diagnostic
 *     (message Google nettoyé, date, source, statut) ;
 *   · aucune substitution : la version de configuration n'est pas modifiée.
 * Aucun réseau. Partie unitaire : `l49-sondes-modeles.test.ts`.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l49e@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'AIzaE2E-l49e-cle-secrete-000000000';
const LISTES = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const listing = () => ({
  models: LISTES.map((m) => ({
    name: `models/${m}`, supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536,
  })),
});
const fetcher = (async () => new Response(JSON.stringify(listing()), { status: 200 })) as unknown as typeof fetch;

/** Comportement simulé de Google par modèle (sonde ET épreuve de génération). */
type Reponse = 'ok' | 'vide' | '429' | 'cle' | 'retire';
const comportement = new Map<string, Reponse>();
function repondre(model: string, i?: { responseSchema?: unknown }) {
  const r = comportement.get(model) ?? 'ok';
  if (r === 'vide') return { rawText: '', inputTokens: 4, outputTokens: 0 };
  if (r === '429') throw new Error('got status: 429. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}');
  if (r === 'cle') throw new Error(`got status: 400. {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. key=${CLE}"}}`);
  if (r === 'retire') {
    throw new Error(`got status: 404. {"error":{"code":404,"status":"NOT_FOUND","message":"models/${model} has been retired and is no longer available. key=${CLE}"}}`);
  }
  return { rawText: i?.responseSchema ? '{"ok":true,"mot":"verebona"}' : 'OK', inputTokens: 4, outputTokens: 2 };
}

scenario('L49E-11', 'Sondes Gemini fiabilisées, diagnostic BO, alerte unique par modèle', ({ sql, make }) => {
  let versionId = 0;
  let activeAvant: number[] = [];

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    // Résolution RÉELLE de la configuration (version active en base).
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    await sql`DELETE FROM ai_alerts WHERE code = 'ai_active_model_unavailable'`;

    // Version ACTIVE : gemini-3.6-flash à cinq endroits (T1 principal, T2
    // repli 1, T3 principal, T4 principal, T6 repli 2).
    const { getAiEnvironment } = await import('@/services/ai/config/environment');
    const env = getAiEnvironment();
    const { createDraft } = await import('@/services/ai/config/config-version.repository');
    versionId = (await createDraft(admin.id, 'e2e-l49e-11', env)).id;
    const chaines: Record<string, [string, string | null, string | null]> = {
      T1: ['gemini-3.6-flash', 'gemini-3.1-flash-lite', null],
      T2: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', null],
      T3: ['gemini-3.6-flash', 'gemini-3.1-flash-lite', null],
      T4: ['gemini-3.6-flash', 'gemini-3.1-flash-lite', null],
      T6: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'],
    };
    for (const [t, [p, f1, f2]] of Object.entries(chaines)) {
      await sql`UPDATE ai_config_entries SET primary_model = ${p}, fallback_1 = ${f1}, fallback_2 = ${f2}
                 WHERE version_id = ${versionId} AND treatment = ${t}`;
    }
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
    await sql`UPDATE ai_config_versions SET status = 'VALIDATED' WHERE environment = ${env} AND status = 'ACTIVE'`;
    await sql`UPDATE ai_config_versions SET status = 'ACTIVE', activated_at = now(), activated_by = ${admin.id} WHERE id = ${versionId}`;
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
  });

  afterAll(async () => {
    await sql`UPDATE ai_config_versions SET status = 'ARCHIVED' WHERE id = ${versionId}`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE' WHERE id = ANY(${activeAvant})`;
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(null);
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_alerts WHERE code = 'ai_active_model_unavailable'`;
  });

  async function sync(trigger: 'schedule' | 'manual' = 'schedule') {
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    return syncAiCatalog({ trigger }, {
      fetcher,
      qualificationCall: (async (i: { model: string; responseSchema?: unknown }) => repondre(i.model, i)) as never,
      probeCall: async (model: string) => repondre(model),
      confirmDelayMs: 0,
      pricing: { fetchPage: async () => '', billing: null },
    });
  }
  async function statut() {
    const { GET } = await import('@/app/api/admin/ai/catalog-status/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/admin/ai/catalog-status'));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  const etat = async (model: string) => (await sql<{ ok: boolean | null; check_status: string | null; error: string | null; error_kind: string | null; source: string }[]>`
    SELECT ok, check_status, error, error_kind, source FROM ai_model_operational_status WHERE model = ${model}`)[0];

  it('migration 0335 : colonnes de diagnostic, `ok` nullable, contrainte de statut ; rejouable deux fois sans effet', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0335_ai_model_operational_diagnostics.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'ai_model_operational_status'`;
    const par = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(par.ok).toBe('YES');
    for (const c of ['check_status', 'error_kind', 'suspect_since', 'last_ok_at']) expect(par[c], c).toBe('YES');
    await expect(sql`INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, source, check_status)
                     VALUES ('gemini', 'e2e-invalide', 'x', NULL, 'catalog_refresh', 'peut-etre')`).rejects.toThrow();
  });

  it('T11-AC01 / AC03 / AC02 / AC04 — sain : aucune alerte ; réponse vide, 429, clé refusée : jamais ok=false', async () => {
    const r1 = await sync();
    expect(r1.ok).toBe(true);
    for (const m of LISTES) expect((await etat(m))?.ok, m).toBe(true);
    expect(r1.anomalies).toEqual([]);
    const [{ n: a0 }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = 'ai_active_model_unavailable'`;
    expect(a0).toBe(0);
    expect((await statut()).body.unavailableTitle).toBeNull();

    for (const [mode, kind] of [['vide', 'empty_response'], ['429', 'quota'], ['cle', 'auth_global']] as const) {
      for (const m of LISTES) comportement.set(m, mode);
      await sync();
      for (const m of LISTES) {
        const e = await etat(m);
        expect(e, `${mode} ${m}`).toMatchObject({ ok: true, check_status: 'inconclusive', error_kind: kind });
        expect(e.error ?? '').not.toContain(CLE);
      }
      expect((await statut()).body.anomalies).toEqual([]);
    }
    comportement.clear();
  });

  it('T11-AC06 / AC10 / AC11 / AC12 / AC13 / AC09 / AC14 / AC16 — retrait explicite : confirmé, une alerte, cinq usages regroupés au BO, aucune substitution', async () => {
    const entreesAvant = JSON.stringify(await sql`SELECT * FROM ai_config_entries WHERE version_id = ${versionId} ORDER BY treatment`);
    comportement.set('gemini-3.6-flash', 'retire');
    const r = await sync();
    expect(await etat('gemini-3.6-flash')).toMatchObject({ ok: false, check_status: 'failed_confirmed', error_kind: 'model_retired' });
    expect(r.anomalies.filter((a) => a.model === 'gemini-3.6-flash')).toHaveLength(5);
    // Second passage dans la même fenêtre : toujours UNE alerte.
    await sync('manual');
    const alertes = await sql<{ treatment: string | null; severity: string; message: string; details: Record<string, any> }[]>`
      SELECT treatment, severity, message, details FROM ai_alerts WHERE code = 'ai_active_model_unavailable'`;
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toMatchObject({ treatment: null, severity: 'warning' });
    expect(alertes[0].details.model).toBe('gemini-3.6-flash');
    expect((alertes[0].details.usages as Array<{ treatment: string; rank: string }>).map((u) => `${u.treatment}/${u.rank}`).sort())
      .toEqual(['T1/primaryModel', 'T2/fallback1', 'T3/primaryModel', 'T4/primaryModel', 'T6/fallback2']);
    expect(JSON.stringify(alertes)).not.toContain(CLE);

    const s = await statut();
    expect(s.status).toBe(200);
    expect(s.body.unavailableTitle).toBe('1 modèle actif indisponible — 5 usages impactés');
    expect(s.body.unavailableModels).toHaveLength(1);
    const g = s.body.unavailableModels[0];
    expect(g.model).toBe('gemini-3.6-flash');
    expect(g.usages).toHaveLength(5);
    expect(g.diagnostic).toMatchObject({ status: 'failed_confirmed', operational: false, source: 'catalog_refresh' });
    expect(g.diagnostic.error).toMatch(/HTTP 404 NOT_FOUND — models\/gemini-3\.6-flash has been retired/);
    expect(g.diagnostic.checkedAt).toEqual(expect.any(String));
    expect(JSON.stringify(s.body)).not.toContain(CLE);

    // Aucune substitution : la version active est intacte, les replis restent proposés.
    expect(JSON.stringify(await sql`SELECT * FROM ai_config_entries WHERE version_id = ${versionId} ORDER BY treatment`)).toBe(entreesAvant);
    const { GET } = await import('@/app/api/admin/ai/config-catalogs/route');
    const { NextRequest } = await import('next/server');
    const cat = await (await GET(new NextRequest('http://app.test/api/admin/ai/config-catalogs'))).json() as Record<string, any>;
    for (const t of ['T1', 'T3', 'T4']) {
      const liste = (cat.modelsByTreatment[t] as Array<{ model: string }>).map((m) => m.model);
      expect(liste, t).toContain('gemini-3.1-flash-lite');
      expect(liste, t).not.toContain('gemini-3.6-flash');
    }
  });

  it('T11-AC07 — modèle de nouveau sain : rétabli au contrôle suivant, plus d’anomalie', async () => {
    comportement.clear();
    await sync();
    expect(await etat('gemini-3.6-flash')).toMatchObject({ ok: true, check_status: 'ok' });
    expect((await statut()).body.unavailableTitle).toBeNull();
  });
});
