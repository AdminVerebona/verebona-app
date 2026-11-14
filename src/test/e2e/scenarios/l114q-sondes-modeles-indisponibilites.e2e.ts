/**
 * L114Q — carte Trello #771 « IA — Fiabiliser les sondes de modèles et propager les indisponibilités jusqu'au
 * routage et aux promotions », sur PostgreSQL réel (migration 1692). Fournisseur simulé et instrumenté ; aucun
 * réseau, aucun appel IA réel. Partie unitaire : `provider/__tests__/l114q-sondes-indisponibilites.test.ts`,
 * routage : `gateway/__tests__/l114q-indisponibilites-routage.test.ts`.
 *
 *   E01 · migration 1692 : état par ACCÈS, colonnes de diagnostic, historique ; rejouable sans effet ;
 *   E02 · R01 — appel 15389 rejoué : la sonde planifiée reçoit le 404 « no longer available to new users » →
 *         failed_confirmed persisté avec son diagnostic ; BO : « 1 modèle actif indisponible — 5 usages
 *         impactés », code, accès pseudonymisé, prochaine sonde ; une alerte ; sélecteurs : modèle exclu ;
 *   E03 · A06 / R10 — passage planifié suivant : aucune nouvelle sonde du modèle refusé, aucune alerte en double ;
 *   E04 · R06 / P03 — deux instances : un cache chaud suit la clé de version partagée ; redémarrage (cache
 *         froid) : l'exclusion tient ; sondes simultanées et retours hors ordre : aucune réactivation indue ;
 *   E05 · R02 — une autre clé ne modifie pas le verdict de la clé active ;
 *   E06 · R08 / A03 — promotion refusée dans la transaction (`BLOCKED_MODEL_UNAVAILABLE`) ;
 *   E07 · R07 / E04 — refus d'un appel réel écrit dans l'état canonique ; un 429 n'écrit rien ;
 *   E08 · A04 / B03 — rétablissement prouvé par une sonde : blocage levé, alerte résolue, aucune résurrection ;
 *         la configuration active n'a jamais été modifiée ;
 *   E09 · S04 / B04 — incident global du fournisseur : aucune indisponibilité de modèle, alerte séparée, résolue.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l114q@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'AIzaE2E-l114q-cle-active-00000000';
const AUTRE_CLE = 'AIzaE2E-l114q-autre-cle-11111111';
const REFUSE = 'gemini-3.6-flash';
const LISTES = [REFUSE, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const listing = () => ({
  models: LISTES.map((m) => ({
    name: `models/${m}`, supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536,
  })),
});
const fetcher = (async () => new Response(JSON.stringify(listing()), { status: 200 })) as unknown as typeof fetch;

/** Refus de l'appel 15389 (faits de la carte), pour le modèle sondé : HTTP 404 NOT_FOUND, message exact. */
const refus15389 = (model: string) => new Error(
  `got status: 404. {"error":{"code":404,"message":"This model models/${model} is no longer available to new users","status":"NOT_FOUND"}}`);

type Reponse = 'ok' | 'refus' | 'cle';
const comportement = new Map<string, Reponse>();
/** Requêtes réellement envoyées au fournisseur simulé (sondes et épreuves), par modèle. */
const envoyees: string[] = [];
function repondre(model: string, i?: { responseSchema?: unknown }) {
  envoyees.push(model);
  const r = comportement.get(model) ?? 'ok';
  if (r === 'refus') throw refus15389(model);
  if (r === 'cle') throw new Error(`got status: 400. {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. key=${CLE}"}}`);
  return { rawText: i?.responseSchema ? '{"ok":true,"mot":"verebona"}' : 'OK', inputTokens: 4, outputTokens: 2 };
}

scenario('L114Q', 'Sondes de modèles : verdict par accès, propagation jusqu’au routage, aux sélecteurs, aux promotions et au BO', ({ sql, make }) => {
  let versionId = 0;
  let activeAvant: number[] = [];
  let entreesAvant = '';
  const O = () => import('@/services/ai/provider/model-operational.service');
  const F = () => import('@/services/ai/gateway/fallback-context');
  const empreinte = async (cle = CLE) => (await O()).keyFingerprint(cle);

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status', 'ai_model_operational_history']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    await sql`DELETE FROM ai_alerts WHERE code IN ('ai_active_model_unavailable', 'ai_provider_auth_failure')`;

    // Version ACTIVE : le modèle refusé est employé à cinq endroits (T1, T3, T4 principal ; T2 repli 1 ; T6 repli 2).
    const { getAiEnvironment } = await import('@/services/ai/config/environment');
    const env = getAiEnvironment();
    const { createDraft } = await import('@/services/ai/config/config-version.repository');
    versionId = (await createDraft(admin.id, 'e2e-l114q', env)).id;
    const chaines: Record<string, [string, string | null, string | null]> = {
      T1: [REFUSE, 'gemini-3.1-flash-lite', null],
      T2: ['gemini-3.5-flash-lite', REFUSE, null],
      T3: [REFUSE, 'gemini-3.1-flash-lite', null],
      T4: [REFUSE, 'gemini-3.1-flash-lite', null],
      T6: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', REFUSE],
    };
    for (const [t, [p, f1, f2]] of Object.entries(chaines)) {
      await sql`UPDATE ai_config_entries SET primary_model = ${p}, fallback_1 = ${f1}, fallback_2 = ${f2}
                 WHERE version_id = ${versionId} AND treatment = ${t}`;
    }
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
    await sql`UPDATE ai_config_versions SET status = 'VALIDATED' WHERE environment = ${env} AND status = 'ACTIVE'`;
    await sql`UPDATE ai_config_versions SET status = 'ACTIVE', activated_at = now(), activated_by = ${admin.id} WHERE id = ${versionId}`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    entreesAvant = JSON.stringify(await sql`SELECT * FROM ai_config_entries WHERE version_id = ${versionId} ORDER BY treatment`);
    (await F()).__enableFallbackContextDbForTests(true);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.useRealTimers();
    await sql`UPDATE ai_config_versions SET status = 'ARCHIVED' WHERE id = ${versionId}`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE' WHERE id = ANY(${activeAvant})`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(null);
    (await F()).__enableFallbackContextDbForTests(false);
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_operational_history`;
    await sql`DELETE FROM ai_alerts WHERE code IN ('ai_active_model_unavailable', 'ai_provider_auth_failure')`;
    vi.restoreAllMocks();
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
  type Etat = {
    ok: boolean | null; check_status: string | null; error: string | null; error_kind: string | null; source: string;
    http_status: number | null; provider_code: string | null; capability: string; endpoint: string | null;
    failure_count: number; next_probe_at: Date | null; state_version: string; confirmed_at: Date | null;
  };
  const etat = async (model: string, cle = CLE) => (await sql<Etat[]>`
    SELECT ok, check_status, error, error_kind, source, http_status, provider_code, capability, endpoint, failure_count, next_probe_at, state_version, confirmed_at
      FROM ai_model_operational_status WHERE model = ${model} AND key_fingerprint = ${await empreinte(cle)}`)[0];
  const versionPartagee = async () => Number((await sql<{ version: string }[]>`
    SELECT version FROM verebona_cache_versions WHERE scope = 'ai-model-operational'`)[0]?.version ?? 0);
  const alertes = (code = 'ai_active_model_unavailable') => sql<{ id: number; severity: string; message: string; details: Record<string, any>; resolved_at: Date | null; resolution_code: string | null; condition_key: string | null; occurrences: number }[]>`
    SELECT id, severity, message, details, resolved_at, resolution_code, condition_key, occurrences FROM ai_alerts WHERE code = ${code} ORDER BY id`;
  const utilisable = async (model: string, treatment: 'T1' | 'T2' = 'T1') => {
    const { loadUsableModelsContext, evaluateModelForTreatment } = await import('@/services/ai/registry/usable-models');
    return evaluateModelForTreatment(treatment, model, await loadUsableModelsContext());
  };

  it('L114Q-E01 — migration 1692 : état par accès, diagnostic, historique ; rejouable sans effet', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/1692_l114_sondes_modeles_etat_par_acces.sql'), 'utf8');
    await sql.unsafe(texte);
    await sql.unsafe(texte);
    const cols = (await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_model_operational_status'`).map((c) => c.column_name);
    for (const c of ['http_status', 'provider_code', 'capability', 'endpoint', 'probe_call_id', 'observed_at', 'confirmed_at', 'failure_count', 'next_probe_at', 'state_version']) {
      expect(cols, c).toContain(c);
    }
    const [pk] = await sql<{ cols: string }[]>`
      SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum)) AS cols
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.conrelid = 'ai_model_operational_status'::regclass AND c.contype = 'p'`;
    expect(pk.cols).toBe('provider,model,key_fingerprint');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'ai_model_operational_history'`;
    expect(n).toBe(1);
    // Une ligne par accès : deux clés pour le même modèle coexistent ; la même clé reste unique.
    await sql`INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, source, check_status) VALUES ('gemini', 'e2e-acces', 'a', TRUE, 'provider_test', 'ok')`;
    await sql`INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, source, check_status) VALUES ('gemini', 'e2e-acces', 'b', FALSE, 'provider_test', 'failed_confirmed')`;
    await expect(sql`INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, source, check_status) VALUES ('gemini', 'e2e-acces', 'a', TRUE, 'provider_test', 'ok')`).rejects.toThrow();
    await sql`DELETE FROM ai_model_operational_status WHERE model = 'e2e-acces'`;
  });

  it('L114Q-E02 (R01) — 404 de l’appel 15389 : failed_confirmed persisté, affiché au BO, modèle exclu des sélecteurs', async () => {
    // Passage sain d'abord : tout répond.
    const r0 = await sync();
    expect(r0.ok).toBe(true);
    for (const m of LISTES) expect((await etat(m))?.ok, m).toBe(true);
    expect((await utilisable(REFUSE)).usable).toBe(true);
    const v0 = await versionPartagee();

    comportement.set(REFUSE, 'refus');
    envoyees.length = 0;
    const r = await sync();
    // Message explicite et définitif : UNE requête vers ce modèle, pas de seconde sonde.
    expect(envoyees.filter((m) => m === REFUSE)).toHaveLength(1);
    const e = await etat(REFUSE);
    expect(e).toMatchObject({
      ok: false, check_status: 'failed_confirmed', error_kind: 'model_access_closed', http_status: 404, provider_code: 'NOT_FOUND',
      capability: 'text_generation', endpoint: 'generateContent', source: 'catalog_refresh', failure_count: 1,
    });
    expect(e.error).toBe(`HTTP 404 NOT_FOUND — This model models/${REFUSE} is no longer available to new users`);
    expect(e.next_probe_at).not.toBeNull();
    expect(e.confirmed_at).not.toBeNull();
    expect(await versionPartagee()).toBe(v0 + 1);
    expect(r.operational.failed).toEqual([REFUSE]);
    expect(r.operational.verdicts).toMatchObject({ controlled: 3, ok: 2, failedConfirmed: 1 });
    // Les autres modèles ne sont pas déclassés.
    for (const m of LISTES.filter((x) => x !== REFUSE)) expect((await etat(m))?.ok, m).toBe(true);
    // Historique conservé : le contrôle sain précédent et le refus.
    const histo = await sql<{ outcome: string; check_status: string; applied: boolean; http_status: number | null }[]>`
      SELECT outcome, check_status, applied, http_status FROM ai_model_operational_history WHERE model = ${REFUSE} ORDER BY id`;
    expect(histo.at(-1)).toMatchObject({ outcome: 'failed', check_status: 'failed_confirmed', applied: true, http_status: 404 });
    expect(histo.some((x) => x.outcome === 'ok')).toBe(true);

    // BO : un modèle, cinq usages ; code, accès pseudonymisé, prochaine sonde ; aucun secret.
    expect(r.anomalies.filter((a) => a.model === REFUSE)).toHaveLength(5);
    const s = await statut();
    expect(s.status).toBe(200);
    expect(s.body.unavailableTitle).toBe('1 modèle actif indisponible — 5 usages impactés');
    expect(s.body.unavailableModels).toHaveLength(1);
    const g = s.body.unavailableModels[0];
    expect(g.diagnostic).toMatchObject({
      status: 'failed_confirmed', operational: false, httpStatus: 404, providerCode: 'NOT_FOUND', errorKind: 'model_access_closed',
      access: `clé …${(await empreinte()).slice(0, 8)}`, source: 'catalog_refresh',
    });
    expect(g.diagnostic.nextProbeAt).toEqual(expect.any(String));
    expect(g.diagnostic.error).toMatch(/no longer available to new users/);
    expect(JSON.stringify(s.body)).not.toContain(CLE);

    // Alerte : une seule, de condition, usages regroupés.
    const a = await alertes();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: 'warning', resolved_at: null, condition_key: `ai:active-model:${REFUSE}:clé …${(await empreinte()).slice(0, 8)}` });
    expect(a[0].details).toMatchObject({ model: REFUSE, counts: { models: 1, usages: 5 }, diagnostic: { httpStatus: 404, providerCode: 'NOT_FOUND' } });
    expect(JSON.stringify(a)).not.toContain(CLE);

    // Sélecteurs, campagnes et validation de configuration lisent le même état : modèle non utilisable.
    const u = await utilisable(REFUSE);
    expect(u.usable).toBe(false);
    expect(u.reasons).toContain('NOT_OPERATIONAL');
    expect((await utilisable('gemini-3.1-flash-lite')).usable).toBe(true);
  });

  it('L114Q-E03 (A06, R10) — passage planifié suivant : aucune nouvelle sonde du modèle refusé, aucune alerte en double', async () => {
    envoyees.length = 0;
    const avant = await etat(REFUSE);
    const r = await sync();
    expect(envoyees.filter((m) => m === REFUSE)).toHaveLength(0); // échéance de recontrôle non atteinte
    expect(r.operational.deferred).toEqual([REFUSE]);
    const apres = await etat(REFUSE);
    expect(apres).toMatchObject({ ok: false, check_status: 'failed_confirmed', failure_count: 1, state_version: avant.state_version });
    const a = await alertes();
    expect(a).toHaveLength(1);
    expect(a[0].resolved_at).toBeNull();
    expect(a[0].occurrences).toBeGreaterThanOrEqual(2); // même alerte mise à jour, jamais dupliquée
  });

  it('L114Q-E04 (R06, P03) — deux instances, cache chaud, redémarrage, retours hors ordre : aucune réactivation indue', async () => {
    const { fallbackContext, invalidateFallbackStatusCache, STATUS_VERSION_CHECK_MS } = await F();
    const { recordOperationalCheck } = await O();
    const { classifyProbeFailure } = await import('@/services/ai/provider/probe-classification');
    const lu = async () => [...(await fallbackContext().knownUnavailable()).keys()].sort();
    const autre = 'gemini-3.5-flash-lite';

    // Redémarrage (cache froid) : l'exclusion est relue en base.
    invalidateFallbackStatusCache();
    expect(await lu()).toEqual([REFUSE]);

    // Une AUTRE instance confirme un second modèle indisponible (écriture directe + clé de version) : le cache
    // chaud de cette instance le voit dès qu'il relit la clé de version (au plus 5 s), sans redémarrage.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await sql`UPDATE ai_model_operational_status SET ok = FALSE, check_status = 'failed_confirmed', error = 'HTTP 404 NOT_FOUND', checked_at = now()
                 WHERE model = ${autre} AND key_fingerprint = ${await empreinte()}`;
      await sql`INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at) VALUES ('ai-model-operational', 1, 'e2e', now())
                ON CONFLICT (scope) DO UPDATE SET version = verebona_cache_versions.version + 1, updated_at = now()`;
      expect(await lu()).toEqual([REFUSE]); // lecture mise en cache à l'instant
      vi.setSystemTime(Date.now() + STATUS_VERSION_CHECK_MS + 1_000);
      expect(await lu()).toEqual([autre, REFUSE].sort());
      // Et dans l'autre sens : rétabli ailleurs, vu ici de la même façon.
      await sql`UPDATE ai_model_operational_status SET ok = TRUE, check_status = 'ok', error = NULL WHERE model = ${autre} AND key_fingerprint = ${await empreinte()}`;
      await sql`UPDATE verebona_cache_versions SET version = version + 1 WHERE scope = 'ai-model-operational'`;
      vi.setSystemTime(Date.now() + STATUS_VERSION_CHECK_MS + 1_000);
      expect(await lu()).toEqual([REFUSE]);
    } finally {
      vi.useRealTimers();
    }

    // Sondes simultanées, retours hors ordre (transactions réelles) : un « ok » ENVOYÉ avant le refus n'efface rien.
    const quand = await sql<{ t: Date }[]>`SELECT observed_at AS t FROM ai_model_operational_status WHERE model = ${REFUSE} AND key_fingerprint = ${await empreinte()}`;
    const avantRefus = new Date(new Date(quand[0].t).getTime() - 60_000);
    const refus = classifyProbeFailure(refus15389(REFUSE), { model: REFUSE });
    const resultats = await Promise.all([
      recordOperationalCheck({ model: REFUSE, secret: CLE, outcome: { status: 'ok' }, source: 'provider_test', observedAt: avantRefus }),
      recordOperationalCheck({ model: REFUSE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh', observedAt: avantRefus }),
      recordOperationalCheck({ model: REFUSE, secret: CLE, outcome: refus, source: 'gateway_call', observedAt: new Date() }),
    ]);
    expect(resultats.slice(0, 2).every((x) => x.stale === true && x.ok === false)).toBe(true);
    expect(await etat(REFUSE)).toMatchObject({ ok: false, check_status: 'failed_confirmed', failure_count: 1 });
    const ecartes = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_model_operational_history WHERE model = ${REFUSE} AND applied = FALSE`;
    expect(ecartes[0].n).toBe(3); // deux « ok » tardifs et un refus déjà opposable : historisés, non appliqués
    invalidateFallbackStatusCache();
    expect(await lu()).toEqual([REFUSE]);
  });

  it('L114Q-E05 (R02) — le même modèle répond avec une autre clé : verdict de la clé active intact, aucune exclusion globale', async () => {
    const { recordOperationalCheck, loadOperationalStatuses } = await O();
    await recordOperationalCheck({ model: REFUSE, secret: AUTRE_CLE, outcome: { status: 'ok' }, source: 'provider_test' });
    expect((await etat(REFUSE))?.ok).toBe(false);
    expect((await etat(REFUSE, AUTRE_CLE))?.ok).toBe(true);
    expect((await loadOperationalStatuses(CLE)).get(REFUSE)?.ok).toBe(false);
    expect((await loadOperationalStatuses(AUTRE_CLE)).get(REFUSE)?.ok).toBe(true);
    await sql`DELETE FROM ai_model_operational_status WHERE key_fingerprint = ${await empreinte(AUTRE_CLE)}`;
  });

  it('L114Q-E06 (R08, A03) — promotion refusée dans la transaction quand le modèle est confirmé indisponible', async () => {
    const { profiledOperationsOf } = await import('@/services/ai/config/operation-profiles');
    const { promote } = await import('@/services/ai/config/routing-state.service');
    const operationCode = profiledOperationsOf('T2')[0].operationCode;
    const [{ n: avant }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_routing_promotions`;
    // T2 : le modèle refusé est le repli 1 de la chaîne configurée — le promouvoir en tête est refusé.
    const e = await promote({ operationCode, model: REFUSE, justification: 'e2e l114q', origin: 'admin' }, session.adminId).catch((x) => x);
    expect(e).toMatchObject({ code: 'BLOCKED_MODEL_UNAVAILABLE' });
    expect(String(e.message)).toMatch(/confirmé indisponible/);
    expect(String(e.message)).not.toContain(CLE);
    const [{ n: apres }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_routing_promotions`;
    expect(apres).toBe(avant);
    // Les preuves de qualification technique du modèle ne sont pas effacées par le refus.
    const [{ n: qualifs }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_model_qualification WHERE model = ${REFUSE}`;
    expect(qualifs).toBe(1);
  });

  it('L114Q-E07 (R07, E04) — refus d’un appel réel : écrit dans l’état canonique ; 429 et 5xx : rien', async () => {
    const { fallbackContext, invalidateFallbackStatusCache } = await F();
    const cible = 'gemini-3.1-flash-lite';
    const v0 = await versionPartagee();
    const transitoires = [
      Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}'), { status: 429 }),
      Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE","message":"overloaded"}}'), { status: 503 }),
    ];
    for (const err of transitoires) {
      expect(await fallbackContext().reportRefusal({ model: cible, error: err, httpStatus: (err as { status?: number }).status ?? null, sentAt: new Date() })).toBeNull();
    }
    expect((await etat(cible))?.ok).toBe(true);
    expect(await versionPartagee()).toBe(v0);

    const signal = await fallbackContext().reportRefusal({ model: cible, error: refus15389(cible), httpStatus: 404, sentAt: new Date() });
    expect(signal).toBe('recorded');
    expect(await etat(cible)).toMatchObject({ ok: false, check_status: 'failed_confirmed', source: 'gateway_call', http_status: 404, provider_code: 'NOT_FOUND' });
    expect(await versionPartagee()).toBe(v0 + 1);
    // Opposable aussitôt à la passerelle de cette instance (aucune attente de la sonde quotidienne).
    expect([...(await fallbackContext().knownUnavailable()).keys()].sort()).toEqual([cible, REFUSE].sort());
    // T1 n'a plus aucune route utilisable (principal et repli confirmés indisponibles) : alerte critique.
    const r = await sync();
    const g = (await alertes()).filter((a) => a.resolved_at === null);
    expect(g.map((a) => [a.details.model, a.severity]).sort()).toEqual([[cible, 'warning'], [REFUSE, 'critical']].sort());
    expect(r.anomalies.length).toBeGreaterThan(5);
    // Remise en état pour la suite : le modèle répond à la sonde demandée par un administrateur.
    await sync('manual');
    invalidateFallbackStatusCache();
    expect((await etat(cible))?.ok).toBe(true);
  });

  it('L114Q-E08 (A04, B03) — rétablissement prouvé : blocage levé, alerte résolue, aucune résurrection ; configuration intacte', async () => {
    const { fallbackContext, invalidateFallbackStatusCache } = await F();
    // Le geste « Actualiser le catalogue » en E07 a recontrôlé le modèle refusé (toujours refusé) : échéance repoussée.
    expect(await etat(REFUSE)).toMatchObject({ ok: false, failure_count: 2 });
    comportement.clear();
    const v0 = await versionPartagee();
    // Passage planifié avant l'échéance : toujours exclu (pas de réactivation sans preuve).
    await sync();
    expect((await etat(REFUSE))?.ok).toBe(false);
    // Preuve : sonde réussie pour le même accès (geste de l'administrateur).
    const r = await sync('manual');
    expect(await etat(REFUSE)).toMatchObject({ ok: true, check_status: 'ok', failure_count: 0, next_probe_at: null, confirmed_at: null, error: null });
    expect(await versionPartagee()).toBeGreaterThan(v0);
    expect(r.anomalies).toEqual([]);
    invalidateFallbackStatusCache();
    expect((await fallbackContext().knownUnavailable()).size).toBe(0);
    expect((await utilisable(REFUSE)).usable).toBe(true);
    // Alertes résolues automatiquement, conservées ; aucune résurrection aux passages suivants.
    const a = await alertes();
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a.every((x) => x.resolved_at !== null)).toBe(true);
    expect(a.find((x) => x.details.model === REFUSE)?.resolution_code).toBe('MODEL_AVAILABLE_AGAIN');
    const n = a.length;
    await sync();
    await sync('manual');
    expect(await alertes()).toHaveLength(n);
    expect((await statut()).body.unavailableTitle).toBeNull();
    // Aucune substitution ni réactivation automatique : la configuration active n'a jamais été modifiée.
    expect(JSON.stringify(await sql`SELECT * FROM ai_config_entries WHERE version_id = ${versionId} ORDER BY treatment`)).toBe(entreesAvant);
    const [{ n: promotions }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_routing_promotions WHERE reverted_at IS NULL`;
    expect(promotions).toBe(0);
  });

  it('L114Q-E09 (S04, B04) — incident global du fournisseur : aucun modèle déclassé, alerte séparée puis résolue', async () => {
    for (const m of LISTES) comportement.set(m, 'cle');
    envoyees.length = 0;
    const r = await sync('manual');
    expect(envoyees).toHaveLength(1); // l'éclaireur seul : les autres sondes ne partent pas
    expect(r.operational.notSent).toHaveLength(2);
    expect(r.operational.providerIncident).toBe('auth_global');
    for (const m of LISTES) expect(await etat(m), m).toMatchObject({ ok: true, check_status: 'inconclusive', error_kind: 'auth_global' });
    expect(r.anomalies).toEqual([]);
    const s = await statut();
    expect(s.body.unavailableTitle).toBeNull();
    expect(s.body.operationalWatch.providerIncident).toMatchObject({ code: 'PROVIDER_AUTH_FAILURE', kind: 'auth_global' });
    expect(s.body.operationalWatch.providerIncident.models).toHaveLength(3);
    expect(JSON.stringify(s.body)).not.toContain(CLE);
    const inc = await alertes('ai_provider_auth_failure');
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: 'critical', resolved_at: null });
    expect(JSON.stringify(inc)).not.toContain(CLE);
    expect((await alertes()).filter((a) => a.resolved_at === null)).toHaveLength(0); // aucune indisponibilité de modèle
    // Second passage : même alerte ; rétablissement : résolue.
    await sync('manual');
    expect(await alertes('ai_provider_auth_failure')).toHaveLength(1);
    comportement.clear();
    await sync('manual');
    const apres = await alertes('ai_provider_auth_failure');
    expect(apres).toHaveLength(1);
    expect(apres[0].resolution_code).toBe('PROVIDER_ACCESS_RESTORED');
    expect((await statut()).body.operationalWatch.providerIncident).toBeNull();
  });
});
