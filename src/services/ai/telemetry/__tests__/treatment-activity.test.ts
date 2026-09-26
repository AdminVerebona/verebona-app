/**
 * Activité par traitement (HLT-01, PER-01, VOL-01) : agrégation et taux.
 */
import { describe, it, expect, vi } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) } }));

const { getTreatmentActivity, successRate } = await import('../treatment-activity.repository');

describe('successRate', () => {
  it('null sans appel, arrondi au millième sinon', () => {
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(2, 3)).toBe(0.667);
  });
});

describe('getTreatmentActivity', () => {
  it('une ligne par traitement, zéros pour les traitements sans appel, ombre exclue', async () => {
    unsafe.mockResolvedValueOnce([{ t: 'T1', c24: '2', c7: '4', c30: '9', ok7: '3', last_at: '2026-09-25T10:00:00Z', last_err: null }]);
    const r = await getTreatmentActivity(new Date('2026-09-26T00:00:00Z'));
    expect(r.find((a) => a.treatment === 'T1')).toMatchObject({ calls24h: 2, calls7d: 4, calls30d: 9, successRate7d: 0.75, lastErrorAt: null });
    expect(r.find((a) => a.treatment === 'T3')).toMatchObject({ calls30d: 0, successRate7d: null });
    expect(String(unsafe.mock.calls[0][0])).toMatch(/shadow/);
  });
});
