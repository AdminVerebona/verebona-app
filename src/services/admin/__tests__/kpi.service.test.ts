/**
 * KPI purs du Dashboard — CDC BO DASH-006, DASH-007, REC-DASH-02, §4.2–§4.4.
 */
import { describe, it, expect } from 'vitest';
import {
  breakdownByPlan, buildKpi, changePercent, classifyPlanChange, computeArrCents, computeMrrCents,
  computeStorageStats, mean, median, monthlyRevenueCents, rate, trendDirection, trendTone, type PlanPrice,
} from '../kpi.service';

const plans = new Map<string, PlanPrice>([
  ['standard', { code: 'standard', label: 'Standard', monthlyPriceCents: 499, yearlyPriceCents: 4990, displayOrder: 1, offered: true }],
  ['premium', { code: 'premium', label: 'Premium', monthlyPriceCents: 999, yearlyPriceCents: 9990, displayOrder: 2, offered: true }],
  ['premium_pro', { code: 'premium_pro', label: 'Premium Pro', monthlyPriceCents: 4999, yearlyPriceCents: null, displayOrder: 9, offered: false }],
]);

describe('tendance (DASH-006, DASH-007)', () => {
  it('stagnation = égalité STRICTE, sans tolérance (REC-DASH-02)', () => {
    expect(trendDirection(100, 100)).toBe('flat');
    expect(trendDirection(100.0001, 100)).toBe('up');
    expect(trendDirection(99.9999, 100)).toBe('down');
    expect(trendDirection(0, 0)).toBe('flat');
  });

  it('valeur indisponible → pas de sens', () => {
    expect(trendDirection(null, 3)).toBeNull();
    expect(trendDirection(3, null)).toBeNull();
  });

  it('le caractère dépend de la polarité : hausse d\'anomalies défavorable', () => {
    expect(trendTone('up', 'up_good')).toBe('favorable');
    expect(trendTone('up', 'up_bad')).toBe('unfavorable');
    expect(trendTone('down', 'up_bad')).toBe('favorable');
    expect(trendTone('down', 'up_good')).toBe('unfavorable');
    expect(trendTone('flat', 'up_bad')).toBe('neutral');
    expect(trendTone('up', 'neutral')).toBe('neutral');
  });

  it('pourcentage d\'évolution, indéfini depuis zéro', () => {
    expect(changePercent(120, 100)).toBe(20);
    expect(changePercent(80, 100)).toBe(-20);
    expect(changePercent(5, 0)).toBeNull();
    expect(changePercent(0, 0)).toBeNull();
  });

  it('buildKpi : sens et caractère distincts ; écart en points pour un taux', () => {
    const k = buildKpi(12, 10, { polarity: 'up_bad', nature: 'stock' });
    expect(k).toMatchObject({ direction: 'up', tone: 'unfavorable', changePct: 20, nature: 'stock' });
    const r = buildKpi(0.25, 0.2, { polarity: 'up_good', unit: 'ratio', nature: 'flow' });
    expect(r.deltaPoints).toBeCloseTo(5);
    expect(r.tone).toBe('favorable');
    expect(buildKpi(3, 3, { polarity: 'up_good', nature: 'flow' }).tone).toBe('neutral');
  });
});

describe('MRR / ARR (§4.2, §4.4)', () => {
  it('mensuel au prix mensuel, annuel ramené au mois', () => {
    expect(monthlyRevenueCents('premium', 'monthly', plans)).toBe(999);
    expect(monthlyRevenueCents('premium', 'yearly', plans)).toBeCloseTo(832.5);
    expect(monthlyRevenueCents('inconnue', 'monthly', plans)).toBe(0);
    expect(monthlyRevenueCents('premium', null, plans)).toBe(0);
  });

  it('MRR = somme sur les abonnements actifs, ARR = MRR × 12', () => {
    const mrr = computeMrrCents([
      { planCode: 'standard', billingPeriod: 'monthly', count: 10 },
      { planCode: 'premium', billingPeriod: 'yearly', count: 4 },
    ], plans);
    expect(mrr).toBe(4990 + 3330);
    expect(computeArrCents(mrr)).toBe(mrr * 12);
    expect(computeMrrCents([], plans)).toBe(0);
  });

  it('ventilation offre × périodicité, offres non commercialisées masquées à zéro', () => {
    const rows = breakdownByPlan([
      { planCode: 'premium', billingPeriod: 'yearly', count: 3 },
      { planCode: 'premium', billingPeriod: 'monthly', count: 2 },
    ], plans);
    expect(rows.map((r) => r.planCode)).toEqual(['standard', 'premium']);
    expect(rows[1]).toMatchObject({ monthly: 2, yearly: 3, total: 5 });
  });
});

describe('taux à dénominateur stable (DACT-002, conversion, churn)', () => {
  it('dénominateur nul → non calculable, jamais 0 %', () => {
    expect(rate(3, 12)).toBe(0.25);
    expect(rate(0, 12)).toBe(0);
    expect(rate(0, 0)).toBeNull();
  });

  it('moyenne et médiane (zéros compris)', () => {
    expect(median([0, 0, 5])).toBe(0);
    expect(median([1, 3, 2, 10])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(mean([0, 0, 6])).toBe(2);
  });
});

describe('upgrades / downgrades', () => {
  it('classe selon le rang d\'offre', () => {
    expect(classifyPlanChange('STANDARD', 'PREMIUM')).toBe('upgrade');
    expect(classifyPlanChange('PREMIUM_DUO', 'PREMIUM')).toBe('downgrade');
    expect(classifyPlanChange('PREMIUM', 'PREMIUM')).toBeNull();
    expect(classifyPlanChange(null, 'PREMIUM')).toBeNull();
  });
});

describe('bloc stockage (§4.3, DACT-008)', () => {
  it('seuils 80 % et 100 % inclusifs', () => {
    const s = computeStorageStats([
      { usedBytes: 80, limitBytes: 100 },
      { usedBytes: 100, limitBytes: 100 },
      { usedBytes: 10, limitBytes: 100 },
      { usedBytes: 0, limitBytes: 100 },
    ]);
    expect(s).toMatchObject({ totalBytes: 190, maxBytes: 100, medianBytes: 45, accountsAtLeast80: 2, accountsAt100: 1 });
    expect(s.meanQuotaRate).toBeCloseTo(0.475);
  });

  it('aucun compte', () => {
    expect(computeStorageStats([])).toMatchObject({ totalBytes: 0, meanBytes: null, medianBytes: null, meanQuotaRate: null });
  });
});
