/**
 * Journalisation des appels modèles — CDC §5.5.
 *
 * Chaque appel est rattaché à : un usage cible, une opération, un compte,
 * éventuellement un utilisateur, une source ou un objet, un modèle, une version
 * de prompt, un résultat métier, un coût et une durée.
 *
 * Écrit dans `ai_pipeline_step`, étendue par la migration 0101 avec
 * `use_case_code`, `operation_code` et `trace_id`. Les tables de suivi
 * existantes sont conservées et renforcées, jamais remplacées.
 */
import { db } from '@/db';
import { aiPipelineStep, aiUsageEvent } from '@/db/schema';
import type { AiUseCaseCode } from '../registry/use-cases';

export interface CallTrace {
  traceId: string;
  useCaseCode: AiUseCaseCode;
  operationCode: string;
  accountId: number;
  userId?: number;
  parentOperationId?: number;
  provider: string;
  model: string;
  promptVersion: string;
  usedFallback: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  durationMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  /** false pour le mode shadow et les opérations internes (CDC §10.2). */
  billable: boolean;
  shadow: boolean;
  outputPreview?: string;
}

export async function recordCallTrace(t: CallTrace): Promise<void> {
  try {
    if (t.parentOperationId) {
      await db.insert(aiPipelineStep).values({
        operationId: t.parentOperationId,
        stepName: t.operationCode,
        stepOrder: 0,
        provider: t.provider,
        model: t.model,
        durationMs: t.durationMs,
        status: t.status === 'success' ? 'done' : 'failed',
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        costMicros: t.costMicros,
        isFallback: t.usedFallback,
        errorCode: t.errorCode,
        errorMessage: t.errorMessage,
        promptVersion: t.promptVersion,
        outputPreview: t.outputPreview,
        // Colonnes ajoutées par la migration 0101.
        useCaseCode: t.useCaseCode,
        operationCode: t.operationCode,
        traceId: t.traceId,
      } as never);
    }

    await db.insert(aiUsageEvent).values({
      accountId: t.accountId,
      userId: t.userId,
      operationType: t.operationCode,
      provider: t.provider,
      model: t.model,
      isBillable: t.billable,
      isFallback: t.usedFallback,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costMicros: t.costMicros,
      durationMs: t.durationMs,
      status: t.status,
      errorCode: t.errorCode,
      errorMessage: t.errorMessage,
      metadata: { traceId: t.traceId, promptVersion: t.promptVersion, shadow: t.shadow },
      useCaseCode: t.useCaseCode,
      operationCode: t.operationCode,
    } as never);
  } catch (e) {
    // La télémétrie ne doit jamais faire échouer un traitement métier.
    console.error('[ai-trace] écriture impossible (non bloquant) :', (e as Error).message);
  }
}
