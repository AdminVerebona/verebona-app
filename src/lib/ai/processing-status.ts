/**
 * Statut FONCTIONNEL d'un traitement IA vu par l'utilisateur — lot 34C
 * (ticket « ne plus exposer les erreurs techniques IA aux utilisateurs »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * APPLICATION UTILISATEUR ≠ BO › EXÉCUTIONS IA
 *
 * L'application ne reçoit QUE :
 *   · `processingStatus` — calculé côté serveur à partir de l'état RÉEL du
 *     traitement (job de file vivant, état du document) ;
 *   · `userMessageCode`  — code d'un référentiel FERMÉ (ci-dessous), traduit
 *     en texte par l'application ;
 *   · `retryScheduled`   — une nouvelle tentative existe réellement en file
 *     (jamais déduite d'un échec).
 *
 * Aucun message technique (modèle, fournisseur, prompt, schéma, champ,
 * « Invalid input », pile…) ne peut devenir un texte utilisateur : le texte
 * vient exclusivement de `USER_MESSAGES`. Le diagnostic reste dans
 * BO › Exécutions IA.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « EN FILE D'ATTENTE » SEULEMENT SI UN JOB ATTEND VRAIMENT
 *
 * `PENDING` n'est rendu QUE si un job de file est réellement en attente
 * (`ai_job_queue.status = 'PENDING'`). Un document resté « UPLOADED » sans
 * job vivant n'est pas « en file » : il est `NOT_PROCESSED` (aucun
 * traitement en cours ni prévu), sans message.
 *
 * Module pur, sans import serveur : utilisable par le front et testé seul.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Statuts fonctionnels (ticket) + `NOT_PROCESSED` (aucun traitement en cours ni prévu). */
export const PROCESSING_STATUSES = [
  'PENDING', 'PROCESSING', 'RETRYING', 'COMPLETED', 'NEEDS_USER_ACTION', 'FAILED_FINAL', 'NOT_PROCESSED',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/**
 * Référentiel FERMÉ des messages utilisateur. Ajouter un code impose d'en
 * écrire le texte (le compilateur l'exige dans `USER_MESSAGES`).
 */
export const USER_MESSAGE_CODES = [
  'FILE_UNREADABLE',
  'FILE_PASSWORD_PROTECTED',
  'FILE_CORRUPTED',
  'FILE_UNSUPPORTED',
  'FILE_EMPTY',
  'ANALYSIS_FAILED_FINAL',
  'ANALYSIS_DEFERRED_COST_CAP',
] as const;
export type UserMessageCode = (typeof USER_MESSAGE_CODES)[number];

/** Codes qui appellent une action de l'utilisateur (fichier à remplacer). */
export const USER_ACTION_CODES: ReadonlySet<UserMessageCode> = new Set<UserMessageCode>([
  'FILE_UNREADABLE', 'FILE_PASSWORD_PROTECTED', 'FILE_CORRUPTED', 'FILE_UNSUPPORTED', 'FILE_EMPTY',
]);

/** Message générique d'un échec définitif (texte imposé par le ticket). */
export const ANALYSIS_FAILED_FINAL_MESSAGE = 'L’analyse automatique de ce document n’a pas pu être finalisée.';

export const USER_MESSAGES: Record<UserMessageCode, string> = {
  FILE_UNREADABLE: 'Ce document est illisible et ne peut pas être analysé automatiquement. Vous pouvez le déposer à nouveau ou renseigner les informations manuellement.',
  FILE_PASSWORD_PROTECTED: 'Ce document est protégé et ne peut pas être analysé automatiquement.',
  FILE_CORRUPTED: 'Ce document semble endommagé et ne peut pas être analysé automatiquement. Vous pouvez le déposer à nouveau.',
  FILE_UNSUPPORTED: 'Ce format de document ne peut pas être analysé automatiquement.',
  FILE_EMPTY: 'Ce document est vide et ne peut pas être analysé automatiquement.',
  ANALYSIS_FAILED_FINAL: ANALYSIS_FAILED_FINAL_MESSAGE,
  ANALYSIS_DEFERRED_COST_CAP: 'Plafond IA du mois atteint : l’analyse sera lancée automatiquement le 1er du mois.',
};

export function isUserMessageCode(v: unknown): v is UserMessageCode {
  return typeof v === 'string' && (USER_MESSAGE_CODES as readonly string[]).includes(v);
}

export function isProcessingStatus(v: unknown): v is ProcessingStatus {
  return typeof v === 'string' && (PROCESSING_STATUSES as readonly string[]).includes(v);
}

/** « 1er novembre » (fuseau de Paris), comme le motif historique du plafond (lot 22). */
function resumeLabel(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mois = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', month: 'long' }).format(d);
  return `1er ${mois}`;
}

/**
 * Texte d'un code — SEULE source de texte utilisateur d'un état de
 * traitement. Un code inconnu (client plus ancien que le serveur) rend le
 * message générique, jamais une valeur reçue.
 */
export function userMessageText(code: unknown, params: { resumeAt?: string | null } = {}): string | null {
  if (code === null || code === undefined) return null;
  if (!isUserMessageCode(code)) return ANALYSIS_FAILED_FINAL_MESSAGE;
  if (code === 'ANALYSIS_DEFERRED_COST_CAP' && params.resumeAt) {
    const l = resumeLabel(params.resumeAt);
    if (l) return `Plafond IA du mois atteint, reprise le ${l} : l’analyse sera lancée automatiquement.`;
  }
  return USER_MESSAGES[code];
}

/** Libellé court du statut (pastille, en-tête de bloc) ; `null` : rien à afficher. */
export const PROCESSING_STATUS_LABELS: Record<ProcessingStatus, string | null> = {
  PENDING: 'En file d’attente',
  PROCESSING: 'Analyse en cours',
  RETRYING: 'Analyse en cours',
  COMPLETED: null,
  NEEDS_USER_ACTION: 'Action requise',
  FAILED_FINAL: 'Analyse non finalisée',
  NOT_PROCESSED: null,
};

// ── Calcul (côté serveur, à partir de l'état réel) ──────────────────────────

/** Job de file T1 vivant du document (`PENDING` ou `RUNNING`), lu en base. */
export interface LiveJobSnapshot {
  status: 'PENDING' | 'RUNNING';
  /** Exécutions déjà consommées (`ai_job_queue.attempts`). */
  attempts: number;
  /** Prochaine prise possible (`available_at`, ISO). */
  availableAt?: string | null;
  /** Report pour plafond de coût du compte (lot 22), ISO. */
  costCapDeferredUntil?: string | null;
}

export interface ProcessingInput {
  /** `asset_files.analysis_state`. */
  analysisState: string | null | undefined;
  /** Job T1 vivant du document, `null` s'il n'y en a aucun. */
  liveJob: LiveJobSnapshot | null;
  /**
   * Code fonctionnel de l'échec constaté (classé côté serveur à partir du
   * motif technique, jamais transmis tel quel). `null` : échec sans action
   * possible de l'utilisateur.
   */
  failureCode?: UserMessageCode | null;
}

export interface ProcessingView {
  processingStatus: ProcessingStatus;
  userMessageCode: UserMessageCode | null;
  /** Une nouvelle tentative du job existe réellement en file. */
  retryScheduled: boolean;
  /** Prochaine tentative prévue (job en attente), ISO ; `null` sinon. */
  nextAttemptAt: string | null;
  /** Report pour plafond : date de reprise (ISO), pour le texte du message. */
  resumeAt: string | null;
}

/** États d'un document dont l'analyse a abouti. */
const COMPLETED_STATES = new Set(['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'FUSION_SUGGESTED']);

export function computeProcessingStatus(input: ProcessingInput, now: number = Date.now()): ProcessingView {
  const vue = (s: ProcessingStatus, extra: Partial<ProcessingView> = {}): ProcessingView => ({
    processingStatus: s, userMessageCode: null, retryScheduled: false, nextAttemptAt: null, resumeAt: null, ...extra,
  });
  const job = input.liveJob;

  // 1. Un job vivant fait foi, quel que soit l'état (transitoire) du document :
  //    un échec intermédiaire de la cascade ou d'une tentative n'est jamais
  //    montré tant que le traitement continue (cas 1, cas 2).
  if (job?.status === 'RUNNING') {
    // RETRYING : uniquement une VRAIE reprise (2e exécution ou plus) en cours.
    return vue(job.attempts >= 2 ? 'RETRYING' : 'PROCESSING');
  }
  if (job?.status === 'PENDING') {
    const differe = job.costCapDeferredUntil && new Date(job.costCapDeferredUntil).getTime() > now
      ? job.costCapDeferredUntil : null;
    if (differe) {
      return vue('PENDING', { userMessageCode: 'ANALYSIS_DEFERRED_COST_CAP', resumeAt: differe, nextAttemptAt: job.availableAt ?? null });
    }
    // Une exécution déjà consommée puis remise en file : retry RÉEL (cas 2).
    return vue('PENDING', { retryScheduled: job.attempts >= 1, nextAttemptAt: job.availableAt ?? null });
  }

  // 2. Aucun job vivant : l'état du document, sans jamais « en file » (cas 7).
  const state = (input.analysisState ?? '').toUpperCase();
  if (state === 'ANALYZING') return vue('PROCESSING'); // analyse directe (tiroir), hors file
  if (COMPLETED_STATES.has(state)) return vue('COMPLETED');
  if (state === 'ANALYSIS_FAILED') {
    const code = input.failureCode && USER_ACTION_CODES.has(input.failureCode) ? input.failureCode : null;
    return code
      ? vue('NEEDS_USER_ACTION', { userMessageCode: code })
      : vue('FAILED_FINAL', { userMessageCode: 'ANALYSIS_FAILED_FINAL' });
  }
  // UPLOADED sans job, UPLOADING, NULL : aucun traitement en cours ni prévu.
  return vue('NOT_PROCESSED');
}

/** Le traitement est-il terminé (plus rien à attendre) ? Lu par le bandeau d'analyse. */
export function isSettledProcessingStatus(s: unknown): boolean {
  return s === 'COMPLETED' || s === 'NEEDS_USER_ACTION' || s === 'FAILED_FINAL' || s === 'NOT_PROCESSED';
}

/**
 * État d'affichage du tiroir à partir du statut fonctionnel : le tiroir garde
 * ses libellés existants (« En file d'attente », « Analyse en cours… »…)
 * mais ne les choisit plus sur l'état brut du document.
 */
export function displayAnalysisState(analysisState: string | null | undefined, status: ProcessingStatus | null | undefined): string | null {
  switch (status) {
    case 'PENDING': return 'UPLOADED';
    case 'PROCESSING': case 'RETRYING': return 'ANALYZING';
    case 'NEEDS_USER_ACTION': case 'FAILED_FINAL': return 'ANALYSIS_FAILED';
    case 'NOT_PROCESSED': return null;
    case 'COMPLETED': return analysisState ?? null;
    default: return analysisState ?? null;
  }
}
