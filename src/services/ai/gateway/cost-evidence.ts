/**
 * Carte #838 (C2, AC17/AC19) — NATURE DU COÛT d'un ensemble de requêtes
 * fournisseur RÉELLEMENT envoyées (tentatives d'analyse, essai sans schéma,
 * réparation, essai diagnostique). PUR.
 *
 * Un montant n'est jamais présenté comme exhaustif quand une partie n'est pas
 * chiffrable :
 *   · `OBSERVED`      toutes les tentatives sont chiffrées sur une consommation
 *                     rendue (au moins une non nulle) ;
 *   · `ZERO_REPORTED` le fournisseur a explicitement rendu une consommation
 *                     NULLE pour toutes les composantes facturables de toutes
 *                     les tentatives (0 € prouvé) ;
 *   · `PARTIAL`       une partie est chiffrée, une partie INCONNUE (refus HTTP
 *                     400 sans consommation, délai, composante manquante,
 *                     tarif absent) — le montant observé est un MINIMUM, la
 *                     part inconnue est comptée ;
 *   · `NO_PRICE`      (carte #863) rien de chiffré : consommation rendue mais
 *                     AUCUN tarif autorisé (#770) pour toutes les tentatives ;
 *   · `UNKNOWN`       aucune tentative chiffrable : coût inconnu, jamais 0 ;
 *   · `NONE`          aucune requête envoyée (refus avant appel) : 0 € réel.
 *
 * Carte #863 (C1) : une tentative NON partie (`dispatch` ≠ `SENT` : garde,
 * construction, transfert sans génération) n'est ni une requête ni un coût :
 * elle est comptée à part (`notSentAttempts`). Un départ non prouvable
 * (`DEPARTURE_UNPROVEN`) est compté à part ET dans la part inconnue du coût.
 * Une tentative tracée avant la carte (sans `dispatch`) reste une requête
 * tracée (`dispatchUndetermined`), son coût suit son statut.
 *
 * Réutilise le chiffrage déjà calculé par tentative (`ProviderAttemptTrace`,
 * tarifs autorisés de `calcCostMicros`) : aucun tarif nouveau.
 */
import type { AttemptCostStatus, AttemptDispatch, ProviderAttemptTrace } from './diagnostics/taxonomy';

export type CostEvidenceStatus = 'OBSERVED' | 'ZERO_REPORTED' | 'PARTIAL' | 'NO_PRICE' | 'UNKNOWN' | 'NONE';

export interface CostEvidence {
  status: CostEvidenceStatus;
  /** Requêtes fournisseur réellement envoyées (tentatives tracées comme parties). */
  attempts: number;
  /** Somme des coûts CHIFFRÉS (observés, partiels, zéro prouvé), en micro-unités : un minimum si `PARTIAL`. */
  observedMicros: number;
  observedAttempts: number;
  zeroReportedAttempts: number;
  /** Tentatives au coût non chiffrable (`UNKNOWN`, `NO_PRICE`) : la part inconnue, jamais rabattue à 0. */
  unknownAttempts: number;
  /** Carte #863 (C2) : tentatives dont une partie seulement est chiffrée (minimum compté, reste inconnu). */
  partialAttempts?: number;
  /** Carte #863 (C2) : tentatives au tarif absent (sous-ensemble de `unknownAttempts`). */
  noPriceAttempts?: number;
  /** Carte #863 (C1) : tentatives tracées mais NON parties (garde, construction, transfert) — exclues des requêtes. */
  notSentAttempts?: number;
  /** Carte #863 (C1) : départs non prouvables (comptés dans la part inconnue, pas comme requêtes réelles). */
  unprovenAttempts?: number;
}

export const NO_COST_EVIDENCE: CostEvidence = Object.freeze({
  status: 'NONE', attempts: 0, observedMicros: 0, observedAttempts: 0, zeroReportedAttempts: 0, unknownAttempts: 0,
  partialAttempts: 0, noPriceAttempts: 0, notSentAttempts: 0, unprovenAttempts: 0,
}) as CostEvidence;

type Counts = Omit<CostEvidence, 'status'> & { partialAttempts: number; noPriceAttempts: number; notSentAttempts: number; unprovenAttempts: number };

function statusOf(e: Counts): CostEvidenceStatus {
  const total = e.attempts + e.unprovenAttempts;
  if (total === 0) return 'NONE';
  const connues = e.observedAttempts + e.zeroReportedAttempts;
  if (connues === total) return e.observedAttempts === 0 ? 'ZERO_REPORTED' : 'OBSERVED';
  if (connues === 0 && e.partialAttempts === 0) {
    return e.noPriceAttempts > 0 && e.noPriceAttempts === e.unknownAttempts && e.unprovenAttempts === 0 ? 'NO_PRICE' : 'UNKNOWN';
  }
  return 'PARTIAL';
}

const NON_PARTIES: ReadonlySet<AttemptDispatch> = new Set(['NOT_SENT_GUARD', 'NOT_SENT_BUILD', 'TRANSFER_NO_GENERATION']);

/** Nature du coût d'une liste de tentatives (une tentative sans statut : coût INCONNU). */
export function costEvidenceOf(attempts: ReadonlyArray<Pick<ProviderAttemptTrace, 'costStatus' | 'costMicros'> & { dispatch?: AttemptDispatch }>): CostEvidence {
  const e: Counts = {
    attempts: 0, observedMicros: 0, observedAttempts: 0, zeroReportedAttempts: 0, unknownAttempts: 0,
    partialAttempts: 0, noPriceAttempts: 0, notSentAttempts: 0, unprovenAttempts: 0,
  };
  for (const a of attempts) {
    if (a.dispatch && NON_PARTIES.has(a.dispatch)) { e.notSentAttempts++; continue; }
    const st: AttemptCostStatus = a.costStatus ?? 'UNKNOWN';
    if (st === 'NOT_SENT') { e.notSentAttempts++; continue; }
    if (a.dispatch === 'DEPARTURE_UNPROVEN') { e.unprovenAttempts++; e.unknownAttempts++; continue; }
    e.attempts++;
    if (st === 'OBSERVED' && typeof a.costMicros === 'number') { e.observedAttempts++; e.observedMicros += a.costMicros; }
    else if (st === 'ZERO_REPORTED') e.zeroReportedAttempts++;
    else if (st === 'PARTIAL') {
      e.partialAttempts++; e.unknownAttempts++;
      if (typeof a.costMicros === 'number') e.observedMicros += a.costMicros;
    } else {
      e.unknownAttempts++;
      if (st === 'NO_PRICE') e.noPriceAttempts++;
    }
  }
  return { ...e, status: statusOf(e) };
}

/** Somme de plusieurs natures de coût (analyse + réparation…) : une part inconnue reste visible. */
export function combineCostEvidence(...parts: ReadonlyArray<CostEvidence | null | undefined>): CostEvidence {
  const e: Counts = {
    attempts: 0, observedMicros: 0, observedAttempts: 0, zeroReportedAttempts: 0, unknownAttempts: 0,
    partialAttempts: 0, noPriceAttempts: 0, notSentAttempts: 0, unprovenAttempts: 0,
  };
  for (const p of parts) {
    if (!p) continue;
    e.attempts += p.attempts; e.observedMicros += p.observedMicros; e.observedAttempts += p.observedAttempts;
    e.zeroReportedAttempts += p.zeroReportedAttempts; e.unknownAttempts += p.unknownAttempts;
    e.partialAttempts += p.partialAttempts ?? 0; e.noPriceAttempts += p.noPriceAttempts ?? 0;
    e.notSentAttempts += p.notSentAttempts ?? 0; e.unprovenAttempts += p.unprovenAttempts ?? 0;
  }
  return { ...e, status: statusOf(e) };
}

/**
 * Carte #863 (C2) — montant utilisable comme coût EXHAUSTIF d'une réponse de
 * la passerelle : seulement si sa nature le prouve (`OBSERVED`,
 * `ZERO_REPORTED`, `NONE`, ou réponse antérieure sans nature). Sinon `null` :
 * une somme partielle n'est jamais utilisée comme un total.
 */
export function exhaustiveCostMicros(r: { costMicros: number | null | undefined; costStatus?: string | null }): number | null {
  if (r.costMicros == null || !Number.isFinite(r.costMicros)) return null;
  if (r.costStatus == null || r.costStatus === 'OBSERVED' || r.costStatus === 'ZERO_REPORTED' || r.costStatus === 'NONE') return r.costMicros;
  return null;
}

/**
 * Carte #863 (C2) — chiffrage CANONIQUE d'une tentative à partir de ses
 * compteurs (pur ; tarif injecté = `calcCostMicros` avec les tarifs autorisés
 * #770). Règles :
 *   · jetons de RÉFLEXION facturés au tarif de sortie, ajoutés à la sortie
 *     visible (Gemini : `candidatesTokenCount` les exclut) — jamais deux fois ;
 *   · `ZERO_REPORTED` seulement si entrée ET sortie sont explicitement nulles
 *     (réflexion nulle ou non rendue) ; « 0 + manquant » n'est pas un zéro ;
 *   · une seule composante rendue : `PARTIAL`, son coût est un MINIMUM ;
 *   · aucune composante : `UNKNOWN` ; un TOTAL seul n'est jamais ventilé ;
 *   · tarif absent : `NO_PRICE` (rien n'est inventé).
 */
export function attemptCost(
  t: { inputTokens: number | null | undefined; outputTokens: number | null | undefined; thoughtsTokens: number | null | undefined },
  price: (input: number, output: number) => number | null,
): { costMicros: number | null; costStatus: AttemptCostStatus } {
  const entree = typeof t.inputTokens === 'number' && Number.isFinite(t.inputTokens) ? Math.max(0, t.inputTokens) : null;
  const visible = typeof t.outputTokens === 'number' && Number.isFinite(t.outputTokens) ? Math.max(0, t.outputTokens) : null;
  const pensees = typeof t.thoughtsTokens === 'number' && Number.isFinite(t.thoughtsTokens) ? Math.max(0, t.thoughtsTokens) : null;
  const sortie = visible === null ? (pensees !== null && pensees > 0 ? pensees : null) : visible + (pensees ?? 0);
  if (entree === null && sortie === null) return { costMicros: null, costStatus: 'UNKNOWN' };
  if (entree !== null && visible !== null) {
    if (entree === 0 && sortie === 0) return { costMicros: 0, costStatus: 'ZERO_REPORTED' };
    const micros = price(entree, sortie ?? 0);
    return micros === null ? { costMicros: null, costStatus: 'NO_PRICE' } : { costMicros: micros, costStatus: 'OBSERVED' };
  }
  // Une composante manquante : la part connue est un MINIMUM, jamais un total.
  const micros = price(entree ?? 0, sortie ?? 0);
  return micros === null ? { costMicros: null, costStatus: 'NO_PRICE' } : { costMicros: micros, costStatus: 'PARTIAL' };
}
