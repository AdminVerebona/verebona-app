/**
 * Lot 113AH (#732) — rappels d'échéance : règles pures (délai calendaire
 * Europe/Paris, changements d'heure, minuit, plage d'envoi, éligibilité J+0 …
 * J+7), texte exact du catalogue (jamais « dans 7 jours » si l'échéance est
 * plus proche), compatibilité des lignes déjà en file, orchestration du
 * passage planifié (rappels jusqu'à 21 h, récapitulatif jusqu'à 11 h).
 * Sans base : la couverture, l'unicité, la concurrence et l'outbox sont
 * prouvées sur PostgreSQL réel (`l113ah-rappels-echeances.e2e.ts`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const policy = await import('../scheduled/deadline-reminder-policy');
const { NOTIFICATION_CATALOG } = await import('../catalog');

const Z = (iso: string) => new Date(iso);

describe('113AH — délai réel en jours calendaires Europe/Paris', () => {
  it('jours calendaires, y compris à travers les changements d’heure (29/03 et 25/10/2026)', () => {
    expect(policy.calendarDaysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(policy.calendarDaysBetween('2026-03-29', '2026-04-05')).toBe(7);
    expect(policy.calendarDaysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(policy.calendarDaysBetween('2026-10-25', '2026-11-01')).toBe(7);
    expect(policy.calendarDaysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('minuit à Paris (et non UTC) : 23 h 59 → J+1 = demain ; 00 h 01 → même date = aujourd’hui', () => {
    // 22:59 UTC = 23:59 Paris (hiver, UTC+1).
    expect(policy.daysUntilDeadline('2026-11-12', Z('2026-11-11T22:59:00Z'))).toBe(1);
    expect(policy.daysUntilDeadline('2026-11-12', Z('2026-11-11T23:01:00Z'))).toBe(0);
    // Été (UTC+2) : 21:59 UTC = 23:59 Paris.
    expect(policy.daysUntilDeadline('2026-07-02', Z('2026-06-30T21:59:00Z'))).toBe(2);
    expect(policy.daysUntilDeadline('2026-07-02', Z('2026-06-30T22:01:00Z'))).toBe(1);
  });

  it('jour du passage à l’heure d’été / d’hiver : fenêtre J+0 … J+7 sur dates locales', () => {
    expect(policy.deadlineReminderRange(Z('2026-03-29T07:30:00Z'))).toEqual({ today: '2026-03-29', last: '2026-04-05' });
    expect(policy.deadlineReminderRange(Z('2026-10-25T07:30:00Z'))).toEqual({ today: '2026-10-25', last: '2026-11-01' });
    // 00 h 30 Paris le 25/10 (encore UTC+2 avant 3 h) = 22:30 UTC le 24.
    expect(policy.deadlineReminderRange(Z('2026-10-24T22:30:00Z')).today).toBe('2026-10-25');
  });
});

describe('113AH — plage d’envoi 8 h 30 – 21 h (Paris, hiver et été)', () => {
  it.each([
    ['2026-11-10T07:29:00Z', false], ['2026-11-10T07:30:00Z', true], ['2026-11-10T19:59:00Z', true], ['2026-11-10T20:00:00Z', false],
    ['2026-07-10T06:29:00Z', false], ['2026-07-10T06:30:00Z', true], ['2026-07-10T18:59:00Z', true], ['2026-07-10T19:00:00Z', false],
    ['2026-03-29T06:30:00Z', true], ['2026-10-25T07:30:00Z', true],
  ])('%s → %s', (iso, attendu) => {
    expect(policy.isWithinDeadlineSendWindow(Z(iso))).toBe(attendu);
  });
});

describe('113AH — éligibilité (catégorie « action » inchangée, J+0 … J+7, échéance pas encore passée)', () => {
  const now = Z('2026-11-10T10:30:00Z'); // 11 h 30 Paris
  it.each([
    [{ homeCategory: 'action', startDate: '2026-11-17' }, true],
    [{ homeCategory: 'action', startDate: '2026-11-18' }, false],
    [{ homeCategory: 'action', startDate: '2026-11-11' }, true],
    [{ homeCategory: 'action', startDate: '2026-11-10' }, true],
    [{ homeCategory: 'action', startDate: '2026-11-10', startTime: '11:00:00' }, false],
    [{ homeCategory: 'action', startDate: '2026-11-10', startTime: '14:00:00' }, true],
    [{ homeCategory: 'action', startDate: '2026-11-09' }, false],
    [{ homeCategory: 'information', startDate: '2026-11-12' }, false],
    [{ homeCategory: null, startDate: '2026-11-12' }, false],
    [{ homeCategory: 'action', startDate: null }, false],
  ])('%j → %s', (item, attendu) => {
    expect(policy.isDeadlineReminderEligible(item, now)).toBe(attendu);
  });
});

describe('113AH — texte du rappel (catalogue DEADLINE_DUE_IN_7_DAYS)', () => {
  const j7 = NOTIFICATION_CATALOG.DEADLINE_DUE_IN_7_DAYS!;
  const titre = (p: Record<string, unknown>) => j7.render(p).bellTitle;

  it('à 7 jours : textes d’origine inchangés (une, plusieurs, prévisionnelle)', () => {
    expect(titre({ count: 1, date: '2026-11-17', daysUntil: 7 })).toBe('Échéance dans 7 jours');
    expect(titre({ count: 3, date: '2026-11-17', daysUntil: 7, forecastCount: 1 })).toBe('3 échéances dans 7 jours (dont 1 prévisionnelle)');
    expect(titre({ count: 1, date: '2026-11-17', daysUntil: 7, forecastCount: 1 })).toBe('Échéance prévisionnelle dans 7 jours');
  });

  it('ligne mise en file AVANT 113AH (sans `daysUntil`) : rendu d’origine, payload toujours valide', () => {
    const legacy = { count: 2, date: '2026-11-17', agendaItemIds: [1, 2], forecastCount: 0 };
    expect(j7.payloadSchema.safeParse(legacy).success).toBe(true);
    expect(titre(legacy)).toBe('2 échéances dans 7 jours');
  });

  it('rattrapage : délai réel exact — dans N jours, demain, aujourd’hui', () => {
    expect(titre({ count: 1, date: 'x', daysUntil: 6 })).toBe('Échéance dans 6 jours');
    expect(titre({ count: 1, date: 'x', daysUntil: 2 })).toBe('Échéance dans 2 jours');
    expect(titre({ count: 1, date: 'x', daysUntil: 1 })).toBe('Échéance demain');
    expect(titre({ count: 1, date: 'x', daysUntil: 0 })).toBe('Échéance aujourd’hui');
    expect(titre({ count: 2, date: 'x', daysUntil: 1, forecastCount: 2 })).toBe('2 échéances demain (dont 2 prévisionnelles)');
    expect(titre({ count: 1, date: 'x', daysUntil: 1, forecastCount: 1 })).toBe('Échéance prévisionnelle demain');
  });

  it('jamais « dans 7 jours » quand l’échéance est plus proche (toutes les combinaisons)', () => {
    for (let d = 0; d < 7; d++) {
      for (const count of [1, 2, 5]) {
        for (const forecastCount of [0, 1, count]) {
          const r = j7.render({ count, date: '2026-11-12', daysUntil: d, forecastCount });
          expect(`${r.bellTitle} ${r.pushTitle} ${r.bellBody}`).not.toContain('7 jours');
        }
      }
    }
  });

  it('prévision seule : corps « Date estimée … à confirmer » ; lien Agenda conservé ; délai hors bornes refusé', () => {
    expect(j7.render({ count: 1, date: 'x', daysUntil: 2, forecastCount: 1 }).bellBody).toBe('Date estimée à partir de la récurrence : à confirmer dans Verebona.');
    expect(j7.deepLink({ count: 1, date: '2026-11-12' })).toBe('/agenda?date=2026-11-12');
    expect(j7.payloadSchema.safeParse({ count: 1, date: '2026-11-12', daysUntil: 8 }).success).toBe(false);
    expect(j7.payloadSchema.safeParse({ count: 1, date: '2026-11-12', daysUntil: -1 }).success).toBe(false);
    expect(j7.render({ count: 1, date: 'x', daysUntil: 0 }).emailTemplateCode).toBe('notif_deadline_j7');
  });
});

describe('113AH — passage planifié : rappels jusqu’à 21 h, récapitulatif et fin d’essai jusqu’à 11 h', () => {
  const appels: string[] = [];
  beforeEach(() => { appels.length = 0; vi.resetModules(); });
  async function charger() {
    vi.doMock('../scheduled/deadlines', () => ({ runDeadlineReminders: vi.fn(async () => { appels.push('deadlines'); return { covered: 0 }; }) }));
    vi.doMock('../scheduled/to-process-digest', () => ({ runToProcessDigest: vi.fn(async () => { appels.push('digest'); return {}; }) }));
    vi.doMock('../scheduled/trial-ending', () => ({ runTrialEndingReminders: vi.fn(async () => { appels.push('trial'); return {}; }) }));
    return import('../scheduled/morning-events');
  }

  it.each([
    ['2026-11-10T07:00:00Z', []], // 8 h Paris : avant le créneau
    ['2026-11-10T07:45:00Z', ['deadlines', 'digest', 'trial']], // 8 h 45
    ['2026-11-10T10:30:00Z', ['deadlines']], // 11 h 30 : rattrapage des rappels seul
    ['2026-11-10T19:45:00Z', ['deadlines']], // 20 h 45
    ['2026-11-10T20:15:00Z', []], // 21 h 15 : rien la nuit
    ['2026-07-10T09:30:00Z', ['deadlines']], // 11 h 30 heure d'été
  ])('%s → %j', async (iso, attendu) => {
    const { runMorningScheduledEvents } = await charger();
    await runMorningScheduledEvents({ now: Z(iso) });
    expect(appels).toEqual(attendu);
  });

  it('déclenchement forcé (route, ?force=1) : tout, quelle que soit l’heure', async () => {
    const { runMorningScheduledEvents } = await charger();
    await runMorningScheduledEvents({ now: Z('2026-11-10T22:00:00Z'), force: true });
    expect(appels).toEqual(['deadlines', 'digest', 'trial']);
  });
});
