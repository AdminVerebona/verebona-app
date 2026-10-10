/**
 * Registre de modèles, contrôle de démarrage, alertes et indicateurs —
 * CDC §15.11, §15.13, §15.14, §29.6, §31.3, §32.2, §32.5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ unsafe: vi.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: h.unsafe }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

const registre = await import('../registries/model-registry');
const { recordAiRun, awaitAiRuns } = await import('../core/usage-tracking.service');
const { checkModelRegistry, runAssistantStartupCheck, lastValidRegistry, resetModelStartupForTests, currentStartupVerdict } =
  await import('../core/model-startup-check');
const alertes = await import('../observability/assistant-alerts');
const { getTreatmentMetrics, setMetricsQueryRunner } = await import('@/services/ai/config/treatment-metrics.repository');
const { outputDigestForLog, stripRawExcerpt } = await import('@/services/ai/gateway/redaction');
const { ensureAssistantStartupChecked, resetStartupCheckForTests } = await import('..');

const ENV = ['VEREBONA_ASSISTANT_DEFAULT_MODEL_ALIAS', 'VEREBONA_ASSISTANT_ESCALATION_MODEL_ALIAS',
  'VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT', 'VEREBONA_ASSISTANT_MODEL_ASSISTANT_ESCALATION',
  'VEREBONA_ASSISTANT_MODEL_DEPRECATIONS', 'VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS'];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  h.unsafe.mockReset();
  h.unsafe.mockImplementation(async () => []);
  resetModelStartupForTests();
  resetStartupCheckForTests();
  setMetricsQueryRunner(null);
});

describe('§15.11 — alias configurés, modèle attendu', () => {
  it('noms d’alias et modèles attendus lus en configuration (§43), sinon le référentiel', () => {
    expect(registre.aliasForRank(0)).toMatchObject({ alias: 'assistant-default', rank: 0 });
    expect(registre.aliasForRank(1).alias).toBe('assistant-escalation');
    process.env.VEREBONA_ASSISTANT_DEFAULT_MODEL_ALIAS = 'verebona-defaut';
    process.env.VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT = 'gemini-9-flash-lite';
    expect(registre.aliasForRank(0)).toMatchObject({ alias: 'verebona-defaut', expectedModel: 'gemini-9-flash-lite' });
  });

  it('résolution de l’alias par la chaîne effective (configuration versionnée)', async () => {
    const r = await registre.resolveAliases('t2_answer', async () => ({ primaryModel: 'gemini-a', fallbackModels: ['gemini-b'] }));
    expect(r).toEqual({ operationCode: 't2_answer', default: 'gemini-a', escalation: 'gemini-b' });
  });

  it('chaque appel trace l’alias configuré et le modèle attendu (verebona_ai_runs)', async () => {
    process.env.VEREBONA_ASSISTANT_ESCALATION_MODEL_ALIAS = 'verebona-escalade';
    await recordAiRun({
      requestId: 'r1', routeReason: 'x', promptId: 'p', promptVersion: 'v', accountId: 7, operationCode: 't2_answer',
      resolvedModelId: 'gemini-b', fallbackUsed: true, inputTokens: 1, outputTokens: 1, costMicros: 1, latencyMs: 1,
      attemptNumber: 1, status: 'ok', promptHash: 'h', expectedModelId: 'gemini-b',
    });
    const [sql, params] = h.unsafe.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/expected_model_id/);
    expect(params[3]).toBe('verebona-escalade:t2_answer');
    expect(params.at(-1)).toBe('gemini-b');
  });

  it('awaitAiRuns attend les traces encore en écriture (rattachement au message, §28.8)', async () => {
    let fini = false;
    h.unsafe.mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 20)); fini = true; return []; });
    void recordAiRun({
      requestId: 'r2', routeReason: 'x', promptId: 'p', promptVersion: 'v', accountId: 7, operationCode: 't2_answer',
      resolvedModelId: 'm', fallbackUsed: false, inputTokens: 1, outputTokens: 1, costMicros: 1, latencyMs: 1, attemptNumber: 1, status: 'ok', promptHash: 'h',
    });
    await awaitAiRuns('r2');
    expect(fini).toBe(true);
  });
});

describe('§15.14 — contrôle du registre au démarrage et au changement de configuration', () => {
  const ops = (primary: string, fallback: string[]) => ({
    t2_understand: { operationCode: 't2_understand', useCaseCode: 'INTELLIGENT_ASSISTANT', label: '', provider: 'gemini', primaryModel: primary, fallbackModels: fallback, timeoutMs: 1, outputSchema: 'X' },
    t2_revalidate: { operationCode: 't2_revalidate', useCaseCode: 'INTELLIGENT_ASSISTANT', label: '', provider: 'gemini', primaryModel: primary, fallbackModels: fallback, timeoutMs: 1, outputSchema: 'X' },
    t2_answer: { operationCode: 't2_answer', useCaseCode: 'INTELLIGENT_ASSISTANT', label: '', provider: 'gemini', primaryModel: primary, fallbackModels: fallback, timeoutMs: 1, outputSchema: 'X' },
  }) as never;
  const deps = (primary: string, fallback: string[], prix = true) => ({
    operations: ops(primary, fallback),
    resolve: async () => ({ primaryModel: primary, fallbackModels: fallback }),
    hasPrice: () => prix,
  });

  it('registre valide : alias résolus, prix présents, sorties structurées', async () => {
    const r = await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.1-flash-lite']));
    expect(r.ok).toBe(true);
    expect(r.snapshot.aliases).toEqual({ 'assistant-default': 'gemini-3.5-flash-lite', 'assistant-escalation': 'gemini-3.1-flash-lite' });
  });

  it('refuse : « latest », défaut = escalade, modèle sans sortie structurée — lot 35B : prix absent et preview ne bloquent plus', async () => {
    const sansPrix = await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.1-flash-lite'], false));
    expect(sansPrix.ok).toBe(true);
    expect(sansPrix.warnings.join()).toMatch(/aucun prix/);
    expect((await checkModelRegistry(deps('gemini-4-flash-preview', ['gemini-3.1-flash-lite']))).ok).toBe(true);
    expect((await checkModelRegistry(deps('gemini-flash-latest', ['gemini-3.1-flash-lite']))).errors.join()).toMatch(/latest/);
    expect((await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.5-flash-lite']))).errors.join()).toMatch(/identique/);
    expect((await checkModelRegistry(deps('claude-x', ['gemini-3.1-flash-lite']))).errors.join()).toMatch(/sortie structurée/);
  });

  it('conserve le dernier registre valide, alerte et rend l’assistant indisponible en cas d’échec', async () => {
    const raiseAlert = vi.fn(async () => true);
    await runAssistantStartupCheck('startup', { ...deps('gemini-3.5-flash-lite', ['gemini-3.1-flash-lite']), raiseAlert });
    expect(currentStartupVerdict()).toEqual({ ok: true });
    const valide = lastValidRegistry();
    await runAssistantStartupCheck('config_change', { ...deps('gemini-flash-latest', ['gemini-3.1-flash-lite']), raiseAlert });
    expect(currentStartupVerdict()?.ok).toBe(false);
    expect(ensureAssistantStartupChecked().ok).toBe(false);
    expect(lastValidRegistry()).toBe(valide);
    expect(raiseAlert).toHaveBeenCalledWith(expect.objectContaining({
      code: 'assistant_model_registry_invalid', severity: 'critical', details: expect.objectContaining({ lastValid: valide }),
    }));
  });
});

describe('§31.3, §15.13 — alertes d’exploitation', () => {
  const M = (over: Partial<import('../observability/assistant-alerts').AssistantAlertMetrics> = {}) => ({
    requestsWithAi: 100, escalatedRequests: 5, avgTokensRecent: 1000, avgTokensPrevious: 1000, callsRecent: 100, callsPrevious: 100,
    callsWithExpectation: 100, mismatchedCalls: 0, deprecations: [], ...over,
  });
  const codes = (m: ReturnType<typeof M>, now = new Date('2026-09-27T10:00:00Z')) => alertes.evaluateAssistantAlertRules(m, now).map((v) => v.code);

  it('rien à signaler sous les seuils', () => expect(codes(M())).toEqual([]));
  it('taux d’escalade > 10 %', () => expect(codes(M({ escalatedRequests: 11 }))).toEqual(['escalation_rate']));
  it('jetons en hausse de plus de 30 % sur 7 jours', () => expect(codes(M({ avgTokensRecent: 1400 }))).toEqual(['token_drift']));
  it('modèle résolu ≠ attendu sur plus de 1 % des appels', () => expect(codes(M({ mismatchedCalls: 2 }))).toEqual(['model_mismatch']));
  it('échantillon trop petit : aucun taux affirmé', () => expect(codes(M({ requestsWithAi: 5, escalatedRequests: 5 }))).toEqual([]));

  it('dépréciation : J-30 en avertissement, date dépassée en critique', () => {
    const v = alertes.evaluateAssistantAlertRules(M({ deprecations: [
      { model: 'gemini-a', alias: 'assistant-default', date: '2026-10-15' },
      { model: 'gemini-b', alias: 'assistant-escalation', date: '2026-09-01' },
      { model: 'gemini-c', alias: 'assistant-escalation', date: '2027-06-01' },
    ] }), new Date('2026-09-27T10:00:00Z'));
    expect(v.map((x) => [x.code, x.severity, x.details.model])).toEqual([
      ['model_deprecation', 'warning', 'gemini-a'], ['model_deprecation', 'critical', 'gemini-b'],
    ]);
  });

  it('dates saisies en configuration (VEREBONA_ASSISTANT_MODEL_DEPRECATIONS)', () => {
    expect([...registre.configuredDeprecations('gemini-a=2026-10-01, x=bad,gemini-b=2027-01-31')]).toEqual([
      ['gemini-a', '2026-10-01'], ['gemini-b', '2027-01-31'],
    ]);
  });

  it('passage complet : mesures en base, alertes du BO IA dédupliquées par jour', async () => {
    const raiseAlert = vi.fn(async () => true);
    const query = vi.fn(async (sql: string) => {
      if (/COUNT\(DISTINCT request_id\)/.test(sql)) return [{ requetes: 50, escaladees: 10 }];
      if (/AVG\(input_tokens/.test(sql)) return [{ recent: 900, n_recent: 50, previous: 900, n_previous: 50 }];
      if (/expected_model_id/.test(sql)) return [{ attendus: 50, ecarts: 0 }];
      if (/ai_model_catalog/.test(sql)) return [{ model: 'gemini-a', date: '2026-09-20' }];
      return [];
    });
    const v = await alertes.evaluateAssistantAlerts({
      query, raiseAlert, resolveActiveModels: async () => [{ model: 'gemini-a', alias: 'assistant-default' }],
    }, new Date('2026-09-27T10:00:00Z'));
    expect(v.map((x) => x.code)).toEqual(['escalation_rate', 'model_deprecation']);
    expect(raiseAlert).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'anomaly', code: 'assistant_escalation_rate', treatment: 'T2', dedupeKey: 'assistant:escalation_rate:2026-09-27',
    }));
    expect(raiseAlert).toHaveBeenCalledWith(expect.objectContaining({ code: 'assistant_model_deprecation', severity: 'critical' }));
  });
});

describe('§32.2, §32.5 — indicateurs du BO (traitement T2)', () => {
  it('latence p50 / p95 / p99, taux de réparation, d’escalade, d’actions invalides et de cache', async () => {
    setMetricsQueryRunner(async (sql) => {
      if (/percentile_cont/.test(sql)) return [{ p50: 300, p95: 1200, p99: 4000, avec_ia: 20, reparees: 2, escaladees: 3, actions_invalides: 1, cache: 10 }];
      if (/FROM verebona_request_runs/.test(sql) && /latency_ms/.test(sql)) return [{ total: 40, ia: 20, deterministe: 20, latence: 500, erreurs: 0 }];
      return [];
    });
    const m = Object.fromEntries((await getTreatmentMetrics('T2', 30)).metrics.map((x) => [x.key, x.value]));
    expect(m).toMatchObject({
      latency_p50: 300, latency_p95: 1200, latency_p99: 4000,
      repair_rate: 10, escalation_rate: 15, invalid_action_rate: 5, cache_hit_rate: 25,
    });
  });

  it('demandes non résolues regroupées par intention et motif, sans contenu', async () => {
    setMetricsQueryRunner(async (sql) => {
      if (/MOTIF|motif/.test(sql) && /GROUP BY 1, 2/.test(sql)) return [
        { intent: 'ACCOUNT_SEARCH_DOCUMENT', motif: 'aucune_donnee', total: 7 },
        { intent: 'PRODUCT_HELP_HOW_TO', motif: 'aide_absente', total: 3 },
      ];
      return [];
    });
    const t = (await getTreatmentMetrics('T2', 30)).tables?.find((x) => x.key === 'unresolved');
    expect(t?.rows).toEqual([
      { intent: 'ACCOUNT_SEARCH_DOCUMENT', reason: 'Aucune donnée', count: 7 },
      { intent: 'PRODUCT_HELP_HOW_TO', reason: 'Absence d’article d’aide', count: 3 },
    ]);
    expect(JSON.stringify(t)).not.toMatch(/content|message|question/i);
  });
});

describe('§29.6 — sortie brute non validée jamais journalisée pour l’assistant', () => {
  it('empreinte et longueur seulement ; l’extrait est retiré des messages d’erreur', () => {
    const d = outputDigestForLog('{"claims":[{"text":"IBAN FR76 3000 6000 0112 3456 7890 189"}]}');
    expect(d).toMatch(/^sha256:[0-9a-f]{12} len:\d+$/);
    expect(d).not.toMatch(/IBAN|claims/);
    expect(stripRawExcerpt('m1 : Sortie non parsable : x. Extrait : {"secret":1} — m2 : timeout'))
      .toBe('m1 : Sortie non parsable : x. [extrait non conservé] — m2 : timeout');
  });
});

describe('§17.1 — prompt de l’assistant : le master T2 seul (lot 16b-2)', () => {
  it('le registre des prompts historiques est supprimé ; métadonnées portées par le master', async () => {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    expect(existsSync(join(process.cwd(), 'src/services/verebona-assistant/registries/prompt-registry.ts'))).toBe(false);
    const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
    for (const op of ['t2_understand', 't2_answer', 't2_revalidate']) {
      expect(AI_OPERATIONS[op]).toMatchObject({ masterPromptCode: 't2_master_v1', fallbackModels: expect.any(Array) });
    }
  });
});
