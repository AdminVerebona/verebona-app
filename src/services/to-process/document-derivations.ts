/**
 * Lot 61 — ticket « [P1] À traiter — Fiabiliser la pertinence des cartes et
 * résoudre automatiquement les informations déductibles », étape A
 * (« recherche de résolution automatique »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CALCULS DÉTERMINISTES — DÉCLARÉS PAR DONNÉE, JAMAIS PAR TYPE DE DOCUMENT
 *
 * Cas constaté : deux prêts immobiliers recevaient « Quelle est la date de
 * fin de ce contrat ? » alors que la date de début et la durée permettaient
 * de la calculer. Le défaut n'est pas propre aux prêts : toute échéance qui
 * se déduit d'un début EFFECTIF et d'une DURÉE se calcule.
 *
 *   `DERIVATIONS` déclare, pour une donnée du pont (fin de contrat, fin de
 *   garantie), les données qui la fondent : clés du registre canonique (et
 *   leurs alias) et libellés lus dans le document (« Date d'effet », « Durée
 *   du prêt »). Aucune règle par type de document, aucune règle « prêt ».
 *
 * CE QUI EST PROTÉGÉ
 *   · le début doit être un début EFFECTIF : jamais la date d'édition,
 *     d'émission, de signature ou la date du document (ces clés et libellés
 *     ne figurent pas parmi les sources, et un libellé qui les mentionne est
 *     explicitement écarté) ;
 *   · la valeur calculée est une échéance THÉORIQUE : `value_kind =
 *     CALCULATED`, provenance complète (`derivation`), jamais présentée
 *     comme contractuelle, jamais écrite par-dessus une valeur de
 *     l'utilisateur, recalculée ou retirée quand ses sources changent ;
 *   · seules des sources FIABLES (faits certains, une seule valeur) donnent
 *     une écriture ; sinon le calcul n'est qu'un candidat (pertinence
 *     temporelle), jamais écrit ;
 *   · convention : fin = début + durée − 1 jour (un contrat de 12 mois
 *     commencé le 01/01 finit le 31/12), tracée dans la provenance ;
 *     lot 72 (C1) : une disposition lue (« de date à date », « fin de mois »)
 *     la remplace, des dispositions contradictoires interdisent le calcul ;
 *   · lot 72 (C1) : durée analysée par rôle (`analyzeDuration`) — totale,
 *     incluse, renouvellement, prolongation, différé, condition — jamais une
 *     somme aveugle ; un calcul ambigu n'est JAMAIS « CALCULATED_RELIABLE ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { gatherFieldEvidence, type EvidenceFact, type FieldEvidence } from './document-field-evidence';

export interface DerivationSpec {
  /** Donnée calculée (clé du pont). */
  target: string;
  /** Début effectif : clé du registre (date), alias compris, et libellés lus. */
  start: { key: string; keys: readonly string[]; labels: readonly string[] };
  /** Durée : clés et libellés lus (valeur « 240 mois », « 20 ans », « 36 »…). */
  duration: { key: string; keys: readonly string[]; labels: readonly string[] };
}

/**
 * Données calculables. Une ligne par DONNÉE ; ajouter une échéance
 * calculable = ajouter une ligne (aucun code).
 */
export const DERIVATIONS: readonly DerivationSpec[] = [
  {
    target: 'contractEndDate',
    start: {
      key: 'contractStartDate',
      keys: ['contractStartDate', 'dateDebutContrat', 'effectiveDate', 'dateEffet', 'datePriseEffet', 'loanStartDate', 'dateDebutPret', 'dateDebutCredit'],
      labels: ['date d effet', 'prise d effet', 'date de debut', 'debut du contrat', 'debut de contrat', 'debut du pret', 'debut du credit', 'date de depart', 'entree en vigueur'],
    },
    duration: {
      key: 'contractDurationMonths',
      keys: ['contractDurationMonths', 'contractDuration', 'dureeContrat', 'dureeContratMois', 'leaseDurationMonths', 'dureeMois', 'loanDuration',
        'loanDurationMonths', 'loanTerm', 'loanTermMonths', 'dureePret', 'dureeCredit', 'creditDuration', 'dureeEngagement', 'engagementDuration'],
      labels: ['duree du contrat', 'duree de contrat', 'duree du pret', 'duree du credit', 'duree d engagement', 'duree de l engagement', 'duree de remboursement', 'duree totale'],
    },
  },
  {
    target: 'warrantyEndDate',
    start: {
      key: 'warrantyStartDate',
      keys: ['warrantyStartDate', 'debutGarantie', 'dateDebutGarantie'],
      labels: ['debut de garantie', 'debut de la garantie', 'garantie a compter du', 'date de debut de garantie'],
    },
    duration: {
      key: 'warrantyDurationMonths',
      keys: ['warrantyDurationMonths', 'warrantyDuration', 'dureeGarantie', 'dureeGarantieMois'],
      labels: ['duree de garantie', 'duree de la garantie'],
    },
  },
];

/**
 * Libellés qui désignent une date d'édition, de document, de signature ou
 * de première échéance — jamais un début effectif (lot 72, C1 : ne jamais
 * confondre date d'édition, de signature, d'effet et de première échéance).
 */
const NOT_A_START = ['edition', 'emission', 'signature', 'signe', 'document', 'facture', 'impression', 'courrier', 'envoi', 'offre',
  'echeance', 'prelevement', 'paiement', 'acceptation', 'redaction'];

/** Clés lues qui désignent une date d'édition / de document / de signature (pure, insensible à la casse). */
const NON_START_KEY = /document|edition|emission|issue|signature|signed|signe|facture|invoice|courrier|redaction|acceptation|offre|offer/i;

export function derivationFor(target: string): DerivationSpec | null {
  return DERIVATIONS.find((d) => d.target === target) ?? null;
}

const norm = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Le libellé lu désigne-t-il un début effectif (et pas une date d'édition) ? Pure. */
export function labelIsEffectiveStart(label: string, spec: DerivationSpec): boolean {
  const l = ` ${norm(label)} `;
  if (NOT_A_START.some((w) => l.includes(` ${w} `))) return false;
  return spec.start.labels.some((x) => l.includes(` ${x} `));
}

/**
 * Lot 72 (C1) — le libellé ou la clause d'un fait de DÉBUT le désigne-t-il
 * comme une date qui n'est PAS un début effectif (édition, signature,
 * première échéance…) ? Une clé canonique « date de début » ne suffit pas :
 * T1 peut l'avoir posée sur une date d'édition. Pure.
 */
export function startFactIsNotEffective(f: Pick<EvidenceFact, 'label' | 'excerpt'>, spec: DerivationSpec): boolean {
  for (const t of [f.label, f.excerpt]) {
    if (!t) continue;
    const l = ` ${norm(t)} `;
    const effectif = spec.start.labels.some((x) => l.includes(` ${x} `));
    if (!effectif && NOT_A_START.some((w) => l.includes(` ${w} `))) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 72 (C1) — ANALYSE D'UNE DURÉE : TOTALE, INCLUSE, RENOUVELLEMENT,
// PROLONGATION, DIFFÉRÉ, CONDITION — sans jamais additionner à l'aveugle.
//
// Cause du défaut : `parseDurationMonths` additionnait toutes les durées lues
// (« 240 mois, dont 12 mois de différé » → 252 ; « 12 mois renouvelables
// pour 12 mois » → 24). Désormais chaque quantité reçoit un RÔLE d'après le
// texte qui l'entoure (vocabulaire générique du français contractuel, aucune
// règle propre à un type de contrat) :
//   · « 2 ans et 6 mois »                    → une seule quantité (30 mois) ;
//   · « 240 mois, dont 12 mois de différé »  → total 240, part incluse 12 ;
//   · « 12 mois renouvelables pour 12 mois » → durée INITIALE 12, renouvelable :
//     l'échéance réelle dépend de la reconduction → jamais fiable ;
//   · « 36 ou 48 mois », « 12 mois puis 24 mois », différé non inclus,
//     départ conditionnel (« à compter de la livraison »), « au moins »… →
//     AMBIGUË : aucun calcul automatique.
// ══════════════════════════════════════════════════════════════════════════

export type DurationRole = 'TOTAL' | 'PRIMARY' | 'INCLUDED' | 'RENEWAL' | 'EXTENSION' | 'DEFERRAL' | 'NOTICE' | 'ALTERNATIVE' | 'RESTATED';
export type DurationStatus = 'SIMPLE' | 'TOTAL_WITH_INCLUDED' | 'INITIAL_TERM_RENEWABLE' | 'INITIAL_TERM_EXTENSIBLE' | 'AMBIGUOUS' | 'REFUSED';
export type EndConvention = 'END_INCLUSIVE' | 'ANNIVERSARY' | 'END_OF_MONTH';

export interface DurationAnalysis {
  /** Durée applicable en mois (durée totale, ou durée initiale), sinon null. */
  months: number | null;
  /** Calcul automatique FIABLE autorisé (durée totale identifiée sans ambiguïté). */
  reliable: boolean;
  status: DurationStatus;
  parts: Array<{ months: number; role: DurationRole }>;
  reason: string;
  /** Convention de fin lue dans la clause (null : aucune disposition lue). */
  convention: EndConvention | null;
  /** Conventions contradictoires lues. */
  conventionConflict: boolean;
}

const LETTRES: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, douze: 12 };
const UNITE_AN = /^(ans|an|annees|annee|years|year)$/;
const RE_QUANTITE = /(\d{1,4})\s*(ans|an|annees|annee|years|year|mois|months|month)\b/g;
const has = (t: string, re: RegExp) => re.test(` ${t} `);
const RE_INCLUS_AVANT = /\b(dont|y compris|incluant|comprenant)\b/;
const RE_INCLUS_APRES = /^\s*(\w+\s){0,4}?(inclus|incluse|inclus dans|compris|comprise)\b/;
const RE_RENOUVELLEMENT = /\b(renouvel\w*|reconduct\w*|reconduit\w*|reconductible\w*|tacite\w*)\b/;
const RE_PROLONGATION = /\b(prolong\w*|prorog\w*|extension\w*|etendu\w*|optionnel\w*|option)\b/;
const RE_DIFFERE = /\b(differe\w*|franchise|carence|anticipation)\b/;
const RE_PREAVIS = /\b(preavis|resiliation|resilier|delai de retractation|retractation)\b/;
const RE_ALTERNATIVE = /\b(ou)\b/;
const RE_SEQUENCE = /\b(puis|suivi\w*|ensuite|plus|augmente\w*|majore\w*|apres)\b|\+/;
const RE_TOTAL = /\b(duree totale|au total|en tout|total)\b/;
const RE_REFORMULATION = /\b(soit|c est a dire|equivalent)\b/;
const RE_IMPRECIS = /\b(au moins|minimum|minimale|maximum|maximale|au plus|jusqu a|environ|ou plus|a partir de|des que|sous reserve|si|sauf si|selon|en fonction)\b/;
/** Point de départ conditionnel : « à compter de la livraison » (≠ date d'effet / de début). */
const RE_DEPART = /\b(a compter|a partir|des)\s+(du|de la|de l|de|des)\s+([a-z ]{3,40})/;
const RE_DEPART_EFFECTIF = /\b(effet|prise d effet|date de debut|debut du contrat|debut de contrat|entree en vigueur|date de depart|signature du present|present contrat)\b/;
const RE_ANNIVERSAIRE = /\b(date anniversaire|de date a date|a la date anniversaire|meme quantieme)\b/;
const RE_FIN_DE_MOIS = /\b(fin de mois|dernier jour du mois|fin du mois)\b/;
const RE_REFUS = /\b(indetermine\w*|illimite\w*|jours?|semaines?|days?|weeks?|trimestres?|semestres?|viager\w*)\b/;

/**
 * Analyse d'une durée lue (pure). `keyHint` : clé lue (« dureeMois » → un
 * nombre seul vaut des mois). Ne lève jamais.
 */
export function analyzeDuration(raw: unknown, keyHint?: string | null): DurationAnalysis {
  const refus = (reason: string, status: DurationStatus = 'REFUSED'): DurationAnalysis =>
    ({ months: null, reliable: false, status, parts: [], reason, convention: null, conventionConflict: false });
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 && raw <= 1200 && /mois|months/i.test(keyHint ?? '')
      ? { months: raw, reliable: true, status: 'SIMPLE', parts: [{ months: raw, role: 'PRIMARY' }], reason: 'numeric_months', convention: null, conventionConflict: false }
      : refus('numeric_without_unit');
  }
  if (typeof raw !== 'string') return refus('not_a_duration');
  // Nombres en lettres usuels (« un an », « deux ans ») ramenés en chiffres.
  const s = norm(raw).replace(/\b(un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|douze)\s+(ans?|annees?|mois)\b/g,
    (_m, n: string, u: string) => `${LETTRES[n]} ${u}`);
  if (!s) return refus('empty');
  if (has(s, /\b(indetermine\w*|illimite\w*|viager\w*)\b/)) return refus('open_ended', 'AMBIGUOUS');
  const conventions = new Set<EndConvention>();
  if (has(s, RE_ANNIVERSAIRE)) conventions.add('ANNIVERSARY');
  if (has(s, RE_FIN_DE_MOIS)) conventions.add('END_OF_MONTH');
  const convention = conventions.size === 1 ? [...conventions][0] : null;
  const conventionConflict = conventions.size > 1;

  // ── Quantités, regroupées quand elles se suivent (« 2 ans et 6 mois ») ──
  const brutes = [...s.matchAll(RE_QUANTITE)].map((m) => ({
    months: UNITE_AN.test(m[2]) ? Number(m[1]) * 12 : Number(m[1]), an: UNITE_AN.test(m[2]), start: m.index!, end: m.index! + m[0].length,
  }));
  if (brutes.length === 0) {
    if (/^\d{1,4}$/.test(s) && /mois|months/i.test(keyHint ?? '')) {
      const n = Number(s);
      return n > 0 && n <= 1200
        ? { months: n, reliable: true, status: 'SIMPLE', parts: [{ months: n, role: 'PRIMARY' }], reason: 'numeric_months', convention, conventionConflict }
        : refus('out_of_range');
    }
    return refus(has(s, RE_REFUS) ? 'unsupported_unit' : 'no_duration');
  }
  const quantites: Array<{ months: number; start: number; end: number }> = [];
  for (const b of brutes) {
    const prev = quantites.at(-1);
    const entre = prev ? s.slice(prev.end, b.start) : null;
    // « 2 ans et 6 mois » / « 2 ans 6 mois » : une seule durée (années puis mois).
    if (prev && entre !== null && /^\s*(et\s*)?$/.test(entre) && brutes.find((x) => x.end === prev.end)?.an && !b.an) {
      prev.months += b.months; prev.end = b.end; continue;
    }
    quantites.push({ months: b.months, start: b.start, end: b.end });
  }
  if (quantites.some((q) => q.months <= 0 || q.months > 1200)) return refus('out_of_range');
  // Unité non gérée À CÔTÉ d'une durée (« 12 mois et 15 jours ») : refus.
  if (has(s, RE_REFUS) && !has(s, /\b(indetermine\w*|illimite\w*)\b/) && /\d\s*(jours?|semaines?|days?|weeks?|trimestres?|semestres?)\b/.test(s)) return refus('unsupported_unit');

  // ── Rôle de chaque quantité, d'après le texte qui l'entoure ─────────────
  const roles: DurationRole[] = quantites.map((q, i) => {
    const avant = s.slice(i === 0 ? 0 : quantites[i - 1].end, q.start);
    const apres = s.slice(q.end, i + 1 < quantites.length ? quantites[i + 1].start : s.length);
    // Voisinage immédiat (la ponctuation est retirée par la normalisation).
    if (i > 0 && has(avant, RE_INCLUS_AVANT)) return 'INCLUDED';
    if (RE_INCLUS_APRES.test(apres)) return 'INCLUDED';
    if (has(avant, RE_TOTAL) || has(apres.slice(0, 20), /\b(au total|en tout)\b/)) return 'TOTAL';
    if (i > 0 && has(avant, RE_REFORMULATION)) return 'RESTATED';
    if (i > 0 && has(avant, RE_RENOUVELLEMENT)) return 'RENEWAL';
    if (i > 0 && has(avant, RE_PROLONGATION)) return 'EXTENSION';
    // Préavis / différé : rôle porté par le texte QUI PRÉCÈDE (« préavis de 2 mois »)
    // ou qui suit immédiatement (« 12 mois de différé »).
    if (has(avant.slice(-24), RE_PREAVIS) || /^\s*(de\s+|d\s+)?(preavis)\b/.test(apres)) return 'NOTICE';
    if (has(avant.slice(-24), RE_DIFFERE) || /^\s*(de\s+|d\s+)?(differe\w*|franchise|carence)\b/.test(apres)) return 'DEFERRAL';
    if (i > 0 && has(avant, RE_ALTERNATIVE)) return 'ALTERNATIVE';
    return 'PRIMARY';
  });
  const parts = quantites.map((q, i) => ({ months: q.months, role: roles[i] }));
  const ambigu = (reason: string): DurationAnalysis => ({ months: null, reliable: false, status: 'AMBIGUOUS', parts, reason, convention, conventionConflict });

  // « 36 ou 48 mois », « de 12 à 24 mois » : la première valeur n'a pas d'unité propre.
  if (roles.includes('ALTERNATIVE') || /\b\d{1,4}\s+(ou|a)\s+\d{1,4}\s*(ans|an|annees|annee|mois|years|year|months|month)\b/.test(s)) return ambigu('alternative_durations');
  const totaux = parts.filter((p) => p.role === 'TOTAL');
  const primaires = parts.filter((p) => p.role === 'PRIMARY');
  if (totaux.length > 1 && new Set(totaux.map((t) => t.months)).size > 1) return ambigu('several_totals');
  const total = totaux[0] ?? (primaires.length ? primaires[0] : null);
  if (!total) return ambigu('no_applicable_duration');
  // Plusieurs durées principales distinctes : addition ou alternative ? Jamais présumé.
  const autresPrimaires = primaires.filter((p) => p !== total);
  if (autresPrimaires.length) {
    const entre = s.slice(quantites[0].end, quantites.at(-1)!.start);
    return ambigu(has(entre, RE_SEQUENCE) ? 'sequential_durations' : 'several_durations');
  }
  for (const r of parts.filter((p) => p.role === 'RESTATED')) if (r.months !== total.months) return ambigu('restated_duration_differs');
  for (const inc of parts.filter((p) => p.role === 'INCLUDED')) if (inc.months > total.months) return ambigu('included_part_exceeds_total');
  // Différé NON déclaré inclus : en plus de la durée, ou compris ? Jamais présumé.
  if (parts.some((p) => p.role === 'DEFERRAL')) return ambigu('deferral_not_declared_included');

  // Départ conditionnel (livraison, réception, mise en service…) : point de départ inconnu.
  const depart = RE_DEPART.exec(s);
  if (depart && !has(depart[0], RE_DEPART_EFFECTIF)) return ambigu('conditional_start');
  if (has(s, RE_IMPRECIS)) return ambigu('imprecise_duration');

  const renouvelable = parts.some((p) => p.role === 'RENEWAL') || has(s, RE_RENOUVELLEMENT);
  const prolongeable = parts.some((p) => p.role === 'EXTENSION') || has(s, RE_PROLONGATION);
  if (renouvelable) {
    // Durée INITIALE seulement : l'échéance réelle dépend de la reconduction.
    return { months: total.months, reliable: false, status: 'INITIAL_TERM_RENEWABLE', parts, reason: 'renewable_initial_term', convention, conventionConflict };
  }
  if (prolongeable) {
    return { months: total.months, reliable: false, status: 'INITIAL_TERM_EXTENSIBLE', parts, reason: 'extensible_initial_term', convention, conventionConflict };
  }
  const inclus = parts.some((p) => p.role === 'INCLUDED' || p.role === 'NOTICE');
  return {
    months: total.months, reliable: !conventionConflict, status: inclus ? 'TOTAL_WITH_INCLUDED' : 'SIMPLE', parts,
    reason: conventionConflict ? 'conflicting_end_conventions' : inclus ? 'total_with_included_part' : 'single_duration', convention, conventionConflict,
  };
}

/**
 * Durée lue → nombre de mois FIABLE, sinon null (pure) : « 240 mois »,
 * « 20 ans », « 2 ans et 6 mois », « 240 mois dont 12 mois de différé »
 * (240), « 36 » si la clé dit « Mois ». Une durée renouvelable, composite
 * ambiguë, conditionnelle ou dans une autre unité → null (lot 72, C1).
 */
export function parseDurationMonths(raw: unknown, keyHint?: string | null): number | null {
  const a = analyzeDuration(raw, keyHint);
  return a.reliable ? a.months : null;
}

/**
 * Date de fin depuis un début et une durée, selon la convention (pure) :
 *   END_INCLUSIVE (défaut) : début + durée − 1 jour (12 mois du 01/01 → 31/12) ;
 *   ANNIVERSARY            : début + durée, même quantième (« de date à date ») ;
 *   END_OF_MONTH           : dernier jour du mois de (début + durée − 1 jour).
 */
export function endFromStart(startIso: string, months: number, convention: EndConvention = 'END_INCLUSIVE'): string | null {
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const totalM = (m - 1) + months;
  const ty = y + Math.floor(totalM / 12);
  const tm = totalM % 12;
  // Jour borné à la fin du mois cible (31/01 + 1 mois → 28/02).
  const dernier = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const anniversaire = Date.UTC(ty, tm, Math.min(d, dernier));
  let fin = new Date(convention === 'ANNIVERSARY' ? anniversaire : anniversaire - 86_400_000);
  if (convention === 'END_OF_MONTH') fin = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() + 1, 0));
  return Number.isNaN(fin.getTime()) ? null : fin.toISOString().slice(0, 10);
}

export interface DerivationSource { key: string | null; value: string; source: string; confidence: string }

export interface DerivationResult {
  /** CALCULATED_RELIABLE : écrite ; CALCULATED_PROBABLE : candidat seulement ; NOT_DERIVABLE / AMBIGUOUS. */
  status: 'CALCULATED_RELIABLE' | 'CALCULATED_PROBABLE' | 'NOT_DERIVABLE' | 'AMBIGUOUS';
  value: string | null;
  method: 'START_PLUS_DURATION';
  /** Convention de fin APPLIQUÉE (lot 72 : lue dans la clause, sinon « fin incluse » par défaut — hypothèse tracée). */
  convention: EndConvention;
  start: DerivationSource | null;
  duration: (DerivationSource & { months: number; status?: DurationStatus; parts?: DurationAnalysis['parts'] }) | null;
  reason: string;
  /** Lot 72 (C1) : hypothèses retenues (convention par défaut, durée initiale…). */
  assumptions?: string[];
}

const fiable = (f: EvidenceFact) => f.confidence === 'certain' && f.source === 'FACTS';

/** Options du calcul (lot 72) : dates du document qui ne sont PAS un début effectif. */
export interface DerivationOptions {
  /** Dates (ISO) d'édition, de signature, du document lues ailleurs dans le document. */
  nonStartDates?: readonly string[];
}

/**
 * Calcul de l'échéance depuis les connaissances lues (pure) : faits du début
 * effectif et de la durée. Lot 72 (C1) — `CALCULATED_RELIABLE` seulement si :
 *   · chaque source est un fait certain et unique ;
 *   · le début n'est désigné ni comme une date d'édition / signature /
 *     première échéance, ni égal à une telle date du document ;
 *   · la durée applicable est TOTALE et sans ambiguïté (`analyzeDuration`),
 *     aucune clause lue ne la contredit (renouvellement, condition…) ;
 *   · aucune convention de fin contradictoire n'est lue.
 * Sinon : CALCULATED_PROBABLE (candidat pour la pertinence, jamais écrit) ou
 * AMBIGUOUS (aucune valeur).
 */
export function computeDerivation(
  spec: DerivationSpec, start: EvidenceFact[], duration: EvidenceFact[],
  durationKeyHint: (f: EvidenceFact) => string | null = () => null, opts: DerivationOptions = {},
): DerivationResult {
  const base = { method: 'START_PLUS_DURATION' as const, convention: 'END_INCLUSIVE' as const };
  const debutsLus = start.filter((f) => typeof f.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.value));
  const debutsEffectifs = debutsLus.filter((f) => !startFactIsNotEffective(f, spec));
  const debuts = [...new Map(debutsEffectifs.map((f) => [String(f.value), f])).values()];
  const analyses = duration.map((f) => {
    const a = analyzeDuration(f.value, durationKeyHint(f));
    // La CLAUSE (extrait) peut révéler ce que la valeur seule tait : renouvellement, condition…
    const c = f.excerpt && f.excerpt !== f.value ? analyzeDuration(f.excerpt, durationKeyHint(f)) : null;
    return { f, a, c };
  });
  const lisibles = analyses.filter((x) => x.a.months !== null);
  const ambigues = analyses.filter((x) => x.a.status === 'AMBIGUOUS');
  const durees = [...new Map(lisibles.map((x) => [x.a.months, x])).values()];
  if (debuts.length === 0 || (durees.length === 0 && ambigues.length === 0)) {
    return { ...base, status: 'NOT_DERIVABLE', value: null, start: null, duration: null,
      reason: debuts.length === 0 ? (debutsLus.length ? 'start_is_not_effective' : 'no_effective_start') : 'no_duration' };
  }
  if (durees.length === 0) {
    return { ...base, status: 'AMBIGUOUS', value: null, start: null, duration: null, reason: `ambiguous_duration:${ambigues[0].a.reason}` };
  }
  if (debuts.length > 1 || durees.length > 1) {
    return { ...base, status: 'AMBIGUOUS', value: null, start: null, duration: null,
      reason: debuts.length > 1 ? 'several_start_dates' : 'several_durations' };
  }
  const s = debuts[0];
  const d = durees[0];
  const hypotheses: string[] = [];
  let surDuree = d.a.reliable;
  let motif = d.a.reason;
  if (d.c) {
    if (d.c.status === 'AMBIGUOUS' || d.c.status === 'INITIAL_TERM_RENEWABLE' || d.c.status === 'INITIAL_TERM_EXTENSIBLE') {
      surDuree = false; motif = `clause_${d.c.reason}`;
    } else if (d.c.months !== null && d.c.months !== d.a.months && d.c.status !== 'REFUSED') {
      surDuree = false; motif = 'clause_contradicts_value';
    }
  }
  const conventions = new Set([d.a.convention, d.c?.convention].filter((x): x is EndConvention => !!x));
  const conflit = conventions.size > 1 || d.a.conventionConflict || !!d.c?.conventionConflict;
  const convention: EndConvention = conventions.size === 1 ? [...conventions][0] : 'END_INCLUSIVE';
  if (conflit) { surDuree = false; motif = 'conflicting_end_conventions'; }
  if (conventions.size === 0) hypotheses.push('convention par défaut : fin = début + durée − 1 jour (aucune disposition contraire lue)');
  if (d.a.status === 'INITIAL_TERM_RENEWABLE' || d.c?.status === 'INITIAL_TERM_RENEWABLE') hypotheses.push('durée INITIALE seulement : contrat renouvelable, échéance réelle inconnue');
  if (d.a.status === 'TOTAL_WITH_INCLUDED') hypotheses.push('durée totale retenue (part incluse non additionnée)');
  // Début égal à une date d'édition / de signature du document : jamais présumé effectif.
  const debutSuspect = !!opts.nonStartDates?.includes(String(s.value)) && !(s.label && labelIsEffectiveStart(s.label, spec));
  if (debutSuspect) hypotheses.push('début égal à une date d’édition ou de signature du document');
  const value = endFromStart(String(s.value), d.a.months!, convention);
  if (!value) return { ...base, status: 'NOT_DERIVABLE', value: null, start: null, duration: null, reason: 'invalid_start' };
  const sur = fiable(s) && fiable(d.f) && surDuree && !debutSuspect;
  return {
    ...base, convention, status: sur ? 'CALCULATED_RELIABLE' : 'CALCULATED_PROBABLE', value,
    start: { key: spec.start.key, value: String(s.value), source: s.source, confidence: String(s.confidence) },
    duration: { key: spec.duration.key, value: String(d.f.value), source: d.f.source, confidence: String(d.f.confidence), months: d.a.months!, status: d.a.status, parts: d.a.parts },
    reason: sur ? 'reliable_sources' : debutSuspect ? 'start_equals_document_date' : !surDuree ? `duration_not_reliable:${motif}` : 'uncertain_sources',
    assumptions: hypotheses,
  };
}

export interface DerivationEvidence {
  result: DerivationResult;
  startEvidence: FieldEvidence;
  durationEvidence: FieldEvidence;
}

/**
 * Connaissance T1 PERSISTÉE du début effectif et de la durée, puis calcul.
 * Lecture seule ; une lecture en échec est levée (jamais confondue avec une
 * donnée absente).
 */
export async function gatherDerivation(accountId: number, fileId: number, target: string): Promise<DerivationEvidence | null> {
  const spec = derivationFor(target);
  if (!spec) return null;
  const [startEvidence, durationEvidence] = await Promise.all([
    gatherFieldEvidence(accountId, fileId, spec.start.key, {
      designation: { keys: spec.start.keys, labelMatch: (l) => labelIsEffectiveStart(l, spec) }, withTitleHint: false,
    }),
    gatherFieldEvidence(accountId, fileId, spec.duration.key, {
      designation: { keys: spec.duration.keys, labelMatch: (l) => spec.duration.labels.some((x) => ` ${norm(l)} `.includes(` ${x} `)) },
      withTitleHint: false, valueType: 'text',
    }),
  ]);
  const errs = [...startEvidence.errors, ...durationEvidence.errors];
  if (errs.length) throw new Error(`lecture des sources du calcul impossible : ${errs.join(' ; ')}`.slice(0, 300));
  const hint = (f: EvidenceFact) => f.key ?? null;
  // Lot 72 (C1) : dates d'édition / signature / document lues ailleurs — jamais un début effectif.
  const nonStartDates = (startEvidence.contextDates ?? []).filter((c) => NON_START_KEY.test(c.key)).map((c) => c.iso);
  return { result: computeDerivation(spec, startEvidence.facts, durationEvidence.facts, hint, { nonStartDates }), startEvidence, durationEvidence };
}
