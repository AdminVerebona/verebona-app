/**
 * Service de tracking de la consommation IA
 * CDC Verebona V2 — utilisé par le pipeline d'analyse pour logguer chaque opération
 *
 * Architecture multi-provider :
 *   - Flash en priorité (gemini-2.0-flash)
 *   - Pro en fallback (gemini-2.0-pro)
 *   - Fallback invisible utilisateur, traçable en backoffice
 *
 * PRINCIPE : Les jobs déjà démarrés vont à leur terme même en cas de quota dépassé.
 */

import { db } from '@/db';
import {
  aiOperation, aiPipelineStep, aiAnalysisVersion,
  aiUsageAccountCounter, aiSecurityLock, aiUsageEvent,
} from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';

// ─── Seuils de sécurité ───────────────────────────────────────────────────────
const SECURITY_THRESHOLDS = {
  /** Nombre max de réanalyses réussies pour un même fichier avant blocage */
  REANALYSIS_LOOP_LIMIT: 5,
  /** Coût max d'une seule opération en micros (50 000 µ$ = $0.05) */
  ABERRANT_COST_MICROS: 50_000,
} as const;
import type {
  AiOperationCategory, AiBusinessResult, AiPipelineStepStatus, AiOperationOrigin,
} from '@/types/ai-usage';
import { resolveLegacyUseCase } from '@/services/ai/registry/legacy-usage-mapping';

// ─── Configuration routage multi-provider ────────────────────────────────────

/**
 * Routage par catégorie — chemin historique uniquement.
 *
 * ⚠️ Les modèles déclarés ici (`gemini-2.0-flash`, `gemini-2.0-pro`) ne figurent
 * dans AUCUNE opération du référentiel : c'est le défaut n°10 de l'audit. Les
 * lignes `ai_operation` écrites par ce chemin portent donc un nom de modèle qui
 * ne correspond pas à l'appel réellement passé, et leur coût est faux.
 *
 * Corrigé de fait par la bascule : le pipeline unifié n'utilise pas ce tracker,
 * il passe par la télémétrie de la gateway, aux modèles du référentiel. Cette
 * constante disparaît au lot 7 avec le reste du chemin historique — elle figure
 * déjà dans les symboles interdits de `check-legacy-ai.mjs` à partir de la
 * phase 6.
 *
 * Ne pas la « corriger » ici : réaligner les modèles rendrait l'historique
 * illisible, une même catégorie changeant de modèle sans qu'aucun appel n'ait
 * changé.
 */
export const DEFAULT_PROVIDER_ROUTING: Record<AiOperationCategory, { primary: string; fallback: string; primaryModel: string; fallbackModel: string }> = {
  document_analysis: { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  agenda_extraction: { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  enrichissement:    { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  supplier_detection:{ primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  embedding:         { primary: 'gemini', fallback: 'gemini', primaryModel: 'text-embedding-004', fallbackModel: 'text-embedding-004' },
  ocr:               { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  coherence_check:   { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  search:            { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
  retroactive:       { primary: 'gemini', fallback: 'gemini', primaryModel: 'gemini-2.0-flash', fallbackModel: 'gemini-2.0-pro' },
};


// ─── Types internes ───────────────────────────────────────────────────────────

export interface StartOperationOptions {
  accountId: number;
  userId?: number;
  assetFileId?: number;
  operationCategory: AiOperationCategory;
  origin?: AiOperationOrigin;
  pipelineVersion?: string;
  isReanalysis?: boolean;
  reanalysisReason?: string;
  isBillable?: boolean;
  environment?: 'production' | 'staging' | 'test';
}

export interface CompleteOperationOptions {
  operationId: number;
  businessResult: AiBusinessResult;
  totalCostMicros?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  errorCode?: string;
  errorMessage?: string;
  warningMessage?: string;
  usedFallback?: boolean;
  providerFallback?: string;
}

export interface StartStepOptions {
  operationId: number;
  stepName: string;
  stepOrder: number;
  provider?: string;
  model?: string;
  promptVersion?: string;
  inputHash?: string;
}

export interface CompleteStepOptions {
  stepId: number;
  status: AiPipelineStepStatus;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  isFallback?: boolean;
  fallbackReason?: string;
  errorCode?: string;
  errorMessage?: string;
  outputPreview?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AiUsageTracker {
  /**
   * Démarre une opération IA métier et retourne son ID.
   * À appeler au début de chaque workflow d'analyse.
   */
  static async startOperation(opts: StartOperationOptions): Promise<number> {
    const routing = DEFAULT_PROVIDER_ROUTING[opts.operationCategory];

    const [operation] = await db.insert(aiOperation).values({
      accountId: opts.accountId,
      userId: opts.userId ?? null,
      assetFileId: opts.assetFileId ?? null,
      operationCategory: opts.operationCategory,
      pipelineVersion: opts.pipelineVersion ?? null,
      origin: opts.origin ?? 'upload',
      isReanalysis: opts.isReanalysis ?? false,
      reanalysisReason: opts.reanalysisReason ?? null,
      isBillable: opts.isBillable ?? true,
      environment: opts.environment ?? 'production',
      providerPrimary: routing.primary,
      businessResult: 'pending',
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning({ id: aiOperation.id });

    return operation.id;
  }

  /**
   * Finalise une opération IA.
   * Incrémente le compteur de documents analysés si succès + billable.
   */
  static async completeOperation(opts: CompleteOperationOptions): Promise<void> {
    const op = await db
      .select({ startedAt: aiOperation.startedAt, accountId: aiOperation.accountId, isBillable: aiOperation.isBillable, operationCategory: aiOperation.operationCategory, assetFileId: aiOperation.assetFileId, pipelineVersion: aiOperation.pipelineVersion, providerPrimary: aiOperation.providerPrimary })
      .from(aiOperation)
      .where(eq(aiOperation.id, opts.operationId))
      .limit(1)
      .then(r => r[0]);

    if (!op) return;

    const durationMs = op.startedAt ? Date.now() - new Date(op.startedAt).getTime() : null;

    await db.update(aiOperation).set({
      businessResult: opts.businessResult,
      totalCostMicros: opts.totalCostMicros ?? 0,
      totalInputTokens: opts.totalInputTokens ?? 0,
      totalOutputTokens: opts.totalOutputTokens ?? 0,
      errorCode: opts.errorCode ?? null,
      errorMessage: opts.errorMessage ?? null,
      warningMessage: opts.warningMessage ?? null,
      usedFallback: opts.usedFallback ?? false,
      providerFallback: opts.providerFallback ?? null,
      completedAt: new Date(),
      durationMs,
      updatedAt: new Date(),
    }).where(eq(aiOperation.id, opts.operationId));

    // Enregistrer la version d'analyse si succès
    if ((opts.businessResult === 'success' || opts.businessResult === 'success_with_warning') && op.assetFileId) {
      await this.recordAnalysisVersion({
        assetFileId: op.assetFileId,
        operationId: opts.operationId,
        pipelineVersion: op.pipelineVersion ?? undefined,
        businessResult: opts.businessResult,
        totalCostMicros: opts.totalCostMicros ?? 0,
        providerUsed: op.providerPrimary ?? undefined,
        usedFallback: opts.usedFallback ?? false,
      });
    }

    // Incrémenter le compteur uniquement pour les analyses documentaires (pas enrichissement ni coherence_check)
    if (op.operationCategory === 'document_analysis' && op.isBillable && (opts.businessResult === 'success' || opts.businessResult === 'success_with_warning')) {
      await this.incrementAnalysisCounter(op.accountId);
    }

    // Log événement de consommation
    await this.logUsageEvent({
      accountId: op.accountId,
      assetFileId: op.assetFileId ?? undefined,
      operationType: 'operation_complete',
      costMicros: opts.totalCostMicros ?? 0,
      isBillable: op.isBillable ?? true,
    });
  }

  /**
   * Démarre une étape de pipeline et retourne son ID.
   */
  static async startStep(opts: StartStepOptions): Promise<number> {
    const [step] = await db.insert(aiPipelineStep).values({
      operationId: opts.operationId,
      stepName: opts.stepName,
      stepOrder: opts.stepOrder,
      provider: opts.provider ?? null,
      model: opts.model ?? null,
      promptVersion: opts.promptVersion ?? null,
      inputHash: opts.inputHash ?? null,
      status: 'queued',
      startedAt: new Date(),
      createdAt: new Date(),
    }).returning({ id: aiPipelineStep.id });

    // Incrémenter le compteur d'étapes de l'opération
    await db.update(aiOperation)
      .set({ stepsCount: sql`${aiOperation.stepsCount} + 1`, updatedAt: new Date() })
      .where(eq(aiOperation.id, opts.operationId));

    return step.id;
  }

  /**
   * Finalise une étape de pipeline.
   */
  static async completeStep(opts: CompleteStepOptions): Promise<void> {
    const step = await db
      .select({ startedAt: aiPipelineStep.startedAt, operationId: aiPipelineStep.operationId })
      .from(aiPipelineStep)
      .where(eq(aiPipelineStep.id, opts.stepId))
      .limit(1)
      .then(r => r[0]);

    if (!step) return;

    const durationMs = step.startedAt ? Date.now() - new Date(step.startedAt).getTime() : null;

    await db.update(aiPipelineStep).set({
      status: opts.status,
      completedAt: new Date(),
      durationMs,
      inputTokens: opts.inputTokens ?? null,
      outputTokens: opts.outputTokens ?? null,
      costMicros: opts.costMicros ?? null,
      isFallback: opts.isFallback ?? false,
      fallbackReason: opts.fallbackReason ?? null,
      errorCode: opts.errorCode ?? null,
      errorMessage: opts.errorMessage ?? null,
      outputPreview: opts.outputPreview ? opts.outputPreview.substring(0, 500) : null,
    }).where(eq(aiPipelineStep.id, opts.stepId));

    // Agréger le coût dans l'opération parente
    if (opts.costMicros) {
      await db.update(aiOperation).set({
        totalCostMicros: sql`${aiOperation.totalCostMicros} + ${opts.costMicros}`,
        totalInputTokens: sql`${aiOperation.totalInputTokens} + ${opts.inputTokens ?? 0}`,
        totalOutputTokens: sql`${aiOperation.totalOutputTokens} + ${opts.outputTokens ?? 0}`,
        updatedAt: new Date(),
      }).where(eq(aiOperation.id, step.operationId));
    }
  }

  /**
   * Enregistre une version d'analyse pour un document.
   * Marque les versions précédentes comme non-courantes.
   */
  static async recordAnalysisVersion(opts: {
    assetFileId: number;
    operationId: number;
    pipelineVersion?: string;
    businessResult: AiBusinessResult;
    totalCostMicros: number;
    providerUsed?: string;
    usedFallback: boolean;
  }): Promise<void> {
    // Dé-marquer les versions précédentes
    await db.update(aiAnalysisVersion)
      .set({ isCurrent: false })
      .where(eq(aiAnalysisVersion.assetFileId, opts.assetFileId));

    // Compter les versions existantes
    const existingCount = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(aiAnalysisVersion)
      .where(eq(aiAnalysisVersion.assetFileId, opts.assetFileId))
      .then(r => r[0]?.cnt ?? 0);

    await db.insert(aiAnalysisVersion).values({
      assetFileId: opts.assetFileId,
      operationId: opts.operationId,
      versionNumber: existingCount + 1,
      pipelineVersion: opts.pipelineVersion ?? null,
      businessResult: opts.businessResult,
      totalCostMicros: opts.totalCostMicros,
      providerUsed: opts.providerUsed ?? null,
      usedFallback: opts.usedFallback,
      isCurrent: true,
      analysisDate: new Date(),
      createdAt: new Date(),
    });
  }

  /**
   * Incrémente le compteur de documents analysés du compte.
   * Appelé uniquement après un workflow terminé + succès.
   */
  static async incrementAnalysisCounter(accountId: number): Promise<void> {
    const currentYear = new Date().getFullYear();

    // Upsert compteur
    await db.insert(aiUsageAccountCounter)
      .values({
        accountId,
        periodYear: currentYear,
        documentsAnalyzedCount: 1,
        documentsAnalyzedQuota: 0,
        trialDocumentsCount: 0,
        trialDocumentsQuota: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [aiUsageAccountCounter.accountId, aiUsageAccountCounter.periodYear],
        set: {
          documentsAnalyzedCount: sql`${aiUsageAccountCounter.documentsAnalyzedCount} + 1`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Vérifie si le compte peut analyser un document.
   * Retourne { allowed: true } ou { allowed: false, reason: ... }
   */
  static async checkQuota(accountId: number): Promise<{ allowed: boolean; reason?: string }> {
    const currentYear = new Date().getFullYear();

    // Vérifier blocage sécurité
    const lock = await db
      .select({ id: aiSecurityLock.id })
      .from(aiSecurityLock)
      .where(and(eq(aiSecurityLock.accountId, accountId), eq(aiSecurityLock.isResolved, false)))
      .limit(1)
      .then(r => r[0]);

    if (lock) {
      return { allowed: false, reason: 'security_lock' };
    }

    // Vérifier quota documentaire
    const counter = await db
      .select({
        documentsAnalyzedCount: aiUsageAccountCounter.documentsAnalyzedCount,
        documentsAnalyzedQuota: aiUsageAccountCounter.documentsAnalyzedQuota,
      })
      .from(aiUsageAccountCounter)
      .where(and(eq(aiUsageAccountCounter.accountId, accountId), eq(aiUsageAccountCounter.periodYear, currentYear)))
      .limit(1)
      .then(r => r[0]);

    if (counter && counter.documentsAnalyzedQuota > 0 && counter.documentsAnalyzedCount >= counter.documentsAnalyzedQuota) {
      return { allowed: false, reason: 'quota_exceeded' };
    }

    return { allowed: true };
  }

  /**
   * Lève un blocage sécurité IA pour un compte.
   */
  static async triggerSecurityLock(opts: {
    accountId: number;
    assetFileId?: number;
    lockType: string;
    triggerDetails?: string;
  }): Promise<void> {
    // Ne pas créer de doublon pour un même type de lock actif
    const existing = await db
      .select({ id: aiSecurityLock.id })
      .from(aiSecurityLock)
      .where(
        and(
          eq(aiSecurityLock.accountId, opts.accountId),
          eq(aiSecurityLock.lockType, opts.lockType),
          eq(aiSecurityLock.isResolved, false),
        )
      )
      .limit(1)
      .then(r => r[0]);

    if (existing) return;

    await db.insert(aiSecurityLock).values({
      accountId: opts.accountId,
      assetFileId: opts.assetFileId ?? null,
      lockType: opts.lockType,
      triggerDetails: opts.triggerDetails ?? null,
      triggeredAt: new Date(),
      isResolved: false,
      createdAt: new Date(),
    });
  }

  /**
   * Vérifie les règles de sécurité après une opération et déclenche les blocages si nécessaire.
   * À appeler après completeOperation (succès) ou checkReanalysisLoop (avant analyse).
   *
   * @param opts.accountId   Compte concerné
   * @param opts.assetFileId Fichier analysé (pour reanalysis_loop)
   * @param opts.totalCostMicros Coût de l'opération (pour aberrant_cost)
   * @param opts.checkReanalysis  Si true, vérifie la boucle de réanalyse
   * @param opts.checkCost        Si true, vérifie le coût aberrant
   */
  static async checkSecurityRules(opts: {
    accountId: number;
    assetFileId?: number;
    totalCostMicros?: number;
    checkReanalysis?: boolean;
    checkCost?: boolean;
  }): Promise<void> {
    const checks: Promise<void>[] = [];

    // 1. Boucle de réanalyse : > LIMIT réanalyses réussies pour ce fichier
    if (opts.checkReanalysis && opts.assetFileId) {
      checks.push((async () => {
        const reanalysisCount = await db
          .select({ cnt: sql<number>`count(*)::int` })
          .from(aiOperation)
          .where(
            and(
              eq(aiOperation.assetFileId, opts.assetFileId!),
              eq(aiOperation.isReanalysis, true),
              eq(aiOperation.businessResult, 'success'),
            )
          )
          .then(r => r[0]?.cnt ?? 0);

        if (reanalysisCount >= SECURITY_THRESHOLDS.REANALYSIS_LOOP_LIMIT) {
          await AiUsageTracker.triggerSecurityLock({
            accountId: opts.accountId,
            assetFileId: opts.assetFileId,
            lockType: 'reanalysis_loop',
            triggerDetails: `Document réanalysé ${reanalysisCount} fois (seuil : ${SECURITY_THRESHOLDS.REANALYSIS_LOOP_LIMIT})`,
          });
        }
      })());
    }

    // 2. Coût aberrant : une opération dépasse le seuil unitaire
    if (opts.checkCost && opts.totalCostMicros !== undefined) {
      checks.push((async () => {
        if (opts.totalCostMicros! >= SECURITY_THRESHOLDS.ABERRANT_COST_MICROS) {
          await AiUsageTracker.triggerSecurityLock({
            accountId: opts.accountId,
            assetFileId: opts.assetFileId,
            lockType: 'aberrant_cost',
            triggerDetails: `Coût opération : ${opts.totalCostMicros} µ$ (seuil : ${SECURITY_THRESHOLDS.ABERRANT_COST_MICROS} µ$)`,
          });
        }
      })());
    }

    await Promise.allSettled(checks);
  }

  /**
   * Log un événement de consommation IA (granulaire).
   */
  static async logUsageEvent(opts: {
    accountId: number;
    userId?: number;
    assetFileId?: number;
    operationType: string;
    provider?: string;
    model?: string;
    isBillable?: boolean;
    isFallback?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
    durationMs?: number;
    status?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    try {
      await db.insert(aiUsageEvent).values({
        accountId: opts.accountId,
        userId: opts.userId ?? null,
        assetFileId: opts.assetFileId ?? null,
        operationType: opts.operationType,
        // Rattachement à l'écriture. La migration 0110 ne complète que les
        // lignes existantes ; sans ceci, tout événement produit par un moteur
        // historique après le déploiement reste non rattaché — et les moteurs
        // historiques tournent tant que les drapeaux valent `legacy`.
        useCaseCode: resolveLegacyUseCase(opts.operationType),
        provider: opts.provider ?? null,
        model: opts.model ?? null,
        isBillable: opts.isBillable ?? true,
        isFallback: opts.isFallback ?? false,
        inputTokens: opts.inputTokens ?? null,
        outputTokens: opts.outputTokens ?? null,
        costMicros: opts.costMicros ?? null,
        durationMs: opts.durationMs ?? null,
        status: opts.status ?? 'success',
        errorCode: opts.errorCode ?? null,
        errorMessage: opts.errorMessage ?? null,
        createdAt: new Date(),
      });
    } catch (e) {
      // Les événements de log ne doivent pas bloquer le pipeline
      console.error('[AiUsageTracker.logUsageEvent]', e);
    }
  }
}
