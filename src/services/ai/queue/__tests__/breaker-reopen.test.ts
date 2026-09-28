/**
 * Anti-oscillation du disjoncteur (revue indépendante lot IA 2, WF-09) :
 * une sonde triviale qui réussit alors que les vrais appels échouent ne doit
 * pas provoquer un cycle réactivation / réouverture toutes les 30 s.
 */
import { describe, it, expect } from 'vitest';
import {
  reopenPlan, nextProbeDelay, REOPEN_WINDOW_SECONDS, REOPEN_DELAY_CAP_SECONDS,
} from '../circuit-breaker';

const now = new Date('2026-09-26T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe('reopenPlan', () => {
  it('première ouverture (jamais réactivé) : planning normal', () => {
    expect(reopenPlan(null, 0, now)).toEqual({ reopens: 0, probeAttempts: 0, delaySeconds: nextProbeDelay(0) });
  });

  it('réactivation ancienne (hors fenêtre) : le compteur repart de zéro', () => {
    expect(reopenPlan(ago(REOPEN_WINDOW_SECONDS + 1), 4, now).reopens).toBe(0);
  });

  it('réouvertures rapprochées : délai croissant, planning avancé, plafonné', () => {
    const p1 = reopenPlan(ago(120), 0, now);
    const p2 = reopenPlan(ago(120), p1.reopens, now);
    const p3 = reopenPlan(ago(120), p2.reopens, now);
    expect(p1.reopens).toBe(1);
    expect(p1.delaySeconds).toBeGreaterThan(nextProbeDelay(0));
    expect(p2.delaySeconds).toBeGreaterThan(p1.delaySeconds);
    expect(p3.delaySeconds).toBeGreaterThanOrEqual(p2.delaySeconds);
    expect(p3.probeAttempts).toBeGreaterThan(p1.probeAttempts);
    expect(reopenPlan(ago(10), 50, now).delaySeconds).toBe(REOPEN_DELAY_CAP_SECONDS);
  });
});
