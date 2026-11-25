/**
 * Horloge décalée des tests (`src/test/clock-offset.ts`) — le détecteur de
 * « bombes à retardement » doit lui-même être fiable : décalage exact de
 * `Date.now()` / `new Date()`, dates explicites intactes, inactif sans variable.
 */
import { describe, expect, it } from 'vitest';
import { installTestClockOffset } from '@/test/clock-offset';

describe('Horloge décalée des tests', () => {
  it('sans TEST_CLOCK_OFFSET_DAYS : inactive (décalage 0, Date d’origine conservée)', () => {
    const avant = globalThis.Date;
    expect(installTestClockOffset({})).toBe(0);
    expect(globalThis.Date).toBe(avant);
  });

  it('valeur invalide : échec explicite plutôt qu’un décalage deviné', () => {
    expect(() => installTestClockOffset({ TEST_CLOCK_OFFSET_DAYS: 'demain' })).toThrow(/invalide/);
  });

  it('active (si la suite tourne décalée) : Date.now() et new Date() décalés, dates explicites inchangées', () => {
    const jours = Number(process.env.TEST_CLOCK_OFFSET_DAYS ?? 0);
    if (!jours) return; // suite normale : rien à vérifier ici (couvert par `npm run test:horloge-decalee`)
    const reel = performance.timeOrigin + performance.now();
    expect(Math.abs(Date.now() - (reel + jours * 86_400_000))).toBeLessThan(5_000);
    expect(Math.abs(new Date().getTime() - Date.now())).toBeLessThan(5_000);
    expect(new Date('2026-11-25T10:00:00.000Z').toISOString()).toBe('2026-11-25T10:00:00.000Z');
    expect(new Date(0).getTime()).toBe(0);
    expect(new Date() instanceof Date).toBe(true);
  });
});
