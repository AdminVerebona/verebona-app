/**
 * Lot 114H (Trello #775, P1-D et § 6) — ISSUE ACTUELLE d'une couverture T1,
 * pour le BO (module PUR, partagé par la lecture serveur et l'écran).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SÉPARER « LIMITE DE VÉRIFICATION » ET « ANOMALIE ACTIONNABLE »
 *
 * Une image ou un PDF scanné sans couche texte reste VERIFICATION_INCOMPLETE :
 * aucun texte original indépendant ne permet de confronter la lecture. C'est
 * un choix prudent, PAS une preuve de perte. L'état et son motif sont
 * conservés (jamais COMPLETE), mais le BO ne présente plus ce document comme
 * une réparation en attente : il le classe « limite de vérification — aucune
 * action automatique », distinct d'une omission réelle.
 *
 * Six issues, chacune avec un motif vérifiable et la prochaine action RÉELLE :
 *   RESOLVED               complète ;
 *   REPAIR_SCHEDULED       une reprise automatique admissible est programmée ;
 *   TECHNICAL_ANOMALY      erreur technique avérée (source illisible, remise
 *                          en file refusée, reprise en erreur) ;
 *   CAP_REACHED            lacune ou résidu, plus aucune reprise permise ;
 *   VERIFICATION_LIMIT     non vérifiable, sans action automatique utile ;
 *   ACTIONABLE_UNRESOLVED  résidu sur lequel une action reste possible.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const COVERAGE_ISSUES = ['RESOLVED', 'REPAIR_SCHEDULED', 'TECHNICAL_ANOMALY', 'CAP_REACHED', 'VERIFICATION_LIMIT', 'ACTIONABLE_UNRESOLVED'] as const;
export type CoverageIssue = (typeof COVERAGE_ISSUES)[number];

/** Libellés BO (textes nouveaux — à valider par le PO). */
export const COVERAGE_ISSUE_LABEL: Readonly<Record<CoverageIssue, string>> = {
  RESOLVED: 'résolue',
  REPAIR_SCHEDULED: 'réparation programmée',
  TECHNICAL_ANOMALY: 'anomalie technique',
  CAP_REACHED: 'plafond atteint',
  VERIFICATION_LIMIT: 'limite de vérification — aucune action automatique',
  ACTIONABLE_UNRESOLVED: 'non résolue — action possible',
};

export interface CoverageIssueInput {
  qualityState: string;
  anomalies?: readonly string[] | null;
  nextRetryAt?: string | Date | null;
  retryAttempts?: number | null;
  maxRetries?: number | null;
  /** Diagnostics de la couverture (`verification`) — compteurs et codes seulement. */
  verification?: Record<string, unknown> | null;
  sourceVerification?: string | null;
  lastRetryResult?: string | null;
}

export interface CoverageIssueView {
  issue: CoverageIssue;
  label: string;
  /** Motif vérifiable (codes et compteurs de la couverture, jamais de contenu). */
  reason: string;
  /** Prochaine action réelle, ou explication de l'absence d'action. */
  nextAction: string;
  /** Une action (automatique ou manuelle) reste-t-elle utile ? */
  actionable: boolean;
}

/** Résultats de dernière reprise qui dénotent une erreur technique avérée. */
const TECHNICAL_RETRY_RESULTS: Readonly<Record<string, string>> = {
  REQUEUE_REJECTED_FINAL: 'remise en file T1 refusée (définitif)',
  REQUEUE_REJECTED_TRANSIENT: 'remise en file T1 refusée (transitoire)',
  REQUEUE_ACCOUNT_NOT_ELIGIBLE: 'remise en file T1 refusée : compte non éligible au traitement',
  ERROR: 'dernière reprise en erreur',
  // Carte #837 (A1) : refus d'ADMISSION à cause temporaire ou technique (aucune reprise consommée).
  'REQUEUE_NOT_ADMISSIBLE:ACCOUNT_NOT_ELIGIBLE': 'remise en file T1 refusée : compte non éligible au traitement',
  'REQUEUE_NOT_ADMISSIBLE:AI_TREATMENT_BLOCKED': 'remise en file T1 refusée : traitement T1 suspendu ou arrêté',
  'REQUEUE_NOT_ADMISSIBLE:ACCOUNT_AI_BUDGET_REACHED': 'remise en file T1 refusée : plafond de coût IA du compte atteint',
  'REQUEUE_NOT_ADMISSIBLE:IDENTITY_UNAVAILABLE': 'remise en file T1 refusée : identité des demandes indisponible (migration)',
  'REQUEUE_NOT_ADMISSIBLE:SOURCE_NOT_AVAILABLE': 'remise en file T1 refusée : fichier source absent ou supprimé',
  REQUEUE_COMPLETED_BUSINESS_FAILED: 'relecture T1 terminée en échec métier',
};

/** Refus DÉFINITIFS de la règle commune : plus aucune reprise n'est promise (carte #837, A4). */
const REFUS_DEFINITIFS = new Set(['REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED', 'REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED', 'REQUEUE_NOT_ADMISSIBLE:NOTHING_TO_RETRY']);

/**
 * Carte #837 (A4) — une ÉCHÉANCE n'est une « reprise programmée » que si une
 * reprise est encore ADMISSIBLE (pure) : plafond à 0, plafond atteint sans
 * continuation possible (unités jamais examinées, qui ne consomment pas de
 * reprise), ou refus définitif consigné après l'échéance → l'échéance est
 * HISTORIQUE, jamais affichée comme une promesse.
 */
export function scheduleAdmissible(p: CoverageIssueInput): boolean {
  if (!p.nextRetryAt) return false;
  const plafond = p.maxRetries === null || p.maxRetries === undefined ? null : Number(p.maxRetries);
  if (plafond === 0) return false;
  if (p.lastRetryResult && REFUS_DEFINITIFS.has(p.lastRetryResult)) return false;
  const tentatives = Number(p.retryAttempts ?? 0);
  if (plafond !== null && tentatives >= plafond) return nombre((p.verification ?? {}).pendingRepairUnits) > 0;
  return true;
}

/** Motifs de vérification qui relèvent d'un problème de fichier (action de l'administrateur). */
const FILE_PROBLEM_REASONS: Readonly<Record<string, string>> = {
  source_unreadable: 'fichier source illisible (téléchargement)',
  pdf_unreadable: 'PDF illisible ou corrompu',
  source_too_large: 'fichier trop volumineux pour être contrôlé',
};

/** Motifs de vérification sans preuve indépendante disponible (limite, pas perte). */
const LIMIT_REASONS: Readonly<Record<string, string>> = {
  image_not_checkable: 'image ou scan : aucun texte original indépendant à confronter',
  image_without_content: 'image sans contenu lu',
  multiple_files: 'document composé de plusieurs fichiers : contrôle page par page impossible',
  format_not_checkable: 'format non vérifiable page par page',
  pages_unverified: 'pages scannées ou sans couche texte : rien à confronter',
  backfill: 'couverture reconstruite d’une analyse antérieure, jamais confrontée au fichier',
};

const nombre = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : 0);

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115H (Trello #785, § 6) — RAPPORT HISTORIQUE IMMUABLE ≠ ÉTAT ACTUEL
 *
 * Règle complétée : une même ligne mêlait ce que l'ANALYSE avait conclu à sa
 * date (état de qualité écrit alors, anomalies, compteurs d'unités) et ce
 * qu'il en est AUJOURD'HUI (issue, reprise programmée, dernier résultat de
 * reprise). Les vues, filtres, exports et compteurs pouvaient donc afficher
 * deux statuts contradictoires pour le même document — par exemple « reprise
 * programmée » dans un onglet et « plafond atteint » dans un autre.
 *
 * Cette fonction PURE sépare les deux faces, sans rien recalculer :
 *   · `historical` — ce que le rapport d'analyse a consigné, immuable : il
 *     décrit un passé et ne doit jamais être réécrit par un recalcul ;
 *   · `current` — l'état du document maintenant : son issue, son motif, sa
 *     prochaine action réelle, et si une action reste utile.
 * Les deux portent le même document : c'est la LECTURE qui est séparée, pas
 * la donnée. Aucun texte n'est dupliqué entre les deux faces.
 * ══════════════════════════════════════════════════════════════════════════
 */
/**
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE TRELLO #837 (D4) — L'HISTORIQUE EST SOURCÉ, PAS RECONSTITUÉ
 *
 * Règle remplacée : `historical` était RECONSTITUÉ depuis les MÊMES champs de
 * couverture que `current` (état, anomalies, tentatives d'aujourd'hui) — il
 * ne pouvait donc jamais différer de l'état actuel, et un recalcul le
 * réécrivait. Il est maintenant lu dans le RAPPORT D'EXÉCUTION d'origine
 * (`ai_execution_reports`, section COVERAGE : immuable, daté, identifié) ;
 * sans rapport, la face historique est déclarée INDISPONIBLE — jamais
 * déduite de l'état actuel.
 * ══════════════════════════════════════════════════════════════════════════
 */
export interface AnalysisReportRef {
  reportId: number;
  createdAt: string | Date | null;
  /** État de qualité consigné par le rapport (null : section absente). */
  qualityState: string | null;
  anomalies: readonly string[] | null;
}

export interface CoverageHistoricalFace {
  /** `ANALYSIS_REPORT` : lu dans le rapport d'exécution d'origine ; `UNAVAILABLE` : aucun rapport (jamais reconstitué). */
  source: 'ANALYSIS_REPORT' | 'UNAVAILABLE';
  reportId: number | null;
  /** État de qualité CONSIGNÉ à l'analyse (null : indisponible). */
  qualityState: string | null;
  anomalies: readonly string[];
  /** Instant du rapport (null : inconnu). */
  reportedAt: string | null;
}

export interface CoverageCurrentFace extends CoverageIssueView {
  /** État de qualité ACTUEL de la couverture (après reprises et recalculs). */
  qualityState: string;
  anomalies: readonly string[];
  /** Reprises consommées à ce jour. */
  retryAttempts: number;
  /** Une reprise automatique ADMISSIBLE est-elle programmée MAINTENANT ? (une échéance historique ne suffit pas) */
  retryScheduled: boolean;
  /** Dernier résultat de demande de reprise consigné (code), ou null. */
  lastRetryResult: string | null;
  /** L'état actuel diffère de celui consigné à l'analyse. */
  changedSinceAnalysis: boolean | null;
}

export function splitHistoricalAndCurrent(p: CoverageIssueInput & { analysisReport?: AnalysisReportRef | null }): {
  historical: CoverageHistoricalFace; current: CoverageCurrentFace;
} {
  const r = p.analysisReport ?? null;
  const quand = !r?.createdAt ? null : r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt);
  const historical: CoverageHistoricalFace = r
    ? { source: 'ANALYSIS_REPORT', reportId: r.reportId, qualityState: r.qualityState, anomalies: [...(r.anomalies ?? [])], reportedAt: quand }
    : { source: 'UNAVAILABLE', reportId: null, qualityState: null, anomalies: [], reportedAt: null };
  const vue = coverageIssueOf(p);
  return {
    historical,
    current: {
      ...vue,
      qualityState: p.qualityState,
      anomalies: [...(p.anomalies ?? [])],
      retryAttempts: Number(p.retryAttempts ?? 0),
      retryScheduled: vue.issue === 'REPAIR_SCHEDULED',
      lastRetryResult: p.lastRetryResult ?? null,
      changedSinceAnalysis: historical.qualityState === null ? null : historical.qualityState !== p.qualityState,
    },
  };
}

/** Issue actuelle d'une couverture (pure) — voir l'en-tête. */
export function coverageIssueOf(p: CoverageIssueInput): CoverageIssueView {
  const d = p.verification ?? {};
  const raison = typeof d.verificationReason === 'string' ? d.verificationReason : p.sourceVerification === 'RECONSTRUCTED' ? 'backfill' : null;
  const tentatives = Number(p.retryAttempts ?? 0);
  const plafond = p.maxRetries === null || p.maxRetries === undefined ? null : Number(p.maxRetries);
  const auPlafond = plafond !== null && tentatives >= plafond;
  const voir = (issue: CoverageIssue, reason: string, nextAction: string, actionable: boolean): CoverageIssueView => ({
    issue, label: COVERAGE_ISSUE_LABEL[issue], reason, nextAction, actionable,
  });
  const residus = [
    nombre(d.pagesMissing) ? `${nombre(d.pagesMissing)} page(s) manquante(s)` : null,
    nombre(d.exhaustedRepairUnits) ? `${nombre(d.exhaustedRepairUnits)} réparation(s) épuisée(s)` : null,
    nombre(d.failedRepairUnits) ? `${nombre(d.failedRepairUnits)} réparation(s) sans résultat` : null,
    nombre(d.needsSourceUnits) ? `${nombre(d.needsSourceUnits)} unité(s) à relire dans le fichier` : null,
    nombre(d.uncertainUnits) ? `${nombre(d.uncertainUnits)} unité(s) incertaine(s)` : null,
  ].filter((x): x is string => x !== null).join(', ');

  if (p.qualityState === 'COMPLETE') return voir('RESOLVED', 'toutes les unités sont couvertes ou non informatives', 'Aucune.', false);

  // Carte #837 (A4) : la présence d'une date ne suffit plus — la reprise doit être encore ADMISSIBLE.
  const echeanceHistorique = !!p.nextRetryAt && !scheduleAdmissible(p);
  const historique = echeanceHistorique ? ' (échéance historique sans reprise admissible : ignorée)' : '';
  if (p.nextRetryAt && !echeanceHistorique) {
    const quoi = nombre(d.pagesMissing) > 0 ? 'relecture du fichier (pages manquantes)'
      : nombre(d.pendingRepairUnits) > 0 ? `${nombre(d.pendingRepairUnits)} unité(s) jamais examinée(s) faute de budget`
        : nombre(d.needsSourceUnits) > 0 ? 'relecture ciblée du fichier (observation incertaine)'
          : raison === 'source_unreadable' ? 'relecture du fichier (source momentanément illisible)' : 'reprise ciblée des unités en échec transitoire';
    return voir('REPAIR_SCHEDULED', quoi, `Reprise automatique programmée (reprise ${Math.min(tentatives + 1, plafond ?? tentatives + 1)} sur ${plafond ?? '?'}).`, true);
  }

  const technique = p.lastRetryResult ? TECHNICAL_RETRY_RESULTS[p.lastRetryResult] : undefined;
  if (technique) {
    return voir('TECHNICAL_ANOMALY', technique,
      p.lastRetryResult === 'REQUEUE_ACCOUNT_NOT_ELIGIBLE' ? 'Aucune tant que le compte n’est pas éligible ; la reprise repart à la réactivation du compte.'
        : 'Vérifier la Supervision (domaine IA), puis relancer l’analyse depuis cet écran.', true);
  }
  if (raison && FILE_PROBLEM_REASONS[raison]) {
    return voir('TECHNICAL_ANOMALY', FILE_PROBLEM_REASONS[raison], 'Vérifier le fichier (ouverture, taille) ; si besoin, demander un nouveau dépôt puis relancer l’analyse.', true);
  }

  if (p.qualityState === 'INCOMPLETE_FINAL' || p.qualityState === 'INCOMPLETE_RETRYABLE') {
    return voir('CAP_REACHED', `partie du document non analysée${residus ? ` — ${residus}` : ''} ; ${auPlafond || plafond === 0 ? 'plafond de reprises atteint' : 'aucune reprise automatique admissible'}${historique}`,
      'Aucune reprise automatique. Relancer l’analyse du document si l’information manquante est utile.', true);
  }

  if (p.qualityState === 'VERIFICATION_INCOMPLETE') {
    return voir('VERIFICATION_LIMIT', (raison ? LIMIT_REASONS[raison] : undefined) ?? 'couverture de la source non vérifiable',
      'Aucune action automatique : aucune preuve indépendante n’est disponible. Contrôle visuel possible ; relancer l’analyse seulement si une information manque.', false);
  }

  if (auPlafond) {
    return voir('CAP_REACHED', `part non structurée conservée${residus ? ` — ${residus}` : ''} ; plafond de reprises atteint${historique}`,
      'Aucune reprise automatique ni ciblée. Le contenu reste lu par l’assistant et la réconciliation.', false);
  }
  return voir('ACTIONABLE_UNRESOLVED', `part non structurée conservée${residus ? ` — ${residus}` : ''}`,
    '« Réconcilier (sans IA) », puis « Reprise ciblée des unités non couvertes » si des unités restent non résolues.', true);
}
