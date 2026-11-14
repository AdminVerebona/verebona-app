/**
 * Lot 114H (Trello #775, P1-A) — RÈGLE UNIQUE DES REPRISES T1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « UNE ACTION UTILE, AUTORISÉE ET ENCORE RÉALISABLE EXISTE-T-ELLE ? »
 *
 * Avant ce lot, la réponse était recalculée à cinq endroits (rapport de
 * complétude, écriture de la couche A, tâche `t1-completeness-retry`, reprise
 * manuelle du BO, re-vérification du stock) avec des bornes différentes :
 *   · `buildCompletenessReport` rendait INCOMPLETE_RETRYABLE dès qu'une unité
 *     était PENDING ou qu'une page manquait, même plafond consommé ;
 *   · `retryDocument` reprogrammait alors `next_retry_at` sans fin (délai
 *     croissant, mais jamais d'arrêt) pour un document sans action exécutable.
 *
 * Ce module PUR (aucun accès base, aucun appel IA) est maintenant la seule
 * source de cette décision. Il lit TOUTES les bornes :
 *   T1_COMPLETENESS_MAX_RETRIES        reprises par document (0 : aucune
 *                                      reprise automatique, d'aucune sorte) ;
 *   plafond par unité                  T1_MAX_REPAIR_PASSES + reprises
 *                                      (`repairAttemptCap`) ;
 *   T1_REPAIR_CONTINUATION_MAX_RUNS    passages de continuation (travail
 *                                      jamais exécuté faute de budget) ;
 *   T1_REPAIR_MAX_CALLS                appels par passe ;
 *   plafond de relecture du fichier    par unité NEEDS_SOURCE.
 * Le délai (`next_retry_at`) et le budget IA du compte (plafond de coût de la
 * passerelle, éligibilité) restent appliqués par leurs gardes existantes, au
 * moment de l'exécution : ils ne rendent jamais une action « admissible ».
 *
 * Distinction conservée (carte, § 2.5) : « encore du travail jamais exécuté
 * faute de budget » (CONTINUATION, ne consomme pas de reprise, plafond
 * propre) ≠ « vraies tentatives épuisées » (REPAIR_EXHAUSTED).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { selectRepairUnits, selectSourceRereadUnits } from './coverage';
import { residualPolicyOf } from './coverage-reconciliation';
import type { CoveredSourceUnit, SourceLayer, T1CompletenessReport, T1QualityState } from './types';
import { T1_COMPLETENESS_ANOMALIES } from './types';

type Env = Record<string, string | undefined>;

const entier = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

/** Bornes effectives des reprises T1 (mêmes lectures d'environnement que `repository`, `repair` et `jobs`). */
export interface RetryLimits {
  /** `T1_COMPLETENESS_MAX_RETRIES` (0 à 5, défaut 2). */
  maxRetries: number;
  /** Tentatives de réparation au plus par unité. */
  unitCap: number;
  /** Relectures du fichier au plus par unité NEEDS_SOURCE. */
  sourceCap: number;
  /** `T1_REPAIR_CONTINUATION_MAX_RUNS` (1 à 200, défaut 20). */
  continuationMaxRuns: number;
  /** `T1_REPAIR_MAX_CALLS` (1 à 10, défaut 3). */
  repairMaxCalls: number;
}

/** Passages de CONTINUATION au plus par document (`T1_REPAIR_CONTINUATION_MAX_RUNS`). */
export function continuationMaxRuns(env: Env = process.env): number {
  return entier(env.T1_REPAIR_CONTINUATION_MAX_RUNS, 20, 1, 200);
}

/** Reprises automatiques d'un document (`T1_COMPLETENESS_MAX_RETRIES`, 2 par défaut, 0 à 5). */
export function completenessMaxRetries(env: Env = process.env): number {
  return entier(env.T1_COMPLETENESS_MAX_RETRIES, 2, 0, 5);
}

/** Passes de réparation à l'analyse (`T1_MAX_REPAIR_PASSES`, 0 à 2) et appels par passe (`T1_REPAIR_MAX_CALLS`, 1 à 10). */
export function repairBounds(env: Env = process.env): { maxPasses: number; maxCalls: number } {
  return { maxPasses: entier(env.T1_MAX_REPAIR_PASSES, 1, 0, 2), maxCalls: entier(env.T1_REPAIR_MAX_CALLS, 3, 1, 10) };
}

export function retryLimits(env: Env = process.env): RetryLimits {
  const maxRetries = completenessMaxRetries(env);
  const { maxPasses, maxCalls } = repairBounds(env);
  return {
    maxRetries,
    unitCap: Math.max(1, maxPasses + maxRetries),
    sourceCap: Math.max(1, maxRetries),
    continuationMaxRuns: continuationMaxRuns(env),
    repairMaxCalls: maxCalls,
  };
}

/** Actions de reprise qu'une tâche peut réellement exécuter. */
export type RetryAction =
  /** Le document repasse dans la file T1 (lacune de pages, page manquante, source momentanément illisible). */
  | 'REQUEUE_T1'
  /** Relecture ciblée du fichier (observation visuelle incertaine). */
  | 'SOURCE_REREAD'
  /** Réparation textuelle d'unités en échec TRANSITOIRE ou en attente (consomme une reprise). */
  | 'TEXT_REPAIR'
  /** Unités jamais examinées faute de budget (ne consomme pas de reprise). */
  | 'CONTINUATION';

/** Motif stable de l'absence d'action automatique. */
export type RetryBlock =
  | 'NOTHING_TO_RETRY'
  | 'RETRIES_DISABLED'
  | 'RETRY_CAP_REACHED'
  | 'CONTINUATION_CAP_REACHED'
  | 'UNIT_CAP_REACHED'
  | 'NOT_AUTOMATIC';

/** Faits d'un document dont dépend la décision (compteurs, jamais de contenu). */
export interface RetryFacts {
  /** Unités PENDING encore sélectionnables par la réparation (texte, plafond par unité non atteint). */
  pendingSelectable: number;
  /** Unités PENDING au total (sélectionnables ou non). */
  pending: number;
  /** Unités en échec transitoire de réparation, encore sélectionnables. */
  transientRepairable: number;
  /** Lots de pages non analysés, réessayables. */
  retryablePageGaps: number;
  /** Pages dont le texte original est absent de la lecture (omission objectivée). */
  missingPages: number;
  /** Unités NEEDS_SOURCE dont le plafond de relecture n'est pas atteint. */
  sourceRereadable: number;
  /** Vérification incomplète pour une cause transitoire (source momentanément illisible). */
  transientVerification: boolean;
  /** Unités qu'une reprise MANUELLE (BO, contrôle de cohérence) pourrait encore réparer. */
  manuallyRepairable: number;
}

export interface RetryBudget {
  retryAttempts: number;
  continuationRuns: number;
}

export interface RetryDecision {
  /** Actions AUTOMATIQUES admissibles (vide : rien ne doit être programmé). */
  actions: RetryAction[];
  /** Une reprise automatique est admissible : seule condition d'un `next_retry_at`. */
  automatic: boolean;
  /** Une reprise manuelle (BO) consommant une reprise resterait possible. */
  manual: boolean;
  /** Motif de l'absence d'action automatique (null : au moins une action). */
  blocked: RetryBlock | null;
  /**
   * Motif porté par la POLITIQUE d'une unité jamais tentée quand le document n'a plus de reprise
   * (`REPAIR_NOT_RUN:<motif>`) ; null tant qu'une reprise reste. Ne dépend que des bornes et des tentatives du
   * document : stable d'un recalcul à l'autre (idempotence de la réconciliation).
   */
  unitMotive: 'RETRIES_DISABLED' | 'RETRY_CAP_REACHED' | null;
}

/** Motifs de vérification pour lesquels une relecture automatique peut lever l'incertitude (même liste que `verification-followup`). */
const TRANSIENT_VERIFICATION_REASONS: ReadonlySet<string> = new Set(['source_unreadable']);

/** Faits d'un document, depuis ses unités (après `withRepairStates`) et ses diagnostics (pure). */
export function retryFactsOf(units: readonly CoveredSourceUnit[], d: {
  qualityState?: string | null; verificationReason?: string | null; pagesMissing?: readonly number[] | null;
}, limits: RetryLimits): RetryFacts {
  const selectionnables = selectRepairUnits(units, limits.unitCap);
  const ids = new Set(selectionnables.map((u) => u.sourceUnitId));
  const enAttente = units.filter((u) => u.repairState === 'PENDING');
  return {
    pending: enAttente.length,
    pendingSelectable: enAttente.filter((u) => ids.has(u.sourceUnitId)).length,
    transientRepairable: selectionnables.filter((u) => u.status === 'FAILED' && u.reason === 'repair_failed:retryable').length,
    retryablePageGaps: units.filter((u) => u.kind === 'PAGE_GAP' && u.status === 'FAILED' && u.payload.retryable === true).length,
    missingPages: d.pagesMissing?.length ?? 0,
    sourceRereadable: selectSourceRereadUnits(units, limits.sourceCap).length,
    transientVerification: d.qualityState === 'VERIFICATION_INCOMPLETE' && TRANSIENT_VERIFICATION_REASONS.has(d.verificationReason ?? ''),
    manuallyRepairable: selectionnables.length,
  };
}

/**
 * LA règle (pure). Aucune action n'est admissible au-delà d'une borne ; une
 * borne à 0 ou déjà dépassée (valeur réduite après coup) vaut « atteinte ».
 */
export function decideRetry(f: RetryFacts, b: RetryBudget, limits: RetryLimits): RetryDecision {
  const reste = limits.maxRetries > 0 && b.retryAttempts < limits.maxRetries;
  const actions: RetryAction[] = [];
  if (reste && (f.retryablePageGaps > 0 || f.missingPages > 0 || f.transientVerification)) actions.push('REQUEUE_T1');
  if (reste && f.sourceRereadable > 0) actions.push('SOURCE_REREAD');
  // Réparation textuelle ordinaire (consomme une reprise) : échec transitoire, ou unités en attente quand la
  // continuation n'est plus permise.
  if (reste && (f.transientRepairable > 0 || f.pendingSelectable > 0) && limits.repairMaxCalls > 0) actions.push('TEXT_REPAIR');
  // Continuation : travail jamais exécuté — plafond propre, mais jamais quand les reprises sont désactivées (0).
  if (limits.maxRetries > 0 && f.pendingSelectable > 0 && b.continuationRuns < limits.continuationMaxRuns && limits.repairMaxCalls > 0) {
    actions.push('CONTINUATION');
  }
  const manual = reste && f.manuallyRepairable > 0;
  const unitMotive = reste ? null : limits.maxRetries <= 0 ? 'RETRIES_DISABLED' as const : 'RETRY_CAP_REACHED' as const;
  if (actions.length > 0) return { actions, automatic: true, manual, blocked: null, unitMotive };
  const aFaire = f.retryablePageGaps > 0 || f.missingPages > 0 || f.transientVerification || f.pending > 0 || f.transientRepairable > 0
    || f.sourceRereadable > 0;
  let blocked: RetryBlock;
  if (!aFaire && f.manuallyRepairable === 0) blocked = 'NOTHING_TO_RETRY';
  else if (limits.maxRetries <= 0) blocked = 'RETRIES_DISABLED';
  // Rien d'automatique : des unités restent réparables à la demande tant qu'une reprise est disponible.
  else if (!aFaire) blocked = reste ? 'NOT_AUTOMATIC' : 'RETRY_CAP_REACHED';
  else if (f.pending > 0 && f.pendingSelectable === 0) blocked = 'UNIT_CAP_REACHED';
  else if (f.pendingSelectable > 0 && b.continuationRuns >= limits.continuationMaxRuns) blocked = 'CONTINUATION_CAP_REACHED';
  else blocked = 'RETRY_CAP_REACHED';
  return { actions, automatic: false, manual, blocked, unitMotive };
}

/**
 * SYNCHRONISE les unités avec l'absence de reprise automatique (carte § 2.4) —
 * à n'appeler que si `decision.automatic` est faux. Pure et idempotente.
 *   · unité PENDING : l'attente n'est plus annoncée. Jamais « épuisée »
 *     (aucune tentative n'a eu lieu) : l'état de réparation redevient vide ;
 *   · unité jamais tentée, quand plus aucune reprise (même manuelle) n'est
 *     possible : politique « réparation non exécutée » avec le MOTIF du
 *     plafond du document (`REPAIR_NOT_RUN:RETRY_CAP_REACHED` ou
 *     `:RETRIES_DISABLED`), distincte de REPAIR_EXHAUSTED
 *     (vraies tentatives épuisées) ; si une reprise manuelle reste possible,
 *     la politique dit simplement « non tentée » ;
 *   · échec « réessayable » : la politique ne promet plus une reprise
 *     programmée (TECHNICAL_FAILURE_FINAL — reprise manuelle).
 * Le texte, les preuves et les compteurs de tentatives ne sont jamais touchés.
 */
export function releaseUnschedulablePending<U extends CoveredSourceUnit>(units: readonly U[], decision: Pick<RetryDecision, 'manual' | 'unitMotive'>): U[] {
  const motif = decision.manual ? null : decision.unitMotive;
  return units.map((u) => {
    if (u.status === 'COVERED' || u.status === 'NON_INFORMATIONAL') return u.repairState === 'PENDING' ? { ...u, repairState: null } : u;
    if (u.status === 'FAILED') {
      const politique = u.residualPolicy === 'REPAIR_RETRY_SCHEDULED' || u.residualPolicy === 'REPAIR_PENDING' ? 'TECHNICAL_FAILURE_FINAL' : u.residualPolicy;
      return u.repairState === 'PENDING' || politique !== u.residualPolicy ? { ...u, repairState: u.repairState === 'PENDING' ? null : u.repairState, residualPolicy: politique } : u;
    }
    if (u.repairState === 'PENDING') {
      const libere = { ...u, repairState: null };
      return { ...libere, residualPolicy: residualPolicyOf(libere, { repairSkipped: motif }) };
    }
    return motif && u.residualPolicy === 'REPAIR_NOT_ATTEMPTED' ? { ...u, residualPolicy: `REPAIR_NOT_RUN:${motif}` } : u;
  });
}

/** Décision d'un document depuis sa couche (unités + rapport) — raccourci des appelants. */
export function decideLayerRetry(units: readonly CoveredSourceUnit[], report: Pick<T1CompletenessReport, 'qualityState' | 'diagnostics'>,
  b: RetryBudget, limits: RetryLimits): RetryDecision {
  return decideRetry(retryFactsOf(units, {
    qualityState: report.qualityState, verificationReason: report.diagnostics?.verificationReason ?? null,
    pagesMissing: report.diagnostics?.pagesMissing ?? [],
  }, limits), b, limits);
}

/** Couverture de la source non établie (même définition que `buildCompletenessReport`). */
function sourceNonVerifiee(report: T1CompletenessReport): boolean {
  const d = report.diagnostics;
  if (!d) return false;
  return d.sourceVerification === 'UNVERIFIABLE' || d.sourceVerification === 'RECONSTRUCTED'
    || (d.sourceVerification === 'PARTIAL' && d.pagesMissing.length === 0);
}

/**
 * GARDE FINALE DES ÉCRITURES (toutes origines : analyse, reprise, réconciliation).
 *
 * Une couche annoncée INCOMPLETE_RETRYABLE sans action automatique admissible
 * est ramenée à un état final cohérent AVEC SA CAUSE, sans jamais devenir
 * COMPLETE :
 *   · unité en échec, section tronquée ou page manquante (lacune réelle)
 *     → INCOMPLETE_FINAL (Supervision, reprise manuelle) ;
 *   · seules des unités en attente (jamais examinées) → l'attente est levée
 *     (`releaseUnschedulablePending`), le document est VERIFICATION_INCOMPLETE
 *     si sa source n'est pas vérifiée, sinon COMPLETE_WITH_UNRESOLVED ; les
 *     unités, leur texte et leurs preuves sont conservés.
 * Rend aussi la décision : l'appelant n'écrit `next_retry_at` que si
 * `decision.automatic`. Pure : rend une NOUVELLE couche si elle change.
 */
export function settleLayerRetry(layer: SourceLayer, b: RetryBudget, limits: RetryLimits): { layer: SourceLayer; decision: RetryDecision; settled: boolean } {
  const decision = decideLayerRetry(layer.units, layer.report, b, limits);
  const r = layer.report;
  if (decision.automatic) return { layer, decision, settled: false };
  const units = releaseUnschedulablePending(layer.units, decision);
  const unitesChangees = units.some((u, i) => u !== layer.units[i]);
  const anomaliesActuelles: readonly string[] = r.anomalies ?? [];
  if (r.qualityState !== 'INCOMPLETE_RETRYABLE' && !unitesChangees && !anomaliesActuelles.includes('REPAIR_PENDING')) return { layer, decision, settled: false };
  let quality: T1QualityState = r.qualityState;
  if (r.qualityState === 'INCOMPLETE_RETRYABLE') {
    const lacune = r.failedUnits > 0 || r.truncatedSectionsCount > 0 || (r.diagnostics?.pagesMissing.length ?? 0) > 0;
    quality = lacune ? 'INCOMPLETE_FINAL' : sourceNonVerifiee(r) ? 'VERIFICATION_INCOMPLETE' : 'COMPLETE_WITH_UNRESOLVED';
  }
  const anomalies = new Set<string>(anomaliesActuelles);
  anomalies.delete('REPAIR_PENDING');
  if (quality === 'INCOMPLETE_FINAL') anomalies.add('COVERAGE_INCOMPLETE'); else anomalies.delete('COVERAGE_INCOMPLETE');
  if (quality === 'VERIFICATION_INCOMPLETE') anomalies.add('COVERAGE_UNVERIFIED');
  const politiques: Record<string, number> = {};
  for (const u of units) if (u.residualPolicy) politiques[u.residualPolicy] = (politiques[u.residualPolicy] ?? 0) + 1;
  const report: T1CompletenessReport = {
    ...r,
    qualityState: quality,
    anomalies: T1_COMPLETENESS_ANOMALIES.filter((a) => anomalies.has(a)),
    ...(r.diagnostics ? { diagnostics: { ...r.diagnostics, pendingRepairUnits: 0, residualPolicies: politiques } } : {}),
  };
  return { layer: { ...layer, units, report, retryable: false }, decision, settled: true };
}

