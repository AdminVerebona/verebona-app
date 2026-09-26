/**
 * Liens préfiltrés — COST-009, CST-UI-10, LOG-UI-01 à 03, ALT-01 : les pages
 * ai-* lisent leurs paramètres d'URL (jusqu'ici ignorés).
 */
import { describe, it, expect } from 'vitest';
import { readExecutionFilters, executionFiltersToParams, periodBounds } from '../execution-filters';

describe('filtres lus depuis l’URL', () => {
  it('les liens du tableau de bord et des alertes ouvrent un écran filtré', () => {
    const f = readExecutionFilters(new URLSearchParams('treatment=T1&errorsOnly=1&rank=fallback&from=2026-09-01&to=2026-09-02&accountId=12'));
    expect(f).toMatchObject({ treatment: 'T1', errorsOnly: true, rank: 'fallback', from: '2026-09-01', to: '2026-09-02', accountId: '12' });
  });
  it('un paramètre illisible est ignoré, jamais bloquant', () => {
    const f = readExecutionFilters(new URLSearchParams('treatment=T9&accountId=abc&rank=autre&from=hier'));
    expect(f).toMatchObject({ treatment: '', accountId: '', rank: '', from: '' });
  });
  it('aller-retour sans valeurs vides', () => {
    const f = readExecutionFilters(new URLSearchParams('model=gemini-3.5-flash&jobId=4'));
    expect(executionFiltersToParams(f).toString()).toBe('model=gemini-3.5-flash&jobId=4');
  });
});

describe('périodes (COST-002)', () => {
  const now = new Date('2026-09-26T10:00:00Z');
  it('mois calendaire distinct des 30 jours glissants', () => {
    expect(periodBounds('calendarMonth', now)).toEqual({ from: '2026-09-01', to: '2026-09-26' });
    expect(periodBounds('month30', now)).toEqual({ from: '2026-08-28', to: '2026-09-26' });
  });
  it('personnalisée, avec repli si incomplète', () => {
    expect(periodBounds('custom', now, { from: '2026-01-01', to: '2026-01-31' })).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(periodBounds('custom', now, { from: 'x' }).to).toBe('2026-09-26');
  });
});
