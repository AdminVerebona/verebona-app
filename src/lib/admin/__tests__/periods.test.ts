/**
 * Périodes du Dashboard — CDC BO DASH-003, DASH-004, DASH-005, REC-DASH-01.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PERIOD_KIND, parisMonthStart, parsePeriodKind, parseRef, resolvePeriod, seriesBuckets,
} from '../periods';

const NOW = new Date('2026-09-26T10:00:00Z');

describe('périodes calendaires (DASH-003)', () => {
  it('Mois par défaut, type inconnu ramené à Mois', () => {
    expect(DEFAULT_PERIOD_KIND).toBe('month');
    expect(parsePeriodKind(null)).toBe('month');
    expect(parsePeriodKind('week')).toBe('month');
    expect(parsePeriodKind('semester')).toBe('semester');
  });

  it('bornes à minuit heure de Paris (été et hiver)', () => {
    expect(parisMonthStart(2026, 9).toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(parisMonthStart(2026, 1).toISOString()).toBe('2025-12-31T23:00:00.000Z');
    // Débordement : mois 13 = janvier suivant, mois 0 = décembre précédent.
    expect(parisMonthStart(2026, 13).toISOString()).toBe(parisMonthStart(2027, 1).toISOString());
    expect(parisMonthStart(2026, 0).toISOString()).toBe(parisMonthStart(2025, 12).toISOString());
  });

  it('mois, trimestre, semestre, année contenant la référence', () => {
    const ref = { year: 2026, month: 8 };
    expect(resolvePeriod('month', ref, NOW).label).toBe('août 2026');
    expect(resolvePeriod('quarter', ref, NOW).label).toBe('T3 2026');
    expect(resolvePeriod('semester', ref, NOW).label).toBe('S2 2026');
    expect(resolvePeriod('year', ref, NOW).label).toBe('2026');
    const q = resolvePeriod('quarter', ref, NOW);
    expect(q.start.toISOString()).toBe(parisMonthStart(2026, 7).toISOString());
    expect(q.end.toISOString()).toBe(parisMonthStart(2026, 10).toISOString());
  });

  it('référence invalide → mois courant à Paris', () => {
    expect(parseRef('n/importe', NOW)).toEqual({ year: 2026, month: 9 });
    expect(parseRef('2026-13-01', NOW)).toEqual({ year: 2026, month: 9 });
    expect(parseRef('2025-02-01', NOW)).toEqual({ year: 2025, month: 2 });
  });
});

describe('comparaison à la période précédente (DASH-004, DASH-005)', () => {
  it('période close : précédente de même nature, fenêtre complète', () => {
    const p = resolvePeriod('month', { year: 2026, month: 8 }, NOW);
    expect(p.inProgress).toBe(false);
    expect(p.asOf).toEqual(p.end);
    expect(p.prevLabel).toBe('juillet 2026');
    expect(p.prevEnd).toEqual(p.start);
    expect(p.prevFlowEnd).toEqual(p.prevEnd);
  });

  it('trimestre précédent à cheval sur l\'année', () => {
    const p = resolvePeriod('quarter', { year: 2026, month: 2 }, NOW);
    expect(p.prevLabel).toBe('T4 2025');
    expect(p.prevStart.toISOString()).toBe(parisMonthStart(2025, 10).toISOString());
    expect(p.prevRef).toBe('2025-10-01');
    expect(p.nextRef).toBe('2026-04-01');
  });

  it('période en cours : stock à maintenant, flux sur la même durée écoulée', () => {
    const p = resolvePeriod('month', { year: 2026, month: 9 }, NOW);
    expect(p.inProgress).toBe(true);
    expect(p.asOf).toEqual(NOW);
    const elapsed = NOW.getTime() - p.start.getTime();
    expect(p.prevFlowEnd.getTime() - p.prevStart.getTime()).toBe(elapsed);
    // Stock comparé à la fin de la période précédente (DASH-005).
    expect(p.prevEnd).toEqual(p.start);
  });

  it('durée équivalente bornée à la fin d\'une période précédente plus courte', () => {
    // 31 mars 12 h : 30,5 jours écoulés, février n'en a que 28.
    const now = new Date('2026-03-31T10:00:00Z');
    const p = resolvePeriod('month', { year: 2026, month: 3 }, now);
    expect(p.prevFlowEnd).toEqual(p.prevEnd);
  });

  it('période future signalée', () => {
    expect(resolvePeriod('month', { year: 2026, month: 12 }, NOW).future).toBe(true);
  });
});

describe('séries des graphiques', () => {
  it('12 mois se terminant par la période choisie, dernier borné à maintenant', () => {
    const p = resolvePeriod('month', { year: 2026, month: 9 }, NOW);
    const b = seriesBuckets(p);
    expect(b).toHaveLength(12);
    expect(b[11].label).toBe('sept. 26');
    expect(b[0].label).toBe('oct. 25');
    expect(b[11].end).toEqual(NOW);
    for (let i = 1; i < b.length; i++) expect(b[i].start).toEqual(b[i - 1].end);
  });

  it('5 années pour Année', () => {
    const b = seriesBuckets(resolvePeriod('year', { year: 2026, month: 9 }, NOW));
    expect(b.map((x) => x.label)).toEqual(['2022', '2023', '2024', '2025', '2026']);
  });
});
