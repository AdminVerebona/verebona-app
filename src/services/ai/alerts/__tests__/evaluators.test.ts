/**
 * Garde-fous appliqués (T1-UI-09, T3-UI-06, T4-UI-05, MOD-011), budgets et
 * anomalies de coût (COST-010 à COST-014, WF-22, WF-44).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateGuardrail, evaluateGuardrails, alertWindow, guardrailDrilldown, MIN_RATE_SAMPLE,
  type GuardrailMetrics,
} from '../guardrail-evaluator';
import { detectAnomaly, evaluateBudgets, treatmentCaseSql, MIN_BASELINE_DAYS } from '../cost-evaluator';

const m = (o: Partial<GuardrailMetrics> = {}): GuardrailMetrics => ({
  consecutiveFailures: 0, callsLastHour: 0, invalidOutputsLastHour: 0, successesLastHour: 0,
  fallbacksLastHour: 0, dailyCostMicros: 0, maxExecutionSeconds: null, ...o,
});
const g = (code: string, threshold: number, reaction: 'alerte' | 'suspension' = 'alerte') => ({ code, threshold, reaction });

describe('mesure des garde-fous', () => {
  it('échecs consécutifs et coût journalier', () => {
    expect(evaluateGuardrail(g('consecutive_failures', 5), m({ consecutiveFailures: 5 })).breached).toBe(true);
    expect(evaluateGuardrail(g('daily_cost', 10), m({ dailyCostMicros: 9_990_000 })).breached).toBe(false);
    expect(evaluateGuardrail(g('daily_cost', 10), m({ dailyCostMicros: 12_000_000 })).value).toBe(12);
  });
  it('taux : échantillon minimal exigé', () => {
    expect(evaluateGuardrail(g('invalid_output_rate', 10), m({ callsLastHour: 3, invalidOutputsLastHour: 2 })).value).toBeNull();
    const v = evaluateGuardrail(g('invalid_output_rate', 10), m({ callsLastHour: MIN_RATE_SAMPLE * 2, invalidOutputsLastHour: 8 }));
    expect(v).toMatchObject({ value: 20, breached: true });
    expect(evaluateGuardrail(g('fallback_rate', 50), m({ successesLastHour: 40, fallbacksLastHour: 10 })).breached).toBe(false);
  });
  it('durée : absente hors file', () => {
    expect(evaluateGuardrail(g('execution_duration', 60), m()).breached).toBe(false);
    expect(evaluateGuardrail(g('execution_duration', 60), m({ maxExecutionSeconds: 90 })).breached).toBe(true);
  });
  it('fenêtre de déduplication et lien préfiltré', () => {
    const d = new Date('2026-09-26T10:42:00Z');
    expect(alertWindow('daily_cost', d)).toBe('2026-09-26');
    expect(alertWindow('fallback_rate', d)).toBe('2026-09-26T10');
    expect(guardrailDrilldown('T1', 'consecutive_failures')).toBe('/admin/ai-executions?treatment=T1&errorsOnly=1');
    expect(guardrailDrilldown('T3', 'execution_duration')).toBe('/admin/ai-queue?treatment=T3');
  });
});

describe('réactions', () => {
  it('« alerte » n’interrompt rien ; « suspension » suspend et alerte en critique', async () => {
    const raiseAlert = vi.fn(async () => true);
    const suspend = vi.fn(async () => true);
    const out = await evaluateGuardrails({
      loadGuardrails: async (t) => (t === 'T1' ? [g('consecutive_failures', 3), g('daily_cost', 1, 'suspension')] : []),
      measure: async () => m({ consecutiveFailures: 4, dailyCostMicros: 2_000_000 }),
      raiseAlert, suspend,
    }, new Date('2026-09-26T10:00:00Z'));
    expect(out.map((r) => [r.verdict.code, r.suspended])).toEqual([['consecutive_failures', false], ['daily_cost', true]]);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledWith('T1', expect.stringMatching(/daily_cost/));
    expect(raiseAlert.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ kind: 'guardrail', severity: 'warning', dedupeKey: 'guardrail:T1:consecutive_failures:2026-09-26T10' }),
      expect.objectContaining({ severity: 'critical', dedupeKey: 'guardrail:T1:daily_cost:2026-09-26' }),
    ]);
  });
  it('sans garde-fou configuré, rien n’est mesuré', async () => {
    const measure = vi.fn();
    await evaluateGuardrails({ loadGuardrails: async () => [], measure, raiseAlert: vi.fn(), suspend: vi.fn() });
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('budgets (COST-010, COST-013)', () => {
  it('seuls les budgets renseignés sont surveillés ; dépassement strict', () => {
    const v = evaluateBudgets(
      [{ scope: 'global', monthlyBudgetMicros: 100 }, { scope: 'T1', monthlyBudgetMicros: null }, { scope: 'T2', monthlyBudgetMicros: 50 }],
      { global: 120, T1: 999, T2: 50 },
    );
    expect(v.map((x) => [x.scope, x.exceeded])).toEqual([['global', true], ['T2', false]]);
  });
  it('rattachement usage → traitement dans les agrégats SQL', () => {
    expect(treatmentCaseSql()).toContain("WHEN 'SOURCE_ANALYSIS' THEN 'T1'");
    expect(treatmentCaseSql()).toContain("WHEN 'HOME_MASCOT' THEN 'T6'");
  });
});

describe('anomalies (COST-011, COST-012, WF-44)', () => {
  const stable = Array.from({ length: 28 }, (_, i) => 10 + (i % 3));
  it('baseline insuffisante : jamais de fausse anomalie', () => {
    const v = detectAnomaly(stable.slice(0, MIN_BASELINE_DAYS - 1), 1000);
    expect(v).toMatchObject({ anomalous: false, enoughBaseline: false });
  });
  it('pic franc détecté ; variation ordinaire ignorée', () => {
    expect(detectAnomaly(stable, 40).anomalous).toBe(true);
    expect(detectAnomaly(stable, 12).anomalous).toBe(false);
  });
  it('plancher absolu : une petite valeur n’est pas un incident', () => {
    expect(detectAnomaly(stable.map((x) => x / 1000), 0.05, 1).anomalous).toBe(false);
  });
});
