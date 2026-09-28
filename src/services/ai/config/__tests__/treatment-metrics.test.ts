/**
 * Indicateurs par traitement — T1-UI-10/11, T1-025, T2-045, T2-UI-05 à 10,
 * T3-UI-07, T4-UI-06.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const { getTreatmentMetrics, setMetricsQueryRunner } = await import('../treatment-metrics.repository');

afterEach(() => setMetricsQueryRunner(null));

const byKey = (ms: Array<{ key: string; value: number | null }>) =>
  Object.fromEntries(ms.map((m) => [m.key, m.value]));

describe('indicateurs par traitement', () => {
  it('T1 : lacunes et rechecks mesurés, durée, coût et replis', async () => {
    setMetricsQueryRunner(async (sql) => {
      if (/document_analysis_runs/.test(sql)) return [{ total: 10, echecs: 1, duree: 4200 }];
      if (/t1_quality_signals/.test(sql)) return [{ signaux: 3, rechecks: 5, rechecks_lacune: 2 }];
      if (/ai_usage_event/.test(sql)) return [{ calls: 20, functional: 150000, technical: 30, ok: 19, fallbacks: 2 }];
      return [];
    });
    const m = byKey((await getTreatmentMetrics('T1', 7)).metrics);
    expect(m).toMatchObject({ t1_gaps: 3, t2_rechecks: 2, duration: 4200, cost: 150000, technical_cost: 30, fallback_rate: 11 });
  });

  it('T1-UI-10 : détail des lacunes T1 (fichier, fait, motif, recheck), sans question', async () => {
    setMetricsQueryRunner(async (sql) => {
      if (/LEFT JOIN LATERAL/.test(sql)) {
        return [{
          id: 1, created_at: '2026-09-02T10:00:00Z', account_id: 7, file_id: 12, fact_key: 'contract.end_date',
          problem: 'MISSING', t1_model: 'gemini-x', recheck_status: 'CORRECTED', recheck_mode: 'SOURCE_RECHECK',
        }, {
          id: 2, created_at: '2026-09-01T10:00:00Z', account_id: 7, file_id: 13, fact_key: null,
          problem: 'CONFLICT', t1_model: null, recheck_status: null, recheck_mode: null,
        }];
      }
      return [];
    });
    const res = await getTreatmentMetrics('T1', 7);
    const table = res.tables?.find((t) => t.key === 't1_gaps');
    expect(table?.rows[0]).toMatchObject({
      date: '2026-09-02T10:00:00.000Z', account: 7, source: 'Fichier 12', fact: 'contract.end_date',
      problem: 'Information absente', model: 'gemini-x', recheck: 'Corrigé (SOURCE_RECHECK)',
    });
    expect(table?.rows[1]).toMatchObject({ problem: 'Conflit', recheck: 'Aucun' });
    expect(JSON.stringify(res.tables)).not.toMatch(/question|information/);
  });

  it('T2 : ratio sémantique, coût et appels moyens par requête totale, commandes, conversations, liste des rechecks', async () => {
    setMetricsQueryRunner(async (sql) => {
      if (/FROM verebona_request_runs/.test(sql) && /latency_ms/.test(sql)) return [{ total: 4, ia: 1, deterministe: 3, latence: 300, erreurs: 0 }];
      if (/levelsReached/.test(sql)) return [{ bdd: 4, texte: 2, semantique: 0, modele: 1 }];
      if (/ai_usage_event/.test(sql)) return [{ calls: 2, functional: 800, technical: 0, ok: 2, fallbacks: 0 }];
      if (/verebona_conversations/.test(sql)) return [{ ouvertes: 3, actives: 2, expirent: 1, a_purger: 0 }];
      if (/verebona_command_plans/.test(sql)) {
        // L'état UNDONE (« Annuler » une action exécutée) est agrégé à part.
        expect(sql).toMatch(/status = 'UNDONE'/);
        return [{ plans: 6, succes: 3, echecs: 1, abandons: 1, annules: 1 }];
      }
      if (/SUM\(cost_micros\)/.test(sql) && /verebona_fact_revalidations/.test(sql)) return [{ total: 1, cout: 90 }];
      if (/ORDER BY r.created_at DESC/.test(sql)) {
        return [{ created_at: '2026-09-01T10:00:00Z', account_id: 7, file_id: 12, fact_key: 'amount', trigger_reason: 'LOW_CONFIDENCE', mode: 'SOURCE_RECHECK', status: 'CONFIRMED', ai_calls: 1, cost_micros: 90 }];
      }
      return [];
    });
    const res = await getTreatmentMetrics('T2', 30);
    const m = byKey(res.metrics);
    expect(m).toMatchObject({
      cascade_semantic: 0, cascade_llm: 25, avg_cost: 200, avg_ai_cost: 800, avg_calls: 0.5,
      command_success: 3, command_failed: 1, conversations_expiring: 1, rechecks: 1,
      command_plans: 6, command_abandoned: 1, command_undone: 1,
    });
    // Mesure réelle (plus de « non disponible ») : succès + échecs + abandons + annulées = total.
    expect(res.metrics.find((x) => x.key === 'command_undone')).toMatchObject({ value: 1, label: expect.stringMatching(/annulées/) });
    expect(res.tables?.[0].rows[0]).toMatchObject({ source: 'Fichier 12', fact: 'amount', cost: 90 });
    // Le contenu conversationnel n'est jamais exposé (T2-UI-09) : pas de question dans la liste.
    expect(JSON.stringify(res.tables)).not.toMatch(/question/);
  });

  it('T3 : coût ; T4 : prévisionnelles, confirmées, rappels', async () => {
    setMetricsQueryRunner(async (sql) => {
      if (/ai_usage_event/.test(sql)) return [{ calls: 1, functional: 42, technical: 0, ok: 1, fallbacks: 0 }];
      if (/occurrence_nature/.test(sql)) return [{ total: 6, automatiques: 4, reprises: 1, previsionnelles: 2 }];
      if (/confirmed_at/.test(sql)) return [{ total: 1 }];
      if (/DEADLINE_/.test(sql)) return [{ total: 9 }];
      return [{}];
    });
    expect(byKey((await getTreatmentMetrics('T3')).metrics).cost).toBe(42);
    expect(byKey((await getTreatmentMetrics('T4')).metrics)).toMatchObject({ forecast: 2, confirmed: 1, reminders: 9, cost: 42 });
  });
});
