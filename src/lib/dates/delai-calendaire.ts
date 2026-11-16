/**
 * Écart CALENDAIRE entre deux jours civils, et son libellé lisible
 * (« Dans 1 an et 5 mois »). Module PUR : aucune horloge, aucun accès base,
 * aucun import serveur — lisible côté client comme côté serveur, donc UNE
 * seule règle pour le web et pour l'application mobile (qui affiche
 * l'interface web distante, décision 108G). Aucun moteur parallèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE (carte #752)
 *
 * Le délai de l'accueil était calculé en arrondissant les jours : au-delà de
 * 60 jours, `Math.round(jours / 30)` donnait des « mois » théoriques de
 * 30 jours, puis 12 à 17 mois étaient repliés en dur sur « Dans 1 an » et
 * 18 mois et plus sur « Dans N ans ». Deux effets, tous deux faux :
 *
 *   · 523 jours (18/04/2028 depuis le 12/11/2026) = 1 an, 5 mois et 6 jours
 *     se lisaient « Dans 1 an » — plus de cinq mois escamotés ;
 *   · 525 jours (20/04/2028) se lisaient « Dans 2 ans » — une rupture de
 *     libellé à une frontière arbitraire, pour deux jours d'écart.
 *
 * Ici, l'écart est une VRAIE différence de calendrier : mois de longueurs
 * réelles (28, 29, 30, 31), années bissextiles, fins de mois. Le libellé ne
 * saute jamais d'un terme à l'autre : l'unité la plus fine affichée est
 * arrondie au plus proche, sur la longueur réelle du mois traversé, et
 * 12 mois arrondis deviennent une année de plus (jamais « Dans 2 ans »
 * pour 1 an et 5 mois).
 *
 * Les jours civils sont comparés à minuit UTC des deux côtés : aucun
 * changement d'heure (CET / CEST) ne peut décaler le compte. Le JOUR de
 * référence, lui, doit être le jour civil de l'utilisateur (Europe/Paris) —
 * c'est l'appelant qui le fournit (`todayIn`), jamais ce module.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { daysInMonth } from '@/lib/filters/date-filter';

const JOUR_MS = 86_400_000;

/** Mois abrégés de la charte (pastille de date, mentions courtes). */
export const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'] as const;

/** Mois en clair (date complète annoncée aux lecteurs d'écran). */
export const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'] as const;

export interface EcartCalendaire {
  /** Années complètes. */
  annees: number;
  /** Mois complets au-delà des années (0 à 11). */
  mois: number;
  /** Jours au-delà des mois complets (0 à 30). */
  jours: number;
  /** Jours civils exacts entre les deux dates (bissextiles comprises) ; négatif si `au` précède `du`. */
  totalJours: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Les trois nombres d'un jour `AAAA-MM-JJ` (les 10 premiers caractères suffisent). */
function partsJour(jour: string): [number, number, number] {
  const [a, m, j] = jour.slice(0, 10).split('-').map(Number);
  return [a, m, j];
}

/**
 * Jour civil réellement existant (`AAAA-MM-JJ`) : le 30 février n'en est pas
 * un, et `Date` le reporterait silencieusement au 2 mars — d'où un délai
 * inventé. À appeler avant tout affichage de date ou de délai.
 */
export function estJourValide(jour: string): boolean {
  const [a, m, j] = partsJour(jour);
  return Number.isInteger(a) && Number.isInteger(m) && Number.isInteger(j)
    && m >= 1 && m <= 12 && j >= 1 && j <= daysInMonth(a, m);
}

/**
 * Jours civils de `du` à `au`, exactement (minuit UTC des deux côtés : ni
 * fuseau ni changement d'heure n'interviennent). Négatif si `au` précède.
 */
export function joursEntre(du: string, au: string): number {
  const [a1, m1, j1] = partsJour(du);
  const [a2, m2, j2] = partsJour(au);
  return Math.round((Date.UTC(a2, m2 - 1, j2) - Date.UTC(a1, m1 - 1, j1)) / JOUR_MS);
}

/**
 * Ajoute `n` mois à un jour civil ; un jour qui n'existe pas dans le mois
 * d'arrivée est ramené au dernier jour de ce mois (31 janvier + 1 mois =
 * 28 ou 29 février). `n` peut être négatif.
 */
export function ajouteMois(jour: string, n: number): string {
  const [a, m, j] = partsJour(jour);
  const total = a * 12 + (m - 1) + n;
  const annee = Math.floor(total / 12);
  const mois = total - annee * 12 + 1;
  return `${annee}-${pad(mois)}-${pad(Math.min(j, daysInMonth(annee, mois)))}`;
}

/**
 * Écart calendaire de `du` à `au` : années, mois complets puis jours, le
 * report de jours étant emprunté au mois qui PRÉCÈDE `au` (sa longueur
 * réelle). Si `au` ne suit pas `du`, seuls les jours totaux portent le
 * signe : les termes sont nuls (l'accueil ne présente pas de date passée,
 * lot 113P).
 */
export function ecartCalendaire(du: string, au: string): EcartCalendaire {
  const totalJours = joursEntre(du, au);
  if (!(totalJours > 0)) return { annees: 0, mois: 0, jours: 0, totalJours: Number.isFinite(totalJours) ? totalJours : 0 };
  const [a1, m1, j1] = partsJour(du);
  const [a2, m2, j2] = partsJour(au);
  let annees = a2 - a1;
  let mois = m2 - m1;
  let jours = j2 - j1;
  if (jours < 0) {
    mois -= 1;
    const anneeAvant = m2 === 1 ? a2 - 1 : a2;
    const moisAvant = m2 === 1 ? 12 : m2 - 1;
    jours += daysInMonth(anneeAvant, moisAvant);
  }
  if (mois < 0) { annees -= 1; mois += 12; }
  return { annees, mois, jours, totalJours };
}

/**
 * Seuils d'écriture du délai (paramètres à valider par le PO) : en jours
 * sous `DELAI_JOURS_MAX`, en semaines sous `DELAI_SEMAINES_MAX`, en mois et
 * années calendaires au-delà. Bornes existantes de l'accueil, conservées.
 */
export const DELAI_JOURS_MAX = 14;
export const DELAI_SEMAINES_MAX = 60;

/**
 * Mois (et années) à ÉCRIRE : les mois complets, augmentés d'un mois quand
 * le reste de jours atteint la MOITIÉ du mois réel qu'il parcourt — jamais
 * 30 jours supposés. Politique d'omission des jours, documentée et non
 * trompeuse : les jours ne sont pas écrits, mais ils ne sont pas perdus,
 * ils arrondissent le mois au plus proche (écart maximal : un demi-mois).
 * 12 mois arrondis font une année de plus, de sorte qu'un délai ne se lit
 * jamais « Dans 1 an et 12 mois ».
 */
export function moisAEcrire(du: string, e: EcartCalendaire): { annees: number; mois: number } {
  const ancre = ajouteMois(du, e.annees * 12 + e.mois);
  const [a, m] = partsJour(ancre);
  let annees = e.annees;
  let mois = e.mois + (e.jours * 2 >= daysInMonth(a, m) ? 1 : 0);
  if (mois >= 12) { annees += 1; mois -= 12; }
  return { annees, mois };
}

/**
 * Délai lisible d'un jour de référence vers une échéance :
 * « Aujourd'hui », « Demain », « Dans 5 jours », « Dans 3 semaines »,
 * « Dans 7 mois », « Dans 1 an », « Dans 1 an et 5 mois », « Dans 2 ans ».
 *
 * Lot 113P (#715) : jamais « En retard » — une date passée ou du jour se lit
 * « Aujourd'hui » au plus tôt (et l'accueil ne présente pas les dates
 * passées). Une date invalide ne produit aucun délai inventé : `null`.
 */
export function libelleDelai(du: string, au: string): string | null {
  if (!estJourValide(du) || !estJourValide(au)) return null;
  const e = ecartCalendaire(du, au);
  const n = e.totalJours;
  if (n <= 0) return 'Aujourd’hui';
  if (n === 1) return 'Demain';
  if (n < DELAI_JOURS_MAX) return `Dans ${n} jours`;
  if (n < DELAI_SEMAINES_MAX) return `Dans ${Math.round(n / 7)} semaines`;
  const { annees, mois } = moisAEcrire(du, e);
  if (annees === 0) return `Dans ${mois} mois`;
  const ans = `${annees} ${annees > 1 ? 'ans' : 'an'}`;
  return mois === 0 ? `Dans ${ans}` : `Dans ${ans} et ${mois} mois`;
}

/** « 18 avr. », ou « 18 avr. 2028 » avec l'année. Jour invalide : chaîne vide. */
export function dateCourteFr(jour: string, avecAnnee = false): string {
  if (!estJourValide(jour)) return '';
  const [a, m, j] = partsJour(jour);
  return `${j} ${MOIS_COURTS[m - 1]}${avecAnnee ? ` ${a}` : ''}`;
}

/** « 18 avril 2028 » — date complète, année toujours comprise. Jour invalide : chaîne vide. */
export function dateLongueFr(jour: string): string {
  if (!estJourValide(jour)) return '';
  const [a, m, j] = partsJour(jour);
  return `${j === 1 ? '1er' : j} ${MOIS_LONGS[m - 1]} ${a}`;
}

/**
 * L'année est-elle NÉCESSAIRE pour situer `jour` depuis le jour de
 * référence ? Vrai dès que l'année civile diffère : « 18 avr. » seul ne
 * distingue alors pas 2027 de 2028.
 */
export function anneeNecessaire(reference: string, jour: string): boolean {
  return jour.slice(0, 4) !== reference.slice(0, 4);
}
