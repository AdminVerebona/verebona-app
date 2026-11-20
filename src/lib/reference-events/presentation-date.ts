/**
 * Carte #744, point F (« Dates, finances et protections », CDC « Opérations /
 * Agenda V2.0 » §11 ; AC32, AC33, AC35) — DATE DE PRÉSENTATION d'un événement
 * de référence. PUR (aucune dépendance serveur) : partagé par la Timeline du
 * bien, la page, la recherche, les exports et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE RÈGLE, DEUX LECTURES DE LA MÊME TABLE
 *
 * La date de présentation est un REPÈRE explicable, fondé sur le fait le plus
 * représentatif ATTESTÉ. Elle ne remplace jamais la date d'un événement de
 * l'Agenda, n'est jamais stockée, ne crée ni rappel ni événement, et n'est
 * jamais la date d'un événement de l'Agenda, ni un horodatage système.
 *
 * `PRESENTATION_DATE_RULES` dit, pour chaque type, QUELS FAITS sont examinés
 * et DANS QUEL ORDRE ; le premier fait daté donne le repère et son fondement
 * (`basis`). Sans fait daté : `null` — l'événement de référence est « Sans
 * date » (jamais une date inventée).
 *
 *   · INTERVENTION : réalisation attestée ; à défaut, PREMIÈRE date fiable de
 *     devis (un devis ultérieur ou une visite ne déplacent pas le repère :
 *     c'est le plus ancien devis qui compte ; aucun devis « retenu ») ; à
 *     défaut, date prévue de l'intervention ;
 *   · CONTRAT : début initial fiable ; à défaut, première couverture connue —
 *     comme REPÈRE seulement : elle n'est jamais écrite comme prise d'effet ;
 *   · ACQUISITION : date réelle de l'achat (réalisation) ; à défaut (carte
 *     #813), DATE DE COMMANDE — date du premier bon de commande source, datée
 *     et sourcée par ce justificatif. C'est un REPÈRE seulement : elle n'est
 *     jamais écrite comme date de réalisation, de paiement ou de livraison,
 *     ni comme date d'acquisition du bien, et ne crée aucun événement ;
 *   · autres types et type non qualifié : fait métier propre (réalisation,
 *     sinon début, sinon date prévue).
 *
 * Cette table est lue par `presentationDateOf` (TypeScript) ET par
 * `presentationDateSql` (expression SQL engendrée, pour trier et paginer la
 * Timeline) : il n'existe pas deux règles. L'égalité des deux lectures est
 * prouvée sur PostgreSQL réel (scénario L114OF).
 *
 * Une date de réalisation CONTESTÉE (sources contradictoires tracées par T3)
 * n'est pas « fiable » : l'appelant ne la fournit pas (`realizedDate: null`).
 *
 * Textes et ordre des faits hors CDC : « à valider par le PO » (fiche de
 * recette 114O, section « Dates, finances, exports »).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Faits datés qui peuvent fonder le repère. */
export const PRESENTATION_DATE_BASES = ['REALIZED', 'FIRST_QUOTE', 'START', 'FIRST_COVERAGE', 'PLANNED', 'FIRST_ORDER'] as const;
export type PresentationDateBasis = (typeof PRESENTATION_DATE_BASES)[number];

/** Types pour lesquels le CDC §11 (ou cette carte) fixe un ordre propre ; les autres suivent `DEFAULT`. */
type PresentationRuleKey = 'INTERVENTION' | 'CONTRACT' | 'ACQUISITION' | 'DEFAULT';

/**
 * LA règle (CDC §11). Ordre = priorité. Modifier une ligne ici change à la
 * fois le calcul TypeScript et l'expression SQL de la Timeline.
 */
export const PRESENTATION_DATE_RULES: Readonly<Record<PresentationRuleKey, readonly PresentationDateBasis[]>> = {
  INTERVENTION: ['REALIZED', 'FIRST_QUOTE', 'PLANNED'],
  CONTRACT: ['START', 'FIRST_COVERAGE'],
  ACQUISITION: ['REALIZED', 'FIRST_ORDER'],
  DEFAULT: ['REALIZED', 'START', 'PLANNED'],
};

const SPECIFIC_RULE_KEYS = (Object.keys(PRESENTATION_DATE_RULES) as PresentationRuleKey[]).filter((k) => k !== 'DEFAULT');

/** Ordre des faits pour un type (type inconnu, autre ou non qualifié : `DEFAULT`). */
export function presentationRuleOf(typeCode: string | null | undefined): readonly PresentationDateBasis[] {
  const k = SPECIFIC_RULE_KEYS.find((x) => x === typeCode);
  return PRESENTATION_DATE_RULES[k ?? 'DEFAULT'];
}

/** Faits datés d'un événement de référence (AAAA-MM-JJ ou null), tels que lus en base. */
export interface PresentationDateFacts {
  typeCode: string | null;
  /** Réalisation attestée ; null si absente OU contestée (non fiable). */
  realizedDate: string | null;
  /** Date la plus ancienne des devis (justificatifs sources de rôle « devis », datés). */
  firstQuoteDate: string | null;
  /** Début propre (contrat, financement : prise d'effet initiale). */
  startDate: string | null;
  /** Début le plus ancien des périodes de couverture connues de ses justificatifs. */
  firstCoverageStart: string | null;
  /** Date prévue. */
  plannedDate: string | null;
  /**
   * Carte #813 : date de COMMANDE — date la plus ancienne des bons de commande (justificatifs sources de
   * rôle « commande », ou classés bon de commande au référentiel, datés). Absente (appelant antérieur) : aucune.
   */
  firstOrderDate?: string | null;
}

/** Repère rendu : date et fondement, ou « sans date ». */
export type PresentationDate =
  | { date: string; basis: PresentationDateBasis }
  | { date: null; basis: null };

export const UNDATED_PRESENTATION: PresentationDate = { date: null, basis: null };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `AAAA-MM-JJ…` valide → `AAAA-MM-JJ` ; toute autre valeur : null (jamais une date fabriquée). */
export function presentationDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.slice(0, 10);
  if (!ISO_DAY.test(d)) return null;
  // Jour réel du calendrier seulement (« 2024-02-31 » n'est pas une date) : aller-retour strict.
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d ? d : null;
}

const FACT_OF: Readonly<Record<PresentationDateBasis, (f: PresentationDateFacts) => string | null>> = {
  REALIZED: (f) => f.realizedDate,
  FIRST_QUOTE: (f) => f.firstQuoteDate,
  START: (f) => f.startDate,
  FIRST_COVERAGE: (f) => f.firstCoverageStart,
  PLANNED: (f) => f.plannedDate,
  FIRST_ORDER: (f) => f.firstOrderDate ?? null,
};

/** Date de présentation d'un événement de référence (pure ; ne dépend pas de la date du jour). */
export function presentationDateOf(facts: PresentationDateFacts): PresentationDate {
  for (const basis of presentationRuleOf(facts.typeCode)) {
    const date = presentationDay(FACT_OF[basis](facts));
    if (date) return { date, basis };
  }
  return UNDATED_PRESENTATION;
}

/** Fondement lu en base (colonne texte) → fondement typé ; valeur inconnue : null. */
export function presentationBasisOf(v: unknown): PresentationDateBasis | null {
  return (PRESENTATION_DATE_BASES as readonly unknown[]).includes(v) ? (v as PresentationDateBasis) : null;
}

/**
 * MÊME règle, en SQL : expressions `date` (type date) et `basis` (texte)
 * engendrées depuis `PRESENTATION_DATE_RULES`. `type` : expression SQL du
 * type ; `facts` : expression SQL (type date, NULL si absent) de chaque fait.
 * Les noms de types et de fondements viennent des constantes de ce module
 * (aucune valeur d'utilisateur n'entre dans le SQL).
 */
export function presentationDateSql(type: string, facts: Readonly<Record<PresentationDateBasis, string>>): { date: string; basis: string } {
  const dateOf = (rule: readonly PresentationDateBasis[]) =>
    (rule.length === 1 ? facts[rule[0]] : `COALESCE(${rule.map((b) => facts[b]).join(', ')})`);
  const basisOf = (rule: readonly PresentationDateBasis[]) =>
    `CASE ${rule.map((b) => `WHEN ${facts[b]} IS NOT NULL THEN '${b}'`).join(' ')} END`;
  const cas = (f: (rule: readonly PresentationDateBasis[]) => string) =>
    `CASE ${SPECIFIC_RULE_KEYS.map((k) => `WHEN ${type} = '${k}' THEN ${f(PRESENTATION_DATE_RULES[k])}`).join(' ')} ELSE ${f(PRESENTATION_DATE_RULES.DEFAULT)} END`;
  return { date: cas(dateOf), basis: cas(basisOf) };
}

/**
 * Libellé du fondement, pour dire D'OÙ vient le repère quand il ne vient pas
 * d'une date propre déjà affichée (à valider par le PO). `null` : le repère
 * est une date propre, déjà nommée par son rôle sur la page.
 */
export const PRESENTATION_BASIS_LABELS: Readonly<Record<PresentationDateBasis, string | null>> = {
  REALIZED: null,
  START: null,
  PLANNED: null,
  FIRST_QUOTE: 'Premier devis',
  FIRST_COVERAGE: 'Première couverture connue',
  // Carte #813 (C) : la date du bon de commande est la date de COMMANDE (à valider par le PO).
  FIRST_ORDER: 'Date de commande',
};
