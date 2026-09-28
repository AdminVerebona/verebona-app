/**
 * Alertes de coût de l'assistant — CDC §31.3 (audit P2).
 *
 *   · moyenne JOURNALIÈRE par réponse > 0,005 USD (et non chaque réponse) ;
 *   · coût par utilisateur actif incompatible avec la marge de l'offre ;
 *   · alertes écrites dans `ai_alerts` (BO IA), plus des `console.warn` ;
 *   · toute modification de seuil tracée.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

const alertes = await import('../observability/assistant-alerts');
const budget = await import('../core/budget.service');
const { resetAssistantConfigForTests } = await import('../config/assistant-config');

const M = (o: Partial<Parameters<typeof alertes.evaluateAssistantAlertRules>[0]> = {}) => ({
  requestsWithAi: 0, escalatedRequests: 0, avgTokensRecent: null, avgTokensPrevious: null, callsRecent: 0, callsPrevious: 0,
  callsWithExpectation: 0, mismatchedCalls: 0, deprecations: [], ...o,
});
const NOW = new Date('2026-09-28T10:00:00Z');
const codes = (m: ReturnType<typeof M>) => alertes.evaluateAssistantAlertRules(m, NOW).map((v) => v.code);

const ENV = ['VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD', 'VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD_STANDARD', 'VEREBONA_ASSISTANT_COST_ALERT_USD'];
beforeEach(() => { for (const k of ENV) delete process.env[k]; resetAssistantConfigForTests(); });
afterEach(() => { for (const k of ENV) delete process.env[k]; resetAssistantConfigForTests(); });

describe('§31.3 — coût moyen journalier par réponse', () => {
  it('une réponse coûteuse isolée ne déclenche rien si la moyenne reste sous 0,005 USD', () => {
    // 100 réponses, 0,30 USD au total dont une à 0,05 USD : moyenne 0,003 USD.
    expect(codes(M({ answers24h: 100, cost24hMicros: 300_000 }))).toEqual([]);
  });

  it('moyenne > 0,005 USD sur 24 h → daily_cost_per_answer, seuil tracé dans les détails', () => {
    const [v] = alertes.evaluateAssistantAlertRules(M({ answers24h: 40, cost24hMicros: 240_000 }), NOW);
    expect(v).toMatchObject({ code: 'daily_cost_per_answer', severity: 'warning' });
    expect(v.details).toMatchObject({ averageMicros: 6000, thresholdMicros: 5000, answers: 40 });
  });

  it('échantillon trop petit : aucune moyenne affirmée', () => {
    expect(codes(M({ answers24h: 3, cost24hMicros: 300_000 }))).toEqual([]);
  });

  it('seuil configurable (VEREBONA_ASSISTANT_COST_ALERT_USD)', () => {
    process.env.VEREBONA_ASSISTANT_COST_ALERT_USD = '0.01';
    resetAssistantConfigForTests();
    expect(codes(M({ answers24h: 40, cost24hMicros: 240_000 }))).toEqual([]);
  });
});

describe('§31.3 — coût par utilisateur actif et marge de l’offre', () => {
  it('au-delà du seuil de l’offre → cost_per_active_user, une alerte par offre', () => {
    const v = alertes.evaluateAssistantAlertRules(M({ costByPlan: [
      { planType: 'STANDARD', costMicros: 4_000_000, activeUsers: 10 }, // 0,40 USD / utilisateur
      { planType: 'PREMIUM', costMicros: 1_000_000, activeUsers: 10 }, // 0,10 USD / utilisateur
    ] }), NOW);
    expect(v.map((x) => [x.code, x.details.planType])).toEqual([['cost_per_active_user', 'STANDARD']]);
    expect(v[0].key).toBe('cost_per_active_user:STANDARD');
    expect(v[0].details).toMatchObject({ perUserMicros: 400_000, thresholdMicros: 300_000, activeUsers: 10 });
  });

  it('seuil propre à une offre (…_USD_STANDARD) ; trop peu d’utilisateurs actifs : rien', () => {
    process.env.VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD_STANDARD = '0.50';
    expect(codes(M({ costByPlan: [{ planType: 'STANDARD', costMicros: 4_000_000, activeUsers: 10 }] }))).toEqual([]);
    expect(codes(M({ costByPlan: [{ planType: 'PREMIUM', costMicros: 4_000_000, activeUsers: 2 }] }))).toEqual([]);
  });

  it('mesure en base : coût 24 h et coût par offre lus dans verebona_ai_runs / verebona_request_runs', async () => {
    const query = vi.fn(async (sql: string) => {
      if (/AS reponses/.test(sql)) return [{ reponses: 40, total: 240_000 }];
      if (/WITH couts AS/.test(sql)) return [{ plan_type: 'STANDARD', cout: 4_000_000, actifs: 10 }];
      return [];
    });
    const m = await alertes.measureAssistantAlertMetrics({ query, resolveActiveModels: async () => [] });
    expect(m).toMatchObject({ answers24h: 40, cost24hMicros: 240_000, costByPlan: [{ planType: 'STANDARD', costMicros: 4_000_000, activeUsers: 10 }] });
  });
});

describe('§31.3 — alertes écrites dans ai_alerts, seuils tracés', () => {
  const deps = (details: unknown = null) => {
    const raiseAlert = vi.fn(async () => true);
    const query = vi.fn(async (sql: string) => {
      if (/assistant_thresholds_changed/.test(sql)) return details ? [{ details }] : [];
      if (/AS reponses/.test(sql)) return [{ reponses: 40, total: 240_000 }];
      return [];
    });
    return { raiseAlert, query, resolveActiveModels: async () => [] };
  };

  it('passage complet : alerte de coût de type budget, dédupliquée par jour, rattachée au jeu de seuils', async () => {
    const d = deps();
    await alertes.evaluateAssistantAlerts(d, NOW);
    const empreinte = alertes.thresholdsFingerprint(alertes.alertThresholds());
    expect(d.raiseAlert).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'budget', code: 'assistant_daily_cost_per_answer', treatment: 'T2',
      dedupeKey: 'assistant:daily_cost_per_answer:2026-09-28',
      details: expect.objectContaining({ thresholdsFingerprint: empreinte }),
    }));
  });

  it('premier passage : le jeu de seuils en vigueur est enregistré', async () => {
    const d = deps();
    expect(await alertes.traceAlertThresholds(d)).toBe(true);
    expect(d.raiseAlert).toHaveBeenCalledWith(expect.objectContaining({
      code: 'assistant_thresholds_changed', severity: 'info',
      details: expect.objectContaining({ previous: null, thresholds: expect.objectContaining({ costPerAnswerUsd: 0.005 }) }),
    }));
  });

  it('seuils inchangés : rien n’est réécrit ; seuil modifié : ancien et nouveau jeu tracés', async () => {
    const t = alertes.alertThresholds();
    const courant = { fingerprint: alertes.thresholdsFingerprint(t), thresholds: t };
    const inchange = deps(courant);
    expect(await alertes.traceAlertThresholds(inchange)).toBe(false);
    expect(inchange.raiseAlert).not.toHaveBeenCalled();

    process.env.VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD = '0.45';
    const nouveau = alertes.alertThresholds();
    const change = deps(courant);
    expect(await alertes.traceAlertThresholds(change, nouveau)).toBe(true);
    const appel = (change.raiseAlert.mock.calls[0] as unknown[])[0] as { details: Record<string, unknown>; dedupeKey: string };
    expect(appel.details.previousFingerprint).toBe(courant.fingerprint);
    expect((appel.details.thresholds as { costPerActiveUserUsd: Record<string, number> }).costPerActiveUserUsd.PREMIUM).toBe(0.45);
    expect(appel.dedupeKey).toBe(`assistant:thresholds:initial:${courant.fingerprint}->${alertes.thresholdsFingerprint(nouveau)}`);
  });

  it('retour à un jeu antérieur (A → B → A) : tracé à son tour, clé distincte', async () => {
    const tA = alertes.alertThresholds();
    const fA = alertes.thresholdsFingerprint(tA);
    process.env.VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD = '0.45';
    const tB = alertes.alertThresholds();
    const fB = alertes.thresholdsFingerprint(tB);
    // Historique simulé de ai_alerts (clé unique = dedupe_key).
    const lignes: Array<{ id: number; details: unknown; dedupeKey: string }> = [];
    const d = {
      query: vi.fn(async () => (lignes.length ? [{ id: lignes.at(-1)!.id, details: lignes.at(-1)!.details }] : [])),
      raiseAlert: vi.fn(async (a: { details?: Record<string, unknown>; dedupeKey: string }) => {
        if (lignes.some((l) => l.dedupeKey === a.dedupeKey)) return false;
        lignes.push({ id: lignes.length + 1, details: a.details, dedupeKey: a.dedupeKey });
        return true;
      }),
    };
    expect(await alertes.traceAlertThresholds(d, tA)).toBe(true);
    expect(await alertes.traceAlertThresholds(d, tB)).toBe(true);
    expect(await alertes.traceAlertThresholds(d, tA)).toBe(true);
    expect(await alertes.traceAlertThresholds(d, tA)).toBe(false);
    expect(lignes.map((l) => (l.details as { fingerprint: string }).fingerprint)).toEqual([fA, fB, fA]);
    expect(new Set(lignes.map((l) => l.dedupeKey)).size).toBe(3);
  });
});

describe('§6.6, §31.3 — plafond mensuel du compte dans ai_alerts', () => {
  it('part d’alerte franchie (warning) puis plafond atteint (critique), une écriture par mois et par niveau', async () => {
    const raise = vi.fn(async (_a: { code: string; severity?: string; dedupeKey: string }) => true);
    budget.setBudgetAlertWriterForTests(raise);
    const warn = vi.spyOn(console, 'warn');
    const seuil = budget.evaluateBudget(1_700_000, 2_000_000, 0.8);
    await budget.raiseBudgetAlert(7, seuil, 0.8, NOW);
    await budget.raiseBudgetAlert(7, seuil, 0.8, NOW);
    await budget.raiseBudgetAlert(7, budget.evaluateBudget(2_100_000, 2_000_000, 0.8), 0.8, NOW);
    expect(raise.mock.calls.map(([a]) => [a.code, a.severity, a.dedupeKey])).toEqual([
      ['assistant_monthly_budget_threshold', 'warning', 'assistant:monthly_budget:threshold:7:2026-09'],
      ['assistant_monthly_budget_reached', 'critical', 'assistant:monthly_budget:reached:7:2026-09'],
    ]);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'budget', accountId: 7, details: expect.objectContaining({ alertRatio: 0.8, limitMicros: 2_000_000 }) }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    budget.setBudgetAlertWriterForTests(null);
  });

  it('écriture impossible : journalisée, jamais bloquante', async () => {
    budget.setBudgetAlertWriterForTests(async () => { throw new Error('base indisponible'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(budget.raiseBudgetAlert(8, budget.evaluateBudget(2_100_000, 2_000_000, 0.8), 0.8, NOW)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    budget.setBudgetAlertWriterForTests(null);
  });

  it('l’ancienne alerte « par réponse » a disparu du chemin d’appel', async () => {
    expect('alertIfCostlyResponse' in budget).toBe(false);
  });
});
