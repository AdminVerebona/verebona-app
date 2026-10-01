/**
 * CDC Assistant §32.2 (lot 19) — l'onglet T2 affiche les indicateurs
 * techniques calculés par l'observabilité (cadre du lot 17).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));
const obs = vi.fn();
vi.mock('../../telemetry/observability.repository', () => ({ getObservability: (q: unknown) => obs(q) }));

const { getTreatmentMetrics, setMetricsQueryRunner } = await import('../treatment-metrics.repository');
afterEach(() => setMetricsQueryRunner(null));

describe('onglet T2 — §32.2', () => {
  it('ajoute les indicateurs et tables techniques, et seulement eux', async () => {
    setMetricsQueryRunner(async () => []);
    obs.mockResolvedValueOnce({
      metrics: [
        { key: 'timeout_rate', label: 'Taux de timeout', value: 5, unit: 'percent' },
        { key: 'tokens_in', label: 'Jetons d’entrée', value: 100 },
        { key: 'requests', label: 'Demandes', value: 9 },
      ],
      tables: [{ key: 't2_cost_by_plan', label: 'c', columns: [], rows: [] }, { key: 't2_truth', label: 't', columns: [], rows: [] }],
    });
    const r = await getTreatmentMetrics('T2', 400);
    expect(obs).toHaveBeenCalledWith({ domain: 'T2', days: 90 });
    expect(r.metrics.map((m) => m.key)).toEqual(expect.arrayContaining(['timeout_rate', 'tokens_in']));
    expect(r.metrics.filter((m) => m.key === 'requests')).toHaveLength(1);
    expect(r.tables?.map((t) => t.key)).toContain('t2_cost_by_plan');
    expect(r.tables?.map((t) => t.key)).not.toContain('t2_truth');
  });

  it('calcul en cours ou en échec : un indicateur nul avec sa raison, jamais un zéro', async () => {
    setMetricsQueryRunner(async () => []);
    obs.mockResolvedValueOnce({ busy: true, metrics: [], tables: [] });
    let r = await getTreatmentMetrics('T2', 7);
    expect(r.metrics.find((m) => m.key === 't2_technical')).toMatchObject({ value: null, missingReason: expect.stringMatching(/en cours/) });
    obs.mockRejectedValueOnce(new Error('x'));
    r = await getTreatmentMetrics('T2', 7);
    expect(r.metrics.find((m) => m.key === 't2_technical')?.value).toBeNull();
  });
});
