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
  | 'COST_CAP_REACHED'
  /**
   * Lot 34D (contrat runtime source unique) : le schéma de validation n'est
   * pas celui transmis au modèle (empreintes différentes) — défaut INTERNE du
   * moteur, détecté avant tout appel fournisseur. Jamais récupérable ;
   * diagnostiqué dans BO › Exécutions IA, jamais exposé à l'utilisateur final
   * (`isInternalAiErrorCode`).
   */
  | 'RUNTIME_CONTRACT_MISMATCH'
  /**
   * Lot 34D (T4, contexte d'exécution structuré) : contrat d'entrée T4 violé
   * ou introuvable, refusé AVANT tout appel fournisseur (0 appel). Erreurs de
   * configuration ou d'appelant, jamais récupérables.
   */
  | 'T4_INPUT_CONTRACT_MISSING_FIELD'
  | 'T4_INPUT_CONTRACT_INVALID_TYPE'
  | 'T4_TASK_NOT_ALLOWED'
  | 'T4_OUTPUT_CONTRACT_MISSING'
  | 'T4_CONTRACT_VERSION_NOT_FOUND'
  | 'T4_EXECUTION_CONTEXT_BUILD_FAILED';

/**
 * Codes TECHNIQUES internes (lot 34D) : défaut du moteur ou de sa
 * configuration, jamais affiché tel quel à l'utilisateur final — l'écran
 * utilisateur montre un message générique, le BO (Exécutions IA) le détail.
 */
export const INTERNAL_AI_ERROR_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'RUNTIME_CONTRACT_MISMATCH',
  'T4_INPUT_CONTRACT_MISSING_FIELD', 'T4_INPUT_CONTRACT_INVALID_TYPE', 'T4_TASK_NOT_ALLOWED',
  'T4_OUTPUT_CONTRACT_MISSING', 'T4_CONTRACT_VERSION_NOT_FOUND', 'T4_EXECUTION_CONTEXT_BUILD_FAILED',
]);

/** Code interne au moteur (jamais exposé à l'utilisateur final) ? */
export function isInternalAiErrorCode(code: unknown): boolean {
  return typeof code === 'string' && INTERNAL_AI_ERROR_CODES.has(code as AiErrorCode);
}

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
  /**
   * Lot 34D — détail structuré d'un refus de contrat (T4 : TASK, champ,
   * contrat, étape ; contrat runtime : empreintes de génération et de
   * validation). Destiné au BO, jamais à l'utilisateur final.
   */
  readonly contractDetail?: Record<string, unknown>;

  constructor(
    code: AiErrorCode,
    operationCode: string,
    message: string,
    opts?: { recoverable?: boolean; cause?: unknown; lastFailureCode?: AiErrorCode; contractDetail?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AiGatewayError';
    this.code = code;
    this.operationCode = operationCode;
    this.recoverable = opts?.recoverable ?? false;
    this.cause = opts?.cause;
    this.lastFailureCode = opts?.lastFailureCode;
    this.contractDetail = opts?.contractDetail;
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
 * Diagnostic attaché à une sortie invalide (lot 33D) : sous-type, étape,
 * erreurs par chemin, chaîne de contrôles et corrections tentées. Le code
 * reste `INVALID_OUTPUT` (compatibilité des appelants et de la politique
 * d'échec), le détail voyage avec l'erreur jusqu'à la trace.
 */
export interface OutputFailureDetail {
  subtype: import('./diagnostics/taxonomy').InvalidOutputSubtype;
  stage: import('./diagnostics/taxonomy').AiFailureStage;
  issues: import('./diagnostics/taxonomy').ValidationIssueDetail[];
  issueCount: number;
  controls: import('./diagnostics/taxonomy').ControlChain;
  repairs: import('./diagnostics/taxonomy').OutputRepairStep[];
  /** Texte JSON réellement parsé (extraction), s'il diffère de la réponse brute. */
  extracted: string | null;
  /** Sortie parsée, si le parsing a réussi. */
  parsed: unknown;
  /** Message d'origine (parseur, validateur). */
  originalMessage: string | null;
}

/** Sortie modèle invalide, avec son diagnostic (récupérable : modèle suivant). */
export class AiOutputInvalidError extends AiGatewayError {
  constructor(operationCode: string, message: string, readonly detail: OutputFailureDetail, cause?: unknown) {
    super('INVALID_OUTPUT', operationCode, message, { recoverable: true, cause });
    this.name = 'AiOutputInvalidError';
  }
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
    /** Lot 33D : diagnostic de la sortie (INVALID_ENUM sur le discriminant). */
    readonly detail?: OutputFailureDetail,
  ) {
    super('INVALID_OUTPUT', operationCode,
      `Sortie de la branche ${JSON.stringify(receivedTask ?? null)} au lieu de ${discriminant}=${expectedTask} (CDC 15 §22.2).`,
      { recoverable: true });
    this.name = 'AiOutputTaskMismatchError';
  }
}
