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
   * Version de la source analysée. Entre dans la clé d'idempotence (§5.7) :
   * réanalyser la même version ne doit pas produire un second appel.
   */
  sourceVersion?: number;
  /** Rattache l'appel à une opération métier existante (`ai_operation.id`). */
  parentOperationId?: number;
  /** Mode observation : trace écrite, résultat non appliqué (CDC §10.2). */
  shadow?: boolean;
}

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
