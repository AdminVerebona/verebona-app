/**
 * Contrats de la couche unique d'accès aux modèles — CDC §5.2.
 */
import type { ZodType } from 'zod';
import type { AiUseCaseCode } from '../registry/use-cases';

export interface AiAttachment {
  /** URL signée (S3) ou URI fournisseur déjà uploadée. */
  url: string;
  mimeType: string;
  displayName?: string;
  /**
   * Contenu déjà en mémoire, encodé en base64 : transmis tel quel en données
   * en ligne, sans téléchargement ni extraction. Sert aux modules historiques
   * migrés (images extraites d'un DOCX scanné, fichiers téléchargés côté
   * serveur) — `url` n'est alors qu'un libellé de trace.
   */
  data?: string;
}

export interface AiGatewayRequest<T> {
  useCaseCode: AiUseCaseCode;
  operationCode: string;
  accountId: number;
  userId?: number;
  /** Sources concernées — sert à la trace et à la clé d'idempotence. */
  sourceIds?: number[];
  /** Substitutions du prompt versionné. */
  promptVariables: Record<string, unknown>;
  /**
   * Contenu de prompt fourni à l'appel, réservé aux opérations déclarées
   * `dynamicPrompt`. Toute autre opération l'ignore : un prompt hors
   * gouvernance ne doit pas pouvoir être injecté (CDC §4.5).
   */
  promptOverride?: string;
  attachments?: AiAttachment[];
  outputSchema: ZodType<T>;
  /**
   * Clé d'idempotence (CDC §5.7). Si absente, elle est dérivée de
   * compte + opération + sources + hash des variables.
   */
  idempotencyKey?: string;
  /**
   * Durée de vie, en secondes, du résultat mis en cache sous cette clé. Absent :
   * durée par défaut du service d'idempotence (1 h). L'assistant y passe sa
   * fenêtre d'idempotence (CDC Assistant §43).
   */
  idempotencyTtlSeconds?: number;
  /**
   * Version de la source analysée. Entre dans la clé d'idempotence (§5.7) :
   * réanalyser la même version ne doit pas produire un second appel.
   */
  sourceVersion?: number;
  /** Rattache l'appel à une opération métier existante (`ai_operation.id`). */
  parentOperationId?: number;
  /** Mode observation : trace écrite, résultat non appliqué (CDC §10.2). */
  shadow?: boolean;
  /**
   * Nombre maximal de tentatives modèle (principal puis replis) pour CET
   * appel. Absent : toute la chaîne configurée. Sert au budget par message
   * de l'assistant (CDC Assistant §15.5, CA-07 : au plus 2 appels modèle par
   * message utilisateur, toutes opérations confondues). Une valeur < 1
   * n'autorise aucun appel.
   */
  maxModelAttempts?: number;
  /**
   * Rang du premier modèle sollicité dans la chaîne (0 = principal, 1 =
   * premier repli…). Absent : 0. Sert à l'ESCALADE explicite de l'assistant
   * (CDC Assistant §15.4) : le modèle d'escalade est appelé seul, sans
   * rappeler le principal. Combiné à `maxModelAttempts`, qui compte à partir
   * de ce rang.
   */
  firstModelIndex?: number;
  /**
   * Plafond de jetons de sortie imposé par l'appelant (CDC Assistant §13.9,
   * §31.2 : 500). Ne peut que RÉDUIRE la valeur configurée, jamais l'augmenter.
   */
  maxOutputTokensCap?: number;
  /**
   * Plafond de durée par tentative imposé par l'appelant (CDC Assistant
   * §30.1 : 12 s par appel). Ne peut que réduire le timeout de l'opération.
   */
  timeoutMsCap?: number;
  /**
   * Mode JSON natif du fournisseur (`responseMimeType: application/json`)
   * pour CET appel. Absent : valeur déclarée par l'opération (`jsonResponse`).
   * Sert au dernier recours « texte libre » de l'analyse historique
   * (gemini-client), qui relance le dernier modèle sans le mode JSON.
   */
  jsonResponse?: boolean;
  /**
   * Mode d'appel déclaré par l'appelant, figé dans la trace
   * (`ai_usage_event.metadata.callerMode`) pour filtrer Exécutions et Coûts.
   * CDC Mascotte BO-009 : `displayed` (génération attendue par l'affichage)
   * ou `pregeneration` (pré-génération non affichée).
   */
  callerMode?: 'displayed' | 'pregeneration';
  /**
   * Branche TASK/MODE du prompt maître imposée par le serveur (CDC 15 DP-05,
   * ARCH-03), tracée dans `ai_usage_event.task`.
   *
   * Opération master (`masterPromptCode` + `task` au référentiel) : inutile,
   * la gateway prend celle de l'opération et la trace ; fournie et
   * différente ⇒ refus `TASK_MISMATCH`. Autre opération : tracée telle quelle.
   */
  task?: string;
  /**
   * Prompt maître appliqué (CDC 15 DP-05, D-03), tracé en colonnes (0217).
   * Rempli par la gateway pour une opération master (version = fichier ou
   * empreinte du texte de la version de configuration).
   */
  masterPromptCode?: string;
  masterPromptVersion?: string;
  /**
   * Déclencheur effectif (CDC 15 OBS-CFG, CFG-04), figé en métadonnée. Absent :
   * déclencheur du job de file courant (`job-context`), sinon aucun.
   */
  triggerCode?: string;
  /**
   * Moteur réellement utilisé (CDC 15 CFG-05). Absent : déduit de l'opération
   * — `legacy` pour un prompt historique relayé (`legacyPrompt`), `new` sinon.
   */
  engine?: AiEngine;
  /**
   * Lot 22 : appel d'ADMINISTRATION non soumis au plafond mensuel de coût du
   * compte (`account-cost-cap`) — campagnes de mesure du BO (corpus). T5 et
   * les appels sans compte en sont exemptés d'office ; ne jamais le poser
   * pour un usage déclenché par l'utilisateur.
   */
  costCapExempt?: boolean;
}

/** Moteur d'une exécution (CDC 15 CFG-05) : relais historique ou nouveau moteur. */
export type AiEngine = 'legacy' | 'new';

export interface AiGatewayResponse<T> {
  data: T;
  provider: string;
  model: string;
  promptVersion: string;
  usedFallback: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  durationMs: number;
  traceId: string;
  /** true si le résultat provient du cache d'idempotence (aucun appel émis). */
  fromCache: boolean;
}
