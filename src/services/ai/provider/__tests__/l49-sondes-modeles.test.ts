/**
 * Lot 49 (49E) — ticket 11 « BO IA — Fiabiliser la détection “modèle actif
 * indisponible” et les sondes Gemini » : critères d'acceptation T11-AC01 à
 * T11-AC16, partie unitaire (base simulée, aucun appel fournisseur). Le
 * parcours sur PostgreSQL réel (migration 0335, route catalog-status,
 * alerte unique) est couvert par
 * `src/test/e2e/scenarios/l49e-sondes-modeles.e2e.ts`.
 *
 *   T11-AC01 modèle sain : aucune alerte
 *   T11-AC02 429, délai, 5xx, réseau : inconclusive, modèle toujours utilisable
 *   T11-AC03 réponse vide (même répétée) : pas de déclassement
 *   T11-AC04 erreur globale de clé : aucun modèle à ok=false
 *   T11-AC05 403 ambigu : inconclusive
 *   T11-AC06 retrait explicite / 404 du modèle : indisponible confirmé
 *   T11-AC07 premier échec présumé définitif : confirmation nécessaire
 *   T11-AC08 sonde : reasoning minimal, maxOutputTokens 512
 *   T11-AC09 BO : erreur nettoyée, date et source visibles
 *   T11-AC10 « 1 modèle actif indisponible — 5 usages impactés »
 *   T11-AC11 les 5 usages regroupés sous le modèle
 *   T11-AC12 une seule alerte par modèle et fenêtre, details avec tous les usages
 *   T11-AC13 sévérité agrégée
 *   T11-AC14 aucun modèle remplacé automatiquement
 *   T11-AC15 replis existants toujours utilisables
 *   T11-AC16 aucun secret au BO ni dans les journaux
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;

// Base simulée : ligne connue de `ai_model_operational_status` par modèle.
const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  writes: [] as unknown[][],
  fail: null as Error | null,
}));
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string, params: unknown[] = []) => {
      if (db.fail) throw db.fail;
      if (/^\s*INSERT INTO ai_model_operational_status/.test(q)) {
        db.writes.push(params);
        const [model, , ok, error, source, checkStatus, errorKind, suspectSince] = params as [string, string, boolean | null, string | null, string, string, string | null, string | null];
        db.rows.set(model, { model, ok, error, source, check_status: checkStatus, error_kind: errorKind, suspect_since: suspectSince, checked_at: '2026-10-12T08:00:00Z' });
        return [];
      }
      if (/FROM ai_model_operational_status/.test(q) && /model = \$1/.test(q)) {
        const r = db.rows.get(String(params[0]));
        return r ? [r] : [];
      }
      if (/FROM ai_model_operational_status/.test(q)) return [...db.rows.values()];
      return [];
    }),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const C = await import('../probe-classification');
const O = await import('../model-operational.service');
const A = await import('../active-model-anomalies');
const { usableModelsForTreatment } = await import('../../registry/usable-models');
const { providerTestGenerationBody } = await import('../provider-test.service');
const { UnavailableModelCard } = await import('@/app/admin/ai-config/_components/CatalogBanners');
type UsableModelsContext = import('../../registry/usable-models').UsableModelsContext;
type ActiveChainEntry = import('../active-model-anomalies').ActiveChainEntry;

const SECRET = 'AIzaSyD-cle-secrete-de-test-0123456789';

beforeEach(() => {
  db.rows.clear();
  db.writes = [];
  db.fail = null;
});
afterEach(() => vi.restoreAllMocks());

function ctx(operational: UsableModelsContext['operational'] = new Map()): UsableModelsContext {
  const listes = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
  return {
    environment: 'production',
    catalog: {
      refreshedAt: '2026-10-12T06:00:00Z',
      models: listes.map((model) => ({ model, available: true, supportsGeneration: true, lifecycle: 'stable' as const })),
    },
    codeCatalog: [],
    price: () => ({ verified: false }),
    operational,
    qualifications: new Map(),
    today: '2026-10-12',
  };
}

/** gemini-3.6-flash à cinq endroits (situation du 11/10, T5 remplacé par T6 depuis le lot 49). */
const CHAINES: ActiveChainEntry[] = [
  { treatment: 'T1', rank: 'primaryModel', model: 'gemini-3.6-flash', source: 'version' },
  { treatment: 'T1', rank: 'fallback1', model: 'gemini-3.1-flash-lite', source: 'version' },
  { treatment: 'T2', rank: 'primaryModel', model: 'gemini-3.5-flash-lite', source: 'version' },
  { treatment: 'T2', rank: 'fallback1', model: 'gemini-3.6-flash', source: 'version' },
  { treatment: 'T3', rank: 'primaryModel', model: 'gemini-3.6-flash', source: 'version' },
  { treatment: 'T3', rank: 'fallback1', model: 'gemini-3.1-flash-lite', source: 'version' },
  { treatment: 'T4', rank: 'primaryModel', model: 'gemini-3.6-flash', source: 'version' },
  { treatment: 'T4', rank: 'fallback1', model: 'gemini-3.1-flash-lite', source: 'version' },
  { treatment: 'T6', rank: 'primaryModel', model: 'gemini-3.5-flash-lite', source: 'version' },
  { treatment: 'T6', rank: 'fallback1', model: 'gemini-3.1-flash-lite', source: 'version' },
  { treatment: 'T6', rank: 'fallback2', model: 'gemini-3.6-flash', source: 'version' },
];
const indisponible = () => new Map([['gemini-3.6-flash', { ok: false, checkedAt: '2026-10-12T08:00:00Z', error: 'HTTP 404 NOT_FOUND — model retired', source: 'catalog_refresh' }]]);

describe('T11-AC01 — modèle sain', () => {
  it('T11-AC01 — la sonde répond : état ok, aucune anomalie, aucune alerte', async () => {
    const r = await O.probeModels(['gemini-3.6-flash'], SECRET, { call: async () => ({ rawText: 'OK' }), confirmDelayMs: 0 });
    expect(r[0]).toMatchObject({ ok: true, checkStatus: 'ok' });
    expect(db.rows.get('gemini-3.6-flash')).toMatchObject({ ok: true, check_status: 'ok' });
    const statuses = await O.loadOperationalStatuses(SECRET);
    const anomalies = A.detectActiveModelAnomalies(CHAINES, ctx(statuses));
    expect(anomalies).toEqual([]);
    const raise = vi.fn(async () => true);
    expect(await A.raiseActiveModelAlerts(anomalies, new Date(), raise)).toBe(0);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe('T11-AC02 à T11-AC07 — classification des résultats de sonde', () => {
  const sain = { ok: true, checkStatus: 'ok' as const, suspectSince: null };

  it.each([
    ['429 RESOURCE_EXHAUSTED', Object.assign(new Error('got status: 429 Too Many Requests. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}'), {}), 'quota'],
    ['délai', Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TIMEOUT' }), 'timeout'],
    ['503', new Error('got status: 503 Service Unavailable. {"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded."}}'), 'server'],
    ['réseau', new Error('fetch failed: ECONNRESET'), 'network'],
  ])('T11-AC02 — %s : inconclusive, dernier état conservé, modèle toujours utilisable', (_n, err, kind) => {
    const c = C.classifyProbeFailure(err, { model: 'gemini-3.6-flash' });
    expect(c).toMatchObject({ status: 'inconclusive', kind });
    const next = C.nextOperationalState(sain, c);
    expect(next).toMatchObject({ ok: true, checkStatus: 'inconclusive' });
    expect(usableModelsForTreatment('T1', ctx(new Map([['gemini-3.6-flash', { ok: next.ok as boolean, checkedAt: '', error: next.error, source: 'catalog_refresh' }]]))).map((m) => m.model))
      .toContain('gemini-3.6-flash');
  });

  it('T11-AC02 — 5xx : catégorie « server », jamais « failed »', () => {
    expect(C.classifyProbeFailure(Object.assign(new Error('Internal error'), { status: 500 }))).toMatchObject({ status: 'inconclusive', kind: 'server' });
  });

  it('T11-AC03 — réponse vide, même répétée : non concluant, jamais un retrait', async () => {
    expect(C.classifyProbeResponse('   ')).toMatchObject({ status: 'inconclusive', kind: 'empty_response' });
    db.rows.set('gemini-3.6-flash', { model: 'gemini-3.6-flash', ok: true, check_status: 'ok', error: null, suspect_since: null, source: 'catalog_refresh', checked_at: '2026-10-11T08:00:00Z' });
    for (let i = 0; i < 3; i++) {
      const [r] = await O.probeModels(['gemini-3.6-flash'], SECRET, { call: async () => ({ rawText: '' }), confirmDelayMs: 0 });
      expect(r).toMatchObject({ ok: false, transient: true, checkStatus: 'inconclusive' });
    }
    expect(db.rows.get('gemini-3.6-flash')).toMatchObject({ ok: true, check_status: 'inconclusive', error_kind: 'empty_response' });
    expect((await O.loadOperationalStatuses(SECRET)).get('gemini-3.6-flash')?.ok).toBe(true);
  });

  it('T11-AC03 — ancien `ok=false` « réponse vide » (avant le lot 49) : relu comme état inconnu, modèle non écarté', async () => {
    db.rows.set('gemini-3.6-flash', { model: 'gemini-3.6-flash', ok: false, check_status: null, error: 'réponse vide', source: 'catalog_refresh', checked_at: '2026-10-11T08:00:00Z' });
    expect((await O.loadOperationalStatuses(SECRET)).has('gemini-3.6-flash')).toBe(false);
    expect((await O.loadOperationalDiagnostics(SECRET)).get('gemini-3.6-flash')).toMatchObject({ checkStatus: 'inconclusive', ok: null });
  });

  it.each([
    ['401', Object.assign(new Error('Request had invalid authentication credentials.'), { status: 401 })],
    ['400 clé invalide', new Error('got status: 400 Bad Request. {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key."}}')],
    ['403 projet', new Error('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Generative Language API has not been used in project 123 before or it is disabled."}}')],
  ])('T11-AC04 — erreur globale (%s) : aucun modèle passé à ok=false', async (_n, err) => {
    const modeles = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    for (const m of modeles) db.rows.set(m, { model: m, ok: true, check_status: 'ok', error: null, suspect_since: null, source: 'catalog_refresh', checked_at: '2026-10-11T08:00:00Z' });
    const r = await O.probeModels(modeles, SECRET, { call: async () => { throw err; }, confirmDelayMs: 0 });
    expect(r.every((x) => x.checkStatus === 'inconclusive')).toBe(true);
    for (const m of modeles) expect(db.rows.get(m)?.ok).toBe(true);
    expect(db.writes.every((p) => p[2] !== false)).toBe(true);
  });

  it('T11-AC05 — 403 sans mention du modèle : inconclusive', () => {
    const c = C.classifyProbeFailure(new Error('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"The caller does not have permission"}}'));
    expect(c).toMatchObject({ status: 'inconclusive', kind: 'forbidden_ambiguous' });
    expect(C.nextOperationalState(sain, c).ok).toBe(true);
  });

  it.each([
    ['retrait explicite', new Error('{"error":{"code":404,"status":"NOT_FOUND","message":"models/gemini-3.6-flash has been retired and is no longer available."}}'), 'model_retired'],
    ['404 du modèle', new Error('{"error":{"code":404,"status":"NOT_FOUND","message":"models/gemini-3.6-flash is not found for API version v1beta, or is not supported for generateContent."}}'), 'model_not_found'],
    ['ancienne trace « 404 no longer available »', new Error('404 no longer available'), 'model_retired'],
  ])('T11-AC06 — %s : indisponible confirmé dès le premier contrôle', async (_n, err, kind) => {
    const c = C.classifyProbeFailure(err, { model: 'gemini-3.6-flash' });
    expect(c).toMatchObject({ status: 'failed', kind, definitive: true });
    const [r] = await O.probeModels(['gemini-3.6-flash'], SECRET, { call: async () => { throw err; }, confirmDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, checkStatus: 'failed_confirmed' });
    expect(r.transient).toBeUndefined();
    expect((await O.loadOperationalStatuses(SECRET)).get('gemini-3.6-flash')?.ok).toBe(false);
  });

  it('T11-AC07 — premier échec présumé (403 propre au modèle) : SUSPECT, état sain conservé, second contrôle', async () => {
    const err = new Error('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Access to model gemini-3.6-flash is denied for this project tier."}}');
    expect(C.classifyProbeFailure(err, { model: 'gemini-3.6-flash' })).toMatchObject({ status: 'failed', definitive: false });
    // Transition pure : suspect, état retenu inchangé.
    const s1 = C.nextOperationalState(sain, C.classifyProbeFailure(err, { model: 'gemini-3.6-flash' }), new Date('2026-10-12T08:00:00Z'));
    expect(s1).toMatchObject({ ok: true, checkStatus: 'suspect', suspectSince: '2026-10-12T08:00:00.000Z' });

    // Second contrôle sain : le modèle reste sain, aucune dégradation.
    db.rows.set('gemini-3.6-flash', { model: 'gemini-3.6-flash', ok: true, check_status: 'ok', error: null, suspect_since: null, source: 'catalog_refresh', checked_at: '2026-10-11T08:00:00Z' });
    let n = 0;
    const [r1] = await O.probeModels(['gemini-3.6-flash'], SECRET, {
      call: async () => { n++; if (n === 1) throw err; return { rawText: 'OK' }; }, confirmDelayMs: 0,
    });
    expect(n).toBe(2);
    expect(r1).toMatchObject({ ok: true, checkStatus: 'ok' });
    expect(db.rows.get('gemini-3.6-flash')).toMatchObject({ ok: true, check_status: 'ok', suspect_since: null });

    // Échec répété : confirmé.
    const [r2] = await O.probeModels(['gemini-3.6-flash'], SECRET, { call: async () => { throw err; }, confirmDelayMs: 0 });
    expect(r2).toMatchObject({ ok: false, checkStatus: 'failed_confirmed' });
    expect(db.writes.slice(-2).map((p) => p[5])).toEqual(['suspect', 'failed_confirmed']);
  });

  it('T11-AC07 — un contrôle non concluant entre deux échecs garde la suspicion (sans dégrader)', () => {
    const suspect = { ok: true, checkStatus: 'suspect' as const, suspectSince: '2026-10-12T08:00:00.000Z' };
    const nc = C.nextOperationalState(suspect, { status: 'inconclusive', kind: 'timeout', error: 'timeout' });
    expect(nc).toMatchObject({ ok: true, suspectSince: suspect.suspectSince });
  });
});

describe('T11-AC08 — paramètres de la sonde', () => {
  it('T11-AC08 — reasoning « minimal » explicite et maxOutputTokens 512 (sonde, test de clé)', () => {
    expect(C.PROBE_REASONING).toBe('minimal');
    expect(C.PROBE_MAX_OUTPUT_TOKENS).toBe(512);
    expect(O.probeCallInput('gemini-3.6-flash')).toMatchObject({
      model: 'gemini-3.6-flash', reasoning: 'minimal', maxOutputTokens: 512, timeoutMs: 20_000, prompt: 'Réponds exactement : OK', attachments: [],
    });
    const corps = providerTestGenerationBody('gemini-3.6-flash');
    expect(corps).toMatchObject({ generationConfig: { maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'low' } } });
    expect(JSON.stringify(corps)).not.toMatch(/temperature/);
    // Gemini 2.5 Flash : raisonnement désactivé (budget 0), toujours plafonné à 512.
    expect(providerTestGenerationBody('gemini-2.5-flash')).toMatchObject({ generationConfig: { maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } } });
  });
});

describe('T11-AC09 à T11-AC15 — BO, regroupement, alerte, configuration', () => {
  const diagnostics = new Map([['gemini-3.6-flash', {
    model: 'gemini-3.6-flash', ok: false, checkStatus: 'failed_confirmed' as const,
    error: C.sanitizeProviderError(`got status: 404. {"error":{"code":404,"status":"NOT_FOUND","message":"models/gemini-3.6-flash has been retired. key=${SECRET}"}}`, SECRET),
    errorKind: 'model_retired' as const, checkedAt: '2026-10-12T08:00:00.000Z', source: 'catalog_refresh', lastOkAt: null, suspectSince: null,
  }]]);

  it('T11-AC10 / T11-AC11 — un modèle à cinq endroits : « 1 modèle actif indisponible — 5 usages impactés », usages regroupés', () => {
    const anomalies = A.detectActiveModelAnomalies(CHAINES, ctx(indisponible()));
    expect(anomalies).toHaveLength(5);
    const groupes = A.groupAnomaliesByModel(anomalies, diagnostics);
    expect(groupes).toHaveLength(1);
    expect(A.unavailableBannerTitle(groupes)).toBe('1 modèle actif indisponible — 5 usages impactés');
    expect(groupes[0].usages.map(A.usageLabel)).toEqual(['T1 principal', 'T2 repli 1', 'T3 principal', 'T4 principal', 'T6 repli 2']);
  });

  it('T11-AC10 — plusieurs modèles : identifiants distincts et occurrences comptés séparément', () => {
    const op = indisponible();
    op.set('gemini-3.1-flash-lite', { ok: false, checkedAt: '', error: 'retired', source: 'catalog_refresh' });
    const groupes = A.groupAnomaliesByModel(A.detectActiveModelAnomalies(CHAINES, ctx(op)));
    expect(groupes.map((g) => g.model).sort()).toEqual(['gemini-3.1-flash-lite', 'gemini-3.6-flash']);
    expect(A.unavailableBannerTitle(groupes)).toBe('2 modèles actifs indisponibles — 9 usages impactés');
  });

  it('T11-AC09 / T11-AC16 — BO : message Google nettoyé, date et source visibles, aucun secret (desktop et mobile : même composant)', () => {
    const [g] = A.groupAnomaliesByModel(A.detectActiveModelAnomalies(CHAINES, ctx(indisponible())), diagnostics);
    expect(g.diagnostic).toMatchObject({ status: 'failed_confirmed', checkedAt: '2026-10-12T08:00:00.000Z', source: 'catalog_refresh', sourceLabel: 'actualisation du catalogue (sonde)' });
    expect(g.diagnostic.error).toBe('HTTP 404 NOT_FOUND — models/gemini-3.6-flash has been retired. key=***');
    const html = renderToStaticMarkup(h('ul', null, h(UnavailableModelCard, { group: g as never })));
    expect(html).toContain('gemini-3.6-flash');
    expect(html).toContain('5 usages impactés');
    expect(html).toContain('T6 repli 2');
    expect(html).toContain('failed_confirmed');
    expect(html).toContain('HTTP 404 NOT_FOUND');
    expect(html).toContain('actualisation du catalogue (sonde)');
    expect(html).toMatch(/12\/10\/2026/);
    expect(html).not.toContain(SECRET);
    // Mise en page fluide commune : une colonne en mobile, deux à partir de `sm`.
    expect(html).toMatch(/grid-cols-1 sm:grid-cols-\[auto_1fr\]/);
    expect(html).toMatch(/flex-wrap/);
  });

  it('T11-AC09 — le bandeau lit le titre et les groupes rendus par la route (aucune consultation SQL)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/admin/ai-config/_components/CatalogBanners.tsx'), 'utf8');
    expect(src).toMatch(/data\.unavailableTitle/);
    expect(src).toMatch(/data\.unavailableModels\.map/);
    const route = readFileSync(join(process.cwd(), 'src/app/api/admin/ai/catalog-status/route.ts'), 'utf8');
    expect(route).toMatch(/unavailableModels/);
    expect(route).toMatch(/unavailableTitle: unavailableBannerTitle/);
  });

  it('T11-AC12 / T11-AC13 — UNE alerte par modèle et fenêtre, tous les usages dans details, sévérité agrégée', async () => {
    const raise = vi.fn(async (_a: unknown) => true);
    const anomalies = A.detectActiveModelAnomalies(CHAINES, ctx(indisponible()));
    expect(await A.raiseActiveModelAlerts(anomalies, new Date('2026-10-12T09:00:00Z'), raise, diagnostics)).toBe(1);
    expect(raise).toHaveBeenCalledTimes(1);
    const alerte = raise.mock.calls[0][0] as { dedupeKey: string; severity: string; treatment: unknown; details: { usages: Array<Record<string, unknown>>; diagnostic: Record<string, unknown> } };
    expect(alerte.dedupeKey).toBe('ai:active-model:gemini-3.6-flash:2026-10-12');
    expect(alerte.treatment).toBeNull();
    expect(alerte.details.usages).toHaveLength(5);
    expect(alerte.details.usages[0]).toEqual({ treatment: 'T1', rank: 'primaryModel', source: 'version', fallbackAvailable: true });
    expect(alerte.details.diagnostic).toMatchObject({ status: 'failed_confirmed', source: 'catalog_refresh' });
    // Chaque principal a un repli utilisable : avertissement.
    expect(alerte.severity).toBe('warning');
    // Même fenêtre : même clé (dédupliquée par `raiseAlert`) ; jour suivant : nouvelle clé.
    await A.raiseActiveModelAlerts(anomalies, new Date('2026-10-12T22:00:00Z'), raise);
    await A.raiseActiveModelAlerts(anomalies, new Date('2026-10-13T09:00:00Z'), raise);
    expect(raise.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey)).toEqual([
      'ai:active-model:gemini-3.6-flash:2026-10-12', 'ai:active-model:gemini-3.6-flash:2026-10-12', 'ai:active-model:gemini-3.6-flash:2026-10-13',
    ]);
  });

  it('T11-AC13 — critique si au moins un principal n’a aucun repli utilisable', () => {
    const sansRepli = CHAINES.filter((c) => !(c.treatment === 'T4' && c.rank === 'fallback1'));
    const [g] = A.groupAnomaliesByModel(A.detectActiveModelAnomalies(sansRepli, ctx(indisponible())));
    expect(g.severity).toBe('critical');
    expect(A.groupMessage(g)).toMatch(/Aucun repli utilisable pour T4/);
  });

  it('T11-AC14 / T11-AC15 — aucune substitution : chaînes inchangées, replis toujours proposés', async () => {
    const copie = JSON.parse(JSON.stringify(CHAINES));
    const c = ctx(indisponible());
    const anomalies = A.detectActiveModelAnomalies(CHAINES, c);
    await A.raiseActiveModelAlerts(anomalies, new Date(), async () => true);
    expect(CHAINES).toEqual(copie);
    for (const t of ['T1', 'T3', 'T4'] as const) {
      expect(anomalies.find((a) => a.treatment === t && a.rank === 'primaryModel')?.fallbackAvailable).toBe(true);
      expect(usableModelsForTreatment(t, c).map((m) => m.model)).toContain('gemini-3.1-flash-lite');
    }
    expect(A.groupMessage(A.groupAnomaliesByModel(anomalies)[0])).toMatch(/Les chaînes de repli prennent le relais\. Aucun remplacement automatique/);
    // Le service de synchronisation n'écrit jamais dans la configuration.
    const sync = readFileSync(join(process.cwd(), 'src/services/ai/provider/ai-catalog-sync.service.ts'), 'utf8');
    expect(sync).not.toMatch(/ai_config_entries|saveEntry|createDraft|activateVersion/);
  });
});

describe('T11-AC16 — aucun secret fournisseur', () => {
  it('T11-AC16 — nettoyage : secret connu, clé Google, paramètre key=, Bearer, en-tête', () => {
    const brut = `POST https://x/v1beta/models/m:generateContent?key=${SECRET}&alt=sse failed; Bearer abc.def-ghi; x-goog-api-key: AIzaAutreCle1234567890; ${SECRET}`;
    const propre = C.sanitizeProviderError(brut, SECRET);
    expect(propre).not.toContain(SECRET);
    expect(propre).not.toContain('AIzaAutreCle');
    expect(propre).not.toContain('abc.def-ghi');
    expect(propre.length).toBeLessThanOrEqual(500);
  });

  it('T11-AC16 — journaux : un échec d’écriture ne journalise pas le secret ; l’état écrit est nettoyé', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.fail = new Error(`connexion refusée pour ${SECRET}`);
    await O.recordOperationalCheck({ model: 'gemini-3.6-flash', secret: SECRET, outcome: { status: 'inconclusive', kind: 'network', error: `boom ${SECRET}` }, source: 'catalog_refresh' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    db.fail = null;
    await O.probeModels(['gemini-3.6-flash'], SECRET, { call: async () => { throw new Error(`HTTP 503 UNAVAILABLE ?key=${SECRET}`); }, confirmDelayMs: 0 });
    expect(JSON.stringify(db.writes)).not.toContain(SECRET);
    const d = await O.loadOperationalDiagnostics(SECRET);
    expect(JSON.stringify([...d.values()])).not.toContain(SECRET);
  });
});
