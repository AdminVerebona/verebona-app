/**
 * Erreurs typées de la gateway — CDC §5.2 (gestion des erreurs) et §11.4
 * (« le pipeline reste fonctionnel si le fournisseur IA est indisponible »).
 */
export type AiErrorCode =
  | 'OPERATION_UNKNOWN'
  | 'OPERATION_INACTIVE'
  | 'USE_CASE_MISMATCH'
  | 'PROVIDER_UNAVAILABLE'
  /**
   * Lot 52B : requête REFUSÉE par le fournisseur (HTTP 400 INVALID_ARGUMENT,
   * contexte trop grand, clé refusée, structured output refusé) — le
   * fournisseur répond, ce n'est pas une indisponibilité. Récupérable comme
   * avant (modèle suivant, reprise de la file) : seul le libellé change.
   */
  | 'PROVIDER_REQUEST_REJECTED'
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
   * Lot 82A (C-Q10, §3.3) : compte non actif (essai échu), suspendu ou en
   * lecture seule — aucun traitement métier (T1, T2, T3, T4, T6). Refusé
   * AVANT tout contact fournisseur, jamais récupérable : dans une exécution
   * de file, c'est une interruption (le travail est neutralisé) ; hors file,
   * l'appelant prend son repli sans IA.
   */
  | 'ACCOUNT_INELIGIBLE'
  /**
   * Lot 34D (contrat runtime source unique) : le schéma de validation n'est
   * pas celui transmis au modèle (empreintes différentes) — défaut INTERNE du
   * moteur, détecté avant tout appel fournisseur. Jamais récupérable ;
   * diagnostiqué dans BO › Exécutions IA, jamais exposé à l'utilisateur final
   * (`isInternalAiErrorCode`).
   */
  | 'RUNTIME_CONTRACT_MISMATCH'
  /**
   * Lot 61 (incident fileId=98) : requête IMPOSSIBLE À CONSTRUIRE localement
   * (en-tête HTTP invalide — nom de fichier Unicode NFD —, paramètre non
   * encodable). Rien n'a été envoyé au fournisseur ; l'erreur est identique
   * sur tous les modèles : jamais récupérable, aucun repli. Défaut interne,
   * jamais exposé tel quel à l'utilisateur final.
   */
  | 'REQUEST_BUILD_FAILED'
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
  | 'T4_EXECUTION_CONTEXT_BUILD_FAILED'
  /**
   * Lot 85C (CDC Pilotage IA V2 P4, CFG-03, R02) : combinaison modèle +
   * paramètres CONNUE comme incompatible d'après la fiche de capacités du
   * modèle (niveau ou budget de raisonnement non accepté, limite de sortie
   * inférieure au plancher de l'opération, entrée image refusée…). Refusée
   * AVANT tout appel fournisseur, jamais une indisponibilité de Gemini ;
   * RÉCUPÉRABLE pour la chaîne : un autre modèle (profil propre) peut convenir.
   */
  | 'MODEL_PARAMETERS_INCOMPATIBLE'
  /**
   * Lot 87A (CDC Pilotage IA V2 P7, RUN-02, R11) : aucun secours ADMISSIBLE
   * après une panne de disponibilité (quota, indisponibilité, délai, modèle
   * connu indisponible, paramètre refusé, accès global) — l'exécution est
   * SUSPENDUE sans nouvelle écriture métier. Jamais récupérable dans
   * l'exécution (aucun modèle improvisé) : dans la file, le travail est remis
   * en attente et repris automatiquement depuis un point sûr ; hors file,
   * l'appelant prend son repli sans IA. Cause et décisions de secours portées
   * par `AiSuspendedError`.
   */
  | 'AI_SUSPENDED';

/**
 * Codes TECHNIQUES internes (lot 34D) : défaut du moteur ou de sa
 * configuration, jamais affiché tel quel à l'utilisateur final — l'écran
 * utilisateur montre un message générique, le BO (Exécutions IA) le détail.
 */
const INTERNAL_AI_ERROR_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'RUNTIME_CONTRACT_MISMATCH', 'REQUEST_BUILD_FAILED',
  'T4_INPUT_CONTRACT_MISSING_FIELD', 'T4_INPUT_CONTRACT_INVALID_TYPE', 'T4_TASK_NOT_ALLOWED',
  'T4_OUTPUT_CONTRACT_MISSING', 'T4_CONTRACT_VERSION_NOT_FOUND', 'T4_EXECUTION_CONTEXT_BUILD_FAILED',
  'MODEL_PARAMETERS_INCOMPATIBLE', 'AI_SUSPENDED',
]);

/** Code interne au moteur (jamais exposé à l'utilisateur final) ? */
export function isInternalAiErrorCode(code: unknown): boolean {
  return typeof code === 'string' && INTERNAL_AI_ERROR_CODES.has(code as AiErrorCode);
}

/**
 * Lot 61 — erreur LOCALE et DÉTERMINISTE levée pendant la construction de la
 * requête (étape `request_build`), avant tout envoi : réessayer sur un autre
 * modèle reproduirait exactement la même erreur.
 *
 *   · erreur marquée `deterministic: true` par l'adaptateur
 *     (`AttachmentRequestBuildError`) ;
 *   · `TypeError` de validation d'en-tête de `fetch`/`Request` (undici :
 *     « Cannot convert argument to a ByteString », « Invalid header … »).
 *
 * JAMAIS déterministes (repli conservé) : erreurs réseau (`fetch failed`),
 * HTTP 4xx/5xx du stockage ou de la Files API, délai d'activation d'un
 * fichier, erreurs du SDK.
 */
export function isDeterministicLocalError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if ((e as { deterministic?: unknown }).deterministic === true) return true;
  if (!(e instanceof TypeError)) return false;
  return /ByteString|Invalid header (name|value)|is an invalid header value|Headers\.(append|set)/i.test(e.message);
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
 * Lot 87A (P7, RUN-02) — exécution SUSPENDUE : aucun secours admissible.
 * `failureCause` : cause établie de la dernière panne (`fallback-policy`) ;
 * `decisions` : chaque choix ou refus de la chaîne (rang, modèle, motif).
 */
export class AiSuspendedError extends AiGatewayError {
  constructor(
    operationCode: string,
    message: string,
    readonly failureCause: string,
    readonly decisions: ReadonlyArray<Record<string, unknown>>,
    lastFailureCode?: AiErrorCode,
    /**
     * Traitement de l'opération suspendue (`null` : usage technique). Une
     * suspension n'interrompt un travail de file que pour SON traitement : un
     * appel secondaire d'un autre traitement (T3 dans une analyse T1) garde
     * son repli local (`execution-control#isExecutionCancelled`).
     */
    readonly treatment: string | null = null,
  ) {
    super('AI_SUSPENDED', operationCode, message, { recoverable: false, lastFailureCode });
    this.name = 'AiSuspendedError';
  }
}

/** Suspension IA (aucun secours admissible) ? Reconnue par son code. */
export function isAiSuspended(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'AI_SUSPENDED';
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
