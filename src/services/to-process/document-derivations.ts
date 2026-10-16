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
 *     commencé le 01/01 finit le 31/12), tracée dans la provenance.
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

/** Libellés qui désignent une date d'édition / de document — jamais un début effectif. */
const NOT_A_START = ['edition', 'emission', 'signature', 'signe', 'document', 'facture', 'impression', 'courrier', 'envoi', 'offre'];

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
 * Durée lue → nombre de mois, sinon null (pure) : « 240 mois », « 20 ans »,
 * « 20 années », « 2 ans et 6 mois », « 36 » si la clé dit « Mois ».
 * Toute autre forme (jours, semaines, « durée indéterminée ») est refusée.
 */
export function parseDurationMonths(raw: unknown, keyHint?: string | null): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 && raw <= 1200 && /mois|months/i.test(keyHint ?? '') ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = norm(raw);
  if (!s || /indetermine|illimite|jour|semaine|day|week/.test(s)) return null;
  let total = 0;
  let found = false;
  for (const m of s.matchAll(/(\d{1,4})\s*(ans|an|annees|annee|years|year|mois|months|month)\b/g)) {
    const n = Number(m[1]);
    total += /^(ans|an|annee|annees|year|years)$/.test(m[2]) ? n * 12 : n;
    found = true;
  }
  if (!found && /^\d{1,4}$/.test(s) && /mois|months/i.test(keyHint ?? '')) { total = Number(s); found = true; }
  return found && total > 0 && total <= 1200 ? total : null;
}

/** Ajoute des mois à une date ISO puis retire un jour (fin incluse). Pure. */
export function endFromStart(startIso: string, months: number): string | null {
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const totalM = (m - 1) + months;
  const ty = y + Math.floor(totalM / 12);
  const tm = totalM % 12;
  // Jour borné à la fin du mois cible (31/01 + 1 mois → 28/02).
  const dernier = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const fin = new Date(Date.UTC(ty, tm, Math.min(d, dernier)) - 86_400_000);
  return Number.isNaN(fin.getTime()) ? null : fin.toISOString().slice(0, 10);
}

export interface DerivationSource { key: string | null; value: string; source: string; confidence: string }

export interface DerivationResult {
  /** CALCULATED_RELIABLE : écrite ; CALCULATED_PROBABLE : candidat seulement ; NOT_DERIVABLE / AMBIGUOUS. */
  status: 'CALCULATED_RELIABLE' | 'CALCULATED_PROBABLE' | 'NOT_DERIVABLE' | 'AMBIGUOUS';
  value: string | null;
  method: 'START_PLUS_DURATION';
  convention: 'END_INCLUSIVE';
  start: DerivationSource | null;
  duration: (DerivationSource & { months: number }) | null;
  reason: string;
}

const fiable = (f: EvidenceFact) => f.confidence === 'certain' && f.source === 'FACTS';

/**
 * Calcul de l'échéance depuis les connaissances lues (pure) : faits du début
 * effectif et de la durée. Fiable seulement si chaque source est un fait
 * certain et unique ; plusieurs valeurs distinctes → AMBIGUOUS.
 */
export function computeDerivation(spec: DerivationSpec, start: EvidenceFact[], duration: EvidenceFact[], durationKeyHint: (f: EvidenceFact) => string | null = () => null): DerivationResult {
  const base = { method: 'START_PLUS_DURATION' as const, convention: 'END_INCLUSIVE' as const };
  const debuts = [...new Map(start.filter((f) => typeof f.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.value)).map((f) => [String(f.value), f])).values()];
  const durees = [...new Map(duration
    .map((f) => ({ f, months: parseDurationMonths(f.value, durationKeyHint(f)) }))
    .filter((x): x is { f: EvidenceFact; months: number } => x.months !== null)
    .map((x) => [x.months, x])).values()];
  if (debuts.length === 0 || durees.length === 0) {
    return { ...base, status: 'NOT_DERIVABLE', value: null, start: null, duration: null,
      reason: debuts.length === 0 ? 'no_effective_start' : 'no_duration' };
  }
  if (debuts.length > 1 || durees.length > 1) {
    return { ...base, status: 'AMBIGUOUS', value: null, start: null, duration: null,
      reason: debuts.length > 1 ? 'several_start_dates' : 'several_durations' };
  }
  const s = debuts[0];
  const d = durees[0];
  const value = endFromStart(String(s.value), d.months);
  if (!value) return { ...base, status: 'NOT_DERIVABLE', value: null, start: null, duration: null, reason: 'invalid_start' };
  const sur = fiable(s) && fiable(d.f);
  return {
    ...base, status: sur ? 'CALCULATED_RELIABLE' : 'CALCULATED_PROBABLE', value,
    start: { key: spec.start.key, value: String(s.value), source: s.source, confidence: String(s.confidence) },
    duration: { key: spec.duration.key, value: String(d.f.value), source: d.f.source, confidence: String(d.f.confidence), months: d.months },
    reason: sur ? 'reliable_sources' : 'uncertain_sources',
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
  return { result: computeDerivation(spec, startEvidence.facts, durationEvidence.facts, hint), startEvidence, durationEvidence };
}
