/**
 * Tableau de bord IA — fonctions pures (VER-01, PER-01, GST-01).
 */
import { describe, it, expect } from 'vitest';
import { activityForWindow, globalAiStatus, parseDashboardWindow, shortUid } from '@/lib/admin/ai-dashboard';

describe('parseDashboardWindow (PER-01)', () => {
  it('accepte 1, 7 et 30, sinon 7', () => {
    expect(parseDashboardWindow('1')).toBe(1);
    expect(parseDashboardWindow('30')).toBe(30);
    expect(parseDashboardWindow(null)).toBe(7);
    expect(parseDashboardWindow('14')).toBe(7);
    expect(parseDashboardWindow('abc')).toBe(7);
  });
});

describe('shortUid (VER-01)', () => {
  it('8 caractères, sans tiret', () => {
    expect(shortUid('1a2b-3c4d-5e6f')).toBe('1a2b3c4d');
    expect(shortUid(null)).toBe('');
  });
});

describe('globalAiStatus (GST-01)', () => {
  it('deux états, jamais « dégradé »', () => {
    expect(globalAiStatus(false).label).toBe('Opérationnel');
    expect(globalAiStatus(true).label).toBe('Arrêt d’urgence');
  });
});

describe('activityForWindow (PER-01, VOL-01)', () => {
  const a = { calls24h: 1, calls7d: 5, calls30d: 9, failed24h: 1, failed7d: 2, failed30d: 3, successRate24h: 0, successRate7d: 0.6, successRate30d: 0.667 };
  it('choisit les chiffres de la fenêtre', () => {
    expect(activityForWindow(a, 1)).toEqual({ calls: 1, failed: 1, successRate: 0 });
    expect(activityForWindow(a, 7)).toEqual({ calls: 5, failed: 2, successRate: 0.6 });
    expect(activityForWindow(a, 30)).toEqual({ calls: 9, failed: 3, successRate: 0.667 });
  });
});
