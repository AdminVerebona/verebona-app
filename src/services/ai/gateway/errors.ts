/**
 * Erreurs typées de la gateway — CDC §5.2 (gestion des erreurs) et §11.4
 * (« le pipeline reste fonctionnel si le fournisseur IA est indisponible »).
 */
export type AiErrorCode =
  | 'OPERATION_UNKNOWN'
  | 'OPERATION_INACTIVE'
  | 'USE_CASE_MISMATCH'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'ALL_MODELS_FAILED'
  | 'MISSING_COST_ENTRY'
  | 'QUOTA_EXCEEDED'
  /**
   * Appel refusé AVANT tout contact fournisseur : arrêt d'urgence engagé, ou
   * traitement désactivé / suspendu (CDC BO IA OPS-011, OPS-008, WF-07, WF-08,
   * MOD-012). Jamais récupérable : réessayer sur un autre modèle ou plus tard
   * dans la même exécution n'a pas de sens, c'est une décision d'exploitation.
   */
  | 'AI_BLOCKED'
  /**
   * Requête d'opération master contredisant le référentiel (CDC 15 §22.2,
   * DP-05) : TASK ou master différents de ceux de l'opération. Erreur
   * d'appelant, jamais récupérable.
   */
  | 'TASK_MISMATCH'
  /**
   * Prompt maître inutilisable (CDC 15 §22.3, D-03) : introuvable, sans
   * `{{TASK}}` ou sans la section de la branche, variable non déclarée ou
   * emplacement sans valeur. Identique sur tous les modèles : non récupérable.
   */
  | 'MASTER_PROMPT_INVALID'
  /**
   * Lot 22 : plafond mensuel de coût IA du compte atteint (offre ou
   * dérogation, `account-cost-cap`). Refusé AVANT tout contact fournisseur,
   * jamais récupérable dans la période : la file durable reporte le travail
   * au début de la période suivante, les usages synchrones prennent leur
   * repli sans IA.
   */
  | 'COST_CAP_REACHED';

export class AiGatewayError extends Error {
  readonly code: AiErrorCode;
  readonly operationCode: string;
  readonly recoverable: boolean;
  readonly cause?: unknown;
  /**
   * `ALL_MODELS_FAILED` uniquement : code de l'échec du DERNIER modèle
   * sollicité. Permet à un appelant de distinguer une sortie invalide
   * (`INVALID_OUTPUT`) d'une panne technique sans analyser le message.
   */
  readonly lastFailureCode?: AiErrorCode;

  constructor(
    code: AiErrorCode,
    operationCode: string,
    message: string,
    opts?: { recoverable?: boolean; cause?: unknown; lastFailureCode?: AiErrorCode },
  ) {
    super(message);
    this.name = 'AiGatewayError';
    this.code = code;
    this.operationCode = operationCode;
    this.recoverable = opts?.recoverable ?? false;
    this.cause = opts?.cause;
    this.lastFailureCode = opts?.lastFailureCode;
  }
}

export function isAiGatewayError(e: unknown): e is AiGatewayError {
  return e instanceof AiGatewayError;
}

/**
 * Plafond mensuel de coût IA du compte atteint (lot 22). Porte la date de
 * reprise (début de la période suivante, Europe/Paris) : la file durable y
 * reporte le travail, l'analyse l'affiche à l'utilisateur.
 */
export class AiCostCapReachedError extends AiGatewayError {
  constructor(
    operationCode: string,
    readonly accountId: number,
    readonly capMicros: number,
    readonly spentMicros: number,
    readonly resumeAt: Date,
  ) {
    super('COST_CAP_REACHED', operationCode,
      `Plafond IA du mois atteint pour le compte ${accountId} (${spentMicros} / ${capMicros} micro-unités) — reprise le ${resumeAt.toISOString()}.`);
    this.name = 'AiCostCapReachedError';
  }
}

/**
 * Refus pour plafond de coût du compte ? Reconnu par son code (l'erreur peut
 * traverser une frontière de module ou être enveloppée une fois : `cause`).
 */
export function isCostCapReached(e: unknown): boolean {
  const code = (x: unknown) => (typeof x === 'object' && x !== null ? (x as { code?: unknown }).code : undefined);
  if (code(e) === 'COST_CAP_REACHED') return true;
  const cause = typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined;
  return code(cause) === 'COST_CAP_REACHED';
}

/** Date de reprise portée par un refus pour plafond (`null` : inconnue). */
export function costCapResumeAt(e: unknown): Date | null {
  for (const x of [e, typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined]) {
    const r = typeof x === 'object' && x !== null ? (x as { resumeAt?: unknown }).resumeAt : undefined;
    if (r instanceof Date && !Number.isNaN(r.getTime())) return r;
    if (typeof r === 'string' && !Number.isNaN(Date.parse(r))) return new Date(r);
  }
  return null;
}

/**
 * Sortie d'une opération master dont `task` n'est pas la branche demandée
 * (CDC 15 §22.2, validation discriminée). Code `INVALID_OUTPUT` et
 * récupérable, comme toute sortie invalide : le modèle suivant est essayé et
 * `lastFailureCode` reste `INVALID_OUTPUT` pour les appelants existants. Les
 * deux branches sont portées pour le diagnostic.
 */
export class AiOutputTaskMismatchError extends AiGatewayError {
  constructor(
    operationCode: string,
    readonly expectedTask: string,
    readonly receivedTask: unknown,
    /** Discriminant du master : `TASK` (T1, T3, T4) ou `MODE` (T2, §24). */
    readonly discriminant: 'TASK' | 'MODE' = 'TASK',
  ) {
    super('INVALID_OUTPUT', operationCode,
      `Sortie de la branche ${JSON.stringify(receivedTask ?? null)} au lieu de ${discriminant}=${expectedTask} (CDC 15 §22.2).`,
      { recoverable: true });
    this.name = 'AiOutputTaskMismatchError';
  }
}
