/**
 * Lot 108A — ticket P1 « TCO — correctifs globaux » §A : identité d'un MÊME
 * fait économique (achat) représenté par plusieurs sources — prix de la fiche
 * du bien ou de l'équipement, justificatif, événement de référence consolidé
 * par T3, composante financière. PUR (aucun accès base, aucun import serveur :
 * consommé par `computeTco` et par `fact-identity`, tous deux utilisables côté
 * client).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE RACINE CORRIGÉE
 *
 * Jusqu'au lot 107, le rapprochement « prix de la fiche ↔ facture d'achat »,
 * « prix de la fiche ↔ achat consolidé » et « prix de l'équipement ↔ sa
 * facture / son achat » exigeait le MÊME JOUR (`sameDay`) dès qu'aucune
 * preuve T1 du prix n'existait : une facture datée de la veille de la date
 * d'achat saisie (date de pièce ≠ date d'achat) devenait un SECOND achat
 * (« accessoire »), et le TCO comptait deux fois le même coût. De même, T3
 * fonde l'empreinte d'une composante sans référence sur sa date exacte : la
 * donnée de la fiche (date d'achat) et la facture (date de pièce) d'un même
 * achat, réunies dans le même événement de référence, y forment deux
 * composantes que le TCO additionnait (`fact-identity`).
 *
 * RÈGLE (faisceau de preuves, aucune exception par fournisseur, montant,
 * date ou intervalle propre à un exemple) :
 *   conditions NÉCESSAIRES   même montant en euros (exact) ; même objet
 *                            (bien, ou équipement — jamais l'un pour l'autre) ;
 *   contradictions → DISTINCT références de facture disjointes ; fournisseurs
 *                            connus et incompatibles ; dates éloignées au-delà
 *                            de la fenêtre d'une transaction d'achat ;
 *   identité CONFIRMÉE → SAME référence de facture commune ; OU dates proches
 *                            (≤ `sameFactDays`) ET (cible explicite des deux
 *                            côtés OU même fournisseur) ; OU même fournisseur
 *                            ET cible explicite des deux côtés ET dates dans
 *                            la fenêtre d'achat ;
 *   doute réel → UNCERTAIN   même montant sans date comparable, ou dates
 *                            proches sans autre corroboration : la dépense
 *                            reste comptée, l'ambiguïté est signalée
 *                            (arbitrage de l'utilisateur seulement) ;
 *   sinon → DISTINCT         deux achats de même montant restent deux coûts.
 * Le montant, le fournisseur, l'intitulé ou la proximité de dates ne suffisent
 * JAMAIS seuls.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { normalizeSupplier } from '../finance/economic-lines';

/**
 * Paramètres CENTRALISÉS du rapprochement (alignés sur l'identité économique
 * de T3, `consolidation/economic-identity.ts` : `SAME_DATE_DAYS` et
 * `transactionWindowDays('ACQUISITION')` — égalité vérifiée par test
 * L108A-U-PARAM ; recopiés ici pour garder ce module pur et client).
 */
export const TCO_FACT_MATCHING = {
  /** Écart (jours) en deçà duquel deux dates désignent le même achat (date de pièce, de livraison, de saisie). */
  sameFactDays: 7,
  /** Fenêtre d'une transaction d'achat (jours) : au-delà, deux dates ne décrivent jamais le même achat. */
  purchaseWindowDays: 180,
  /** Longueur minimale d'une clé de fournisseur pour qu'une inclusion vaille concordance (« LIBRAIRIE X » ⊂ « LIBRAIRIE X PARIS »). */
  supplierContainmentMinLength: 4,
} as const;

/** Ce qu'une source dit de l'achat (pure, normalisée par l'appelant). */
export interface PurchaseFact {
  /** Montant en centimes d'euro (null : non convertible — jamais rapproché). */
  eurCents: number | null;
  /** Date du fait (achat, pièce, réalisation), ISO ; null : inconnue. */
  date: string | null;
  /** Fournisseur (brut ou clé) ; null : inconnu. */
  supplier: string | null;
  /**
   * Le fournisseur n'est qu'un INDICE positif (lieu d'achat saisi sur la
   * fiche : peut être une ville) — jamais une contradiction.
   */
  supplierHintOnly?: boolean;
  /**
   * La source désigne explicitement CET objet comme ce qui est acheté :
   * donnée de la fiche, cible T1 d'un indice d'achat, composante ciblant le
   * bien, justificatif rattaché à ce seul bien sans autre cible.
   */
  explicitTarget: boolean;
  /** Références de facture normalisées. */
  invoiceRefs?: readonly string[];
  /** Le fait concerne un ÉQUIPEMENT (jamais l'achat du bien lui-même). */
  equipment: boolean;
}

export type SameFactVerdict = 'SAME' | 'UNCERTAIN' | 'DISTINCT';

export interface SameFactAssessment {
  verdict: SameFactVerdict;
  /** Codes stables (`+DATE_CLOSE`, `-DATE_APART`, `!OBJECT_DIFFERENT`…) — diagnostic BO. */
  signals: string[];
  /** Écart de dates en jours (null : non comparable). */
  daysApart: number | null;
}

const JOUR = 86_400_000;
const iso = (d: string | null | undefined): string | null => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/** Écart en jours entre deux dates ISO (null : l'une est inconnue ou invalide). */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const [x, y] = [iso(a), iso(b)];
  if (!x || !y) return null;
  const [t, u] = [Date.parse(`${x}T00:00:00Z`), Date.parse(`${y}T00:00:00Z`)];
  return Number.isNaN(t) || Number.isNaN(u) ? null : Math.round(Math.abs(t - u) / JOUR);
}

/**
 * Dates compatibles avec un même achat quand les AUTRES preuves d'identité
 * sont déjà établies (rattachement à l'équipement + nature + montant) :
 * inconnues, ou proches (≤ `sameFactDays`). Remplace l'exigence du même jour.
 */
export function purchaseDatesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const d = daysBetween(a, b);
  return d === null || d <= TCO_FACT_MATCHING.sameFactDays;
}

const cle = (s: string | null | undefined): string | null => normalizeSupplier(s);

/** Concordance de fournisseurs : SAME, DIFFERENT, ou null (non comparable). */
function compareSuppliers(a: PurchaseFact, b: PurchaseFact): 'SAME' | 'DIFFERENT' | null {
  const [x, y] = [cle(a.supplier), cle(b.supplier)];
  if (!x || !y) return null;
  if (x === y) return 'SAME';
  const [court, long] = x.length <= y.length ? [x, y] : [y, x];
  if (court.length >= TCO_FACT_MATCHING.supplierContainmentMinLength && long.includes(court)) return 'SAME';
  return 'DIFFERENT';
}

/**
 * Deux représentations décrivent-elles le MÊME achat ? (pure, symétrique)
 * Voir la règle en tête de module.
 */
export function assessSamePurchase(a: PurchaseFact, b: PurchaseFact): SameFactAssessment {
  const signals: string[] = [];
  const daysApart = daysBetween(a.date, b.date);
  const out = (verdict: SameFactVerdict): SameFactAssessment => ({ verdict, signals, daysApart });
  if (a.eurCents == null || b.eurCents == null) { signals.push('!AMOUNT_UNKNOWN'); return out('DISTINCT'); }
  if (a.eurCents !== b.eurCents) { signals.push('!AMOUNT_DIFFERENT'); return out('DISTINCT'); }
  signals.push('+AMOUNT_EQUAL');
  if (a.equipment !== b.equipment) { signals.push('!OBJECT_DIFFERENT'); return out('DISTINCT'); }

  const [ra, rb] = [a.invoiceRefs ?? [], b.invoiceRefs ?? []];
  if (ra.length && rb.length) {
    if (ra.some((r) => rb.includes(r))) { signals.push('+SHARED_REFERENCE'); return out('SAME'); }
    signals.push('-REFERENCE_DIFFERENT');
    return out('DISTINCT');
  }

  const fournisseurs = compareSuppliers(a, b);
  if (fournisseurs === 'SAME') signals.push('+SUPPLIER_SAME');
  else if (fournisseurs === 'DIFFERENT') {
    if (!a.supplierHintOnly && !b.supplierHintOnly) { signals.push('-SUPPLIER_DIFFERENT'); return out('DISTINCT'); }
    signals.push('~SUPPLIER_HINT_UNMATCHED');
  }

  const explicites = a.explicitTarget && b.explicitTarget;
  if (explicites) signals.push('+TARGET_EXPLICIT');

  if (daysApart === null) { signals.push('~DATE_UNKNOWN'); return out('UNCERTAIN'); }
  if (daysApart > TCO_FACT_MATCHING.purchaseWindowDays) { signals.push('-DATE_APART'); return out('DISTINCT'); }
  if (daysApart <= TCO_FACT_MATCHING.sameFactDays) {
    signals.push('+DATE_CLOSE');
    return out(explicites || fournisseurs === 'SAME' ? 'SAME' : 'UNCERTAIN');
  }
  signals.push('~DATE_WITHIN_WINDOW');
  if (fournisseurs === 'SAME' && explicites) return out('SAME');
  // Dates éloignées sans corroboration : deux achats de même montant restent deux coûts (aucune fusion sans preuve).
  return out('DISTINCT');
}

/**
 * Parmi plusieurs représentations candidates d'un même achat établi, la seule
 * qui l'absorbe (identité confirmée la plus proche en date, puis le plus petit
 * identifiant) : les autres confirmées deviennent INCERTAINES — un achat n'est
 * jamais absorbé deux fois (pure).
 */
export function pickSameFact<T>(candidates: ReadonlyArray<{ item: T; assessment: SameFactAssessment; order: number }>): { kept: T | null; demoted: T[] } {
  const memes = candidates.filter((c) => c.assessment.verdict === 'SAME')
    .sort((x, y) => (x.assessment.daysApart ?? 0) - (y.assessment.daysApart ?? 0) || x.order - y.order);
  return { kept: memes[0]?.item ?? null, demoted: memes.slice(1).map((c) => c.item) };
}
