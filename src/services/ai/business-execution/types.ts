/**
 * Exécution métier — lot 83C (CDC Pilotage IA V2, phase P2 « exécution métier
 * et issue finale » : SEM-01 à SEM-06, OP-04 à OP-06, RES-01/02, BO-04/05).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PROJECTION, PAS UN SECOND JOURNAL
 *
 * L'exécution métier n'est écrite nulle part : elle est CALCULÉE à la lecture
 * depuis les états NATIFS, qui restent la seule vérité (OP-04) :
 *   T1  travail de file × document logique (`ai_job_queue`), rapport
 *       d'exécution (`ai_execution_reports`), état du document
 *       (`asset_files`) et qualité de couverture
 *       (`document_extraction_coverage`) ;
 *   T2  demande de l'assistant (`verebona_request_runs`, réponse
 *       `verebona_messages.support_level`) ;
 *   T3  travail de file (`ai_job_queue.business_result`) et rapport T3 ;
 *   T4  travail de file (`business_result`, erreurs T4_*) ;
 *   T6  génération FORMULATE (`home_mascot_generations`) et évaluation
 *       EVALUATE (`t6_evaluation_runs`).
 * Aucun nouveau statut n'est écrit dans ces tables. La qualification
 * administrative (Réussie / Incomplète / Échouée / non finale) est rendue AVEC
 * le résultat natif et la cause : rien n'est perdu (OP-04).
 *
 * Choix motivé (vue calculée plutôt que table dérivée) : toujours exacte au
 * moment de la lecture, aucune écriture ajoutée sur les chemins métier (ni
 * crochet à oublier, ni dérive à réparer), rien à purger, sauvegarder ou
 * restaurer ; le coût est borné par la période lue (index 0669).
 * ══════════════════════════════════════════════════════════════════════════
 */

export const BUSINESS_TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T6'] as const;
export type BusinessTreatment = (typeof BUSINESS_TREATMENTS)[number];

/**
 * Qualification administrative (CDC §10) :
 *   SUCCEEDED     Réussie — résultats et contrôles obligatoires satisfaits ;
 *   INCOMPLETE    Incomplète — un résultat existe, une partie ou un contrôle
 *                 obligatoire reste non vérifié (critère objectif, RES-02) ;
 *   FAILED        Échouée — aucun résultat métier exploitable ;
 *   NOT_FINAL     non finale — en attente, en cours ou suspendue (OP-06) ;
 *   VOID          sans objet — annulée, remplacée par un travail plus récent,
 *                 cible disparue : ni réussite ni échec (R39) ;
 *   UNDETERMINED  non déterminable — l'état natif ne permet pas de conclure
 *                 (historique sans preuve, BO-05) : jamais deviné.
 * Seules SUCCEEDED / INCOMPLETE / FAILED sont des issues comptées.
 */
export const BUSINESS_OUTCOMES = ['SUCCEEDED', 'INCOMPLETE', 'FAILED', 'NOT_FINAL', 'VOID', 'UNDETERMINED'] as const;
export type BusinessOutcome = (typeof BUSINESS_OUTCOMES)[number];

/** Avancement d'une exécution non finale. */
export type BusinessProgress = 'PENDING' | 'RUNNING' | 'SUSPENDED';

export const OUTCOME_LABELS: Record<BusinessOutcome, string> = {
  SUCCEEDED: 'Réussie',
  INCOMPLETE: 'Incomplète',
  FAILED: 'Échouée',
  NOT_FINAL: 'Non finale',
  VOID: 'Sans objet',
  UNDETERMINED: 'Non déterminable',
};

export const PROGRESS_LABELS: Record<BusinessProgress, string> = {
  PENDING: 'en attente',
  RUNNING: 'en cours',
  SUSPENDED: 'suspendue (reprise prévue)',
};

/** Libellé court d'une qualification (« Non finale — en cours »). Pur. */
export function outcomeLabel(outcome: BusinessOutcome, progress: BusinessProgress | null): string {
  return outcome === 'NOT_FINAL' && progress ? `${OUTCOME_LABELS.NOT_FINAL} — ${PROGRESS_LABELS[progress]}` : OUTCOME_LABELS[outcome];
}

/** Issues finales (une date de fin existe). */
export const FINAL_OUTCOMES: ReadonlySet<BusinessOutcome> = new Set(['SUCCEEDED', 'INCOMPLETE', 'FAILED', 'VOID', 'UNDETERMINED']);
/** Issues comptées dans les indicateurs (cartes P3, tableau de bord). */
export const COUNTED_OUTCOMES: ReadonlySet<BusinessOutcome> = new Set(['SUCCEEDED', 'INCOMPLETE', 'FAILED']);

/** SEM-06 : nature de l'exécution. Une exécution technique ne compte jamais dans les indicateurs métier. */
export type BusinessNature = 'BUSINESS' | 'TECHNICAL';
export const NATURE_LABELS: Record<BusinessNature, string> = { BUSINESS: 'Métier', TECHNICAL: 'Technique' };

/**
 * SEM-06 : origine explicite de l'exécution (au démarrage). Une reprise ne
 * change pas l'origine : elle est comptée dans `resumptions`.
 */
export type BusinessOrigin = 'USER' | 'AUTOMATIC' | 'ADMIN' | 'RESUME' | 'TEST' | 'UNKNOWN';
export const ORIGIN_LABELS: Record<BusinessOrigin, string> = {
  USER: 'utilisateur', AUTOMATIC: 'automatique', ADMIN: 'administrateur', RESUME: 'reprise', TEST: 'test', UNKNOWN: 'inconnue',
};

/** État natif d'où vient la qualification (OP-04 : jamais perdu). */
export interface NativeResult {
  /** Table / objet natif décisif (`ai_job_queue`, `ai_execution_reports`, `document_extraction_coverage`…). */
  source: string;
  /** Statut natif (DONE, FAILED, COMPLETED, ok…). */
  status: string;
  /** Résultat natif complémentaire (APPLIED, NO_CHANGE, ABSTAIN, COMPLETE_WITH_UNRESOLVED, partial…). */
  result?: string | null;
  /** Compteurs ou codes (jamais de valeur métier). */
  detail?: Record<string, unknown> | null;
}

/** Résultat d'une fonction de qualification (pure). */
export interface Qualification {
  outcome: BusinessOutcome;
  progress: BusinessProgress | null;
  /** Cause établie, ou null (réussite). Codes et libellés, jamais de donnée métier. */
  cause: string | null;
  native: NativeResult;
  /** Fin réelle (dernier résultat) si l'issue est finale. */
  finishedAt: Date | null;
  /** Dernière activité connue (toutes sources natives). */
  lastActivityAt: Date;
}

/** Exécution métier projetée. */
export interface BusinessExecution extends Qualification {
  id: string;
  treatment: BusinessTreatment;
  /** T6 : FORMULATE / EVALUATE ; T3 : sorte de travail ; T1/T2/T4 : null. */
  mode: string | null;
  nature: BusinessNature;
  origin: BusinessOrigin;
  accountId: number | null;
  /** Objet traité : document logique (T1), demande (T2), bien / cible (T3), source (T4), échéance (T6E). */
  objectType: string | null;
  objectId: string | null;
  /** SEM-02 : date de déclenchement (mise en file, demande). */
  triggeredAt: Date;
  /** Premier début réel connu. */
  startedAt: Date | null;
  /** SEM-02 / BO-05 : date retenue pour la période (fin si finale, sinon dernière activité). */
  referenceAt: Date;
  /** Reprises de CETTE exécution (tentatives de job, remises en file, reprises ciblées). */
  resumptions: number;
  /** Filiation : exécution précédente du même objet (nouvelle exécution). */
  previousExecutionId: string | null;
  jobIds: number[];
  reportIds: number[];
  traceIds: string[];
}

/** Récapitulatif d'un traitement sur une période (BO-04 : chaque exécution comptée une fois). */
export interface TreatmentSummary {
  treatment: BusinessTreatment;
  succeeded: number;
  incomplete: number;
  failed: number;
  notFinal: number;
  void: number;
  undetermined: number;
  /** Exécutions techniques (hors indicateurs métier). */
  technical: number;
}
