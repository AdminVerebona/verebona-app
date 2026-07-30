/**
 * Calendrier français et délai de rétractation.
 *
 * Vérifié sur des dates réelles, vérifiables indépendamment : un calcul de
 * délai légal faux ne se voit pas en recette, il se voit devant un juge.
 */
import { describe, it, expect } from 'vitest';
import {
  easterSunday,
  listPublicHolidays,
  isPublicHoliday,
  isBusinessDay,
  nextBusinessDay,
  computeWithdrawalDeadline,
  isWithinWithdrawalPeriod,
  toParisCivilDate,
  parisEndOfDay,
  formatCivilDate,
  addDays,
} from '@/services/legal/french-calendar';

describe('dimanche de Pâques', () => {
  it('retrouve les dates connues', () => {
    // Dates publiques, vérifiables dans n'importe quel almanach.
    const cases: Array<[number, string]> = [
      [2024, '2024-03-31'],
      [2025, '2025-04-20'],
      [2026, '2026-04-05'],
      [2027, '2027-03-28'],
      [2028, '2028-04-16'],
      [2030, '2030-04-21'],
      [2038, '2038-04-25'], // Pâques la plus tardive possible
    ];
    for (const [year, expected] of cases) {
      expect(formatCivilDate(easterSunday(year))).toBe(expected);
    }
  });
});

describe('jours fériés', () => {
  it('en compte onze en métropole', () => {
    expect(listPublicHolidays(2026)).toHaveLength(11);
    expect(listPublicHolidays(2027)).toHaveLength(11);
  });

  it('en compte treize en Alsace-Moselle', () => {
    expect(listPublicHolidays(2026, 'alsace-moselle')).toHaveLength(13);
  });

  it('place correctement les fêtes mobiles de 2026', () => {
    // Pâques : dimanche 5 avril 2026.
    const dates = listPublicHolidays(2026).map((h) => formatCivilDate(h.date));
    expect(dates).toContain('2026-04-06'); // lundi de Pâques
    expect(dates).toContain('2026-05-14'); // Ascension
    expect(dates).toContain('2026-05-25'); // lundi de Pentecôte
  });

  it('reconnaît les fêtes fixes', () => {
    expect(isPublicHoliday({ year: 2026, month: 1, day: 1 })).toBe(true);
    expect(isPublicHoliday({ year: 2026, month: 7, day: 14 })).toBe(true);
    expect(isPublicHoliday({ year: 2026, month: 12, day: 25 })).toBe(true);
    expect(isPublicHoliday({ year: 2026, month: 12, day: 26 })).toBe(false);
  });

  it('n’ajoute la Saint-Étienne qu’en Alsace-Moselle', () => {
    expect(isPublicHoliday({ year: 2026, month: 12, day: 26 }, 'alsace-moselle')).toBe(true);
  });

  it('ne confond pas un jour ordinaire avec un jour férié', () => {
    expect(isPublicHoliday({ year: 2026, month: 3, day: 17 })).toBe(false);
  });
});

describe('jours ouvrables au sens du L. 221-19', () => {
  it('exclut le samedi et le dimanche', () => {
    // 2026-07-04 est un samedi, 2026-07-05 un dimanche.
    expect(isBusinessDay({ year: 2026, month: 7, day: 4 })).toBe(false);
    expect(isBusinessDay({ year: 2026, month: 7, day: 5 })).toBe(false);
    expect(isBusinessDay({ year: 2026, month: 7, day: 6 })).toBe(true);
  });

  it('exclut les jours fériés en semaine', () => {
    // 14 juillet 2026 : un mardi.
    expect(isBusinessDay({ year: 2026, month: 7, day: 14 })).toBe(false);
  });

  it('avance jusqu’au premier jour réellement ouvrable', () => {
    // Samedi 25 avril 2026 → lundi 27.
    expect(formatCivilDate(nextBusinessDay({ year: 2026, month: 4, day: 25 })))
      .toBe('2026-04-27');
  });

  it('enchaîne les reports quand week-end et férié se suivent', () => {
    // Samedi 1er mai 2027 (Fête du Travail) → dimanche 2 → lundi 3.
    expect(formatCivilDate(nextBusinessDay({ year: 2027, month: 5, day: 1 })))
      .toBe('2027-05-03');
  });

  it('retourne le jour lui-même s’il est déjà ouvrable', () => {
    expect(formatCivilDate(nextBusinessDay({ year: 2026, month: 3, day: 17 })))
      .toBe('2026-03-17');
  });
});

describe('délai de rétractation (§3.1)', () => {
  it('ne compte pas le jour de conclusion', () => {
    // Conclu le mardi 3 mars 2026 → 14ᵉ jour = mardi 17 mars.
    const d = computeWithdrawalDeadline(new Date('2026-03-03T14:30:00Z'));
    expect(formatCivilDate(d.nominalDate)).toBe('2026-03-17');
    expect(d.deferred).toBe(false);
  });

  it('n’est pas décalé par une conclusion tardive dans la journée', () => {
    // 23 h 30 heure de Paris le 3 mars = 22 h 30 UTC. Le jour de référence
    // reste le 3 mars, pas le 4 : c'est le piège que le calcul en UTC crée.
    const soir = computeWithdrawalDeadline(new Date('2026-03-03T22:30:00Z'));
    const matin = computeWithdrawalDeadline(new Date('2026-03-03T08:00:00Z'));
    expect(formatCivilDate(soir.deadlineDate)).toBe(formatCivilDate(matin.deadlineDate));
  });

  it('reporte une échéance tombant un samedi', () => {
    // Conclu le 21 mars 2026 → 14ᵉ jour = samedi 4 avril → lundi 6 avril…
    // qui est le lundi de Pâques 2026. Report jusqu'au mardi 7.
    const d = computeWithdrawalDeadline(new Date('2026-03-21T10:00:00Z'));
    expect(formatCivilDate(d.nominalDate)).toBe('2026-04-04');
    expect(d.deferred).toBe(true);
    expect(d.deferralReason).toBe('samedi');
    expect(formatCivilDate(d.deadlineDate)).toBe('2026-04-07');
  });

  it('reporte une échéance tombant un dimanche', () => {
    // Conclu le 22 mars 2026 → 14ᵉ jour = dimanche 5 avril.
    const d = computeWithdrawalDeadline(new Date('2026-03-22T10:00:00Z'));
    expect(d.deferralReason).toBe('dimanche');
    expect(formatCivilDate(d.deadlineDate)).toBe('2026-04-07');
  });

  it('reporte une échéance tombant un jour férié en semaine', () => {
    // Conclu le 30 juin 2026 → 14ᵉ jour = mardi 14 juillet, férié.
    const d = computeWithdrawalDeadline(new Date('2026-06-30T09:00:00Z'));
    expect(formatCivilDate(d.nominalDate)).toBe('2026-07-14');
    expect(d.deferred).toBe(true);
    expect(d.deferralReason).toBe('Fête nationale');
    expect(formatCivilDate(d.deadlineDate)).toBe('2026-07-15');
  });

  it('fixe l’échéance à 23 h 59 min 59 s, heure de Paris', () => {
    const d = computeWithdrawalDeadline(new Date('2026-03-03T14:30:00Z'));
    // 17 mars 2026 : heure d'hiver, Paris = UTC+1 → 22:59:59 UTC.
    expect(d.deadlineAt.toISOString()).toBe('2026-03-17T22:59:59.000Z');
  });

  it('tient compte de l’heure d’été', () => {
    // Conclu le 1er juillet → échéance le 15 juillet, Paris = UTC+2.
    const d = computeWithdrawalDeadline(new Date('2026-07-01T09:00:00Z'));
    expect(d.deadlineAt.toISOString()).toBe('2026-07-15T21:59:59.000Z');
  });

  it('ne raccourcit jamais le délai, quelle que soit la date', () => {
    // Propriété générale : l'échéance est toujours au moins le 14ᵉ jour.
    for (let i = 0; i < 400; i += 1) {
      const concluded = new Date(Date.UTC(2026, 0, 1 + i, 10, 0, 0));
      const d = computeWithdrawalDeadline(concluded);
      const nominal = addDays(toParisCivilDate(concluded), 14);
      expect(formatCivilDate(d.deadlineDate) >= formatCivilDate(nominal)).toBe(true);
      expect(isBusinessDay(d.deadlineDate)).toBe(true);
    }
  });
});

describe('fenêtre de rétractation', () => {
  const concluded = new Date('2026-03-03T14:30:00Z');

  it('est ouverte la veille de l’échéance', () => {
    expect(isWithinWithdrawalPeriod(concluded, new Date('2026-03-16T12:00:00Z'))).toBe(true);
  });

  it('est ouverte à la dernière seconde', () => {
    expect(isWithinWithdrawalPeriod(concluded, new Date('2026-03-17T22:59:59Z'))).toBe(true);
  });

  it('est fermée une seconde plus tard', () => {
    expect(isWithinWithdrawalPeriod(concluded, new Date('2026-03-17T23:00:00Z'))).toBe(false);
  });
});

describe('conversion de fuseau', () => {
  it('rattache un instant au bon jour parisien', () => {
    // 23 h 30 UTC le 3 mars = 00 h 30 le 4 mars à Paris (UTC+1).
    expect(formatCivilDate(toParisCivilDate(new Date('2026-03-03T23:30:00Z'))))
      .toBe('2026-03-04');
  });

  it('gère la nuit du passage à l’heure d’été', () => {
    // 29 mars 2026 : Paris passe de UTC+1 à UTC+2 à 2 h du matin.
    const end = parisEndOfDay({ year: 2026, month: 3, day: 29 });
    expect(end.toISOString()).toBe('2026-03-29T21:59:59.000Z');
  });

  it('gère la nuit du passage à l’heure d’hiver', () => {
    // 25 octobre 2026 : retour à UTC+1.
    const end = parisEndOfDay({ year: 2026, month: 10, day: 25 });
    expect(end.toISOString()).toBe('2026-10-25T22:59:59.000Z');
  });
});
