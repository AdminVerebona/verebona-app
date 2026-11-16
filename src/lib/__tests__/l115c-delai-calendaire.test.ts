/**
 * Lot 115C — Trello #752 « Accueil web/mobile : corriger les délais
 * d'échéances inexacts et afficher l'année ».
 *
 * Le délai est CALCULÉ ici, pas constaté dans le code : chaque cas donne une
 * valeur attendue, et chaque frontière est éprouvée AVANT et APRÈS. Aucun
 * test ne dépend de la date du jour (toutes les références sont écrites).
 *
 *   L115C-D01  l'anomalie démontrée par la carte (CUPRA, 18 et 20/04/2028) ;
 *   L115C-D02  écart calendaire exact : mois de longueurs réelles, années
 *              bissextiles, fins de mois, décembre → janvier ;
 *   L115C-D03  frontières années / mois : 11, 12, 17, 18, 23, 24 mois ;
 *   L115C-D04  libellés courts conservés (aujourd'hui, demain, jours,
 *              semaines) et leurs frontières 2 / 13 / 14 / 59 / 60 jours ;
 *   L115C-D05  politique d'omission des jours : arrondi au mois RÉEL ;
 *   L115C-D06  jamais de délai inventé : date absente ou illisible ;
 *   L115C-D07  mentions de date : année écrite seulement si nécessaire,
 *              date complète toujours annonçable ;
 *   L115C-D08  fuseau : UTC contre Europe/Paris juste avant / après minuit,
 *              et au changement d'heure.
 */
import { describe, expect, it } from 'vitest';
import {
  ajouteMois, anneeNecessaire, dateCourteFr, dateLongueFr, ecartCalendaire, joursEntre, libelleDelai, moisAEcrire,
} from '@/lib/dates/delai-calendaire';
import { todayIn } from '@/lib/filters/date-filter';

/** Jour de référence de la capture iOS de la carte. */
const REF = '2026-11-12';

describe('L115C-D01 — l’anomalie démontrée par la carte', () => {
  it('18/04/2028 depuis le 12/11/2026 : 523 jours = 1 an, 5 mois et 6 jours → « Dans 1 an et 5 mois » (plus jamais « Dans 1 an »)', () => {
    expect(joursEntre(REF, '2028-04-18')).toBe(523);
    expect(ecartCalendaire(REF, '2028-04-18')).toEqual({ annees: 1, mois: 5, jours: 6, totalJours: 523 });
    expect(libelleDelai(REF, '2028-04-18')).toBe('Dans 1 an et 5 mois');
  });

  it('20/04/2028 : 525 jours = 1 an, 5 mois et 8 jours → « Dans 1 an et 5 mois », JAMAIS « Dans 2 ans »', () => {
    expect(joursEntre(REF, '2028-04-20')).toBe(525);
    expect(ecartCalendaire(REF, '2028-04-20')).toEqual({ annees: 1, mois: 5, jours: 8, totalJours: 525 });
    expect(libelleDelai(REF, '2028-04-20')).toBe('Dans 1 an et 5 mois');
    expect(libelleDelai(REF, '2028-04-20')).not.toBe('Dans 2 ans');
  });

  it('aucune bascule trompeuse : sur 1 000 jours consécutifs, les mois écrits ne reculent jamais et n’avancent jamais de plus d’un', () => {
    // Preuve de la propriété que l'ancienne règle violait (1 an → 2 ans pour
    // deux jours d'écart) : le délai écrit est MONOTONE et continu.
    const ecritsLe = (i: number) => {
      const { annees, mois } = moisAEcrire(REF, ecartCalendaire(REF, jourPlus(REF, i)));
      return annees * 12 + mois;
    };
    let precedent = ecritsLe(60);
    expect(precedent).toBe(2);
    for (let i = 61; i <= 1_000; i++) {
      const jour = jourPlus(REF, i);
      const { annees, mois } = moisAEcrire(REF, ecartCalendaire(REF, jour));
      const ecrits = annees * 12 + mois;
      expect(ecrits, `recul ou saut en ${jour}`).toBeGreaterThanOrEqual(precedent);
      expect(ecrits - precedent, `saut en ${jour}`).toBeLessThanOrEqual(1);
      precedent = ecrits;
    }
    expect(precedent).toBe(33); // 1 000 jours ≈ 2 ans et 9 mois
  });
});

/** `REF` + n jours, sans dépendre d'une horloge. */
function jourPlus(du: string, n: number): string {
  const [a, m, j] = du.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('L115C-D02 — écart calendaire exact (mois réels, bissextiles, fins de mois)', () => {
  it('29 février d’une année bissextile vers le 28 février suivant : 365 jours = 1 an juste', () => {
    expect(joursEntre('2024-02-29', '2025-02-28')).toBe(365);
    expect(ecartCalendaire('2024-02-29', '2025-02-28')).toEqual({ annees: 0, mois: 11, jours: 30, totalJours: 365 });
    // 30 jours sur un janvier de 31 jours : plus de la moitié → le 12e mois est écrit, donc une année.
    expect(libelleDelai('2024-02-29', '2025-02-28')).toBe('Dans 1 an');
  });

  it('28 février vers le 29 février de l’année bissextile suivante : 1 an et 1 jour', () => {
    expect(joursEntre('2027-02-28', '2028-02-29')).toBe(366);
    expect(ecartCalendaire('2027-02-28', '2028-02-29')).toEqual({ annees: 1, mois: 0, jours: 1, totalJours: 366 });
    expect(libelleDelai('2027-02-28', '2028-02-29')).toBe('Dans 1 an');
  });

  it('février non bissextile : 28/02 et 29/02 n’existent pas pareil (le 29/02/2027 n’est pas un jour)', () => {
    expect(libelleDelai('2026-12-01', '2027-02-29')).toBeNull();
    expect(libelleDelai('2026-12-01', '2028-02-29')).toBe('Dans 1 an et 3 mois');
  });

  it('fin de mois : 31 janvier + 1 mois = 29 février 2028 (ramené au dernier jour), + 13 mois = 28 février 2029', () => {
    expect(ajouteMois('2028-01-31', 1)).toBe('2028-02-29');
    expect(ajouteMois('2028-01-31', 13)).toBe('2029-02-28');
    expect(ajouteMois('2026-12-31', 2)).toBe('2027-02-28');
    expect(ajouteMois('2027-03-15', -3)).toBe('2026-12-15');
  });

  it('31 du mois : 31/05 → 30/06 est un mois complet ; 31/01 → 28/02 aussi', () => {
    expect(ecartCalendaire('2027-05-31', '2027-06-30')).toEqual({ annees: 0, mois: 0, jours: 30, totalJours: 30 });
    expect(ecartCalendaire('2027-01-31', '2027-02-28')).toEqual({ annees: 0, mois: 0, jours: 28, totalJours: 28 });
  });

  it('passage décembre → janvier : le report de jours est emprunté à décembre (31), jamais à 30 supposés', () => {
    expect(ecartCalendaire('2026-11-20', '2027-01-10')).toEqual({ annees: 0, mois: 1, jours: 21, totalJours: 51 });
    expect(joursEntre('2026-12-31', '2027-01-01')).toBe(1);
    expect(libelleDelai('2026-12-31', '2027-01-01')).toBe('Demain');
  });

  it('les jours totaux sont exacts sur un siècle non bissextile (2100) et sur 2400', () => {
    expect(joursEntre('2099-12-31', '2100-12-31')).toBe(365);
    expect(joursEntre('2399-12-31', '2400-12-31')).toBe(366);
  });
});

describe('L115C-D03 — frontières années / mois, avant et après', () => {
  const cas: Array<[string, string]> = [
    // Exactement 1 an, 1 an + 1 mois, 1 an + 11 mois, exactement 2 ans, 2 ans + 1 mois.
    ['2027-11-12', 'Dans 1 an'],
    ['2027-12-12', 'Dans 1 an et 1 mois'],
    ['2028-10-12', 'Dans 1 an et 11 mois'],
    ['2028-11-12', 'Dans 2 ans'],
    ['2028-12-12', 'Dans 2 ans et 1 mois'],
    // 11, 17, 18 mois exacts depuis le 12/11/2026 (12, 23 et 24 ci-dessus).
    ['2027-10-12', 'Dans 11 mois'],
    ['2028-04-12', 'Dans 1 an et 5 mois'],
    ['2028-05-12', 'Dans 1 an et 6 mois'],
  ];
  it.each(cas)('%s → %s', (jour, attendu) => {
    expect(libelleDelai(REF, jour)).toBe(attendu);
  });

  it('la veille et le lendemain de chaque frontière restent cohérents (aucun saut d’une année)', () => {
    // 12 mois : la frontière écrite tombe à 11 mois et demi, pas à 12.
    expect(libelleDelai(REF, '2027-11-11')).toBe('Dans 1 an');       // 11 mois et 30 jours → 12 mois arrondis
    expect(libelleDelai(REF, '2027-10-27')).toBe('Dans 11 mois');    // 11 mois et 15 jours sur un octobre de 31 j
    expect(libelleDelai(REF, '2027-10-28')).toBe('Dans 1 an');       // 11 mois et 16 jours → la moitié est franchie
    expect(libelleDelai(REF, '2027-11-13')).toBe('Dans 1 an');
    // 18 mois : jamais la bascule « Dans 2 ans » de l'ancienne règle.
    expect(libelleDelai(REF, '2028-05-11')).toBe('Dans 1 an et 6 mois');
    expect(libelleDelai(REF, '2028-05-13')).toBe('Dans 1 an et 6 mois');
    // 24 mois : la veille reste « Dans 1 an et 11 mois » ou « Dans 2 ans », jamais « Dans 3 ans ».
    expect(libelleDelai(REF, '2028-11-11')).toBe('Dans 2 ans');
    expect(libelleDelai(REF, '2028-11-13')).toBe('Dans 2 ans');
  });

  it('pluriels : « 1 an », « 2 ans », « 3 ans et 1 mois » ; « mois » invariable', () => {
    expect(libelleDelai(REF, '2029-11-12')).toBe('Dans 3 ans');
    expect(libelleDelai(REF, '2029-12-12')).toBe('Dans 3 ans et 1 mois');
    expect(libelleDelai(REF, '2027-01-12')).toBe('Dans 2 mois');
  });
});

describe('L115C-D04 — libellés courts conservés et leurs frontières', () => {
  const bornes: Array<[number, string]> = [
    [0, 'Aujourd’hui'],
    [1, 'Demain'],
    [2, 'Dans 2 jours'],
    [13, 'Dans 13 jours'],
    [14, 'Dans 2 semaines'],
    [59, 'Dans 8 semaines'],
    [60, 'Dans 2 mois'],
  ];
  it.each(bornes)('J+%i → %s', (n, attendu) => {
    expect(libelleDelai(REF, jourPlus(REF, n))).toBe(attendu);
  });

  it('une date passée n’est jamais « En retard » : « Aujourd’hui » au plus tôt (lot 113P)', () => {
    expect(libelleDelai(REF, jourPlus(REF, -1))).toBe('Aujourd’hui');
    expect(libelleDelai(REF, jourPlus(REF, -400))).toBe('Aujourd’hui');
    expect(libelleDelai(REF, jourPlus(REF, -400))).not.toMatch(/retard/i);
  });
});

describe('L115C-D05 — politique d’omission des jours : arrondi au mois RÉEL, jamais 30 jours supposés', () => {
  it('le reste de jours arrondit le mois au plus proche, sur la longueur du mois traversé', () => {
    // 2 mois et 15 jours depuis le 12/11/2026 : le reste court sur janvier (31 j) → 15 < 15,5 → 2 mois.
    expect(ecartCalendaire(REF, '2027-01-27')).toMatchObject({ annees: 0, mois: 2, jours: 15 });
    expect(libelleDelai(REF, '2027-01-27')).toBe('Dans 2 mois');
    // 2 mois et 16 jours → 16 ≥ 15,5 → 3 mois.
    expect(libelleDelai(REF, '2027-01-28')).toBe('Dans 3 mois');
    // Reste couru sur février 2027 (28 j) : 14 jours suffisent (14 ≥ 14).
    expect(ecartCalendaire(REF, '2027-02-26')).toMatchObject({ annees: 0, mois: 3, jours: 14 });
    expect(libelleDelai(REF, '2027-02-26')).toBe('Dans 4 mois');
    // Le même reste de 14 jours couru sur mars (31 j) reste à 4 mois.
    expect(ecartCalendaire(REF, '2027-03-26')).toMatchObject({ annees: 0, mois: 4, jours: 14 });
    expect(libelleDelai(REF, '2027-03-26')).toBe('Dans 4 mois');
  });

  it('365 jours ne sont jamais écrits « Dans 12 mois » : une année', () => {
    expect(libelleDelai('2026-01-01', '2027-01-01')).toBe('Dans 1 an');
    expect(libelleDelai('2026-01-01', '2026-12-25')).toBe('Dans 1 an');
    expect(libelleDelai('2026-01-01', '2026-12-10')).toBe('Dans 11 mois');
    expect(libelleDelai('2026-01-01', '2028-01-01')).toBe('Dans 2 ans');
  });
});

describe('L115C-D06 — jamais de délai inventé', () => {
  it('date absente, vide ou illisible : aucun libellé (null), aucune date affichée', () => {
    expect(libelleDelai(REF, '')).toBeNull();
    expect(libelleDelai(REF, 'bientôt')).toBeNull();
    expect(libelleDelai(REF, '2027-13-01')).toBeNull();
    expect(libelleDelai(REF, '2027-02-30')).toBeNull();
    expect(libelleDelai('', '2028-04-18')).toBeNull();
    expect(dateCourteFr('')).toBe('');
    expect(dateLongueFr('2027-02-30')).toBe('');
  });
});

describe('L115C-D07 — mentions de date', () => {
  it('année écrite seulement quand elle est nécessaire (autre année civile)', () => {
    expect(anneeNecessaire(REF, '2028-04-18')).toBe(true);
    expect(anneeNecessaire(REF, '2027-01-02')).toBe(true);
    expect(anneeNecessaire(REF, '2026-12-31')).toBe(false);
    expect(dateCourteFr('2028-04-18', true)).toBe('18 avr. 2028');
    expect(dateCourteFr('2028-04-18')).toBe('18 avr.');
  });

  it('date complète annonçable, année toujours comprise, « 1er » du mois', () => {
    expect(dateLongueFr('2028-04-18')).toBe('18 avril 2028');
    expect(dateLongueFr('2028-04-01')).toBe('1er avril 2028');
    expect(dateLongueFr('2028-02-29')).toBe('29 février 2028');
  });
});

describe('L115C-D08 — fuseau : le jour de référence est celui de l’utilisateur', () => {
  // L'écart, lui, est insensible au fuseau : les deux bornes sont des jours civils.
  it('23 h 30 à Paris en hiver : le jour UTC est encore la veille — le jour de présentation, non', () => {
    const instant = new Date('2026-11-12T23:30:00+01:00'); // 22 h 30 UTC
    expect(instant.toISOString().slice(0, 10)).toBe('2026-11-12');
    expect(todayIn(instant)).toBe('2026-11-12');
  });

  it('00 h 30 à Paris en hiver : UTC dit encore « hier », le jour de présentation dit « aujourd’hui »', () => {
    const instant = new Date('2026-11-13T00:30:00+01:00'); // 23 h 30 UTC la veille
    expect(instant.toISOString().slice(0, 10)).toBe('2026-11-12');
    expect(todayIn(instant)).toBe('2026-11-13');
    // Conséquence directe du bug : une échéance du 13 se lisait « Demain » à 0 h 30.
    expect(libelleDelai(instant.toISOString().slice(0, 10), '2026-11-13')).toBe('Demain');
    expect(libelleDelai(todayIn(instant), '2026-11-13')).toBe('Aujourd’hui');
  });

  it('01 h 30 à Paris en ÉTÉ (UTC+2) : même écart d’un jour, géré par le fuseau et non par une heure fixe', () => {
    const instant = new Date('2027-07-15T01:30:00+02:00'); // 23 h 30 UTC le 14
    expect(instant.toISOString().slice(0, 10)).toBe('2027-07-14');
    expect(todayIn(instant)).toBe('2027-07-15');
  });

  it('nuit du changement d’heure (29/03/2026, 02 h → 03 h) : le jour civil reste juste avant et après', () => {
    expect(todayIn(new Date('2026-03-29T01:30:00+01:00'))).toBe('2026-03-29');
    expect(todayIn(new Date('2026-03-29T03:30:00+02:00'))).toBe('2026-03-29');
    expect(todayIn(new Date('2026-03-28T23:30:00+01:00'))).toBe('2026-03-28');
    // Retour à l'heure d'hiver (25/10/2026) : les deux 02 h 30 restent le même jour.
    expect(todayIn(new Date('2026-10-25T02:30:00+02:00'))).toBe('2026-10-25');
    expect(todayIn(new Date('2026-10-25T02:30:00+01:00'))).toBe('2026-10-25');
  });

  it('un changement d’heure entre les deux bornes ne change pas l’écart (minuit UTC des deux côtés)', () => {
    expect(joursEntre('2026-03-01', '2026-04-01')).toBe(31);
    expect(joursEntre('2026-10-01', '2026-11-01')).toBe(31);
    expect(libelleDelai('2026-03-01', '2026-04-01')).toBe('Dans 4 semaines');
    expect(libelleDelai('2026-03-01', '2026-05-15')).toBe('Dans 2 mois');
  });
});
