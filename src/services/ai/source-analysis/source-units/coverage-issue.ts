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
};

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

  if (p.nextRetryAt) {
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
    return voir('CAP_REACHED', `partie du document non analysée${residus ? ` — ${residus}` : ''} ; ${auPlafond || plafond === 0 ? 'plafond de reprises atteint' : 'aucune reprise automatique admissible'}`,
      'Aucune reprise automatique. Relancer l’analyse du document si l’information manquante est utile.', true);
  }

  if (p.qualityState === 'VERIFICATION_INCOMPLETE') {
    return voir('VERIFICATION_LIMIT', (raison ? LIMIT_REASONS[raison] : undefined) ?? 'couverture de la source non vérifiable',
      'Aucune action automatique : aucune preuve indépendante n’est disponible. Contrôle visuel possible ; relancer l’analyse seulement si une information manque.', false);
  }

  if (auPlafond) {
    return voir('CAP_REACHED', `part non structurée conservée${residus ? ` — ${residus}` : ''} ; plafond de reprises atteint`,
      'Aucune reprise automatique ni ciblée. Le contenu reste lu par l’assistant et la réconciliation.', false);
  }
  return voir('ACTIONABLE_UNRESOLVED', `part non structurée conservée${residus ? ` — ${residus}` : ''}`,
    '« Réconcilier (sans IA) », puis « Reprise ciblée des unités non couvertes » si des unités restent non résolues.', true);
}
