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
import { pgClient } from '@/db';
import { gatherFieldEvidence, readValue, type EvidenceFact, type FieldEvidence } from './document-field-evidence';

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

/**
 * Nombres en lettres (français) : mots reconnus et valeur. Lot 76 (C1) : une
 * quantité écrite en lettres que le calcul ne sait pas rattacher à une unité
 * prise en charge (« quinze jours », « et demi ») n'est jamais ignorée en
 * silence : la durée est refusée.
 */
const MOTS_NOMBRES: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13,
  quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100, cents: 100,
};
const NW = Object.keys(MOTS_NOMBRES).sort((a, b) => b.length - a.length).join('|');
/** Suite de mots-nombres (« vingt quatre », « trente et un », « quatre vingt dix »). */
const RE_SUITE_LETTRES = new RegExp(`\\b((?:(?:${NW})\\s+(?:et\\s+)?)*(?:${NW}))\\s+(ans|an|annees|annee|mois)\\b`, 'g');
/** Suite de mots-nombres en FIN de texte (juste avant une quantité en chiffres). */
const RE_LETTRES_FINALES = new RegExp(`\\b((?:(?:${NW})\\s+(?:et\\s+)?)*(?:${NW}))\\s*$`);
const UNITES_TOUTES = 'ans|an|annees|annee|mois|jours?|semaines?|trimestres?|semestres?|heures?|years?|year|months?|days?|weeks?';
/** Quantité NON interprétée : mot-nombre, fraction ou quantité vague accolé à une unité de durée. */
const RE_NON_INTERPRETE = new RegExp(`\\b(?:${NW}|demi|quart|quelques|plusieurs)\\s+(?:et\\s+)?(?:d\\s+)?(?:${UNITES_TOUTES})\\b|\\bet\\s+(?:demi|demie|quart)\\b`);

/** Valeur d'une suite de mots-nombres (« vingt quatre » → 24, « quatre vingt dix » → 90), sinon null. Pure. */
export function frenchNumberValue(texte: string): number | null {
  const mots = texte.trim().split(/\s+/).filter((m) => m && m !== 'et');
  if (mots.length === 0 || mots.some((m) => MOTS_NOMBRES[m] === undefined)) return null;
  let total = 0;
  for (const m of mots) {
    const v = MOTS_NOMBRES[m];
    if (v === 100) total = (total || 1) * 100;
    else if (v === 20 && total % 100 === 4) total += 76; // quatre-vingt(s)
    else total += v;
  }
  return total > 0 ? total : null;
}

const UNITE_AN = /^(ans|an|annees|annee|years|year)$/;
/**
 * Lot 76 (C1) : quantité éventuellement DÉCIMALE (« 1d5 » : 1,5 — jeton posé
 * avant la normalisation, la virgule et le point étant sinon perdus).
 */
const RE_QUANTITE = /(\d{1,4}(?:d\d{1,3})?)\s*(ans|an|annees|annee|years|year|mois|months|month)\b/g;
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
const RE_DEPART_EFFECTIF = /\b(effet|prise d effet|date de debut|debut du contrat|debut de contrat|entree en vigueur|date de depart|signature du present|present contrat|datelue)\b/;
const RE_ANNIVERSAIRE = /\b(date anniversaire|de date a date|a la date anniversaire|meme quantieme)\b/;
const RE_FIN_DE_MOIS = /\b(fin de mois|dernier jour du mois|fin du mois)\b/;
const RE_REFUS = /\b(indetermine\w*|illimite\w*|jours?|semaines?|days?|weeks?|trimestres?|semestres?|viager\w*)\b/;

/**
 * Lot 76 (C1) — texte brut préparé AVANT la normalisation (pure) : les dates
 * sont neutralisées (« 01.02.2024 » n'est jamais une décimale) et une
 * décimale accolée à une unité de durée devient un jeton (« 1,5 ans » →
 * « 1d5 ans ») — la normalisation remplaçait la virgule par un espace et
 * lisait « 5 ans » (60 mois « fiables »).
 */
function preparerDuree(raw: string): string {
  return raw
    .replace(/\b\d{1,2}[/.\-:]\d{1,2}[/.\-:]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, ' datelue ')
    .replace(/(\d{1,4})\s*[,.]\s*(\d{1,3})(?=\s*(?:ans?|ann[ée]es?|years?|mois|months?)\b)/gi, '$1d$2');
}

/** Valeur d'une quantité lue (« 18 », « 1d5 » → 1,5). Pure. */
const valeurQuantite = (jeton: string) => Number(jeton.replace('d', '.'));

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
  // Nombres en lettres accolés à une unité prise en charge (« un an », « vingt-quatre mois ») ramenés en chiffres.
  const s = norm(preparerDuree(raw)).replace(RE_SUITE_LETTRES, (m, mots: string, u: string) => {
    const v = frenchNumberValue(mots);
    return v === null ? m : `${v} ${u}`;
  });
  if (!s) return refus('empty');
  if (has(s, /\b(indetermine\w*|illimite\w*|viager\w*)\b/)) return refus('open_ended', 'AMBIGUOUS');
  const conventions = new Set<EndConvention>();
  if (has(s, RE_ANNIVERSAIRE)) conventions.add('ANNIVERSARY');
  if (has(s, RE_FIN_DE_MOIS)) conventions.add('END_OF_MONTH');
  const convention = conventions.size === 1 ? [...conventions][0] : null;
  const conventionConflict = conventions.size > 1;

  // ── Quantités, regroupées quand elles se suivent (« 2 ans et 6 mois ») ──
  const brutes: Array<{ months: number; an: boolean; start: number; end: number; n: number }> = [];
  for (const m of s.matchAll(RE_QUANTITE)) {
    const n = valeurQuantite(m[1]);
    const an = UNITE_AN.test(m[2]);
    const mois = an ? n * 12 : n;
    // Lot 76 (C1) : décimale interprétée EXACTEMENT (1,5 an = 18 mois), sinon refus (jamais arrondie).
    if (Math.abs(mois - Math.round(mois)) > 1e-9) return refus('inexact_decimal_duration');
    brutes.push({ months: Math.round(mois), an, start: m.index!, end: m.index! + m[0].length, n });
  }
  if (brutes.length === 0) {
    if (/^\d{1,4}$/.test(s) && /mois|months/i.test(keyHint ?? '')) {
      const n = Number(s);
      return n > 0 && n <= 1200
        ? { months: n, reliable: true, status: 'SIMPLE', parts: [{ months: n, role: 'PRIMARY' }], reason: 'numeric_months', convention, conventionConflict }
        : refus('out_of_range');
    }
    if (/\d+d\d+/.test(s)) return refus('inexact_decimal_duration');
    return refus(has(s, RE_REFUS) ? 'unsupported_unit' : 'no_duration');
  }
  // Lot 76 (C1) : une quantité en lettres juste avant une quantité en chiffres doit la REDIRE
  // (« douze (12) mois ») ; sinon (« dix-huit » mal lu, « vingt 4 mois ») la durée est refusée.
  for (let i = 0; i < brutes.length; i += 1) {
    const avant = s.slice(i === 0 ? 0 : brutes[i - 1].end, brutes[i].start);
    const lettres = RE_LETTRES_FINALES.exec(avant);
    if (lettres && frenchNumberValue(lettres[1]) !== brutes[i].n) return refus('uninterpreted_component');
  }
  const quantites: Array<{ months: number; start: number; end: number }> = [];
  for (const b of brutes) {
    const prev = quantites.at(-1);
    const entre = prev ? s.slice(prev.end, b.start) : null;
    const prevBrute = prev ? brutes.find((x) => x.end === prev.end) : null;
    if (prev && entre !== null && /^\s*(et\s*)?$/.test(entre) && prevBrute?.an && !b.an) {
      // « 2 ans et 6 mois » / « 2 ans 6 mois » : une seule durée (années puis mois < 12).
      if (b.months < 12) { prev.months += b.months; prev.end = b.end; continue; }
      // Lot 76 : « 2 ans (24 mois) » — la même durée redite, jamais additionnée.
      if (b.months === prev.months) { prev.end = b.end; continue; }
    }
    quantites.push({ months: b.months, start: b.start, end: b.end });
  }
  if (quantites.some((q) => q.months <= 0 || q.months > 1200)) return refus('out_of_range');
  // Unité non gérée À CÔTÉ d'une durée (« 12 mois et 15 jours ») : refus.
  if (has(s, RE_REFUS) && !has(s, /\b(indetermine\w*|illimite\w*)\b/) && /\d\s*(jours?|semaines?|days?|weeks?|trimestres?|semestres?)\b/.test(s)) return refus('unsupported_unit');
  // Lot 76 (C1) : composante NON INTERPRÉTÉE (« et quinze jours », « et demi », « trois semaines ») —
  // jamais ignorée en silence. Conventions de fin retirées avant l'examen (« dernier jour du mois »).
  let reste = s;
  for (const q of [...quantites].reverse()) reste = `${reste.slice(0, q.start)} ${' '.repeat(Math.max(0, q.end - q.start - 1))}${reste.slice(q.end)}`;
  reste = reste.replace(new RegExp(RE_FIN_DE_MOIS.source, 'g'), ' ');
  if (RE_NON_INTERPRETE.test(reste)) return refus('uninterpreted_component');

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

/**
 * Méthode du calcul. Lot 76 (I) : `SCHEDULE_LAST_INSTALMENT` (dernière
 * échéance lue dans l'échéancier), `FIRST_INSTALMENT_PLUS_COUNT` (première
 * échéance + (nombre − 1) périodes), `DISBURSEMENT_PLUS_COUNT` (déblocage :
 * jamais fiable, candidat seulement).
 */
export type DerivationMethod = 'START_PLUS_DURATION' | 'SCHEDULE_LAST_INSTALMENT' | 'FIRST_INSTALMENT_PLUS_COUNT' | 'DISBURSEMENT_PLUS_COUNT';

export interface DerivationResult {
  /** CALCULATED_RELIABLE : écrite ; CALCULATED_PROBABLE : candidat seulement ; NOT_DERIVABLE / AMBIGUOUS. */
  status: 'CALCULATED_RELIABLE' | 'CALCULATED_PROBABLE' | 'NOT_DERIVABLE' | 'AMBIGUOUS';
  value: string | null;
  method: DerivationMethod;
  /** Convention de fin APPLIQUÉE (lot 72 : lue dans la clause, sinon « fin incluse » par défaut — hypothèse tracée). Lot 76 (I) : `LAST_INSTALMENT` — date de la dernière échéance. */
  convention: EndConvention | 'LAST_INSTALMENT';
  /** Lot 76 (I) : calcul par l'échéancier (sources, période, motifs) — toujours tracé quand un échéancier est lu. */
  schedule?: ScheduleDerivation;
  /** Lot 76 (I) : la date de fin conditionne-t-elle une démarche ? (pertinence d'une question, diagnostic) */
  endDateNeed?: EndDateNeed | null;
  /** Lot 76 (I) : autre méthode évaluée mais non retenue (diagnostic). */
  alternative?: { method: DerivationMethod; status: DerivationResult['status']; value: string | null; reason: string } | null;
  start: DerivationSource | null;
  duration: (DerivationSource & { months: number; status?: DurationStatus; parts?: DurationAnalysis['parts'] }) | null;
  reason: string;
  /** Lot 72 (C1) : hypothèses retenues (convention par défaut, durée initiale…). */
  assumptions?: string[];
  /**
   * Lot 76 (C1) : durées REFUSÉES ou ambiguës lues (valeur ou clause de chaque
   * fait, provenance et motif) — jamais ignorées en silence.
   */
  refusals?: Array<{ value: string; part: 'value' | 'clause'; source: string; confidence: string; reason: string; status: DurationStatus }>;
}

/** Motifs de refus d'une durée qui révèlent une durée NON interprétée (et non une absence de durée). */
const REFUS_SIGNIFICATIFS = ['inexact_decimal_duration', 'uninterpreted_component', 'unsupported_unit', 'out_of_range'];

/**
 * Lot 76 (C1) — l'analyse d'une durée (valeur ou clause) interdit-elle un
 * calcul fiable ? Ambiguë, renouvelable / prolongeable, ou refusée parce
 * qu'une partie significative n'est pas interprétée. `valeur` : analyse de la
 * valeur du même fait (une clause qui redit la valeur ne bloque pas). Pure.
 */
export function durationBlocks(a: DurationAnalysis, valeur: DurationAnalysis | null): boolean {
  if (a.status === 'AMBIGUOUS' || a.status === 'INITIAL_TERM_RENEWABLE' || a.status === 'INITIAL_TERM_EXTENSIBLE') return true;
  if (a.status === 'REFUSED' && REFUS_SIGNIFICATIFS.includes(a.reason)) return !valeur || valeur.reason !== a.reason || valeur.months !== null;
  return false;
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
  // Lot 76 (C1) : motifs de refus conservés (provenance comprise) — valeur OU clause de CHAQUE fait.
  const refusals: NonNullable<DerivationResult['refusals']> = [];
  for (const x of analyses) {
    for (const [part, an] of [['value', x.a], ['clause', x.c]] as const) {
      if (!an || !durationBlocks(an, part === 'clause' ? x.a : null)) continue;
      refusals.push({ value: String(x.f.value).slice(0, 120), part, source: x.f.source, confidence: String(x.f.confidence), reason: an.reason, status: an.status });
    }
  }
  const lisibles = analyses.filter((x) => x.a.months !== null);
  const ambigues = analyses.filter((x) => x.a.status === 'AMBIGUOUS');
  const durees = [...new Map(lisibles.map((x) => [x.a.months, x])).values()];
  if (debuts.length === 0 || (durees.length === 0 && ambigues.length === 0)) {
    const refusee = refusals.find((r) => r.part === 'value');
    return { ...base, status: 'NOT_DERIVABLE', value: null, start: null, duration: null, refusals,
      reason: debuts.length === 0 ? (debutsLus.length ? 'start_is_not_effective' : 'no_effective_start') : refusee ? `duration_refused:${refusee.reason}` : 'no_duration' };
  }
  if (durees.length === 0) {
    return { ...base, status: 'AMBIGUOUS', value: null, start: null, duration: null, refusals, reason: `ambiguous_duration:${ambigues[0].a.reason}` };
  }
  if (debuts.length > 1 || durees.length > 1) {
    return { ...base, status: 'AMBIGUOUS', value: null, start: null, duration: null, refusals,
      reason: debuts.length > 1 ? 'several_start_dates' : 'several_durations' };
  }
  // Lot 76 (C1) : un fait CONCURRENT ambigu ou partiellement interprété (valeur ou clause)
  // n'est jamais écarté parce qu'un autre fait est lisible — aucune durée unique fiable.
  const concurrents = analyses.filter((x) => x !== durees[0] && (durationBlocks(x.a, null) || (x.c && durationBlocks(x.c, x.a))
    || (x.c && x.c.months !== null && x.c.months !== durees[0].a.months && x.c.status !== 'REFUSED')));
  if (concurrents.length) {
    return { ...base, status: 'AMBIGUOUS', value: null, start: null, duration: null, refusals,
      reason: `competing_duration_facts:${concurrents.map((x) => (durationBlocks(x.a, null) ? x.a : x.c)!.reason).join(',')}`.slice(0, 200) };
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
    } else if (durationBlocks(d.c, d.a)) {
      // Lot 76 (C1) : clause partiellement interprétée (« 12 mois et quinze jours ») — jamais réduite en silence.
      surDuree = false; motif = `clause_${d.c.reason}`;
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
    assumptions: hypotheses, refusals,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 76 (I) — ÉCHÉANCIER : DERNIÈRE ÉCHÉANCE, PREMIÈRE ÉCHÉANCE + NOMBRE
//
// Cas constaté : offre de crédit immobilier — « Date de première échéance »,
// « Nombre d'échéances : 240 », « Périodicité : mensuelle » lus, mais la
// première échéance était (à juste titre) refusée comme DÉBUT EFFECTIF du
// calcul « début + durée » et rien d'autre ne calculait : la date de fin
// devenait « absente » → « Quelle est la date de fin de ce contrat ? ».
//
// Une échéance de fin se déduit AUSSI d'un échéancier (vocabulaire générique
// du remboursement par échéances, aucune règle propre à un établissement ni à
// un type de contrat) :
//   · dernière échéance lue (échéancier, tableau d'amortissement du même
//     contrat) → privilégiée ;
//   · première échéance + (nombre d'échéances − 1) × périodicité, même
//     quantième borné à la fin du mois (fins de mois, années bissextiles) ;
//   · périodicité : lue, sinon portée par le nombre (« mensualités »), sinon
//     déduite d'une durée FIABLE (durée = nombre × période) — hypothèse tracée ;
//   · déblocage des fonds : jamais assimilé à la première échéance (candidat
//     PROBABLE, jamais écrit) ; date de signature / d'émission : jamais lues ;
//   · contradiction (dernière échéance ≠ calcul, nombre × période ≠ durée,
//     plusieurs valeurs), différé ou palier dans le nombre, quantième
//     incertain, modification connue (avenant, réaménagement, report accordé)
//     → aucune valeur fiable.
// La fin calculée est la fin CONTRACTUELLE PRÉVISIONNELLE (`CALCULATED`) ; la
// fin EFFECTIVE (remboursement anticipé, prêt soldé) reste la preuve de fin du
// cycle de vie (lot 76, C2), évaluée séparément.
// ══════════════════════════════════════════════════════════════════════════

export interface ScheduleDesignation { key: string; keys: readonly string[]; labels: readonly string[] }

export interface ScheduleSpec {
  target: string;
  firstInstalment: ScheduleDesignation;
  lastInstalment: ScheduleDesignation;
  count: ScheduleDesignation;
  periodicity: ScheduleDesignation;
  disbursement: ScheduleDesignation;
  /** Indices d'un remboursement par échéances (jamais une source de calcul). */
  repayment: ScheduleDesignation;
}

export const SCHEDULE_DERIVATIONS: readonly ScheduleSpec[] = [
  {
    target: 'contractEndDate',
    firstInstalment: {
      key: 'firstInstalmentDate',
      keys: ['firstInstalmentDate', 'firstInstallmentDate', 'firstPaymentDate', 'firstRepaymentDate', 'datePremiereEcheance', 'premiereEcheance',
        'datePremierRemboursement', 'datePremiereMensualite', 'datePremierPrelevement'],
      labels: ['premiere echeance', 'premier remboursement', 'premiere mensualite', 'premier prelevement', 'debut des remboursements',
        'debut de remboursement', 'debut d amortissement', 'debut de l amortissement', '1ere echeance', '1re echeance', '1ere mensualite'],
    },
    lastInstalment: {
      key: 'lastInstalmentDate',
      keys: ['lastInstalmentDate', 'lastInstallmentDate', 'lastPaymentDate', 'finalPaymentDate', 'finalInstalmentDate', 'loanEndDate', 'creditEndDate',
        'dateDerniereEcheance', 'derniereEcheance', 'dateDerniereMensualite', 'dateFinPret', 'dateFinCredit', 'dateFinRemboursement'],
      labels: ['derniere echeance', 'dernier remboursement', 'derniere mensualite', 'dernier prelevement', 'echeance finale', 'fin des remboursements',
        'fin de remboursement', 'fin du pret', 'fin du credit', 'fin de l emprunt', 'terme du pret', 'terme du credit', 'fin d amortissement', 'fin de l amortissement'],
    },
    count: {
      key: 'instalmentCount',
      keys: ['instalmentCount', 'installmentCount', 'numberOfInstalments', 'numberOfInstallments', 'numberOfPayments', 'paymentCount', 'nombreEcheances',
        'nbEcheances', 'nombreMensualites', 'nbMensualites', 'nombreRemboursements'],
      labels: ['nombre d echeances', 'nombre des echeances', 'nombre de mensualites', 'nombre de remboursements', 'nombre de versements',
        'nombre de prelevements', 'nombre total d echeances', 'nombre total de mensualites', 'nb d echeances', 'nb de mensualites', 'nombre de termes'],
    },
    periodicity: {
      key: 'instalmentPeriodicity',
      keys: ['instalmentPeriodicity', 'periodicity', 'paymentFrequency', 'repaymentFrequency', 'installmentFrequency', 'periodicite', 'frequenceEcheances',
        'periodiciteEcheances', 'periodiciteRemboursement'],
      labels: ['periodicite', 'frequence des echeances', 'frequence de remboursement', 'frequence des remboursements', 'rythme des echeances'],
    },
    disbursement: {
      key: 'disbursementDate',
      keys: ['disbursementDate', 'fundsReleaseDate', 'dateDeblocage', 'dateDeblocageFonds', 'dateMiseADisposition'],
      labels: ['deblocage', 'mise a disposition des fonds', 'versement des fonds', 'remise des fonds'],
    },
    repayment: {
      key: 'repaymentSchedule',
      keys: ['amortizationSchedule', 'tableauAmortissement', 'loanDuration', 'loanDurationMonths', 'loanTerm', 'loanTermMonths', 'dureePret', 'dureeCredit',
        'creditDuration', 'dureeRemboursement', 'dureeAmortissement', 'capitalRestantDu'],
      labels: ['tableau d amortissement', 'duree du pret', 'duree du credit', 'duree de l emprunt', 'duree de remboursement', 'duree d amortissement',
        'duree de l amortissement', 'capital restant du'],
    },
  },
];

export function scheduleDerivationFor(target: string): ScheduleSpec | null {
  return SCHEDULE_DERIVATIONS.find((d) => d.target === target) ?? null;
}

export type ScheduleRole = 'firstInstalment' | 'lastInstalment' | 'count' | 'periodicity' | 'disbursement' | 'repayment';
const ROLES: readonly ScheduleRole[] = ['firstInstalment', 'lastInstalment', 'count', 'periodicity', 'disbursement', 'repayment'];

/**
 * Rôle d'un fait dans l'échéancier, d'après sa clé lue (canonique ou brute)
 * ou son libellé (pure). Un libellé de signature, d'émission, d'offre ou de
 * document n'est jamais un rôle de date ; un libellé qui désigne à la fois la
 * première et la dernière échéance n'en reçoit aucun.
 */
export function scheduleRoleOf(spec: ScheduleSpec, p: { canonical?: string | null; raw?: string | null; label?: string | null }): ScheduleRole | null {
  const cles = [p.canonical, p.raw].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  for (const r of ROLES) if (spec[r].keys.some((k) => cles.includes(k.toLowerCase()))) return r;
  if (!p.label) return null;
  const l = ` ${norm(p.label)} `;
  const trouves = ROLES.filter((r) => spec[r].labels.some((x) => l.includes(` ${x} `)));
  // « Durée du prêt » : indice d'échéancier seulement si aucun autre rôle n'est désigné.
  const roles = trouves.length > 1 ? trouves.filter((r) => r !== 'repayment') : trouves;
  if (roles.length !== 1) return null;
  const r = roles[0];
  if ((r === 'firstInstalment' || r === 'lastInstalment' || r === 'disbursement') && /\b(signature|signe|emission|edition|offre|acceptation|document)\b/.test(l)) return null;
  return r;
}

/** Périodicité lue (pure) : mois entre deux échéances, sinon null (motif). */
export function parsePeriodicity(raw: unknown): { months: number | null; reason: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { months: null, reason: 'empty' };
  const s = ` ${norm(raw)} `;
  if (/\b(hebdomadaire\w*|quotidien\w*|journalier\w*|quinzaine|jours?|semaines?)\b/.test(s)) return { months: null, reason: 'unsupported_periodicity' };
  const trouves = new Set<number>();
  const tous = /\btous les (\d{1,2}) mois\b/.exec(s);
  if (tous) trouves.add(Number(tous[1]));
  if (/\b(mensuel\w*|par mois|chaque mois|tous les mois|mensualites?)\b/.test(s) || /^\s*(1 )?mois\s*$/.test(s)) trouves.add(1);
  if (/\b(bimestriel\w*)\b/.test(s)) trouves.add(2);
  if (/\b(trimestriel\w*|par trimestre|chaque trimestre|trimestrialites?)\b/.test(s)) trouves.add(3);
  if (/\b(semestriel\w*|par semestre|chaque semestre|semestrialites?)\b/.test(s)) trouves.add(6);
  if (/\b(annuel\w*|par an|chaque annee|tous les ans|annuites?)\b/.test(s)) trouves.add(12);
  if (trouves.size === 0) return { months: null, reason: 'periodicity_not_interpreted' };
  if (trouves.size > 1) return { months: null, reason: 'several_periodicities' };
  const m = [...trouves][0];
  return [1, 2, 3, 4, 6, 12].includes(m) ? { months: m, reason: 'read' } : { months: null, reason: 'unsupported_periodicity' };
}

/**
 * Nombre d'échéances lu (pure) : entier unique 1..1200 (« 240 », « 240
 * mensualités », « 240 (deux cent quarante) »). Montants et taux écartés.
 * Plusieurs nombres, différé, palier, alternative ou imprécision → AMBIGUOUS
 * (jamais une somme ni un choix). `impliedPeriod` : période portée par le
 * mot (« mensualités » → 1).
 */
export function parseInstalmentCount(raw: unknown, label?: string | null): { count: number | null; impliedPeriod: number | null; status: 'OK' | 'AMBIGUOUS' | 'REFUSED'; reason: string } {
  const refus = (reason: string, status: 'AMBIGUOUS' | 'REFUSED' = 'REFUSED') => ({ count: null, impliedPeriod: null, status, reason });
  const periodeDe = (t: string) => { const p = parsePeriodicity(t); return p.months; };
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 && raw <= 1200 ? { count: raw, impliedPeriod: label ? periodeDe(label) : null, status: 'OK', reason: 'numeric' } : refus('out_of_range');
  }
  if (typeof raw !== 'string' || !raw.trim()) return refus('empty');
  // Montants (« de 850,00 € »), taux (« 1,85 % ») et dates retirés avant la lecture des nombres.
  const sansMontants = raw
    .replace(/\b\d{1,2}[/.\-:]\d{1,2}[/.\-:]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\d[\d\s.  ]*(?:[,.]\d{1,2})?\s*(?:€|eur\b|euros?\b)/gi, ' ')
    .replace(/\d+(?:[,.]\d+)?\s*%/g, ' ');
  if (/\d+[,.]\d+/.test(sansMontants)) return refus('decimal_count');
  const s = ` ${norm(sansMontants)} `;
  if (/\b(differe\w*|franchise|carence|report\w*|palier\w*|progressi\w*|modula\w*)\b/.test(s)) return refus('deferral_or_steps_in_count', 'AMBIGUOUS');
  if (/\b(ou|puis|environ|maximum|minimum|au plus|au moins|jusqu a|plus|entre)\b|\+/.test(s)) return refus('imprecise_count', 'AMBIGUOUS');
  const nombres = [...s.matchAll(/\b(\d{1,4})\b/g)].map((m) => Number(m[1]));
  let n: number | null = null;
  if (nombres.length === 0) {
    const lettres = /\b((?:[a-z]+\s+){0,5}[a-z]+)\s+(echeances?|mensualites?|remboursements?|versements?|prelevements?|trimestrialites?|semestrialites?|annuites?)\b/.exec(s);
    n = lettres ? frenchNumberValue(lettres[1].split(/\s+/).filter((w) => MOTS_NOMBRES[w] !== undefined || w === 'et').join(' ')) : null;
    if (n === null) return refus('no_count');
  } else {
    const distincts = [...new Set(nombres)];
    if (distincts.length > 1 && !/\bdont\b/.test(s)) {
      // « 240 (deux cent quarante) » : la redite en lettres est admise si elle donne la même valeur.
      return refus('several_counts', 'AMBIGUOUS');
    }
    n = nombres[0];
    const lettres = s.replace(/\b\d{1,4}\b/g, ' ').replace(/\b(echeances?|mensualites?|remboursements?|versements?|prelevements?|mensuel\w*|trimestriel\w*|semestriel\w*|annuel\w*|nombre|de|d|des|total|totales?|soit|dont)\b/g, ' ').trim();
    if (lettres && frenchNumberValue(lettres) !== null && frenchNumberValue(lettres) !== n) return refus('several_counts', 'AMBIGUOUS');
  }
  if (!n || n <= 0 || n > 1200) return refus('out_of_range');
  const implied = periodeDe(`${s} ${label ?? ''}`);
  return { count: n, impliedPeriod: implied, status: 'OK', reason: 'read' };
}

/** Date + `mois` mois, même quantième borné à la fin du mois cible (pure). `finDeMois` : dernier jour du mois cible. */
export function addMonthsClamped(iso: string, mois: number, finDeMois = false): string | null {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = (m - 1) + mois;
  const ty = y + Math.floor(t / 12);
  const tm = ((t % 12) + 12) % 12;
  const dernier = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const r = new Date(Date.UTC(ty, tm, finDeMois ? dernier : Math.min(d, dernier)));
  return Number.isNaN(r.getTime()) ? null : r.toISOString().slice(0, 10);
}

/**
 * Date de la DERNIÈRE échéance (pure) : première + (nombre − 1) × période.
 * Une première échéance au dernier jour d'un mois de moins de 31 jours
 * laisse le quantième incertain (le 28 ou la fin du mois ?) : `dayAmbiguous`
 * quand les deux lectures divergent, sauf convention « fin de mois » lue.
 */
export function lastInstalmentFrom(firstIso: string, count: number, periodMonths: number, endOfMonth = false): { value: string | null; dayAmbiguous: boolean } {
  const mois = (count - 1) * periodMonths;
  const meme = addMonthsClamped(firstIso, mois);
  const fin = addMonthsClamped(firstIso, mois, true);
  if (endOfMonth) return { value: fin, dayAmbiguous: false };
  const [y, m, d] = firstIso.split('-').map(Number);
  const dernierDuPremier = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { value: meme, dayAmbiguous: d === dernierDuPremier && d < 31 && meme !== fin };
}

/**
 * Modification CONNUE de l'échéancier (pure) : avenant, réaménagement,
 * renégociation, report ou modulation ACCORDÉS — constat, jamais une simple
 * faculté (« possibilité de report », « peut moduler ») ni une négation.
 */
export function knownScheduleChange(textes: ReadonlyArray<string | null | undefined>): string | null {
  const RE_CHANGEMENT = /\b(avenant\w*|reamenage\w*|renegoci\w*|rachat de (credit|pret)|report d echeances? (accorde|consenti|applique|effectue)\w*|modulation (accordee|appliquee|effectuee)|echeancier (modifie|revise))\b/;
  const RE_FACULTE = /\b(peut|peuvent|pourra|pourront|pourrait|possibilite|faculte|droit de|en cas d\w*|si|sauf|sous reserve|eventuel\w*|le cas echeant|modalites|conditions)\b/;
  const RE_NEG = /\b(aucun\w*|pas|non|jamais|sans)\b/;
  for (const t of textes) {
    if (!t) continue;
    for (const phrase of String(t).split(/(?<=[.;!?])\s+|\n+/)) {
      const p = ` ${norm(phrase)} `;
      const m = RE_CHANGEMENT.exec(p);
      if (!m) continue;
      if (RE_FACULTE.test(p) || RE_NEG.test(p.slice(Math.max(0, m.index - 30), m.index))) continue;
      return phrase.replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }
  return null;
}

export interface ScheduleFacts {
  firstInstalment: EvidenceFact[];
  lastInstalment: EvidenceFact[];
  count: EvidenceFact[];
  periodicity: EvidenceFact[];
  disbursement: EvidenceFact[];
  repayment: EvidenceFact[];
}

type ScheduleSource = DerivationSource & { label?: string | null };

export interface ScheduleDerivation {
  status: DerivationResult['status'];
  value: string | null;
  method: Exclude<DerivationMethod, 'START_PLUS_DURATION'> | null;
  reason: string;
  /** Un échéancier (remboursement par échéances) est lu dans la connaissance du contrat. */
  evidenced: boolean;
  sources: {
    firstInstalment?: ScheduleSource;
    lastInstalment?: ScheduleSource;
    count?: ScheduleSource & { count: number };
    periodicity?: { months: number; origin: 'READ' | 'IMPLIED_BY_COUNT' | 'INFERRED_FROM_DURATION'; value?: string; source?: string };
    disbursement?: ScheduleSource;
  };
  assumptions: string[];
  refusals: Array<{ role: ScheduleRole; value: string; reason: string }>;
  /** Modification connue de l'échéancier (extrait), le cas échéant. */
  change?: string | null;
}

/** Fait fiable de l'échéancier : certain, lu dans le document ou dans un document du MÊME contrat. */
const fiableEcheancier = (f: EvidenceFact) => f.confidence === 'certain' && (f.source === 'FACTS' || f.source.startsWith('RELATED_DOCUMENT:'));
const src = (f: EvidenceFact): ScheduleSource => ({ key: f.key ?? null, value: String(f.value), source: f.source, confidence: String(f.confidence), label: f.label ?? null });
const dateIso = (f: EvidenceFact) => (typeof f.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.value) ? f.value : null);

/**
 * Calcul de la fin par l'ÉCHÉANCIER (pure). `durationMonths` : durée FIABLE
 * lue (analyse `analyzeDuration`), pour le contrôle de cohérence et, à défaut
 * de périodicité, sa déduction. `endOfMonth` : convention « fin de mois » lue.
 * `change` : modification connue de l'échéancier.
 */
export function computeScheduleDerivation(
  f: ScheduleFacts, opts: { durationMonths?: number | null; durationIncludedMonths?: number[]; endOfMonth?: boolean; change?: string | null } = {},
): ScheduleDerivation {
  const refusals: ScheduleDerivation['refusals'] = [];
  const assumptions: string[] = [];
  const evidenced = f.firstInstalment.length + f.lastInstalment.length + f.count.length + f.repayment.length > 0;
  const out = (status: ScheduleDerivation['status'], reason: string, x: Partial<ScheduleDerivation> = {}): ScheduleDerivation =>
    ({ status, value: null, method: null, reason, evidenced, sources: {}, assumptions, refusals, change: opts.change ?? null, ...x });

  // ── Dates (dernière, première, déblocage) : valeurs distinctes ─────────────
  const distinctes = (xs: EvidenceFact[], role: ScheduleRole) => {
    const ok = xs.filter((x) => dateIso(x));
    for (const x of xs.filter((y) => !dateIso(y))) refusals.push({ role, value: String(x.value).slice(0, 80), reason: 'not_a_date' });
    return [...new Map(ok.map((x) => [dateIso(x)!, x])).values()];
  };
  const dernieres = distinctes(f.lastInstalment, 'lastInstalment');
  const premieres = distinctes(f.firstInstalment, 'firstInstalment');
  const deblocages = distinctes(f.disbursement, 'disbursement');
  if (dernieres.length > 1) return out('AMBIGUOUS', 'several_last_instalment_dates');
  if (premieres.length > 1) return out('AMBIGUOUS', 'several_first_instalment_dates');

  // ── Nombre d'échéances ─────────────────────────────────────────────────
  const nombres = f.count.map((x) => ({ x, p: parseInstalmentCount(x.value, x.label ?? x.key ?? null) }));
  for (const n of nombres.filter((y) => y.p.status !== 'OK')) refusals.push({ role: 'count', value: String(n.x.value).slice(0, 80), reason: n.p.reason });
  if (nombres.some((n) => n.p.status === 'AMBIGUOUS')) return out('AMBIGUOUS', `count_${nombres.find((n) => n.p.status === 'AMBIGUOUS')!.p.reason}`);
  const lus = [...new Map(nombres.filter((n) => n.p.count !== null).map((n) => [n.p.count, n])).values()];
  if (lus.length > 1) return out('AMBIGUOUS', 'several_counts');

  // ── Périodicité ─────────────────────────────────────────────────────────
  const periodes = f.periodicity.map((x) => ({ x, p: parsePeriodicity(x.value) }));
  for (const p of periodes.filter((y) => y.p.months === null)) refusals.push({ role: 'periodicity', value: String(p.x.value).slice(0, 80), reason: p.p.reason });
  if (periodes.some((p) => p.p.months === null && p.p.reason !== 'empty')) return out('AMBIGUOUS', `periodicity_${periodes.find((p) => p.p.months === null)!.p.reason}`);
  const periodesLues = [...new Map(periodes.filter((p) => p.p.months !== null).map((p) => [p.p.months, p])).values()];
  if (periodesLues.length > 1) return out('AMBIGUOUS', 'several_periodicities');
  const nombre = lus[0] ?? null;
  let periode: ScheduleDerivation['sources']['periodicity'] | undefined;
  if (periodesLues.length === 1) periode = { months: periodesLues[0].p.months!, origin: 'READ', value: String(periodesLues[0].x.value), source: periodesLues[0].x.source };
  if (nombre?.p.impliedPeriod != null) {
    if (periode && periode.months !== nombre.p.impliedPeriod) return out('AMBIGUOUS', 'count_contradicts_periodicity');
    periode ??= { months: nombre.p.impliedPeriod, origin: 'IMPLIED_BY_COUNT', value: String(nombre.x.value), source: nombre.x.source };
  }
  const duree = opts.durationMonths ?? null;
  if (nombre && !periode && duree) {
    const q = duree / nombre.p.count!;
    if ([1, 2, 3, 6, 12].includes(q)) {
      periode = { months: q, origin: 'INFERRED_FROM_DURATION' };
      assumptions.push(`périodicité déduite de la durée (${duree} mois / ${nombre.p.count} échéances)`);
    }
  }
  // Cohérence nombre × période ↔ durée fiable lue (part incluse admise : « 240 mois dont 12 de différé »).
  if (nombre && periode && duree) {
    const couvert = nombre.p.count! * periode.months;
    const admis = [duree, ...(opts.durationIncludedMonths ?? []).map((i) => duree - i)];
    if (!admis.includes(couvert)) return out('AMBIGUOUS', 'schedule_inconsistent_with_duration');
  }

  // ── Calcul depuis la première échéance (ou, à défaut, le déblocage) ──────
  type Calcul = { value: string; method: 'FIRST_INSTALMENT_PLUS_COUNT' | 'DISBURSEMENT_PLUS_COUNT'; reliable: boolean; motif: string };
  let calcul: Calcul | null = null;
  const sources: ScheduleDerivation['sources'] = {};
  if (nombre) sources.count = { ...src(nombre.x), count: nombre.p.count! };
  if (periode) sources.periodicity = periode;
  if (premieres.length === 1 && nombre && periode) {
    const p = premieres[0];
    const r = lastInstalmentFrom(dateIso(p)!, nombre.p.count!, periode.months, !!opts.endOfMonth);
    sources.firstInstalment = src(p);
    if (r.value) {
      const fiables = fiableEcheancier(p) && fiableEcheancier(nombre.x) && (periode.origin !== 'READ' || f.periodicity.every(fiableEcheancier));
      calcul = { value: r.value, method: 'FIRST_INSTALMENT_PLUS_COUNT', reliable: fiables && !r.dayAmbiguous,
        motif: r.dayAmbiguous ? 'instalment_day_ambiguous' : fiables ? 'reliable_schedule' : 'uncertain_sources' };
      if (opts.endOfMonth) assumptions.push('convention « fin de mois » lue : échéances au dernier jour du mois');
    }
  } else if (premieres.length === 0 && deblocages.length === 1 && nombre && periode) {
    // Déblocage ≠ première échéance : estimation (une période après le déblocage), jamais écrite.
    const d = deblocages[0];
    const v = addMonthsClamped(dateIso(d)!, nombre.p.count! * periode.months);
    sources.disbursement = src(d);
    if (v) {
      calcul = { value: v, method: 'DISBURSEMENT_PLUS_COUNT', reliable: false, motif: 'disbursement_is_not_first_instalment' };
      assumptions.push('estimation : première échéance supposée une période après le déblocage (jamais écrite)');
    }
  }

  // ── Dernière échéance lue : privilégiée, contrôlée par le calcul ──────────
  if (dernieres.length === 1) {
    const d = dernieres[0];
    sources.lastInstalment = src(d);
    if (calcul && calcul.method === 'FIRST_INSTALMENT_PLUS_COUNT' && calcul.value !== dateIso(d)) {
      return out('AMBIGUOUS', 'last_instalment_contradicts_schedule', { sources });
    }
    if (opts.change) return out('CALCULATED_PROBABLE', 'known_schedule_change', { value: dateIso(d), method: 'SCHEDULE_LAST_INSTALMENT', sources });
    const sur = fiableEcheancier(d);
    if (calcul?.method === 'FIRST_INSTALMENT_PLUS_COUNT') assumptions.push('dernière échéance lue confirmée par le calcul (première échéance + nombre d’échéances)');
    return out(sur ? 'CALCULATED_RELIABLE' : 'CALCULATED_PROBABLE', sur ? 'reliable_last_instalment' : 'uncertain_sources',
      { value: dateIso(d), method: 'SCHEDULE_LAST_INSTALMENT', sources });
  }
  if (calcul) {
    if (opts.change) return out('CALCULATED_PROBABLE', 'known_schedule_change', { value: calcul.value, method: calcul.method, sources });
    return out(calcul.reliable ? 'CALCULATED_RELIABLE' : 'CALCULATED_PROBABLE', calcul.motif, { value: calcul.value, method: calcul.method, sources });
  }
  if (!evidenced) return out('NOT_DERIVABLE', 'no_schedule', { sources });
  const manque = premieres.length === 0 ? 'no_first_instalment' : !nombre ? 'no_instalment_count' : 'no_periodicity';
  return out('NOT_DERIVABLE', manque, { sources });
}

/**
 * Combinaison des deux méthodes (pure) — l'échéancier prime :
 *   · échéancier fiable → retenu (la méthode « début + durée » est tracée en alternative) ;
 *   · échéancier CONTRADICTOIRE → aucune valeur, jamais de repli sur l'autre méthode ;
 *   · échéancier incertain → « début + durée » fiable s'il existe, sinon le candidat le plus étayé ;
 *   · aucun échéancier calculable → « début + durée » (inchangé), échéancier tracé.
 */
export function combineDerivations(classic: DerivationResult, schedule: ScheduleDerivation): DerivationResult {
  const alt = (r: DerivationResult) => ({ method: r.method, status: r.status, value: r.value, reason: r.reason });
  const depuisEcheancier = (): DerivationResult => ({
    status: schedule.status, value: schedule.value, convention: 'LAST_INSTALMENT',
    method: schedule.method ?? (schedule.sources.lastInstalment ? 'SCHEDULE_LAST_INSTALMENT' : 'FIRST_INSTALMENT_PLUS_COUNT'),
    start: schedule.sources.firstInstalment ?? null, duration: null, reason: schedule.reason, assumptions: schedule.assumptions,
    refusals: classic.refusals, schedule, alternative: alt(classic),
  });
  if (schedule.status === 'CALCULATED_RELIABLE') return depuisEcheancier();
  if (schedule.status === 'AMBIGUOUS') {
    return { ...depuisEcheancier(), status: 'AMBIGUOUS', value: null, start: null, reason: `schedule:${schedule.reason}` };
  }
  if (classic.status === 'CALCULATED_RELIABLE') return { ...classic, schedule };
  if (schedule.status === 'CALCULATED_PROBABLE') {
    if (classic.status === 'CALCULATED_PROBABLE' && classic.value !== schedule.value) return { ...classic, schedule };
    return depuisEcheancier();
  }
  return { ...classic, schedule };
}

/** Connaissance de l'échéancier : faits actifs et unités source « libellé : valeur » des documents donnés. */
async function gatherScheduleFacts(accountId: number, fileId: number, spec: ScheduleSpec, relatedFiles: readonly number[]): Promise<{ facts: ScheduleFacts; texts: string[] }> {
  const facts: ScheduleFacts = { firstInstalment: [], lastInstalment: [], count: [], periodicity: [], disbursement: [], repayment: [] };
  const texts: string[] = [];
  const fichiers = [fileId, ...relatedFiles.filter((x) => x !== fileId)];
  const sourceDe = (fid: number, base: string) => (fid === fileId ? base : `RELATED_DOCUMENT:${fid}`);
  const ajouter = (role: ScheduleRole, fid: number, base: string, key: string | null, label: string | null, raw: unknown, confidence: string, excerpt: string | null) => {
    const date = role === 'firstInstalment' || role === 'lastInstalment' || role === 'disbursement';
    const r = readValue(spec[role].key, raw, confidence, date ? 'date' : 'text');
    if (r.value === null) {
      // Valeur illisible : jamais ignorée en silence (refus tracé par le calcul).
      if (raw !== null && raw !== undefined && String(raw).trim()) facts[role].push({ value: String(raw).trim(), confidence: 'conflictual', source: sourceDe(fid, base), key, label, excerpt });
      return;
    }
    facts[role].push({ value: r.value, confidence: r.confidence, source: sourceDe(fid, base), key, label, excerpt });
  };
  const rows = (await pgClient.unsafe(
    `SELECT f.file_id, to_jsonb(f) ->> 'canonical_key' AS canonical, f.fact_key AS raw, f.label, f.normalized_value AS norm,
            f.value_text AS text, f.confidence, f.excerpt
       FROM document_facts f WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active' ORDER BY f.file_id, f.id LIMIT 2000`,
    [accountId, fichiers] as never[],
  )) as unknown as Array<{ file_id: number; canonical: string | null; raw: string; label: string | null; norm: string | null; text: string | null; confidence: string; excerpt: string | null }>;
  for (const r of rows) {
    texts.push([r.label, r.text, r.excerpt].filter(Boolean).join(' : '));
    const role = scheduleRoleOf(spec, r);
    if (!role) continue;
    const date = role === 'firstInstalment' || role === 'lastInstalment' || role === 'disbursement';
    const brut = date && r.norm && readValue(spec[role].key, r.norm, r.confidence, 'date').value !== null ? r.norm : (r.text ?? r.norm);
    ajouter(role, Number(r.file_id), 'FACTS', r.canonical ?? r.raw, r.label, brut, r.confidence, r.excerpt);
  }
  const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
  if (await sourceLayerReady()) {
    const units = (await pgClient.unsafe(
      `SELECT file_id, kind, label, value_text AS value, content_text AS text, coverage_status AS coverage FROM document_source_units
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN')
        ORDER BY file_id, ordinal LIMIT 2000`,
      [accountId, fichiers] as never[],
    )) as unknown as Array<{ file_id: number; kind: string; label: string | null; value: string | null; text: string | null; coverage: string }>;
    for (const u of units) {
      texts.push([u.label, u.value, u.text].filter(Boolean).join(' : '));
      if (!['LABEL_VALUE', 'FORM_FIELD'].includes(u.kind) || !u.label || !u.value) continue;
      const role = scheduleRoleOf(spec, { label: u.label });
      // Unité lue mais non structurée en fait : jamais « certaine » (proposition).
      if (role) ajouter(role, Number(u.file_id), 'SOURCE_UNITS', u.label, u.label, u.value, u.coverage === 'UNCERTAIN' ? 'conflictual' : 'probable', null);
    }
  }
  return { facts, texts };
}

export interface DerivationEvidence {
  result: DerivationResult;
  startEvidence: FieldEvidence;
  durationEvidence: FieldEvidence;
}

/**
 * Connaissance T1 PERSISTÉE du début effectif et de la durée, puis calcul.
 * Lecture seule ; une lecture en échec est levée (jamais confondue avec une
 * donnée absente). Lot 76 (I) : + échéancier du document et des documents du
 * MÊME contrat (`relatedFiles`, référence exacte), combiné (`combineDerivations`).
 */
export async function gatherDerivation(accountId: number, fileId: number, target: string, opts: { relatedFiles?: readonly number[] } = {}): Promise<DerivationEvidence | null> {
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
  const classic = computeDerivation(spec, startEvidence.facts, durationEvidence.facts, hint, { nonStartDates });
  const echeancier = scheduleDerivationFor(target);
  if (!echeancier) return { result: classic, startEvidence, durationEvidence };
  let lu: Awaited<ReturnType<typeof gatherScheduleFacts>>;
  try {
    lu = await gatherScheduleFacts(accountId, fileId, echeancier, opts.relatedFiles ?? []);
  } catch (e) {
    throw new Error(`lecture de l'échéancier impossible : ${String((e as Error)?.message ?? e)}`.slice(0, 300));
  }
  // Durée FIABLE lue (contrôle de cohérence, déduction de la période) : une seule valeur exacte.
  const analyses = durationEvidence.facts.filter(fiable).map((f) => analyzeDuration(f.value, hint(f))).filter((a) => a.reliable && a.months !== null);
  const mois = [...new Set(analyses.map((a) => a.months!))];
  const conventions = new Set([...durationEvidence.facts, ...lu.facts.count, ...lu.facts.periodicity, ...lu.facts.firstInstalment]
    .flatMap((f) => [f.value, f.excerpt]).filter((t): t is string => typeof t === 'string').filter((t) => RE_FIN_DE_MOIS.test(norm(t))));
  const schedule = computeScheduleDerivation(lu.facts, {
    durationMonths: mois.length === 1 ? mois[0] : null,
    durationIncludedMonths: mois.length === 1 ? analyses.flatMap((a) => a.parts.filter((p) => p.role === 'INCLUDED').map((p) => p.months)) : [],
    endOfMonth: conventions.size > 0,
    change: knownScheduleChange([...(startEvidence.lifecycleTexts ?? []).map((t) => t.text ?? null), ...lu.texts]),
  });
  return { result: combineDerivations(classic, schedule), startEvidence, durationEvidence };
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 76 (I) — LA DATE DE FIN EST-ELLE INDISPENSABLE ?
//
// Une date de fin inconnue et non calculable ne justifie une question que si
// elle conditionne une démarche : reconduction / dénonciation, préavis,
// restitution, levée d'option… Un REMBOURSEMENT PAR ÉCHÉANCES s'éteint de
// lui-même à sa dernière échéance : sans clause qui attache une démarche à
// la fin, son absence ne déclenche aucune carte (règle de pertinence
// existante, `assessDeadlinePertinence` — décision déterministe, sans IA).
// Aucune liste de types de contrats : seuls les faits lus décident.
// ══════════════════════════════════════════════════════════════════════════

/** Démarche attachée à la FIN d'un contrat (vocabulaire générique). */
const RE_DEMARCHE_DE_FIN = /\b(reconduc\w*|reconduit\w*|reconductible\w*|tacite\w*|renouvel\w*|prorog\w*|denonc\w*|preavis|restitu\w*|etat des lieux|remise des cles|option d achat|levee d option|lever l option|valeur residuelle|rachat du vehicule)\b/;
const RE_NEGATION_DEMARCHE = /\b(sans|non|pas de|aucune?|ni)\s+(\w+\s){0,2}(reconduc\w*|reconduit\w*|renouvel\w*|preavis|restitu\w*)/;

export interface EndDateNeed {
  /** Remboursement par échéances lu (échéancier, nombre d'échéances, durée de remboursement…). */
  repaymentSchedule: boolean;
  /** Clauses qui attachent une démarche à la fin (extraits bornés). */
  endActions: string[];
  /** La date de fin, inconnue, n'est nécessaire à aucune démarche identifiable. */
  notNeeded: boolean;
}

/**
 * La date de fin conditionne-t-elle une démarche ? (pure) — `textes` : textes
 * lus du contrat (document et documents du même contrat). Une démarche niée
 * (« sans tacite reconduction ») n'en est pas une.
 */
export function endDateNeed(p: { repaymentSchedule: boolean; textes: ReadonlyArray<string | null | undefined> }): EndDateNeed {
  const endActions: string[] = [];
  for (const t of p.textes) {
    if (!t) continue;
    const n = ` ${norm(t)} `;
    if (!RE_DEMARCHE_DE_FIN.test(n)) continue;
    const reste = n.replace(new RegExp(RE_NEGATION_DEMARCHE.source, 'g'), ' ');
    if (!RE_DEMARCHE_DE_FIN.test(reste)) continue;
    const e = String(t).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (endActions.length < 5 && !endActions.includes(e)) endActions.push(e);
  }
  return { repaymentSchedule: p.repaymentSchedule, endActions, notNeeded: p.repaymentSchedule && endActions.length === 0 };
}
