/**
 * GET /api/admin/ai/inventory
 *
 * Inventaire d'exécution — CDC §12, critères n°1 et n°24.
 *
 * « Un inventaire d'exécution recense exactement cinq usages IA actifs. »
 *
 * Cette route est la preuve technique opposable : elle interroge le référentiel
 * réellement embarqué dans le code déployé, et non une documentation. Elle
 * renvoie 409 si le décompte diffère de cinq — un écart doit être visible
 * depuis l'administration, pas seulement en intégration continue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { listActiveUseCases, listOperationsByUseCase } from '@/services/ai/registry';
import { snapshotFlags } from '@/services/ai/flags/ai-feature-flags';
import { listModelsWithoutPricing, listUnverifiedPricing } from '@/services/ai/gateway/cost-catalog';
import { isCorpusComplete } from '@/services/ai/governance/corpus/corpus-registry';

export async function GET(req: NextRequest) {
  // requireAdmin lève si l'utilisateur n'est pas administrateur.
  // Convention du dépôt, identique aux autres routes /api/admin (§7.2).
  try {
    await requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const useCases = listActiveUseCases().map((uc) => {
    const ops = listOperationsByUseCase(uc.code);
    return {
      code: uc.code, label: uc.label, purpose: uc.purpose,
      replacesLegacyUsages: uc.replacesLegacyUsages,
      operations: ops.map((o) => ({
        code: o.operationCode, label: o.label,
        deterministic: o.provider === 'none',
        model: o.provider === 'none' ? null : o.primaryModel,
        promptCode: o.promptCode ?? null, active: o.active,
      })),
    };
  });

  const corpus = isCorpusComplete();

  const report = {
    generatedAt: new Date().toISOString(),
    activeUseCaseCount: useCases.length,
    expectedUseCaseCount: 5,
    compliant: useCases.length === 5,
    useCases,
    flags: snapshotFlags(),
    // Signalements d'exploitation : présents dans l'inventaire pour que les
    // écarts ne soient pas seulement visibles dans les journaux serveur.
    warnings: {
      modelsWithoutPricing: listModelsWithoutPricing(),
      unverifiedPricing: listUnverifiedPricing(),
      corpusIncomplete: corpus.complete ? [] : corpus.missing,
    },
  };

  return NextResponse.json(report, { status: report.compliant ? 200 : 409 });
}
