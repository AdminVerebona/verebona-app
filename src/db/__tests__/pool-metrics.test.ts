/**
 * Lot 24 — #10 : agrégats du pool PostgreSQL (APP-PERF-01 §MESURES).
 * Le comportement avec le vrai pilote est couvert par l'E2E `l24-pool-metrics`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolMetrics, poolMetricsLogIntervalS, quantile, startPoolMetricsLog, getPoolMetrics } from '../pool-metrics';

function horloge() {
  let t = 0;
  return { now: () => t, avance: (ms: number) => { t += ms; } };
}

describe('PoolMetrics', () => {
  it('attente et temps SQL mesurés séparément ; pics ; compteurs revenus à zéro', () => {
    const h = horloge();
    const m = new PoolMetrics(h.now, () => 0);
    const a = m.debut();
    const b = m.debut();
    expect(m.snapshot()).toMatchObject({ inFlight: 2, waiting: 2, maxInFlight: 2, maxWaiting: 2 });
    a.prise();                 // a : connexion immédiate
    h.avance(400);
    a.fin(false);              // a : 400 ms de SQL
    b.prise();                 // b : 400 ms d'attente
    h.avance(100);
    b.fin(true);               // b : 100 ms de SQL, en erreur
    const s = m.snapshot();
    expect(s).toMatchObject({ queries: 2, errors: 1, unmeasured: 0, inFlight: 0, waiting: 0 });
    expect(s.poolWait).toEqual({ count: 2, avgMs: 200, maxMs: 400, p95Ms: 500 });
    expect(s.sql).toMatchObject({ count: 2, maxMs: 400, p95Ms: 500 });
  });

  it('prise jamais datée : « non mesurée », aucune valeur inventée ; abandon sans mesure', () => {
    const m = new PoolMetrics(horloge().now, () => 0);
    m.debut().fin(false);
    const c = m.debut();
    c.abandon();
    c.fin(false); // sans effet après abandon
    expect(m.snapshot()).toMatchObject({ queries: 1, unmeasured: 1, inFlight: 0, waiting: 0 });
    expect(m.snapshot().poolWait.count).toBe(0);
  });

  it('rotate : fenêtre périodique remise à zéro, total conservé', () => {
    const m = new PoolMetrics(horloge().now, () => 0);
    const a = m.debut(); a.prise(); a.fin(false);
    expect(m.rotate().queries).toBe(1);
    expect(m.rotate().queries).toBe(0);
    expect(m.snapshot().queries).toBe(1);
    m.transaction(12);
    expect(m.snapshot().transactionWait).toMatchObject({ count: 1, maxMs: 12, p95Ms: 20 });
  });

  it('quantile : borne haute de la case ; au-delà de 10 s → null', () => {
    const m = new PoolMetrics(horloge().now, () => 0);
    m.transaction(20_000);
    expect(m.snapshot().transactionWait.p95Ms).toBeNull();
    expect(quantile({ count: 0, sumMs: 0, maxMs: 0, buckets: [] }, 0.95)).toBe(0);
  });
});

describe('journal périodique', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('intervalle : défaut 300 s, 0 = jamais, valeur invalide → défaut', () => {
    expect(poolMetricsLogIntervalS({} as NodeJS.ProcessEnv)).toBe(300);
    expect(poolMetricsLogIntervalS({ DB_POOL_METRICS_LOG_INTERVAL_S: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(poolMetricsLogIntervalS({ DB_POOL_METRICS_LOG_INTERVAL_S: '60' } as unknown as NodeJS.ProcessEnv)).toBe(60);
    expect(poolMetricsLogIntervalS({ DB_POOL_METRICS_LOG_INTERVAL_S: 'x' } as unknown as NodeJS.ProcessEnv)).toBe(300);
  });

  it('une ligne JSON agrégée par fenêtre active, aucune sans activité ; une seule minuterie', () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const env = { DB_POOL_METRICS_LOG_INTERVAL_S: '10' } as unknown as NodeJS.ProcessEnv;
    startPoolMetricsLog('web', 5, env);
    startPoolMetricsLog('web', 5, env);
    vi.advanceTimersByTime(10_000);
    expect(info).not.toHaveBeenCalled();
    const j = getPoolMetrics().debut(); j.prise(); j.fin(false);
    vi.advanceTimersByTime(10_000);
    expect(info).toHaveBeenCalledTimes(1);
    const ligne = String(info.mock.calls[0][0]);
    expect(ligne).toMatch(/^\[db\] pool \{/);
    expect(JSON.parse(ligne.slice('[db] pool '.length))).toMatchObject({ role: 'web', max: 5, queries: 1 });
  });
});
